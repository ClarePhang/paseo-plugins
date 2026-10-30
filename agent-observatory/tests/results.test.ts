import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { fetchAgentResult, recognizeTestCommands, registerResults } from "../server/results";
import { applyTelemetry, normalizeAgent, sameResultSource, type AgentSource } from "../shared/model";
import type { AgentTelemetry } from "../shared/telemetry";
const stamp = "2026-09-17T00:01:00Z";
const row = (seq: number, type: string, text: string) => ({ seqStart: seq, seqEnd: seq, timestamp: stamp, item: { type, text } });
function api(head: unknown[], tail: unknown[], minSeq = 1, running = false) {
  const agent = { id: "agent", status: running ? "running" : "idle", attentionReason: "finished", attentionTimestamp: stamp, lastUserMessageAt: stamp, activeTurn: running ? { turnId: "active" } : null };
  const calls: unknown[] = [];
  return { calls, value: { agents: { ref: () => ({ refresh: async () => ({ agent }), current: () => agent, timeline: { refetch: async (options: { direction: string }) => { calls.push(options); return { epoch: "epoch", rows: options.direction === "after" ? head : tail, window: { minSeq }, hasOlder: false, hasNewer: false }; } } }) } } as unknown as PaseoApi };
}
test("first original input is read from head independently of the latest execution window", async () => {
  const fixture = api([row(1, "user_message", "Original request")], [row(1000, "user_message", "Latest request"), row(1001, "assistant_message", "Latest result")]);
  const result = await fetchAgentResult(fixture.value, "agent");
  assert.equal(result.firstInput?.text, "Original request"); assert.equal(result.firstInput?.completeOrigin, true);
  assert.equal(result.latestUserInput?.text, "Latest request"); assert.equal(result.latestReply?.text, "Latest result"); assert.equal(result.isFinal, true);
  assert.deepEqual(fixture.calls, [{ direction: "after", limit: 100, projection: "projected" }, { direction: "tail", limit: 100, projection: "projected" }]);
});
test("retained history start and running commentary are never mislabeled original or final", async () => {
  const fixture = api([row(20, "user_message", "Oldest retained")], [row(30, "user_message", "Now"), row(31, "assistant_message", "Working")], 20, true);
  const result = await fetchAgentResult(fixture.value, "agent");
  assert.equal(result.firstInput?.completeOrigin, false); assert.equal(result.coverage.firstInputConfirmed, false); assert.equal(result.isFinal, false); assert.equal(result.isRunning, true);
});
test("file and test evidence retain real tool references without manufacturing success", async () => {
  const head = [row(1, "user_message", "Build it")];
  const tail = [...head, { ...row(2, "tool_call", ""), item: { type: "tool_call", name: "write_file", status: "completed", detail: { type: "write", filePath: "/repo/output.ts" } } },
    { ...row(3, "tool_call", ""), item: { type: "tool_call", name: "exec_command", status: "running", detail: { command: "npm test", output: "Testing…" } } }, row(4, "assistant_message", "Result https://example.com/report")];
  const result = await fetchAgentResult(api(head, tail).value, "agent");
  assert.equal(result.artifacts[0].path, "/repo/output.ts"); assert.equal(result.artifacts[0].ref, "agent:epoch:2-2");
  assert.equal(result.testEvidence[0].outcome, "unknown"); assert.equal(result.metrics.changedFiles, 1);
});

test("current-turn sequence proof keeps a final reply even when row timestamps are absent", async () => {
  const head = [row(1, "user_message", "First")];
  const fixture = api(head, [{ ...row(10, "user_message", "Current"), timestamp: "" }, { ...row(11, "assistant_message", "Result without timestamp"), timestamp: "" }]);
  const result = await fetchAgentResult(fixture.value, "agent");
  assert.equal(result.latestReply?.text, "Result without timestamp"); assert.equal(result.isFinal, true);
});

test("a newer host user turn prevents a stale tail reply from becoming the current final result", async () => {
  const head = [row(1, "user_message", "First")];
  const old = "2026-09-16T23:00:00Z";
  const fixture = api(head, [{ ...row(10, "user_message", "Previous request"), timestamp: old }, { ...row(11, "assistant_message", "Previous result"), timestamp: old }]);
  const result = await fetchAgentResult(fixture.value, "agent");
  assert.equal(result.latestReply, null); assert.equal(result.latestUserInput, null); assert.equal(result.isFinal, false);
});

test("a prompt row stamped a millisecond before the Agent's lastUserMessageAt is the same turn: its reply is shown", async () => {
  const head = [row(1, "user_message", "整理发布说明")];
  const fixture = api(head, [{ ...row(1, "user_message", "整理发布说明"), timestamp: "2026-09-17T00:00:59.999Z" }, row(8, "assistant_message", "已更新发布说明。")]);
  const result = await fetchAgentResult(fixture.value, "agent");
  assert.equal(result.latestReply?.text, "已更新发布说明。"); assert.equal(result.isFinal, true);
});

test("result source versions are returned and explicit stale tokens fail before reading history", async () => {
  const fixture = api([row(1, "user_message", "First")], [row(10, "user_message", "Latest"), row(11, "assistant_message", "Answer")]);
  const result = await fetchAgentResult(fixture.value, "agent", null, { expectedLastUserMessageAt: stamp, expectedAttentionTimestamp: stamp });
  assert.deepEqual(result.source, { lastUserMessageAt: stamp, attentionTimestamp: stamp, completionAt: stamp, roundEndedAt: null }, "one turn: the host's stamp is the completion, no round of its own");
  const requests = fixture.calls.length;
  await assert.rejects(fetchAgentResult(fixture.value, "agent", null, { expectedLastUserMessageAt: "2026-09-16T00:00:00Z", expectedAttentionTimestamp: stamp }), /版本已变化/);
  assert.equal(fixture.calls.length, requests);
});

test("a completion changing during timeline reads is rejected by the final source check", async () => {
  let refreshes = 0;
  const agent = { id: "agent", status: "idle", lastUserMessageAt: stamp, attentionReason: "finished", attentionTimestamp: stamp };
  const changing = { agents: { ref: () => ({ refresh: async () => ({ agent: { ...agent, attentionTimestamp: ++refreshes === 1 ? stamp : "2026-09-17T00:02:00Z" } }),
    timeline: { refetch: async () => ({ epoch: "one", window: { minSeq: 1 }, rows: [row(1, "user_message", "Request"), row(2, "assistant_message", "Answer")], hasOlder: false, hasNewer: false }) } }) } } as unknown as PaseoApi;
  await assert.rejects(fetchAgentResult(changing, "agent", null, { expectedLastUserMessageAt: stamp, expectedAttentionTimestamp: stamp }), /版本已变化/);
  assert.equal(refreshes, 2);
});

test("quoted source and heredoc bodies never masquerade as executed test commands", () => {
  assert.equal(recognizeTestCommands("python3 - <<'PY'\ncontent = 'npm run typecheck'\nprint(content)\nPY"), null);
  assert.equal(recognizeTestCommands(`python3 -c "print('npm run typecheck')"`), null);
  assert.equal(recognizeTestCommands(`echo "pytest && npm test"`), null);
  assert.equal(recognizeTestCommands(`node -e "console.log('npx vitest')"`), null);
  assert.deepEqual(recognizeTestCommands("pytest -q"), { command: "pytest -q", safeSuccess: true, safeFailure: true });
  assert.deepEqual(recognizeTestCommands("npx vitest run"), { command: "npx vitest run", safeSuccess: true, safeFailure: true });
  assert.deepEqual(recognizeTestCommands("cd /repo && npm run typecheck && npx vitest run"), { command: "npm run typecheck && npx vitest run", safeSuccess: true, safeFailure: false });
});

test("masked shell exits do not prove success and the latest twenty real tests take priority", async () => {
  const head = [row(1, "user_message", "Verify")];
  const tool = (seq: number, command: string, status = "completed", exitCode = 0) => ({ ...row(seq, "tool_call", ""), item: { type: "tool_call", callId: `test-${seq}`, name: "exec_command", status, detail: { command, exitCode, output: "command output" } } });
  const snapshot = await fetchAgentResult(api(head, [...head,
    tool(2, "pytest || true"), tool(3, "npm test; echo done"), tool(4, "pytest -q", "failed", 1), tool(5, "npx vitest run"),
    tool(6, "python3 - <<'PY'\ns = 'npm test'\nPY"), row(7, "assistant_message", "Checked")]).value, "agent");
  assert.deepEqual(snapshot.testEvidence.map(item => [item.command, item.outcome]), [
    ["npx vitest run", "passed"], ["pytest -q", "failed"], ["npm test", "unknown"], ["pytest", "unknown"],
  ]);
  const many = await fetchAgentResult(api(head, [...head, ...Array.from({ length: 25 }, (_, index) => tool(index + 2, `pytest test_${index}.py`)), row(40, "assistant_message", "Done")]).value, "agent");
  assert.equal(many.testEvidence.length, 20);
  assert.equal(many.testEvidence[0].command, "pytest test_24.py");
  assert.equal(many.testEvidence.at(-1)?.command, "pytest test_5.py");
});
test("polled results short-circuit while nothing but the capture time changed", async () => {
  const handlers = new Map<string, (input: unknown, context: { paseo: PaseoApi }) => Promise<unknown>>();
  const server = { handle(contract: { name: string }, handler: (input: unknown, context: { paseo: PaseoApi }) => Promise<unknown>) { handlers.set(contract.name, handler); return () => {}; },
    on() { return () => {}; } } as unknown as Parameters<typeof registerResults>[0];
  const remove = registerResults(server);
  let tail = [row(10, "user_message", "Request"), row(11, "assistant_message", "Working")];
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { id: "agent", status: "running", lastUserMessageAt: stamp, activeTurn: { turnId: "t" } } }), current: () => null,
    timeline: { refetch: async (options: { direction: string }) => ({ epoch: "e", rows: options.direction === "after" ? [row(1, "user_message", "Original")] : tail, window: { minSeq: 1 }, hasOlder: false, hasNewer: false }) } }) } } as unknown as PaseoApi;
  try {
    const read = handlers.get("observatory.results.get")!;
    const first = await read({ agentId: "agent" }, { paseo }) as { mode: string; revision: string };
    assert.equal(first.mode, "full");
    await new Promise(resolve => setTimeout(resolve, 5));
    const same = await read({ agentId: "agent", revision: first.revision }, { paseo }) as { mode: string };
    assert.equal(same.mode, "unchanged");
    tail = [...tail, row(12, "assistant_message", "Done")];
    await new Promise(resolve => setTimeout(resolve, 5_050));
    const changed = await read({ agentId: "agent", revision: first.revision }, { paseo }) as { mode: string; latestReply: { text: string } };
    assert.equal(changed.mode, "full"); assert.match(changed.latestReply.text, /Done/);
  } finally { remove(); }
});

test("opening a stopped session records whether its final reply asks the user (and what it invites), without passing the text on", async () => {
  const seen: unknown[] = [];
  const asking = api([row(1, "user_message", "修一下")], [row(1, "user_message", "修一下"), row(2, "assistant_message", "改好了。要不要现在发版？")]);
  await fetchAgentResult(asking.value, "agent", null, {}, reply => seen.push(reply));
  // 「要不要现在发版？」 asks to go ahead with something specific: 快捷回复 offers 继续 (opus-B26); only the category leaves.
  // A copy: asserting on `seen` itself would narrow its type for the pushes below.
  assert.deepEqual([...seen], [{ userAt: new Date(stamp).toISOString(), at: new Date(stamp).toISOString(), asks: true, nudge: "go-ahead" }]);
  const running = api([row(1, "user_message", "修一下")], [row(1, "user_message", "修一下"), row(2, "assistant_message", "还在跑")], 1, true);
  await fetchAgentResult(running.value, "agent", null, {}, reply => seen.push(reply));
  assert.equal(seen.length, 1, "a running turn has no final reply yet");
  const linked = api([row(1, "user_message", "提个 MR")], [row(1, "user_message", "提个 MR"), row(2, "assistant_message", "已提交：https://git.example.com/team/app/-/merge_requests/42 ，等你合并。")]);
  await fetchAgentResult(linked.value, "agent", null, {}, reply => seen.push(reply));
  assert.deepEqual(seen.at(-1), { userAt: new Date(stamp).toISOString(), at: new Date(stamp).toISOString(), asks: false, nudge: null, link: { url: "https://git.example.com/team/app/-/merge_requests/42", label: "!42", kind: "mr" } },
    "only the link to the merge request leaves the reply");
});

// codex-obs-attn-F1: a heartbeat starts its turn with a system notification (no user message: lastUserMessageAt stays T0) and,
// while the first result is unread, the host's attention keeps T1. Results of both rounds used to carry the same source.
const [r0, r1, r2, r3] = [0, 1, 2, 3].map(hour => `2026-10-12T0${hour}:00:00.000Z`);
const beat = { id: "beat", status: "idle", createdAt: "2026-10-11T23:00:00.000Z", lastUserMessageAt: r0, requiresAttention: true, attentionReason: "finished", attentionTimestamp: r1, activeTurn: null, pendingPermissions: [] };
const observedTurn = (turnStartedAt: string, turnEndedAt: string | null): AgentTelemetry => ({ agentId: "beat", turnStartedAt, turnEndedAt, outcome: turnEndedAt ? "completed" : null,
  completedTurns: 2, failedTurns: 0, canceledTurns: 0, totalRunMs: 0, permissionWaitMs: 0 });
function beatApi(reply: () => string) {
  let reads = 0;
  const rows = () => [{ seqStart: 1, seqEnd: 1, timestamp: r0, item: { type: "user_message", text: "每小时检查一次构建" } }, { seqStart: 2, seqEnd: 2, timestamp: r3, item: { type: "assistant_message", text: reply() } }];
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: beat }), current: () => beat,
    timeline: { refetch: async () => { reads++; return { epoch: "e", window: { minSeq: 1 }, rows: rows(), hasOlder: false, hasNewer: false }; } } }) } } as unknown as PaseoApi;
  return { paseo, reads: () => reads };
}

test("a heartbeat's result names its own turn though the host's tokens stay; an earlier round's fails the later round's check (codex-obs-attn-F1)", async () => {
  const { paseo } = beatApi(() => "构建正常");
  const expected = { expectedLastUserMessageAt: r0, expectedAttentionTimestamp: r1 };
  const first = await fetchAgentResult(paseo, "beat", observedTurn("2026-10-12T00:00:00.020Z", "2026-10-12T01:00:00.005Z"), expected);
  const second = await fetchAgentResult(paseo, "beat", observedTurn(r2, r3), expected);
  assert.deepEqual(first.source, { lastUserMessageAt: r0, attentionTimestamp: r1, completionAt: r1, roundEndedAt: null });
  assert.deepEqual(second.source, { lastUserMessageAt: r0, attentionTimestamp: r1, completionAt: r3, roundEndedAt: r3 });
  // The page's record of round 2, derived as the dashboard does: only its own result passes 标记已读's check.
  const page = applyTelemetry(normalizeAgent(beat as unknown as AgentSource), observedTurn(r2, r3));
  assert.deepEqual([sameResultSource(page, first.source), sameResultSource(page, second.source)], [false, true]);
  // Read while the heartbeat's turn has not been seen ending: no completion, which no finished round's record shows.
  const open = await fetchAgentResult(paseo, "beat", observedTurn(r2, null), expected);
  assert.deepEqual([open.source?.completionAt, open.source?.roundEndedAt], [null, null]);
  assert.equal(sameResultSource(page, open.source), false);
});

test("the server never serves a result cached for one turn for a heartbeat's next turn, whose request is the same (codex-obs-attn-F1)", async () => {
  const handlers = new Map<string, (input: unknown, context: { paseo: PaseoApi }) => Promise<unknown>>();
  // No turn hooks reach this cache here: the observed turn alone keys it (a hook can also run before telemetry records the end).
  const server = { handle(contract: { name: string }, handler: (input: unknown, context: { paseo: PaseoApi }) => Promise<unknown>) { handlers.set(contract.name, handler); return () => {}; },
    on() { return () => {}; } } as unknown as Parameters<typeof registerResults>[0];
  let observed = observedTurn("2026-10-12T00:00:00.020Z", "2026-10-12T01:00:00.005Z"), reply = "第一轮：构建正常";
  const remove = registerResults(server, async () => observed);
  const { paseo, reads } = beatApi(() => reply);
  try {
    const read = handlers.get("observatory.results.get")!, input = { agentId: "beat", expectedLastUserMessageAt: r0, expectedAttentionTimestamp: r1 };
    const first = await read(input, { paseo }) as { source: { completionAt: string }; latestReply: { text: string } };
    const cached = reads();
    assert.deepEqual([first.source.completionAt, first.latestReply.text], [r1, "第一轮：构建正常"]);
    await read(input, { paseo });
    assert.equal(reads(), cached, "the same turn within five seconds: cached");
    observed = observedTurn(r2, r3); reply = "第二轮：发现一个失败用例";
    const second = await read(input, { paseo }) as { source: { completionAt: string; roundEndedAt: string }; latestReply: { text: string } };
    assert.ok(reads() > cached, "read again");
    assert.deepEqual([second.source.completionAt, second.source.roundEndedAt, second.latestReply.text], [r3, r3, "第二轮：发现一个失败用例"]);
  } finally { remove(); }
});

test("a schedule's prompt starts the latest turn (Paseo 0.14 records it as a tool call): its reply is current and it is no tool", async () => {
  const head = [row(1, "user_message", "Watch the build")];
  const heartbeat = { ...row(3, "tool_call", ""), item: { type: "tool_call", callId: "paseo-system:3f2a", name: "heartbeat", status: "completed", detail: { type: "plain_text", text: "Schedule \"nightly\" fired.\ncheck the build" } } };
  const shell = { ...row(4, "tool_call", ""), item: { type: "tool_call", callId: "c1", name: "exec_command", status: "completed", detail: { type: "shell", command: "ls", exitCode: 0 } } };
  const result = await fetchAgentResult(api(head, [...head, row(2, "assistant_message", "Watching"), heartbeat, shell, row(5, "assistant_message", "Build is green")]).value, "agent");
  assert.equal(result.latestUserInput?.text, "Schedule \"nightly\" fired.\ncheck the build");
  assert.equal(result.latestReply?.text, "Build is green");
  assert.equal(result.metrics.tools, 1);
  assert.equal(result.metrics.userTurns, 1);
});
