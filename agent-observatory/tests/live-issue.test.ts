import assert from "node:assert/strict";
import test from "node:test";
import { AttentionIndex } from "../server/attention";
import { applyLiveExtras, attentionPhase, reasonLine, reasonText, sessionPhase } from "../shared/attention";
import { needsAttention } from "../shared/dashboard-model";
import { activitySignature, detectLoop, isPolling, stuckLimit, toolStepOf, STUCK_MS, STUCK_TOOL_MS, type ToolStep } from "../shared/live-issue";
import { normalizeAgent } from "../shared/model";

// 原地打转 / 可能卡住 (2.18): loops in a running turn's tool calls, and turns that stopped changing.

const T = Date.parse("2026-10-28T20:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
let seq = 0;
const read = (filePath: string, content = "same") => ({ type: "tool_call", callId: `c${++seq}`, name: "Read", status: "completed", error: null, detail: { type: "read", filePath, content } });
const shell = (command: string, output = "", status = "completed") => ({ type: "tool_call", callId: `c${++seq}`, name: "Bash", status, error: null, detail: { type: "shell", command, output, exitCode: 0 } });
const steps = (items: Array<Record<string, unknown>>, gapMs = 2_000, start = T): ToolStep[] => items.map((item, index) => toolStepOf(item as never, start + index * gapMs)!);

test("the same call with the same result four times, fast, is a loop; three times or paced is not", () => {
  assert.equal(detectLoop(steps([read("a.ts"), read("a.ts"), read("a.ts")])), null);
  const loop = detectLoop(steps([read("b.ts"), read("a.ts"), read("a.ts"), read("a.ts"), read("a.ts")]));
  assert.equal(loop?.pattern, "same");
  assert.equal(loop?.count, 4);
  assert.equal(loop?.tool, "Read");
  assert.deepEqual(loop?.evidence.slice(-1), ["Read a.ts"]);
  // 30 seconds apart: it is waiting on something, not spinning.
  assert.equal(detectLoop(steps([read("a.ts"), read("a.ts"), read("a.ts"), read("a.ts")], 31_000)), null);
  // A different result each time breaks the same-result rule.
  assert.equal(detectLoop(steps([read("a.ts", "1"), read("a.ts", "2"), read("a.ts", "3"), read("a.ts", "4")])), null);
});

test("a new call still running that isn't part of the loop ends it; one that is keeps it", () => {
  const loop = [read("a.ts"), read("a.ts"), read("a.ts"), read("a.ts")];
  assert.equal(detectLoop(steps([...loop, shell("npm test", "", "running")])), null, "moved on to the tests");
  assert.equal(detectLoop(steps([...loop, { ...read("a.ts"), status: "running" }]))?.pattern, "same", "a fifth read of the same file");
  assert.equal(detectLoop(steps([...loop, shell("sleep 30", "", "running")]))?.pattern, "same", "polling doesn't count as moving on");
});

test("ACP calls with different titles are different calls, even with no arguments or output", () => {
  const acp = (title: string, output = "") => ({ type: "tool_call", callId: `c${++seq}`, name: "other", status: "completed", error: null, metadata: { kind: "read", title }, detail: { type: "unknown", input: null, output } });
  assert.equal(detectLoop(steps([acp("Read a.ts"), acp("Read b.ts"), acp("Read c.ts"), acp("Read d.ts")])), null);
  const twelve = Array.from({ length: 12 }, (_, index) => acp(`Read f${index}.ts`, String(index)));
  assert.equal(detectLoop(steps(twelve)), null, "twelve different files is reading, not a ping-pong");
  assert.equal(detectLoop(steps([acp("Read a.ts"), acp("Read a.ts"), acp("Read a.ts"), acp("Read a.ts")]))?.pattern, "same");
});

test("known polling never counts: waiting on a task, sleeping, tailing a log", () => {
  const poll = (name: string) => ({ type: "tool_call", callId: `c${++seq}`, name, status: "completed", error: null, detail: { type: "unknown", input: { id: 1 }, output: "running" } });
  assert.equal(detectLoop(steps([poll("TaskOutput"), poll("TaskOutput"), poll("TaskOutput"), poll("TaskOutput"), poll("TaskOutput")])), null);
  assert.equal(isPolling(toolStepOf(shell("sleep 30") as never, T)!), true);
  assert.equal(isPolling(toolStepOf(shell("tail -n 50 build/out.log") as never, T)!), true);
  assert.equal(isPolling(toolStepOf(shell("npm test") as never, T)!), false);
  assert.equal(detectLoop(steps([shell("sleep 5"), shell("sleep 5"), shell("sleep 5"), shell("sleep 5")])), null);
});

test("two calls in turn over 12 calls, or a rotation of up to four over 16, is a loop", () => {
  const pingpong = Array.from({ length: 12 }, (_, index) => index % 2 ? read("a.ts", String(index)) : shell("git status", String(index)));
  assert.equal(detectLoop(steps(pingpong))?.pattern, "pingpong");
  const rotation = Array.from({ length: 16 }, (_, index) => read(`f${index % 4}.ts`, String(index)));
  assert.equal(detectLoop(steps(rotation))?.pattern, "rotation");
  const varied = Array.from({ length: 16 }, (_, index) => read(`f${index % 5}.ts`, String(index)));
  assert.equal(detectLoop(steps(varied)), null, "five different calls in rotation is still exploring");
});

test("the same argument error three times in a row is a loop, whatever the arguments", () => {
  const edit = (oldString: string) => ({ type: "tool_call", callId: `c${++seq}`, name: "Edit", status: "failed", error: "String to replace not found in file.", detail: { type: "edit", filePath: "a.ts", oldString, newString: "x" } });
  const loop = detectLoop(steps([edit("one"), edit("two"), edit("three")]));
  assert.equal(loop?.pattern, "contract");
  assert.equal(loop?.tool, "Edit");
  assert.equal(detectLoop(steps([edit("one"), edit("two")])), null);
});

test("however paced, 30 identical calls or identical results for over an hour is a loop", () => {
  const thirty = Array.from({ length: 30 }, () => shell("gh run view 1", "in_progress"));
  assert.equal(detectLoop(steps(thirty, 40_000))?.pattern, "same");
  const hourly = [shell("gh run view 2", "queued"), shell("gh run view 2", "queued"), shell("gh run view 2", "queued")];
  assert.equal(detectLoop(steps(hourly, 31 * 60_000))?.pattern, "same", "three checks over 62 minutes with no change");
  assert.equal(detectLoop(steps(hourly.slice(0, 2), 61 * 60_000)), null, "two checks an hour apart are just two checks");
});

test("ACP tool calls (all named other) compare by their kind and title", () => {
  const acp = () => ({ type: "tool_call", callId: `c${++seq}`, name: "other", status: "completed", error: null, metadata: { kind: "read", title: "Read src/a.ts" }, detail: { type: "plain_text", label: "Read src/a.ts" } });
  const loop = detectLoop(steps([acp(), acp(), acp(), acp()]));
  assert.equal(loop?.pattern, "same");
  assert.equal(loop?.tool, "read");
});

test("the stuck limit is longer while a tool call still runs", () => {
  assert.equal(stuckLimit([read("a.ts")]).limitMs, STUCK_MS);
  const running = stuckLimit([read("a.ts"), shell("npm test", "", "running")]);
  assert.equal(running.limitMs, STUCK_TOOL_MS);
  assert.equal(running.running?.label, "npm test");
});

test("a running Agent with an issue shows it, counts until 知道了, and says what it is", () => {
  const base = normalizeAgent({ id: "a", status: "running", activeTurn: { startedAt: iso(T) } });
  const issue = { kind: "looping" as const, key: "k1", since: iso(T + 60_000), pattern: "same" as const, tool: "Read", count: 6, toolRunning: false, evidence: ["Read a.ts"], seen: false };
  const [agent] = applyLiveExtras([base], [{ agentId: "a", todo: null, note: null, noteAt: null, ask: null, askAt: null, issue }]);
  assert.equal(attentionPhase(agent!), "looping");
  assert.equal(sessionPhase(agent!), "looping");
  assert.equal(needsAttention(agent!), true);
  assert.equal(reasonLine(agent!)?.text, "疑似原地打转：Read 连续 6 次结果都一样");
  const [seen] = applyLiveExtras([base], [{ agentId: "a", todo: null, note: null, noteAt: null, ask: null, askAt: null, issue: { ...issue, seen: true } }]);
  assert.equal(needsAttention(seen!), false, "seen: shown, no longer counted");
  assert.equal(sessionPhase(seen!), "looping");
  // A finished turn's issue is history.
  const [done] = applyLiveExtras([{ ...base, status: "completed" }], [{ agentId: "a", todo: null, note: null, noteAt: null, ask: null, askAt: null, issue }]);
  assert.equal(done!.issue, undefined);
  assert.equal(reasonText({ phase: "stuck", issue: { pattern: null, tool: "npm test", count: 50, toolRunning: true, since: iso(T) } }, T + 52 * 60_000).text, "可能卡住：npm test 已经跑了 52 分钟");
  assert.equal(reasonText({ phase: "stuck", issue: { pattern: null, tool: null, count: 12, toolRunning: false, since: iso(T) } }, T + 12 * 60_000).text, "可能卡住：12 分钟没有新动静");
});

function host(rows: () => Array<Record<string, unknown>>, agent: Record<string, unknown>) { return observedHost(rows, [agent]).paseo; }
/** A host whose directory takes live agent updates (`update`), every agent reading the same timeline rows. */
function observedHost(rows: () => Array<Record<string, unknown>>, agents: Array<Record<string, unknown>>) {
  let observer: { snapshot(value: unknown): void; update?(value: unknown): void } | null = null;
  const subscription = { subscribe(next: { snapshot(value: unknown): void; update?(value: unknown): void }) { observer = next; next.snapshot({ entries: [] }); return () => {}; }, release: async () => {} };
  const paseo = {
    agents: {
      list: async (options: { subscribe?: unknown }) => options.subscribe ? { entries: [], pageInfo: { nextCursor: null, hasMore: false }, subscription } : { entries: agents.map(agent => ({ agent })), pageInfo: { nextCursor: null, hasMore: false } },
      ref: () => ({ timeline: { refetch: async () => ({ epoch: "e", rows: rows().map((item, index) => ({ key: `r${index}`, epoch: "e", seqStart: index, seqEnd: index, timestamp: iso(T + 1_000 + index * 2_000), item })) }) } }),
    },
    observeEvents: () => ({ subscribe() { return () => {}; }, release: async () => {} }),
  } as never;
  return { paseo, update: (agent: Record<string, unknown>) => observer?.update?.({ type: "agent_update", payload: { kind: "upsert", agent } }) };
}
const sources = (live: boolean) => ({
  telemetry: async () => ({ startedAt: iso(T), persistenceError: null, agents: [], events: [] }), background: () => [], isLive: () => live,
  receipts: async () => ({ receipts: [], archiveOrigins: [] }), preferences: async () => ({ snoozes: [], settings: { childCompletions: false } }),
});
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test("the server watches running turns: a loop reaches the badge, 知道了 takes it out of the count", async () => {
  const agent = { id: "runner", title: "修 bug", status: "running", activeTurn: { startedAt: iso(T) }, updatedAt: iso(T) };
  const loopRows = [read("x.ts"), read("a.ts"), read("a.ts"), read("a.ts"), read("a.ts"), read("a.ts")];
  let now = T + 60_000;
  const index = new AttentionIndex(sources(true), { now: () => now, todoEveryMs: 0 });
  // The sidebar labels hear issue changes too (they have no directory event of their own).
  let changes = 0;
  index.onChange(() => { changes++; });
  try {
    await index.attach(host(() => loopRows, agent));
    await index.read();
    await settle();
    const first = await index.read();
    assert.equal(first.mode === "full" && first.count, 1);
    assert.ok(changes >= 1, "a new issue is a change");
    const entry = first.mode === "full" ? first.entries[0]! : null;
    assert.equal(entry?.phase, "looping");
    assert.equal(entry?.issue?.pattern, "same");
    const extras = await index.readExtras();
    const issue = extras.mode === "full" ? extras.agents.find(extra => extra.agentId === "runner")?.issue : null;
    assert.equal(issue?.seen, false);
    assert.equal(issue?.count, 5);
    assert.equal(index.seeIssue("runner", "not-this-one"), false);
    const beforeSeen = changes;
    assert.equal(index.seeIssue("runner", issue!.key), true);
    assert.equal(changes, beforeSeen + 1, "知道了 is a change");
    now += 1_000;
    const after = await index.read();
    assert.equal(after.mode === "full" && after.count, 0, "seen: no longer counted");
    // The turn ends: the issue goes with it.
    index.turnEnded("runner");
    assert.equal(index.extras().find(extra => extra.agentId === "runner")?.issue ?? null, null);
  } finally {
    index.close();
  }
});

test("rows that stop changing for 10 minutes make a running turn stuck; any change resets the clock", async () => {
  const agent = { id: "quiet", title: "等结果", status: "running", activeTurn: { startedAt: iso(T) }, updatedAt: iso(T) };
  let rows: Array<Record<string, unknown>> = [read("a.ts", "1"), { type: "assistant_message", text: "看一下" }];
  let now = T + 60_000;
  const index = new AttentionIndex(sources(true), { now: () => now, todoEveryMs: 0 });
  const issueOf = () => index.extras().find(extra => extra.agentId === "quiet")?.issue ?? null;
  try {
    await index.attach(host(() => rows, agent));
    await index.read(); await settle();
    assert.equal(issueOf(), null);
    now += 9 * 60_000;
    await index.read(); await settle();
    assert.equal(issueOf(), null, "9 minutes is not yet stuck");
    now += 2 * 60_000;
    await index.read(); await settle();
    assert.equal(issueOf()?.kind, "stuck");
    assert.equal(issueOf()?.count, 11);
    rows = [...rows, { type: "assistant_message", text: "继续" }];
    now += 1_000;
    await index.read(); await settle();
    assert.equal(issueOf(), null, "a new row resets the clock");
    // A tool still running gets 45 minutes.
    rows = [...rows, shell("npm test", "", "running")];
    now += 1_000; await index.read(); await settle();
    now += 20 * 60_000; await index.read(); await settle();
    assert.equal(issueOf(), null);
    now += 26 * 60_000; await index.read(); await settle();
    assert.equal(issueOf()?.kind, "stuck");
    assert.equal(issueOf()?.toolRunning, true);
    assert.equal(issueOf()?.tool, "npm test");
  } finally {
    index.close();
  }
});

test("a parent waiting on its busy sub-agent is never stuck; its quiet clock starts when the sub-agent stops", async () => {
  const lead = { id: "lead", title: "带队", status: "running", activeTurn: { startedAt: iso(T) }, updatedAt: iso(T) };
  const worker = { id: "worker", title: "子任务", status: "running", activeTurn: { startedAt: iso(T) }, updatedAt: iso(T), labels: { "paseo.parent-agent-id": "lead" } };
  const rows = [read("a.ts", "1"), { type: "assistant_message", text: "等子 Agent 交差" }];
  let now = T + 60_000;
  const index = new AttentionIndex(sources(true), { now: () => now, todoEveryMs: 0 });
  const issueOf = (id: string) => index.extras().find(extra => extra.agentId === id)?.issue ?? null;
  const fake = observedHost(() => rows, [lead, worker]);
  try {
    await index.attach(fake.paseo);
    await index.read(); await settle();
    now += 30 * 60_000;
    await index.read(); await settle();
    assert.equal(issueOf("lead"), null, "waiting on a working sub-agent is not stuck");
    assert.equal(issueOf("worker")?.kind, "stuck", "the sub-agent itself still can be");
    fake.update({ ...worker, status: "idle", activeTurn: null, updatedAt: iso(now) });
    now += 1_000; await index.read(); await settle();
    assert.equal(issueOf("lead"), null, "the quiet clock starts when the sub-agent stops");
    now += 11 * 60_000; await index.read(); await settle();
    assert.equal(issueOf("lead")?.kind, "stuck");
    assert.equal(issueOf("lead")?.count, 11);
  } finally {
    index.close();
  }
});

test("a sub-agent tool call whose log grows is activity, not quiet", () => {
  const task = (log: string, actions: unknown[] = []) => ({ type: "tool_call", callId: "t1", name: "Task", status: "running", error: null, detail: { type: "sub_agent", description: "查日志", log, actions } });
  assert.notEqual(activitySignature([task("[Read] a.ts")] as never), activitySignature([task("[Read] a.ts\n[Grep] error")] as never));
  assert.notEqual(activitySignature([task("")] as never), activitySignature([task("", [{ toolName: "Read" }])] as never));
  assert.equal(activitySignature([task("[Read] a.ts")] as never), activitySignature([task("[Read] a.ts")] as never));
});

test("an Agent this process has not seen live is never read (reading would load it)", async () => {
  const agent = { id: "cold", title: "x", status: "running", activeTurn: { startedAt: iso(T) }, updatedAt: iso(T) };
  let reads = 0;
  const paseo = host(() => { reads++; return [read("a.ts"), read("a.ts"), read("a.ts"), read("a.ts")]; }, agent);
  const index = new AttentionIndex(sources(false), { now: () => T + 60_000, todoEveryMs: 0 });
  try {
    await index.attach(paseo);
    await index.read(); await settle();
    assert.equal(reads, 0);
  } finally {
    index.close();
  }
});
