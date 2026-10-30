import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTimelineItem, ToolCallDetail, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import { extractTurnContent } from "../server/turn-content";
import { emptyStatsMetrics, statsMetricsSchema, statsToolSchema } from "../shared/stats";

const user = (text = "Do the work", messageId?: string): AgentTimelineItem => ({ type: "user_message", text, ...(messageId ? { messageId } : {}) });
const assistant = (text = "Done", messageId?: string): AgentTimelineItem => ({ type: "assistant_message", text, ...(messageId ? { messageId } : {}) });
const tool = (callId: string, detail: ToolCallDetail, status: ToolCallTimelineItem["status"] = "completed", name: string = detail.type): ToolCallTimelineItem => ({
  type: "tool_call", callId, name, detail, status, error: null,
});
const shell = (callId: string, exitCode?: number | null, status: ToolCallTimelineItem["status"] = "completed") =>
  tool(callId, { type: "shell", command: "true", ...(exitCode === undefined ? {} : { exitCode }) }, status);

test("empty or unanchored timelines count nothing while advancing the saved marker", () => {
  assert.deepEqual(extractTurnContent([], null), { metrics: emptyStatsMetrics(), tools: [], lastKey: null });
  // Nothing read (a failed read on Paseo 0.13) keeps the place.
  assert.deepEqual(extractTurnContent([], "old"), { metrics: emptyStatsMetrics(), tools: [], lastKey: "old" });
  const result = extractTurnContent([assistant("historical", "a"), shell("old")], null);
  assert.deepEqual(result.metrics, emptyStatsMetrics());
  assert.deepEqual(result.tools, []);
  assert.equal(result.lastKey, "tool:old");
});

test("first sight processes only the latest user turn including its user message", () => {
  const result = extractTurnContent([user("old", "u1"), shell("old"), assistant("old", "a1"), user("new", "u2"), shell("new"), assistant("new", "a2")], null);
  assert.equal(result.metrics.userMessages, 1);
  assert.equal(result.metrics.assistantMessages, 1);
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(result.lastKey, "msg:a2");
});

test("the identical timeline produces a zero delta and does not retain raw content", () => {
  const timeline = [user("private prompt"), shell("run"), assistant("private response")];
  const first = extractTurnContent(timeline, null), again = extractTurnContent(timeline, first.lastKey);
  assert.deepEqual(again, { metrics: emptyStatsMetrics(), tools: [], lastKey: first.lastKey });
  assert.match(first.lastKey!, /^assistant_message:2:[a-f0-9]{12}$/);
  assert.ok(!JSON.stringify(first).includes("private"));
});

test("a found marker processes its complete suffix even if several user turns are present", () => {
  const before = [user("old", "old-u"), assistant("old", "old-a")];
  const previous = extractTurnContent(before, null);
  const result = extractTurnContent([...before, user("one", "u1"), assistant("one", "a1"), user("two", "u2"), assistant("two", "a2")], previous.lastKey);
  assert.equal(result.metrics.userMessages, 2);
  assert.equal(result.metrics.assistantMessages, 2);
  assert.equal(result.lastKey, "msg:a2");
});

test("backward search uses the last matching tool or message ID", () => {
  for (const marker of [shell("duplicate"), assistant("duplicate", "duplicate")]) {
    const key = extractTurnContent([user(), marker], null).lastKey;
    const result = extractTurnContent([user(), marker, user("skip"), shell("skip"), marker, assistant("new", "new")], key);
    assert.equal(result.metrics.userMessages, 0);
    assert.equal(result.metrics.toolCalls, 0);
    assert.equal(result.metrics.assistantMessages, 1);
  }
});

test("missing markers recover at the latest user and skip resets with no user", () => {
  const result = extractTurnContent([user("skip"), shell("skip"), user("new"), shell("new")], "msg:missing");
  assert.equal(result.metrics.userMessages, 1);
  assert.equal(result.metrics.toolCalls, 1);
  assert.deepEqual(extractTurnContent([assistant("reset", "reset")], "msg:missing"), { metrics: emptyStatsMetrics(), tools: [], lastKey: "msg:reset" });
});

test("a found marker needs no user in the remaining timeline", () => {
  const result = extractTurnContent([assistant("restored", "anchor"), shell("new")], "msg:anchor");
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(result.metrics.userMessages, 0);
});

test("message IDs remain stable across text updates; anonymous keys include type, index and text hash", () => {
  assert.equal(extractTurnContent([user(), assistant("changed", "same")], "msg:same").metrics.assistantMessages, 0);
  const first = extractTurnContent([user("one")], null).lastKey;
  const differentText = extractTurnContent([user("two")], null).lastKey;
  const differentIndex = extractTurnContent([assistant(), user("one")], null).lastKey;
  const differentType = extractTurnContent([assistant("one")], null).lastKey;
  assert.notEqual(first, differentText);
  assert.notEqual(first, differentIndex);
  assert.notEqual(first, differentType);
  assert.equal(extractTurnContent([user("one")], null).lastKey, first);
  const errorKey = extractTurnContent([{ type: "error", message: "one" }], null).lastKey;
  assert.notEqual(errorKey, extractTurnContent([{ type: "error", message: "two" }], null).lastKey);
});

test("tool kinds follow normalized details and preserve all requested content counters", () => {
  const details: ToolCallDetail[] = [
    { type: "shell", command: "true" }, { type: "read", filePath: "read.ts" },
    { type: "edit", filePath: "edit.ts", oldString: "old", newString: "new" }, { type: "write", filePath: "write.ts", content: "new" },
    { type: "search", query: "local", toolName: "grep" }, { type: "search", query: "online", toolName: "web_search" },
    { type: "fetch", url: "https://example.com" }, { type: "sub_agent", log: "done" }, { type: "plan", text: "plan" },
    { type: "plain_text", text: "other" }, { type: "unknown", input: null, output: null },
    { type: "worktree_setup", worktreePath: "/test", branchName: "test", log: "", commands: [] },
  ];
  const result = extractTurnContent([user(), ...details.map((detail, index) => tool(String(index), detail, "completed", `tool-${index}`))], null);
  assert.deepEqual(result.tools.map(row => row.kind), ["shell", "read", "edit", "edit", "search", "web", "web", "agent", "plan", "other", "other", "other"]);
  assert.equal(result.metrics.toolCalls, 12);
  assert.equal(result.metrics.edits, 2);
  assert.equal(result.metrics.shellCalls, 1);
  assert.equal(result.metrics.webCalls, 2);
  assert.equal(result.metrics.subagentCalls, 1);
  assert.equal(result.metrics.linesAdded, 2);
  assert.equal(result.metrics.linesRemoved, 1);
  assert.deepEqual(statsMetricsSchema.parse(result.metrics), result.metrics);
  for (const row of result.tools) assert.deepEqual(statsToolSchema.parse(row), row);
});

test("each failed status or nonzero shell exit counts exactly one failure", () => {
  const result = extractTurnContent([user(), shell("undefined"), shell("null", null), shell("zero", 0), shell("one", 1), shell("negative", -1),
    shell("failed", 2, "failed"), shell("failed-zero", 0, "failed"), shell("running", 0, "running"), shell("canceled", 0, "canceled"),
    tool("failed-read", { type: "read", filePath: "x" }, "failed"), tool("http", { type: "fetch", url: "https://example.com", code: 500 })], null);
  assert.equal(result.metrics.toolCalls, 11);
  assert.equal(result.metrics.toolFailures, 5);
  assert.equal(result.metrics.errors, 0);
  assert.equal(result.tools.find(row => row.kind === "shell")?.calls, 9);
  assert.equal(result.tools.find(row => row.kind === "shell")?.failures, 4);
});

test("tool names are trimmed and bounded, and counters combine by normalized name and kind", () => {
  const result = extractTurnContent([user(), tool("a", { type: "shell", command: "true" }, "completed", "  run  "),
    tool("b", { type: "shell", command: "false", exitCode: 1 }, "completed", "run"),
    tool("c", { type: "read", filePath: "x" }, "completed", "run"),
    tool("d", { type: "plan", text: "" }, "completed", `  ${"x".repeat(170)}  `),
    tool("e", { type: "unknown", input: null, output: null }, "completed", " \n\t ")], null);
  assert.deepEqual(result.tools, [
    { name: "run", kind: "shell", calls: 2, failures: 1 }, { name: "run", kind: "read", calls: 1, failures: 0 },
    { name: "x".repeat(160), kind: "plan", calls: 1, failures: 0 }, { name: "", kind: "other", calls: 1, failures: 0 },
  ]);
});

test("unified diffs count changed lines including blanks, excluding headers and fallback strings", () => {
  const result = extractTurnContent([user(), tool("diff", { type: "edit", filePath: "x", oldString: "ignored", newString: "ignored",
    unifiedDiff: "diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1,3 +1,3 @@\r\n-old\r\n-\r\n+new\r\n+\r\n unchanged\r\n\\ No newline at end of file\r\n" }),
    tool("empty-diff", { type: "edit", filePath: "x", unifiedDiff: "", oldString: "ignored", newString: "ignored" })], null);
  assert.equal(result.metrics.linesAdded, 2);
  assert.equal(result.metrics.linesRemoved, 2);
  assert.equal(result.metrics.edits, 2);
});

test("old/new and written contents count real lines with empty, trailing newline, CRLF and CR cases", () => {
  const result = extractTurnContent([user(), tool("edit", { type: "edit", filePath: "x", oldString: "old\r\nsecond\r\n", newString: "first\n\nthird" }),
    tool("write", { type: "write", filePath: "y", content: "\n" }), tool("cr", { type: "write", filePath: "z", content: "one\rtwo\r" }),
    tool("empty", { type: "edit", filePath: "empty", oldString: "", newString: "" }), tool("omitted", { type: "write", filePath: "omitted" })], null);
  assert.equal(result.metrics.linesAdded, 6);
  assert.equal(result.metrics.linesRemoved, 2);
  assert.equal(result.metrics.edits, 5);
});

test("each edit/write item has one bounded 20,000-line budget without capping the whole turn", () => {
  const result = extractTurnContent([user(), tool("write", { type: "write", filePath: "write", content: "x\n".repeat(25_000) }),
    tool("replace", { type: "edit", filePath: "replace", oldString: "x\n".repeat(15_000), newString: "x\n".repeat(15_000) }),
    tool("diff", { type: "edit", filePath: "diff", unifiedDiff: "--- a/x\n+++ b/x\n" + "-old\n+new\n".repeat(15_000) })], null);
  assert.equal(result.metrics.linesAdded, 35_000);
  assert.equal(result.metrics.linesRemoved, 25_000);
  assert.equal(result.metrics.linesAdded + result.metrics.linesRemoved, 60_000);
});

test("changed files are distinct edit/write paths in the delta and reset between calls", () => {
  const before = [user("before", "before"), tool("old", { type: "write", filePath: "old", content: "a" }), assistant("before", "anchor")];
  const result = extractTurnContent([...before, user(), tool("edit", { type: "edit", filePath: "x", newString: "one" }),
    tool("write", { type: "write", filePath: "x", content: "two" }), tool("other", { type: "write", filePath: "y" }, "failed"),
    tool("read", { type: "read", filePath: "read-only" }), tool("blank", { type: "write", filePath: "" })], "msg:anchor");
  assert.equal(result.metrics.filesChanged, 2);
  assert.equal(result.metrics.edits, 4);
  assert.equal(extractTurnContent([user(), tool("again", { type: "write", filePath: "x" })], null).metrics.filesChanged, 1);
});

test("errors include error notifications and only completed compactions count", () => {
  const result = extractTurnContent([user(), { type: "error", message: "error" }, { type: "notification", level: "error", message: "error" },
    { type: "notification", level: "warning", message: "warning" }, { type: "notification", level: "info", message: "info" },
    { type: "compaction", status: "loading" }, { type: "compaction", status: "completed" },
    { type: "reasoning", text: "thinking" }, { type: "todo", items: [] }, { type: "plugin", id: "id", pluginId: "p", kind: "k", version: 1, data: null }], null);
  assert.equal(result.metrics.errors, 2);
  assert.equal(result.metrics.compactions, 1);
  assert.equal(result.metrics.userMessages, 1);
  assert.equal(result.metrics.assistantMessages, 0);
  assert.equal(result.metrics.toolCalls, 0);
});

test("extraction does not mutate the timeline or its nested tool details", () => {
  const item = tool("immutable", { type: "edit", filePath: "x", oldString: "a", newString: "b" });
  Object.freeze(item.detail); Object.freeze(item);
  const timeline = Object.freeze([Object.freeze(user()), item]);
  const serialized = JSON.stringify(timeline);
  const result = extractTurnContent(timeline, null);
  assert.equal(result.metrics.edits, 1);
  assert.equal(JSON.stringify(timeline), serialized);
});

test("Paseo 0.13 windows: row positions keep keys stable between reads, and a turn longer than the window still counts", () => {
  const notice = (text: string): AgentTimelineItem => ({ type: "error", message: text } as AgentTimelineItem);
  // Turn 1 read as rows 10..12; its last row has no id, so its key carries the row's sequence number.
  const first = extractTurnContent([user("go"), shell("a"), notice("boom")], null, { positions: [10, 11, 12] });
  assert.equal(first.metrics.toolCalls, 1);
  // Turn 2's window starts elsewhere (rows 11..15), yet the marker is found at row 12: only the new rows count.
  const second = extractTurnContent([shell("a"), notice("boom"), user("next"), shell("b"), assistant("ok")], first.lastKey, { positions: [11, 12, 13, 14, 15] });
  assert.equal(second.metrics.userMessages, 1);
  assert.equal(second.metrics.toolCalls, 1);
  assert.equal(second.metrics.errors, 0, "the old error is not counted again");
  // A long autonomous turn whose window reaches neither the marker nor a user message: what was read counts.
  const long = extractTurnContent([shell("x"), shell("y")], "msg:gone", { positions: [500, 501], partial: true });
  assert.equal(long.metrics.toolCalls, 2);
  assert.equal(extractTurnContent([shell("x"), shell("y")], "msg:gone").metrics.toolCalls, 0, "a whole conversation without an anchor still counts nothing");
});

test("a schedule's prompt and another agent's message start a turn and are not counted as tools (Paseo 0.14)", () => {
  const heartbeat = { type: "tool_call", callId: "paseo-system:3f2a", name: "heartbeat", status: "completed", error: null, detail: { type: "plain_text", text: "Schedule fired" } } as unknown as AgentTimelineItem;
  const message = { type: "tool_call", callId: "paseo-agent-message:m1", name: "agent_message", status: "completed", error: null, detail: { type: "plain_text", text: "done" }, agentMessage: { event: "finished", sender: { id: "c" }, text: "done" } } as unknown as AgentTimelineItem;
  const fresh = extractTurnContent([user("old"), assistant("old"), heartbeat, shell("s1"), assistant("checked")], null);
  assert.equal(fresh.metrics.toolCalls, 1, "first sight starts at the heartbeat, which is no tool");
  assert.equal(fresh.metrics.userMessages, 0);
  assert.deepEqual(fresh.tools.map(item => item.name), ["shell"]);
  const after = extractTurnContent([user("old"), assistant("old", "a1"), message, shell("s2"), assistant("ok")], "msg:a1");
  assert.equal(after.metrics.toolCalls, 1);
  assert.deepEqual(after.tools.map(item => item.name), ["shell"]);
});
