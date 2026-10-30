import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import type { InsightJob, InsightReport } from "../shared/insights";
import { suggestionJobSchema, type SuggestionJob, type SuggestionReport } from "../shared/insight-overview";
import type { SessionTrajectory } from "../shared/trajectory";
import { InsightManager, type InsightManagerOptions } from "../server/insights";
import { InsightStorage } from "../server/insight-storage";

const epoch = Date.parse("2026-09-23T12:00:00Z");
const at = new Date(epoch).toISOString();
const report: InsightReport = { summary: "实现已完成，验证流程有可复用之处", health: "watch", confidence: "high",
  findings: [{ id: "f1", severity: "medium", category: "quality", title: "补齐验证", detail: "缺少回归检查", evidence: ["r3"], recommendation: "新增回归检查" }], strengths: ["变更有明确范围"], nextActions: [], limitations: [] };
const suggestion: SuggestionReport = { headline: "统一跨项目的验证入口", summary: "多个会话均可改进验证流程", themes: [],
  actions: [{ id: "action1", title: "补齐验证入口", why: "减少重复检查", steps: ["确认各项目的检查命令"], scope: "workflow", impact: "high", effort: "small",
    projects: [], evidence: ["R1#f1"], instruction: "完成变更后执行项目规定的验证命令，并报告结果。", task: null }], wins: [], watch: [] };
const seed = (id: string, index = 0): InsightJob => ({ id, agentId: id, agentTitle: id, projectName: "Project", createdAt: new Date(epoch - 3600000 - index * 1000).toISOString(), updatedAt: new Date(epoch - 3600000 - index * 1000).toISOString(),
  status: "completed", trigger: "manual", stage: "完成", eligibility: null, coverage: null, report, model: "grok-4.7", effort: "xhigh", usage: null, error: null });
const trajectory = (id: string): SessionTrajectory => ({ agent: { id, title: id, cwd: "/repo", workspaceId: "workspace", archivedAt: null, provider: "fake", model: null, status: "idle", attentionReason: "finished" },
  project: { id: "p", name: "Project", rootPath: "/repo" }, capturedAt: at,
  rows: Array.from({ length: 12 }, (_, i) => ({ ref: `r${i}`, epoch: "e", seqStart: i, seqEnd: i, at, turnId: null, kind: i < 3 ? "user_message" : i < 6 ? "tool_call" : "assistant_message", text: "有据的执行结果", toolName: null, toolStatus: null })),
  coverage: { complete: true, hasOlder: false, hasNewer: false, gap: false, truncated: false, reason: null, projectedItems: 12, characters: 100, pages: 1, firstAt: at, lastAt: at, epoch: "e" },
  counts: { userTurns: 3, tools: 3, assistantMessages: 6, toolFailures: 0, errors: 0, observedTurnIds: 3 }, completionEvidence: { kind: "attention_finished", at } });
const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } } as unknown as PaseoApi;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until<T>(read: () => Promise<T | undefined>, predicate: (value: T) => boolean): Promise<T> {
  for (let n = 0; n < 10000; n++) { const value = await read(); if (value && predicate(value)) return value; await tick(); }
  throw new Error("fake runner did not settle");
}
const waitReport = (manager: InsightManager, id: string, status = "completed") => until(async () => (await manager.report(id)).job ?? undefined, job => job.status === status);
const waitSuggestion = (manager: InsightManager, id: string, status = "completed") => until(async () => (await manager.suggestions(id)).job ?? undefined, job => job.status === status);
async function fixture(options: InsightManagerOptions = {}, jobs = [seed("old1"), seed("old2", 1)]) {
  const directory = await mkdtemp(join(tmpdir(), "insight-queue-")); const storage = new InsightStorage(directory);
  const settings = { autoEnabled: false, minTurns: 3, minTools: 3, cooldownHours: 6, runner: { kind: "grok" as const } };
  await storage.saveSettings(settings); await storage.save({ settings, jobs, cooldowns: {}, activity: {}, revision: 1 }); await storage.close();
  const manager = new InsightManager({ directory, now: () => epoch, findBinary: async () => "/fake/grok", fetch: async (_p, id) => trajectory(id),
    run: async ({ prompt }) => JSON.stringify(prompt.includes("<reports_data>") ? suggestion : report), ...options });
  return { directory, manager, close: async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}
test("suggestions skip fewer than two reports without launching a runner", async () => {
  let runs = 0; const f = await fixture({ run: async () => { runs++; return "{}"; } }, [seed("one")]);
  try { const job = await f.manager.suggest(paseo, 7); const done = await waitSuggestion(f.manager, job.id, "skipped"); assert.match(done.stage, /至少需要 2/); assert.equal(runs, 0); }
  finally { await f.close(); }
});
test("suggestions retry once, retain exact evidence and persist action feedback", async () => {
  let runs = 0; const prompts: string[] = [];
  const f = await fixture({ run: async ({ prompt, schema, systemPrompt }) => { runs++; prompts.push(prompt); assert.ok(schema); assert.match(systemPrompt!, /运营顾问/);
    return JSON.stringify({ structured_output: runs === 1 ? { ...suggestion, actions: [{ ...suggestion.actions[0], evidence: ["invented"] }] } : suggestion, usage: { input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.1 }); } });
  try {
    const job = await f.manager.suggest(paseo, 7); const done = await waitSuggestion(f.manager, job.id); suggestionJobSchema.parse(done);
    assert.equal(runs, 2); assert.match(prompts[1], /上次输出/); assert.equal(done.usage?.inputTokens, 10); assert.equal(done.evidence?.["R1#f1"].jobId, "old1");
    assert.equal((await f.manager.suggestions()).job?.id, job.id);
    await assert.rejects(f.manager.actionFeedback(job.id, "missing", "done"), /不存在/);
    await f.manager.actionFeedback(job.id, "action1", "adopted"); assert.equal((await f.manager.suggestions()).history[0].openActions, 0);
    const saved = JSON.parse(await readFile(join(f.directory, "insight-suggestions.json"), "utf8")); assert.equal(saved.jobs[0].feedback.action1.status, "adopted");
    const overview = await f.manager.overview(paseo, 7, 0); assert.equal(overview.mode, "full"); if (overview.mode === "full") assert.equal(overview.suggestions?.id, job.id);
  } finally { await f.close(); }
});
test("manual report and suggestion jobs precede automatic work in one serial queue", async () => {
  const gate = deferred<string>(); const order: string[] = []; let active = 0, maximum = 0;
  const f = await fixture({ run: async ({ prompt }) => {
    active++; maximum = Math.max(maximum, active);
    const id = prompt.includes("<reports_data>") ? "suggestion" : JSON.parse(prompt.split("<trajectory_data>")[1].split("</trajectory_data>")[0]).agent.id;
    order.push(id); const output = id === "hold" ? await gate.promise : JSON.stringify(id === "suggestion" ? suggestion : report); active--; return output;
  } });
  try {
    await f.manager.configure(true); const first = await f.manager.start(paseo, "hold"); await waitReport(f.manager, first.id, "analyzing");
    const automatic = await f.manager.start(paseo, "automatic", "auto"), autoSuggestion = await f.manager.suggest(paseo, 30, undefined, "auto");
    const manual = await f.manager.start(paseo, "manual"), manualSuggestion = await f.manager.suggest(paseo, 7);
    gate.resolve(JSON.stringify(report)); await waitSuggestion(f.manager, autoSuggestion.id); await waitReport(f.manager, automatic.id); await waitReport(f.manager, manual.id); await waitSuggestion(f.manager, manualSuggestion.id);
    assert.deepEqual(order, ["hold", "manual", "suggestion", "automatic", "suggestion"]); assert.equal(maximum, 1);
  } finally { gate.resolve(JSON.stringify(report)); await f.close(); }
});
test("turning auto off cancels both queued kinds while leaving the running suggestion intact", async () => {
  const gate = deferred<string>(); const f = await fixture({ run: async () => gate.promise });
  try {
    await f.manager.configure(true); const running = await f.manager.suggest(paseo, 7); await waitSuggestion(f.manager, running.id, "analyzing");
    const reportJob = await f.manager.start(paseo, "auto-report", "auto"), suggestionJob = await f.manager.suggest(paseo, 30, undefined, "auto");
    await f.manager.configure({ autoEnabled: false });
    assert.equal((await f.manager.report(reportJob.id)).job?.status, "canceled"); assert.equal((await f.manager.suggestions(suggestionJob.id)).job?.status, "canceled");
    assert.equal((await f.manager.suggestions(running.id)).job?.status, "analyzing"); gate.resolve(JSON.stringify(suggestion)); await waitSuggestion(f.manager, running.id);
  } finally { gate.resolve(JSON.stringify(suggestion)); await f.close(); }
});
test("canceling suggestion output cannot publish late data and allows the next report", async () => {
  const gate = deferred<string>(); const f = await fixture({ run: async ({ prompt }) => prompt.includes("<reports_data>") ? gate.promise : JSON.stringify(report) });
  try {
    const canceled = await f.manager.suggest(paseo, 7); await waitSuggestion(f.manager, canceled.id, "analyzing"); const next = await f.manager.start(paseo, "next");
    await f.manager.cancelSuggestion(canceled.id); await waitReport(f.manager, next.id); gate.resolve(JSON.stringify(suggestion)); await tick();
    const job = (await f.manager.suggestions(canceled.id)).job!; assert.equal(job.status, "canceled"); assert.equal(job.report, null);
  } finally { gate.resolve(JSON.stringify(suggestion)); await f.close(); }
});
test("auto suggestions require three new reports and twenty hours since the last automatic job", async () => {
  let now = epoch; const f = await fixture({ now: () => now }, []);
  const runReport = async (id: string) => { now += 1000; const job = await f.manager.start(paseo, id); await waitReport(f.manager, job.id); };
  try {
    await f.manager.configure(true);
    await runReport("a"); await runReport("b"); assert.equal((await f.manager.suggestions()).history.length, 0);
    await runReport("c"); const first = await until(async () => (await f.manager.suggestions()).job ?? undefined, job => job.status === "completed"); assert.equal(first.trigger, "auto");
    await runReport("d"); await runReport("e"); await runReport("f"); assert.equal((await f.manager.suggestions()).history.length, 1);
    const before = await f.manager.overview(paseo, 7, 0); if (before.mode === "full") { assert.equal(before.reportsSinceSuggestions, 3); assert.ok(before.nextSuggestionAt); }
    now += 20 * 3600000;
    await runReport("g"); await until(async () => (await f.manager.suggestions()).job ?? undefined, job => job.id !== first.id && job.status === "completed");
    assert.equal((await f.manager.suggestions()).history.length, 2);
  } finally { await f.close(); }
});
test("reload cancels stored suggestion jobs and never executes them", async () => {
  const f = await fixture(); let restored: InsightManager | undefined;
  try {
    const job = await f.manager.suggest(paseo, 7); const done = await waitSuggestion(f.manager, job.id); await f.manager.close();
    await writeFile(join(f.directory, "insight-suggestions.json"), JSON.stringify({ version: 1, jobs: [{ ...done, status: "analyzing", report: null }] }));
    let runs = 0; restored = new InsightManager({ directory: f.directory, now: () => epoch + 1000, findBinary: async () => null, run: async () => { runs++; return "{}"; } });
    const recovered: SuggestionJob | null = (await restored.suggestions(job.id)).job; assert.equal(recovered?.status, "canceled"); assert.equal(runs, 0);
  } finally { await restored?.close(); await f.close(); }
});
function fakeProvider(options: { output: string; archived?: boolean; gate?: Promise<unknown> }) {
  const creations: any[] = []; let archives = 0;
  const handle = () => ({ id: `analysis-${creations.length}`, current: () => null,
    waitForFinish: async () => ({ status: "idle", lastMessage: options.output, final: { lastUsage: { inputTokens: 20, outputTokens: 9, totalCostUsd: 0.4 } } }),
    archive: async () => { archives++; return { archivedAt: at }; } });
  const api = {
    // A custom provider that extends Codex: only Codex gets the read-only sandbox options.
    config: { get: async () => ({ config: { providers: { "codex-fake": { extends: "codex" } }, agentProfiles: [{ id: "reader", name: "Reader", provider: "codex-fake", model: "m", modeId: "full-access" }] } }) },
    providers: { snapshot: async () => ({ entries: [{ provider: "codex-fake", enabled: true, status: "available", label: "Codex Fake", modes: [{ id: "auto" }, { id: "full-access" }], models: [{ id: "m", label: "Model", isDefault: true }] }] }) },
    agents: { list: async () => { if (options.gate) await options.gate; return { entries: [], pageInfo: { hasMore: false } }; },
      create: async (input: unknown) => { creations.push(input); return handle(); },
      ref: (id: string) => ({ refresh: async () => ({ agent: { id, cwd: "/repo", workspaceId: "workspace", title: id, archivedAt: options.archived ? at : null } }) }) },
    workspaces: { ref: (id: string) => ({ agents: { create: async (input: unknown) => { creations.push({ ...(input as object), workspaceId: id }); return handle(); } } }) },
  } as unknown as PaseoApi;
  return { api, creations, archives: () => archives };
}
test("configured Paseo report runs without Grok and records resolved runner plus real session usage", async () => {
  const fake = fakeProvider({ output: JSON.stringify(report) }); const f = await fixture({ findBinary: async () => null });
  try {
    await f.manager.configure({ runner: { kind: "profile", profileId: "reader" } });
    const queued = await f.manager.start(fake.api, "target"); const done = await waitReport(f.manager, queued.id);
    assert.equal(done.model, "m"); assert.equal(done.runner?.label, "Reader"); assert.equal(done.runner?.modeId, "auto");
    assert.equal(done.runner?.sessionAgentId, "analysis-1"); assert.equal(done.usage?.costUsd, 0.4); assert.equal(fake.archives(), 1);
    // Made in the parent's workspace with the sub-agent label (0.13 escapes a `parent` create's first message).
    assert.equal(fake.creations[0].workspaceId, "workspace"); assert.equal(fake.creations[0].labels["paseo.parent-agent-id"], "target");
    assert.equal(fake.creations[0].parent, undefined); assert.equal(fake.creations[0].config.provider, "codex-fake/m");
    assert.equal(fake.creations[0].config.modeId, "auto"); assert.deepEqual(fake.creations[0].config.options, { sandbox_mode: "read-only", approval_policy: "never" });
    assert.equal((await f.manager.list()).runnerLabel, "Reader"); assert.equal((await f.manager.list()).available, true);
  } finally { await f.close(); }
});
test("Paseo suggestions use the newest source's existing workspace when its parent is archived", async () => {
  const fake = fakeProvider({ output: JSON.stringify(suggestion), archived: true }); const f = await fixture({ findBinary: async () => null });
  try {
    const queued = await f.manager.suggest(fake.api, 7, { kind: "profile", profileId: "reader" }); const done = await waitSuggestion(f.manager, queued.id);
    assert.equal(done.runner.sessionAgentId, "analysis-1"); assert.equal(fake.archives(), 1); assert.equal(done.usage?.inputTokens, 20);
    assert.equal(fake.creations[0].workspaceId, "workspace"); assert.equal(fake.creations[0].parent, undefined); assert.equal(fake.creations[0].title, "观测台建议 · 近 7 天");
    assert.equal(fake.creations[0].autoArchive, undefined);
  } finally { await f.close(); }
});
test("a runner change during cleanup applies only to later dequeued work", async () => {
  const cleanup = deferred<unknown>(), fake = fakeProvider({ output: JSON.stringify(suggestion), gate: cleanup.promise }); let grokCalls = 0;
  const f = await fixture({ run: async () => { grokCalls++; return JSON.stringify(report); } });
  try {
    await f.manager.configure({ runner: { kind: "profile", profileId: "reader" } });
    const first = await f.manager.suggest(fake.api, 7); await waitSuggestion(f.manager, first.id, "collecting");
    await f.manager.configure({ runner: { kind: "grok" } }); const next = await f.manager.start(fake.api, "later");
    cleanup.resolve(undefined); const firstDone = await waitSuggestion(f.manager, first.id); const nextDone = await waitReport(f.manager, next.id);
    assert.equal(firstDone.runner.kind, "profile"); assert.equal(nextDone.runner?.kind, "grok"); assert.equal(grokCalls, 1);
  } finally { cleanup.resolve(undefined); await f.close(); }
});
test("simultaneous starts coalesce even when binary discovery yields", async () => {
  const gate = deferred<string>(); const f = await fixture({ run: async () => gate.promise });
  try {
    const jobs = await Promise.all(Array.from({ length: 12 }, () => f.manager.start(paseo, "same")));
    assert.equal(new Set(jobs.map(job => job.id)).size, 1);
    gate.resolve(JSON.stringify(report)); await waitReport(f.manager, jobs[0].id);
  } finally { gate.resolve(JSON.stringify(report)); await f.close(); }
});
test("disabling auto during binary lookup cannot enqueue automatic work afterward", async () => {
  const gate = deferred<string | null>(); let probes = 0, runs = 0;
  const f = await fixture({ findBinary: async () => ++probes === 2 ? gate.promise : "/fake", run: async () => { runs++; return JSON.stringify(report); } });
  try {
    await f.manager.configure(true); const pending = f.manager.start(paseo, "late-auto", "auto");
    await until(async () => probes, count => count === 2); await f.manager.configure(false); gate.resolve("/fake");
    await assert.rejects(pending, /关闭/); assert.equal(runs, 0);
  } finally { gate.resolve("/fake"); await f.close(); }
});
