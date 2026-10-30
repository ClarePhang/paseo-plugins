import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTimelinePage } from "../shared/timeline";
import { compactRow, createFold, foldRows } from "../server/digest/fold";
import { fetchHistory, type TimelineFetch } from "../server/digest/reader";

const stamp = (at: number) => new Date(at).toISOString();
const row = (seq: number, at: number, item: Record<string, unknown>, turnId = "t1") => ({ seqStart: seq, seqEnd: seq, timestamp: stamp(at), turnId, item });
const source = [row(1, 1000, { type: "user_message", text: "  hello\nworld  " }),
  row(2, 2000, { type: "tool_call", callId: "one", name: "Read", status: "running", detail: { type: "read", filePath: "/repo/a.ts", content: "private" } }),
  row(3, 4000, { type: "tool_call", callId: "one", status: "completed", detail: { type: "read", output: "private" } }),
  row(4, 4500, { type: "assistant_message", text: "Hel", messageId: "m1" }), row(5, 4600, { type: "assistant_message", text: "lo " }),
  row(6, 4700, { type: "assistant_message", text: "world" }), row(7, 8000, { type: "user_message", text: "Next" }, "t2")];
const facts = () => normalizeTimelinePage({ epoch: "epoch", entries: source }).rows.map(value => compactRow(value, "/repo"));

test("canonical fold deduplicates lifecycle rows, streams messages, and discards bodies", () => {
  const state = foldRows(createFold("a", "/repo", "epoch"), facts());
  assert.equal(state.rows, 7); assert.equal(state.turns.length, 2);
  assert.equal(state.turns[0]?.prompt, "hello world"); assert.equal(state.turns[0]?.reply, "Hello world");
  assert.equal(state.turns[0]?.messages, 2);
  const tool = [...state.tools.values()][0]!;
  assert.equal(tool.start, 2000); assert.equal(tool.end, 4000); assert.equal(tool.status, "ok"); assert.equal(tool.seq, 2);
  assert.equal(tool.name, "Read"); assert.equal(tool.path, "a.ts");
  assert.ok(!JSON.stringify(facts()).includes("private"));
});

test("every split of an incremental fold equals the whole fold, including replayed pages", () => {
  const rows = facts(), full = foldRows(createFold("a"), rows);
  for (let split = 0; split <= rows.length; split++) {
    const state = foldRows(createFold("a"), rows.slice(0, split));
    foldRows(state, rows.slice(Math.max(0, split - 1)));
    assert.deepEqual(state, full);
  }
});

test("canonical reader walks tail then before and preserves epoch and cursor for after", async () => {
  const requests: string[] = [];
  const fetch: TimelineFetch = async options => {
    requests.push(options.direction!); assert.equal(options.projection, "projected");
    const entries = options.direction === "tail" ? source.slice(3) : options.direction === "before" ? source.slice(0, 3) : [];
    return { epoch: "epoch", entries, hasOlder: options.direction === "tail", hasNewer: false };
  };
  const initial = await fetchHistory(fetch, "a", "/repo");
  assert.equal(initial.state.epoch, "epoch"); assert.equal(initial.state.rows, 7);
  const next = await fetchHistory(fetch, "a", "/repo", initial);
  assert.deepEqual(next.state, initial.state); assert.deepEqual(requests, ["tail", "before", "after"]);
});

test("reader rebuilds on epoch changes and gaps, and empty history has no epoch", async () => {
  const prior = await fetchHistory(async () => ({ epoch: "old", entries: source.slice(0, 2) }), "a", "/repo");
  let tail = 0;
  const rebuilt = await fetchHistory(async options => {
    if (options.direction === "tail") tail++;
    return { epoch: "new", gap: options.direction === "after", entries: source };
  }, "a", "/repo", prior);
  assert.equal(tail, 1); assert.equal(rebuilt.state.epoch, "new"); assert.equal(rebuilt.state.rows, 7);
  assert.equal((await fetchHistory(async () => ({ epoch: "new", entries: [] }), "empty", "")).state.epoch, null);
});

test("reader caps coverage, reports truncation, and accepts projected timelines", async () => {
  const many = Array.from({ length: 8100 }, (_, i) => row(i + 1, i, { type: "reasoning", text: "private" }));
  const history = await fetchHistory(async () => ({ epoch: "e", entries: many, hasOlder: true }), "a", "");
  assert.equal(history.state.rows, 8000); assert.equal(history.state.truncated, true);
  assert.equal((await fetchHistory(async () => ({ projection: "projected", epoch: "e", entries: source }), "a", "")).state.rows, source.length);
});

test("an unannounced internal sequence gap rebuilds instead of permanently skipping an event", async () => {
  const old = await fetchHistory(async () => ({ epoch: "e", entries: source.slice(0, 2) }), "a", "/repo");
  let tails = 0;
  const next = await fetchHistory(async options => {
    if (options.direction === "tail") tails++;
    return { epoch: "e", entries: options.direction === "after" ? [source[2], source[4]] : source };
  }, "a", "/repo", old);
  assert.equal(tails, 1); assert.equal(next.state.rows, 7); assert.equal(next.state.truncated, false);
  const missing = await fetchHistory(async () => ({ epoch: "e", entries: [source[0], source[2]] }), "a", "/repo");
  assert.equal(missing.state.truncated, true);
});

test("sparse completions retain web search kind, query, hostname and subagent description", () => {
  const details = [{ type: "search", toolName: "web_search", query: "query" }, { type: "fetch", url: "https://example.com/private" },
    { type: "sub_agent", description: "Review source", log: "" }];
  for (const detail of details) {
    const rows = normalizeTimelinePage({ epoch: "e", entries: [row(1, 0, { type: "user_message", text: "Go" }),
      row(2, 1000, { type: "tool_call", name: "Tool", callId: "one", status: "running", detail }),
      row(3, 5000, { type: "tool_call", callId: "one", status: "completed", detail: { type: detail.type } })] }).rows;
    const state = foldRows(createFold("a"), rows.map(row => compactRow(row, "/repo"))), tool = [...state.tools.values()][0]!;
    assert.equal(tool.target, detail.type === "search" ? "query" : detail.type === "fetch" ? "example.com" : "Review source");
    assert.equal(tool.lane, detail.type === "sub_agent" ? "agent" : "web");
  }
});

test("consecutive user messages delimit turns even with reused provider turn IDs", () => {
  const state = foldRows(createFold("a"), normalizeTimelinePage({ epoch: "e", entries: [row(1, 1, { type: "user_message", text: "first" }),
    row(2, 2, { type: "user_message", text: "second" }), row(3, 3, { type: "assistant_message", text: "answer" })] }).rows.map(row => compactRow(row, "")));
  assert.deepEqual(state.turns.map(turn => [turn.prompt, turn.reply]), [["first", ""], ["second", "answer"]]);
});

test("a full window rolls forward using compact facts without fetching old history again", async () => {
  const all = Array.from({ length: 8000 }, (_, index) => row(index + 1, index, { type: "reasoning", text: "BODY_MUST_NOT_BE_RETAINED" }));
  const prior = await fetchHistory(async () => ({ epoch: "e", entries: all, hasOlder: true }), "a", "");
  const appended = row(8001, 8001, { type: "assistant_message", text: "done" });
  const next = await fetchHistory(async options => { assert.equal(options.direction, "after"); return { epoch: "e", entries: [appended] }; }, "a", "", prior);
  const rebuilt = await fetchHistory(async () => ({ epoch: "e", entries: [...all.slice(1), appended], hasOlder: true }), "a", "");
  assert.deepEqual(next.state, rebuilt.state); assert.equal(next.state.rows, 8000); assert.equal(next.facts.size, 8000);
  assert.ok(!JSON.stringify([...next.facts.values()]).includes("BODY_MUST_NOT_BE_RETAINED"));
});

test("a schedule's prompt or another agent's message opens a turn without a turn id, and is no tool (Paseo 0.14)", () => {
  const replayed = [row(1, 1000, { type: "user_message", text: "build it" }, ""), row(2, 2000, { type: "assistant_message", text: "built" }, ""),
    row(3, 3000, { type: "tool_call", callId: "paseo-system:3f2a", name: "heartbeat", status: "completed", detail: { type: "plain_text", text: "Schedule \"nightly\" fired.\ncheck the build" } }, ""),
    row(4, 4000, { type: "tool_call", callId: "c1", name: "Bash", status: "completed", detail: { type: "shell", command: "npm test", exitCode: 0 } }, ""),
    row(5, 5000, { type: "assistant_message", text: "green" }, ""),
    row(6, 6000, { type: "tool_call", callId: "paseo-agent-message:m1", name: "agent_message", status: "completed", agentMessage: { event: "finished", sender: { id: "c" }, text: "child done" }, detail: { type: "plain_text", text: "child done" } }, ""),
    row(7, 7000, { type: "assistant_message", text: "noted" }, "")];
  const state = foldRows(createFold("a", "/repo", "epoch"), normalizeTimelinePage({ epoch: "epoch", entries: replayed }).rows.map(value => compactRow(value, "/repo")));
  assert.deepEqual(state.turns.map(turn => [turn.prompt, turn.reply]), [["build it", "built"], ["Schedule \"nightly\" fired. check the build", "green"], ["child done", "noted"]]);
  assert.deepEqual([...state.tools.values()].map(tool => tool.name), ["Bash"]);
});
