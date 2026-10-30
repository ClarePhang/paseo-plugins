import assert from "node:assert/strict";
import test from "node:test";
import { AttentionIndex, askOf, noteOf, todoOf } from "../server/attention";
import { applyLiveExtras, attentionPhase, clockLabel, getLiveExtras, reasonLine, reasonText } from "../shared/attention";
import { normalizeAgent } from "../shared/model";

const T = "2026-10-11T04:00:00.000Z";

test("one-line reasons say what each waiting Agent wants, without a model", () => {
  const question = normalizeAgent({ id: "q", status: "running", pendingPermissions: [{ id: "1", kind: "question", input: { questions: [{ question: "合并到 main 吗？", options: [{ label: "合并" }, { label: "先不合" }] }] } }] });
  assert.equal(attentionPhase(question), "question");
  assert.equal(reasonLine(question)?.text, "问你：合并到 main 吗？（合并 / 先不合）");
  const plan = normalizeAgent({ id: "p", status: "running", pendingPermissions: [{ id: "1", kind: "plan", input: { plan: "# 拆分存储层" } }] });
  assert.equal(reasonLine(plan)?.text, "计划待批：拆分存储层");
  const tool = normalizeAgent({ id: "t", status: "running", pendingPermissions: [{ id: "1", kind: "tool", name: "Bash", detail: { type: "shell", command: "npm test" } }, { id: "2", kind: "tool", name: "Edit" }] });
  assert.equal(reasonLine(tool)?.text, "要执行：npm test（共 2 项）");
  const failed = normalizeAgent({ id: "e", status: "error", lastError: "spawn ENOENT\n    at x" });
  assert.equal(reasonLine(failed)?.text, "出错：spawn ENOENT");
  const quota = { ...normalizeAgent({ id: "l", status: "idle" }), status: "completed" as const, stop: { kind: "quota" as const, resetAt: null, at: T } };
  assert.equal(reasonLine(quota)?.text, "额度用尽 · 恢复时间未知");
  assert.equal(reasonText({ phase: "idle", note: "要不要我也更新 README？" }).text, "在问你：要不要我也更新 README？");
  assert.equal(reasonLine(normalizeAgent({ id: "r", status: "running" })), null);
});

test("clock labels use the device's day boundaries", () => {
  const now = new Date(2026, 9, 10, 21, 0).getTime();
  assert.equal(clockLabel(new Date(2026, 9, 10, 23, 5).getTime(), now), "23:05");
  assert.equal(clockLabel(new Date(2026, 9, 11, 5, 2).getTime(), now), "明天 05:02");
  assert.equal(clockLabel(new Date(2026, 9, 13, 9, 30).getTime(), now), "10月13日 09:30");
});

test("todo progress and notes: counts, the step in progress, one redacted line", () => {
  assert.deepEqual(todoOf([{ type: "todo", items: [{ text: "读代码", completed: true }, { text: "跑测试", completed: false, status: "in_progress", activeForm: "正在跑测试" }, { text: "提交", completed: false }] }], T),
    { done: 1, total: 3, current: "正在跑测试", at: T });
  assert.equal(todoOf([{ type: "assistant_message", text: "x" }], T), null);
  assert.equal(noteOf("改好了。\n\n要不要发版？"), "改好了。 要不要发版？");
  // Built at runtime: a literal token-shaped string would trip secret scanners on the published source.
  const token = `${"gh"}p_${"a1B2".repeat(9)}`;
  assert.equal(noteOf(`token=${token} done`)?.includes(token), false, "credentials are masked");
  // A note older than the latest prompt is about an earlier turn.
  const agent = normalizeAgent({ id: "a", status: "idle", lastUserMessageAt: "2026-10-11T03:00:00.000Z" });
  assert.equal(applyLiveExtras([agent], [{ agentId: "a", todo: null, note: "旧的", noteAt: "2026-10-11T02:00:00.000Z" }])[0]!.note, undefined);
  assert.equal(applyLiveExtras([agent], [{ agentId: "a", todo: null, note: "新的", noteAt: "2026-10-11T03:01:00.000Z" }])[0]!.note, "新的");
});

function fakeHost(agents: Array<Record<string, unknown>>) {
  const events: Array<{ update(message: unknown): void }> = [];
  const subscription = { subscribe(observer: { snapshot(value: unknown): void }) { observer.snapshot({ entries: [] }); return () => {}; }, release: async () => {} };
  const paseo = {
    agents: {
      list: async (options: { subscribe?: unknown; filter?: { requiresAttention?: boolean } }) => options.subscribe ? { entries: [], pageInfo: { nextCursor: null, hasMore: false }, subscription }
        : { entries: agents.filter(agent => !options.filter?.requiresAttention || agent.requiresAttention).map(agent => ({ agent })), pageInfo: { nextCursor: null, hasMore: false } },
      ref: () => ({ timeline: { refetch: async () => ({ rows: [] }) } }),
    },
    observeEvents: () => ({ subscribe(observer: { update(message: unknown): void }) { events.push(observer); return () => {}; }, release: async () => {} }),
  };
  return { paseo: paseo as never, emit: (message: unknown) => events.forEach(observer => observer.update(message)) };
}

test("the server summary uses the page's rules: blocking first, oldest first, snoozes and subagents honoured", async () => {
  const host = fakeHost([
    { id: "unread", title: "跑完了", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-10-11T01:00:00.000Z", updatedAt: "2026-10-11T01:00:00.000Z", lastUserMessageAt: "2026-10-11T00:50:00.000Z" },
    { id: "ask", title: "要审批", status: "running", pendingPermissions: [{ id: "1", kind: "tool", name: "Bash" }], updatedAt: "2026-10-11T03:00:00.000Z" },
    { id: "child", title: "子任务", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-10-11T00:30:00.000Z", labels: { "paseo.parent-agent-id": "lead" }, updatedAt: "2026-10-11T00:30:00.000Z" },
    { id: "seen-error", title: "看过的失败", status: "error", requiresAttention: false, updatedAt: "2026-10-11T00:10:00.000Z" },
    { id: "insight", title: "分析", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: T, labels: { "observatory.role": "insight" }, updatedAt: T },
    { id: "done", title: "已读", status: "idle", requiresAttention: false, updatedAt: T },
  ]);
  let snoozes: Array<{ agentId: string; completionAt: string; until: string }> = [];
  const index = new AttentionIndex({
    telemetry: async () => ({ startedAt: T, persistenceError: null, agents: [], events: [] }), background: () => [], isLive: () => false,
    receipts: async () => ({ receipts: [], archiveOrigins: [] }), preferences: async () => ({ snoozes, settings: { childCompletions: false } }),
    scheduleFailures: async () => 2,
  }, { now: () => Date.parse(T) });
  await index.attach(host.paseo);
  const first = await index.read();
  assert.equal(first.mode, "full");
  if (first.mode !== "full") return;
  assert.equal(first.count, 2); assert.equal(first.blocking, 1); assert.equal(first.scheduleFailures, 2); assert.equal(first.ready, true);
  assert.equal(first.failed, false); assert.equal(first.loud, 0);
  assert.deepEqual(first.entries.map(entry => [entry.agentId, entry.phase]), [["ask", "approval"], ["unread", "unread"]]);
  assert.equal((await index.read({ revision: first.revision })).mode, "unchanged");
  snoozes = [{ agentId: "unread", completionAt: "2026-10-11T01:00:00.000Z", until: "2026-10-11T05:00:00.000Z" }];
  const snoozed = await index.read({ revision: first.revision });
  assert.equal(snoozed.mode === "full" && snoozed.count, 1, "a snoozed result waits");
  // The host's attention note reaches the live extras (memory only).
  host.emit({ type: "agent_attention_required", payload: { agentId: "unread", reason: "finished", timestamp: T, shouldNotify: true, notification: { title: "x", body: "发版完成，要不要通知团队？" } } });
  const extras = await index.readExtras();
  assert.deepEqual(extras.mode === "full" && extras.agents, [{ agentId: "unread", todo: null, note: "发版完成，要不要通知团队？", noteAt: T, ask: null, askAt: null, issue: null }]);
  // A later request's note is not a result: it never replaces the finished turn's note.
  host.emit({ type: "agent_attention_required", payload: { agentId: "unread", reason: "permission", timestamp: T, shouldNotify: true, notification: { title: "x", body: "要执行 rm -rf dist" } } });
  const after = await index.readExtras();
  assert.equal(after.mode === "full" && after.agents[0]!.note, "发版完成，要不要通知团队？");
  index.close();
});

test("a failed directory read is reported, and failures beyond the first 8 entries still turn the badge red", async () => {
  const many = Array.from({ length: 9 }, (_, index) => ({ id: `ask-${index}`, title: `审批 ${index}`, status: "running", pendingPermissions: [{ id: "1", kind: "tool", name: "Bash" }], updatedAt: T }));
  const host = fakeHost([...many, { id: "broke", title: "失败", status: "error", requiresAttention: true, attentionReason: "error", attentionTimestamp: T, updatedAt: T }]);
  const index = new AttentionIndex({
    telemetry: async () => ({ startedAt: T, persistenceError: null, agents: [], events: [] }), background: () => [], isLive: () => false,
    receipts: async () => ({ receipts: [], archiveOrigins: [] }), preferences: async () => ({ snoozes: [], settings: { childCompletions: false } }),
  }, { now: () => Date.parse(T) });
  await index.attach(host.paseo);
  const read = await index.read();
  assert.equal(read.mode === "full" && read.count, 10);
  assert.equal(read.mode === "full" && read.entries.length, 8);
  assert.equal(read.mode === "full" && read.entries.some(entry => entry.phase === "error"), false, "the error is not among the first 8");
  assert.equal(read.mode === "full" && read.loud, 1);
  index.close();

  const broken = fakeHost([]);
  (broken.paseo as { agents: { list: unknown } }).agents.list = async () => { throw new Error("daemon busy"); };
  const failing = new AttentionIndex({
    telemetry: async () => ({ startedAt: T, persistenceError: null, agents: [], events: [] }), background: () => [], isLive: () => false,
    receipts: async () => ({ receipts: [], archiveOrigins: [] }), preferences: async () => ({ snoozes: [], settings: { childCompletions: false } }),
  }, { now: () => Date.parse(T) });
  await failing.attach(broken.paseo);
  const failed = await failing.read();
  assert.equal(failed.mode === "full" && failed.ready, false, "never read: not ready, so no 「没有需要处理的会话」");
  assert.equal(failed.mode === "full" && failed.failed, true);
  failing.close();
});

test("the sentence a reply's quick replies answer: memory only, redacted, forgotten by a new turn or a newer prompt (P2-1)", async () => {
  const host = fakeHost([{ id: "a", title: "发布", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: T, updatedAt: T, lastUserMessageAt: "2026-10-11T03:50:00.000Z" }]);
  const index = new AttentionIndex({
    telemetry: async () => ({ startedAt: T, persistenceError: null, agents: [], events: [] }), background: () => [], isLive: () => false,
    receipts: async () => ({ receipts: [], archiveOrigins: [] }), preferences: async () => ({ snoozes: [], settings: { childCompletions: false } }),
  }, { now: () => Date.parse(T) });
  try {
    await index.attach(host.paseo);
    // Built at runtime: a literal token-shaped string would trip secret scanners on the published source.
    const token = `${"gh"}p_${"a1B2".repeat(9)}`;
    index.noteAsk("a", `要我用 token=${token} 把改动推到 main 吗？`, T);
    const read = await index.readExtras(), [extra] = read.mode === "full" ? read.agents : [];
    assert.equal(extra!.ask?.includes(token), false, "credentials are masked before the sentence leaves the server");
    assert.match(extra!.ask!, /^要我用 token=.*推到 main 吗？$/);
    assert.equal(extra!.askAt, T);
    assert.equal(getLiveExtras.output.safeParse({ mode: "full", unchanged: false, revision: "r", agents: index.extras() }).success, true);
    // One line, at most 120 characters, whatever it was given.
    assert.equal(askOf(`接下来  我会\n${"整理".repeat(80)}`)!.length, 120);
    assert.equal(askOf("  "), null);
    // A new turn forgets it, as does a turn whose reply invites nothing; a reload starts with none.
    index.turnStarted("a");
    assert.deepEqual(index.extras(), []);
    index.noteAsk("a", "要我继续吗？", T); index.noteAsk("a", null, T);
    assert.deepEqual(index.extras(), []);
    // A sentence older than the Agent's latest prompt is about an earlier turn.
    const agent = normalizeAgent({ id: "a", status: "idle", lastUserMessageAt: "2026-10-11T03:00:00.000Z" });
    assert.equal(applyLiveExtras([agent], [{ agentId: "a", todo: null, note: null, noteAt: null, ask: "要我继续吗？", askAt: "2026-10-11T02:59:00.000Z" }])[0]!.replyAsk, undefined);
    assert.equal(applyLiveExtras([agent], [{ agentId: "a", todo: null, note: null, noteAt: null, ask: "要我继续吗？", askAt: "2026-10-11T03:01:00.000Z" }])[0]!.replyAsk, "要我继续吗？");
    // An older server sends no sentence: it parses, as none.
    assert.deepEqual(getLiveExtras.output.parse({ mode: "full", unchanged: false, revision: "r", agents: [{ agentId: "a", todo: null, note: null, noteAt: null }] }),
      { mode: "full", unchanged: false, revision: "r", agents: [{ agentId: "a", todo: null, note: null, noteAt: null, ask: null, askAt: null, issue: null }] });
  } finally { index.close(); }
});

test("a quoted sentence of 120 characters fits the RPCs whatever the characters (emoji take two UTF-16 units)", () => {
  const ask = askOf("🚀".repeat(200))!;
  assert.equal(Array.from(ask).length, 120);
  assert.equal(getLiveExtras.output.safeParse({ mode: "full", unchanged: false, revision: "r", agents: [{ agentId: "a", todo: null, note: null, noteAt: null, ask, askAt: T }] }).success, true);
});
