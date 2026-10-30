import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { digestResponseSchema, getDigest } from "../shared/digest";
import type { TelemetryEvent } from "../shared/telemetry";
import { ACTIVE_CLOCK_MS, DigestService, registerDigest } from "../server/digest";
import type { TokenCall } from "../server/token-source";
import type { TelemetryStore } from "../server/telemetry";

function fixture() {
  let now = 20000, status = "idle", epoch = "e", exists = true;
  const rows = [{ seqStart: 1, seqEnd: 1, timestamp: new Date(1000).toISOString(), turnId: "t", item: { type: "user_message", text: "Question" } },
    { seqStart: 2, seqEnd: 2, timestamp: new Date(10000).toISOString(), turnId: "t", item: { type: "assistant_message", text: "Answer" } }];
  const calls: TokenCall[] = [], events: TelemetryEvent[] = [];
  const requests: string[] = [];
  let refreshes = 0, tokenReads = 0, gate: Promise<void> = Promise.resolve();
  const paseo = { agents: { ref: (agentId: string) => ({ refresh: async () => {
    refreshes++; await gate; return exists ? { agent: { id: agentId, cwd: "/repo", status, persistence: { sessionId: "s" } } } : null;
  }, timeline: { refetch: async (options: { direction: string; cursor?: { epoch: string; seq: number }; projection: string }) => {
    requests.push(options.direction); assert.equal(options.projection, "projected");
    const same = options.cursor?.epoch === epoch;
    return { epoch, entries: options.direction === "after" && same ? rows.filter(row => row.seqStart > options.cursor!.seq) : rows, reset: !!options.cursor && !same };
  } } }) } } as unknown as PaseoApi;
  const deps = { now: () => now, tokens: { callsForSessions: async (ids: readonly string[]) => { tokenReads++; assert.deepEqual(ids, ["s"]); return calls.length ? { source: "codex" as const, calls } : null; } },
    telemetry: { snapshot: async () => ({ events }) } };
  return { paseo, deps, rows, calls, events, requests, setNow: (value: number) => now = value, setStatus: (value: string) => status = value,
    setEpoch: (value: string) => epoch = value, setExists: (value: boolean) => exists = value, setGate: (value: Promise<void>) => gate = value,
    counts: () => ({ refreshes, tokenReads }) };
}

test("RPC shares builds, returns epoch, short-circuits unchanged and incrementally folds new rows", async () => {
  const f = fixture(), service = new DigestService(f.deps);
  const [a, b] = await Promise.all([service.read({ agentId: "a" }, f.paseo), service.read({ agentId: "a" }, f.paseo)]);
  assert.deepEqual(a, b); assert.deepEqual(f.counts(), { refreshes: 1, tokenReads: 1 });
  assert.equal(a.mode, "full"); if (a.mode !== "full") return;
  assert.equal(a.epoch, "e"); assert.equal(digestResponseSchema.parse(a).mode, "full");
  f.setNow(90000);
  const unchanged = await service.read({ agentId: "a", revision: a.revision }, f.paseo);
  assert.deepEqual(unchanged, { mode: "unchanged", unchanged: true, revision: a.revision });
  assert.ok(Buffer.byteLength(JSON.stringify(unchanged)) < 100); assert.deepEqual(f.requests, ["tail", "after"]);
  f.rows.push({ ...f.rows[1]!, seqStart: 3, seqEnd: 3, timestamp: new Date(11000).toISOString(), item: { type: "assistant_message", text: " appended" } });
  const changed = await service.read({ agentId: "a", revision: a.revision }, f.paseo);
  assert.equal(changed.mode, "full"); if (changed.mode === "full") { assert.equal(changed.coverage.rows, 3); assert.equal(changed.turns[0]!.reply, "Answer appended"); }
  await service.close();
});

test("revisions cover same-call token corrections, same-count telemetry replacement, status and coarse clock", async () => {
  const f = fixture(), service = new DigestService(f.deps);
  f.calls.push({ at: 10000, start: 8000, model: null, input: 10, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 0, subagent: false });
  let response = await service.read({ agentId: "a" }, f.paseo);
  const changed = async () => { const next = await service.read({ agentId: "a", revision: response.revision }, f.paseo); assert.notEqual(next.revision, response.revision); response = next; };
  f.calls[0]!.output++; await changed();
  f.events.push({ id: "1", agentId: "a", agentTitle: "", at: new Date(15000).toISOString(), type: "turn_failed", label: "" }); await changed();
  f.events[0] = { ...f.events[0]!, id: "2", type: "turn_completed" }; await changed();
  f.setStatus("running"); await changed();
  // While running the revision follows a 30 s clock (the client's running poll), not every 10 s.
  const unchanged = async () => assert.equal((await service.read({ agentId: "a", revision: response.revision }, f.paseo)).mode, "unchanged");
  f.setNow(29_999); await unchanged();
  f.setNow(30_000); await changed();
  f.setNow(45_000); await unchanged();
  f.setNow(60_000); await changed();
  f.setStatus("idle"); await changed();
  f.setNow(600_000); await unchanged();
  await service.close();
});

test("a versioned token history is compared by its version, not call by call (opus-F70)", async () => {
  const f = fixture();
  let version = "v1";
  const calls: TokenCall[] = [{ at: 10000, start: 8000, model: null, input: 10, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 0, subagent: false }];
  const service = new DigestService({ ...f.deps, tokens: { callsForSessions: async () => ({ source: "claude" as const, calls: calls.map(item => ({ ...item })), version }) } });
  const first = await service.read({ agentId: "a" }, f.paseo);
  assert.equal(first.mode, "full"); if (first.mode !== "full") return;
  assert.equal(first.tokens?.totals.output, 20);
  calls[0]!.output = 999;
  assert.equal((await service.read({ agentId: "a", revision: first.revision }, f.paseo)).mode, "unchanged", "same logs, same version: nothing to send");
  version = "v2";
  const next = await service.read({ agentId: "a", revision: first.revision }, f.paseo);
  assert.equal(next.mode, "full"); if (next.mode === "full") assert.equal(next.tokens?.totals.output, 999);
  await service.close();
});

test("replacement resets epoch and scoped seq; LRU retains only the newest 24 agent builds", async () => {
  const f = fixture(), service = new DigestService(f.deps);
  const first = await service.read({ agentId: "a" }, f.paseo);
  f.setEpoch("next");
  const next = await service.read({ agentId: "a", revision: first.revision }, f.paseo);
  assert.equal(next.mode, "full"); if (next.mode === "full") assert.equal(next.epoch, "next");
  for (let i = 0; i < 25; i++) await service.read({ agentId: `a${i}` }, f.paseo);
  await service.read({ agentId: "a0" }, f.paseo); assert.equal(f.requests.at(-1), "tail");
  await service.read({ agentId: "a24" }, f.paseo); assert.equal(f.requests.at(-1), "after");
  await service.close();
});

test("unknown agents throw the exact contract error and timed-out or closed builds cannot populate cache", async () => {
  const f = fixture(), service = new DigestService({ ...f.deps, timeoutMs: 15 });
  f.setExists(false); await assert.rejects(service.read({ agentId: "absent" }, f.paseo), { message: "找不到这个 Agent" });
  f.setExists(true);
  let release!: () => void; f.setGate(new Promise(resolve => { release = resolve; }));
  await assert.rejects(service.read({ agentId: "slow" }, f.paseo), /超时/);
  release(); f.setGate(Promise.resolve());
  const next = await service.read({ agentId: "slow" }, f.paseo); assert.equal(next.mode, "full");
  f.setGate(new Promise(() => {}));
  const pending = service.read({ agentId: "closing" }, f.paseo); const rejected = assert.rejects(pending, /已关闭/);
  await service.close(); await rejected;
  await assert.rejects(service.read({ agentId: "a" }, f.paseo), /已关闭/);
});

test("registerDigest installs precisely the shared RPC contract and returns cleanup", async () => {
  const f = fixture(); let registered = false;
  const server = { handle: (contract: unknown) => { assert.equal(contract, getDigest); registered = true; } } as unknown as PluginServerContext;
  const close = registerDigest(server, { tokens: f.deps.tokens, telemetry: f.deps.telemetry as TelemetryStore });
  assert.equal(registered, true); await close();
});

test("daemon refresh exceptions for missing agents map to the exact Chinese error", async () => {
  const f = fixture(), service = new DigestService(f.deps);
  const paseo = { agents: { ref: () => ({ refresh: async () => { throw new Error("Agent not found: absent"); } }) } } as unknown as PaseoApi;
  await assert.rejects(service.read({ agentId: "absent" }, paseo), { message: "找不到这个 Agent" });
  await service.close();
});

test("empty timelines still return cheap unchanged revisions without a history cursor", async () => {
  const f = fixture(), service = new DigestService(f.deps); f.rows.length = 0;
  const first = await service.read({ agentId: "empty" }, f.paseo);
  const next = await service.read({ agentId: "empty", revision: first.revision }, f.paseo);
  assert.equal(next.mode, "unchanged"); await service.close();
});

// The client hook reads AppState from react-native (Flow source node cannot load) and RPCs from the host: stub both, in the background.
const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string; _cache: Record<string, unknown> };
const stubs: Record<string, unknown> = { "react-native": { AppState: { currentState: "background", addEventListener: () => ({ remove() {} }) } },
  "@getpaseo/plugin/client": { useRpc: () => async () => { throw new Error("a server render never fetches"); } } };
for (const [name, value] of Object.entries(stubs)) loader._cache[`\0stub:${name}`] = { id: `\0stub:${name}`, filename: `\0stub:${name}`, loaded: true, exports: value };
const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request, ...rest) { return request in stubs ? `\0stub:${request}` : resolveFilename.call(this, request, ...rest); };
// A server render runs the hook once, without effects or fetches. react-dom has no type declarations here; React Query is
// imported statically above, so it is the same CommonJS instance the hook requires.
const { renderToString } = require("react-dom/server") as { renderToString(element: ReturnType<typeof createElement>): string };

test("a running digest is polled on the revision clock's grain, and not at all in the background", async () => {
  // Imported only now, after the stubs are in place.
  const { digestPollMs, useDigest } = await import("../client/use-digest");
  assert.equal(digestPollMs(true, true), ACTIVE_CLOCK_MS); assert.ok(ACTIVE_CLOCK_MS >= 20_000 && ACTIVE_CLOCK_MS <= 30_000);
  assert.equal(digestPollMs(true, false), 60_000); assert.equal(digestPollMs(false, true), false);
  // A closed Agent is read once, not polled: each read loads it again (Paseo 0.14 closes idle Agents after an hour).
  assert.equal(digestPollMs(true, false, true), false); assert.equal(digestPollMs(true, true, true), false);
  const client = new QueryClient();
  function Digest() { useDigest("a", true, true); return null; }
  renderToString(createElement(QueryClientProvider, { client }, createElement(Digest)));
  const options = client.getQueryCache().getAll()[0]!.options as Record<string, unknown>;
  assert.equal(options.enabled, false); assert.equal(options.refetchInterval, false); assert.equal(options.refetchOnWindowFocus, false);
  client.clear();
});
