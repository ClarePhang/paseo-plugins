import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TokenIngester } from "../server/tokens/ingester";
import { tokenSourceNames } from "../shared/tokens";
import { type LedgerCall, type LogRoot } from "../server/tokens/types";

// Fictional logs in the shapes Gemini CLI's JSONL chat records and Qwen Code write
// (field names checked against the official chat recording types and real logs; values invented).
const NOW = Date.parse("2026-10-11T12:00:00Z");
const line = (row: unknown) => JSON.stringify(row) + "\n";
const iso = (at: number) => new Date(at).toISOString();

async function ingest(roots: (root: string) => LogRoot[], run: (root: string, ingester: TokenIngester, calls: Map<string, LedgerCall>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tokens-gemini-qwen-")), calls = new Map<string, LedgerCall>();
  const ingester = new TokenIngester({ roots: roots(root), now: () => NOW, onCall: call => { calls.set(call.key, call); } });
  try { await run(root, ingester, calls); } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
}

test("Gemini CLI: a gemini message's tokens count once per message id; $set re-emissions correct, chatter is not a call", () => ingest(root => [{ source: "gemini", path: root }], async (root, ingester, calls) => {
  const metadata = { sessionId: "g1111111-0000-4000-8000-00000000000a", projectHash: "f".repeat(64), startTime: iso(NOW - 3_600_000), lastUpdated: iso(NOW), kind: "main" };
  const geminiMessage = (id: string, at: number, tokens: Record<string, number> | undefined) =>
    ({ id, timestamp: iso(at), type: "gemini", content: [{ text: "PRIVATE_OUTPUT" }], model: "gemini-test-model", ...(tokens ? { tokens } : {}) });
  const session = (rows: unknown[]) => rows.map(line).join("");
  await mkdir(join(root, "clare-workspace", "chats"), { recursive: true });
  await writeFile(join(root, "clare-workspace", "chats", "session-2026-10-11T10-00-1a2d9c48.jsonl"), session([
    metadata,
    { $set: { messages: [geminiMessage("gm1", NOW - 40_000, { input: 1_000, output: 200, cached: 300, thoughts: 50, tool: 0, total: 1_550 }), { id: "u1", timestamp: iso(NOW - 50_000), type: "user", content: [{ text: "PRIVATE_PROMPT" }] }] } },
    // A later window re-emits the finished message with the same tokens (a duplicate) and adds a new one.
    { $set: { messages: [geminiMessage("gm1", NOW - 40_000, { input: 1_000, output: 200, cached: 300, thoughts: 50, tool: 0, total: 1_550 }), geminiMessage("gm2", NOW - 20_000, { input: 500, output: 80, cached: 0, thoughts: 10, tool: 0, total: 590 })] } },
  ]));
  // An old-generation chat record (a single JSON document, no tokens per message) is never a JSONL log.
  await mkdir(join(root, "oldest", "chats"), { recursive: true });
  await writeFile(join(root, "oldest", "chats", "session-2026-03-16T06-00-7f1205cf.json"), line(metadata));
  await ingester.backfillAll();
  const rows = [...calls.values()].sort((a, b) => a.at - b.at);
  assert.deepEqual(rows.map(call => [call.source, call.sessionId, call.cwd, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.reasoning, call.at, call.start, call.subagent]), [
    ["gemini", "g1111111-0000-4000-8000-00000000000a", "", "gemini-test-model", 700, 300, 0, 200, 50, NOW - 40_000, null, false],
    ["gemini", "g1111111-0000-4000-8000-00000000000a", "", "gemini-test-model", 500, 0, 0, 80, 10, NOW - 20_000, null, false],
  ], "the cached part comes out of the prompt; thoughts are their own counter; there is no response time");
  assert.equal(tokenSourceNames.gemini, "Gemini CLI");
  assert.ok(!JSON.stringify([...ingester.files.values()]).includes("PRIVATE_"));
}));

test("Qwen Code: assistant rows with their usageMetadata, the cache out of the prompt, the user row as the request start", () => ingest(root => [{ source: "qwen", path: root }], async (root, ingester, calls) => {
  const row = (parts: { id: string; type: string; at: number; model?: string; usage?: Record<string, number> }) => ({
    uuid: parts.id, parentUuid: null, sessionId: "q2222222-0000-4000-8000-00000000000b", timestamp: iso(parts.at),
    type: parts.type, cwd: "/home/me/app", version: "0.14.0", ...(parts.model ? { model: parts.model } : {}),
    ...(parts.usage ? { usageMetadata: parts.usage } : {}), message: { role: parts.type === "user" ? "user" : "assistant", parts: [] } });
  const path = join(root, "home-me-app", "chats", "q2222222-0000-4000-8000-00000000000b.jsonl");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, [
    row({ id: "qu1", type: "user", at: NOW - 50_000 }),
    row({ id: "qa1", type: "assistant", at: NOW - 40_000, model: "qwen-test-model", usage: { promptTokenCount: 18_623, candidatesTokenCount: 111, thoughtsTokenCount: 26, totalTokenCount: 18_734, cachedContentTokenCount: 300 } }),
    row({ id: "qa2", type: "assistant", at: NOW - 30_000, model: "qwen-test-model", usage: { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0, cachedContentTokenCount: 0 } }),
  ].map(line).join(""));
  await ingester.backfillAll();
  const rows = [...calls.values()].sort((a, b) => a.at - b.at);
  assert.deepEqual(rows.map(call => [call.source, call.sessionId, call.cwd, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.reasoning, call.at, call.start, call.subagent]), [
    ["qwen", "q2222222-0000-4000-8000-00000000000b", "/home/me/app", "qwen-test-model", 18_323, 300, 0, 111, 26, NOW - 40_000, NOW - 50_000, false],
  ], "the all-zero row (an aborted call) is not a call; the user row is the request start");
  assert.equal(tokenSourceNames.qwen, "Qwen Code");
  await writeFile(path, line(row({ id: "qa3", type: "assistant", at: NOW - 20_000, model: "qwen-test-model", usage: { promptTokenCount: 2_000, candidatesTokenCount: 50, thoughtsTokenCount: 5, totalTokenCount: 2_050, cachedContentTokenCount: 100 } })));
  await ingester.poll(true);
  assert.deepEqual([...calls.values()].map(call => call.output).sort((a, b) => a - b), [50, 111], "a log is read on from where it stopped");
}));
