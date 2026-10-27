import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TokenIngester } from "../server/tokens/ingester";
import { tokenSourceNames } from "../shared/tokens";
import { type LedgerCall, type LogRoot } from "../server/tokens/types";

// Fictional data in the shapes Hermes (state.db), MiMoCode (mimocode.db, OpenCode-shaped)
// and dsh (cost-meter/ledger.json) write (field names checked against real files; values invented).
const NOW = Date.parse("2026-10-11T12:00:00Z");
const DAY = 86_400_000;
const TODAY_UTC = new Date(NOW).toISOString().slice(0, 10);
const YESTERDAY_UTC = new Date(NOW - DAY).toISOString().slice(0, 10);
const line = (row: unknown) => JSON.stringify(row) + "\n";

async function ingest(roots: (root: string) => LogRoot[], run: (root: string, ingester: TokenIngester, calls: Map<string, LedgerCall>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tokens-hmd-")), calls = new Map<string, LedgerCall>();
  const ingester = new TokenIngester({ roots: roots(root), now: () => NOW, onCall: call => { calls.set(call.key, call); } });
  try { await run(root, ingester, calls); } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
}

test("Hermes: closed sessions emit their per-model aggregates; open sessions and model-less rows wait", () => ingest(root => [{ source: "hermes", path: root }], async (root, ingester, calls) => {
  const db = new DatabaseSync(join(root, "state.db"));
  db.exec("CREATE TABLE sessions (id text PRIMARY KEY, parent_session_id text, cwd text, ended_at real, started_at real)");
  db.exec("CREATE TABLE session_model_usage (session_id text, model text, api_call_count integer, input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer, reasoning_tokens integer, first_seen real, last_seen real)");
  const session = (id: string, parent: string | null, ended: number | null) => db.prepare("INSERT INTO sessions VALUES (?, ?, '/home/me/app', ?, ?)").run(id, parent, ended, NOW - 3_600_000);
  const usage = (session: string, model: string, calls: number, input: number, out: number, read: number, write: number, reason: number, seen: number) =>
    db.prepare("INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(session, model, calls, input, out, read, write, reason, seen, seen);
  session("h-ses-1", null, NOW - 60_000);
  session("h-sub", "h-ses-1", NOW - 50_000);
  session("h-open", null, null); // still running: not counted yet
  usage("h-ses-1", "hm-test-model", 3, 1_000, 200, 5_000, 100, 20, (NOW - 60_000) / 1000);
  usage("h-sub", "hm-test-model", 1, 300, 50, 0, 0, 5, (NOW - 50_000) / 1000);
  usage("h-open", "hm-test-model", 1, 9_999, 0, 0, 0, 0, (NOW - 10_000) / 1000);
  db.close();
  await ingester.backfillAll();
  console.log("DIAG hermes:", JSON.stringify({ files: ingester.files.size, roots: ingester.roots.map(r => ({ s: r.source, files: r.files, error: r.error })), diag: ingester.diagnostics, dbTracked: [...ingester.files.keys()].filter(k => k.endsWith(".db")) }));
  const rows = [...calls.values()].sort((a, b) => a.at - b.at);
  assert.deepEqual(rows.map(call => [call.source, call.sessionId, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.reasoning, call.at, call.start, call.subagent, call.calls ?? 1]), [
    ["hermes", "h-ses-1", "hm-test-model", 1_000, 5_000, 100, 200, 20, NOW - 60_000, null, false, 3],
    ["hermes", "h-sub", "hm-test-model", 300, 0, 0, 50, 5, NOW - 50_000, null, true, 1],
  ], "a closed session emits one call per model row; the open session waits");
  assert.equal(tokenSourceNames.hermes, "Hermes");
}));

test("MiMoCode: assistant messages of mimocode.db count like OpenCode's, minus synthetic and zero rows", () => ingest(root => [{ source: "mimo", path: root }], async (root, ingester, calls) => {
  const db = new DatabaseSync(join(root, "mimocode.db"));
  db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, agent_id text, time_created integer, time_updated integer, data text NOT NULL)");
  db.exec("CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text)");
  db.prepare("INSERT INTO session VALUES (?, NULL, ?)").run("ses_m1", "/home/me/app");
  const message = (id: string, body: Record<string, unknown>) => db.prepare("INSERT INTO message VALUES (?, 'ses_m1', NULL, ?, ?, ?)").run(id, NOW, NOW, JSON.stringify({ id, sessionID: "ses_m1", role: "assistant", path: { cwd: "/home/me/app" }, modelID: "mimo-test-model", time: { created: NOW - 30_000, completed: NOW - 29_000 }, tokens: { input: 4_000, output: 300, reasoning: 25, cache: { read: 6_000, write: 90 } }, ...body }));
  message("mm1", {});
  message("mm2", { modelID: "<synthetic>", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: NOW - 20_000, completed: NOW - 20_000 } });
  db.close();
  await ingester.backfillAll();
  assert.deepEqual([...calls.values()].map(call => [call.source, call.sessionId, call.cwd, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.reasoning, call.at, call.start, call.subagent]), [
    ["mimo", "ses_m1", "/home/me/app", "mimo-test-model", 4_000, 6_000, 90, 300, 25, NOW - 29_000, NOW - 30_000, false],
  ], "the synthetic zero row is not a call");
  assert.equal(tokenSourceNames.mimo, "MiMoCode");
}));

test("dsh: a closed day emits one call per session per provider-model; the in-progress day waits", () => ingest(root => [{ source: "dsh", path: root }], async (root, ingester, calls) => {
  const costMeter = join(root, "storages", "cost-meter");
  await mkdir(costMeter, { recursive: true });
  const modelRow = (input: number, out: number, read: number, write: number, reason: number, calls: number) => ({ input, output: out, cacheRead: read, cacheWrite: write, reasoning: reason, calls, cost: 0 });
  await writeFile(join(costMeter, "ledger.json"), JSON.stringify({
    version: 5, days: {
      [YESTERDAY_UTC]: {
        date: YESTERDAY_UTC, input: 1_300, output: 240, cacheRead: 3_000, cacheWrite: 100, reasoning: 25, calls: 3, cost: 0,
        byProviderModel: { "dsh:deepseek-v4": modelRow(1_300, 240, 3_000, 100, 25, 3) },
        sessions: [
          { id: "session-abc", input: 1_000, output: 200, cacheRead: 2_500, cacheWrite: 100, reasoning: 20, calls: 2, cost: 0, at: NOW - DAY, title: "t", byProviderModel: { "dsh:deepseek-v4": modelRow(1_000, 200, 2_500, 100, 20, 2) } },
          { id: "session-def", input: 300, output: 40, cacheRead: 500, cacheWrite: 0, reasoning: 5, calls: 1, cost: 0, at: NOW - DAY + 60_000, title: "t2", byProviderModel: { "dsh:deepseek-v4": modelRow(300, 40, 500, 0, 5, 1) } },
        ],
      },
      [TODAY_UTC]: { date: TODAY_UTC, input: 5, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1, cost: 0, byProviderModel: {}, sessions: [] },
    },
  }));
  await ingester.backfillAll();
  const rows = [...calls.values()].sort((a, b) => a.at - b.at);
  assert.deepEqual(rows.map(call => [call.source, call.sessionId, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.reasoning, call.at, call.subagent]), [
    ["dsh", "session-abc", "dsh:deepseek-v4", 1_000, 2_500, 100, 200, 20, NOW - DAY, false],
    ["dsh", "session-def", "dsh:deepseek-v4", 300, 500, 0, 40, 5, NOW - DAY + 60_000, false],
  ], "one call per session per provider-model of a closed day; today waits");
  assert.equal(tokenSourceNames.dsh, "DeepSeek Harness");
}));
