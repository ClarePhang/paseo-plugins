import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION, observatoryExportV1 } from "../shared/bots-contract";
import type { AttentionSummary } from "../shared/attention-rpc";
import type { TelemetrySnapshot } from "../shared/telemetry";
import { attentionRows, createBotsContractExporter, stopReasonRows, EXPORT_INTERVAL_MS } from "../server/bots-contract-export";

const tmp = () => mkdtemp(join(tmpdir(), "observatory-bots-contract-"));

const snapshot = (agents: TelemetrySnapshot["agents"]): TelemetrySnapshot => ({ agents, events: [], activeTurns: [] } as unknown as TelemetrySnapshot);
const summary = (entries: AttentionSummary["entries"]): AttentionSummary =>
  ({ count: entries.length, truncated: false, blocking: 0, loud: 0, entries, scheduleFailures: null, ready: true, failed: false } as unknown as AttentionSummary);
const entry = (over: Record<string, unknown> = {}) =>
  ({ agentId: "a4", title: "t", projectName: "p", phase: "error", since: null, pending: [], pendingCount: 0, stop: null, lastError: null, note: null, issue: null, nudge: null, ask: null, promptAt: null, roundAt: null, ...over }) as never;

test("停因与需要处理的行映射自现有取数点", () => {
  const at = "2026-11-11T00:00:00.000Z";
  const rows = stopReasonRows(snapshot([
    { agentId: "a1", outcome: "failed", stop: { kind: "quota", resetAt: "2026-11-11T02:00:00.000Z", at } },
    { agentId: "a2", outcome: "completed", stop: { kind: "silent", resetAt: null, at } },
    { agentId: "a3", outcome: "completed", stop: null },
  ] as never));
  assert.deepEqual(rows, [
    { agentId: "a1", kind: "quota", reason: "resets 2026-11-11T02:00:00.000Z", ts: at },
    { agentId: "a2", kind: "silent", reason: "completed", ts: at },
  ]);
  assert.deepEqual(attentionRows(summary([entry({ lastError: "boom" })]), at), [{ agentId: "a4", kind: "error", reason: "boom", ts: at }], "since 缺失时退 generatedAt");
  assert.deepEqual(attentionRows(null, at), []);
});

test("写入形状与契约 schema 一致（strict），原子写无 tmp 残留", async () => {
  const home = await tmp(), logs: string[] = [];
  try {
    const at = "2026-11-11T00:00:00.000Z";
    const exporter = createBotsContractExporter({
      home, now: () => Date.parse(at), log: message => logs.push(message),
      sources: {
        telemetry: async () => snapshot([{ agentId: "a1", outcome: "failed", stop: { kind: "quota", resetAt: null, at } }] as never),
        attention: async () => summary([entry({ phase: "question", since: at, note: "请确认" })]),
      },
    });
    assert.equal(await exporter.writeOnce(), true);

    const file = join(home, "plugin-data", "bots-contract", "observatory-export.json");
    const document = observatoryExportV1.parse(JSON.parse(await readFile(file, "utf8")));
    assert.equal(document.version, CONTRACT_VERSION);
    assert.equal(document.generatedAt, at);
    assert.deepEqual(document.stopReasons, [{ agentId: "a1", kind: "quota", reason: "failed", ts: at }]);
    assert.deepEqual(document.attention, [{ agentId: "a4", kind: "question", reason: "请确认", ts: at }]);
    assert.match(logs[0]!, /bots-contract export written/);

    const contractDir = join(home, "plugin-data", "bots-contract");
    assert.deepEqual(await readdir(contractDir), ["observatory-export.json"], "只有契约文件，无 tmp 残留");
    // 覆盖写同样干净，且 strict 拒绝多出的字段（与事实源一致）。
    assert.equal(await exporter.writeOnce(), true);
    assert.deepEqual(await readdir(contractDir), ["observatory-export.json"]);
    const parsed = JSON.parse(await readFile(file, "utf8"));
    assert.throws(() => observatoryExportV1.parse({ ...parsed, extra: 1 }));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("坏目录容错：写失败只告警，不抛，目标缺失", async () => {
  const root = await tmp(), logs: string[] = [];
  try {
    // plugin-data 的位置被一个普通文件占住：mkdir recursive 必失败。
    const home = join(root, "blocked");
    await writeFile(home, "not a directory");
    const exporter = createBotsContractExporter({
      home, log: message => logs.push(message),
      sources: { telemetry: async () => snapshot([]), attention: async () => null },
    });
    assert.equal(await exporter.writeOnce(), false);
    assert.match(logs[0]!, /bots-contract export failed/);
    await assert.rejects(stat(join(home, "plugin-data", "bots-contract", "observatory-export.json")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("start 立即写一次并按周期续写；stop 清定时器（mock 时钟，不依赖真实间隔）", async t => {
  const home = await tmp();
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    // 每次写都从 telemetry 取数：第 2 次调用即证明周期 tick 真的触发了下一次写（lib ES2023，无 Promise.withResolvers）。
    let calls = 0, resolveFirst!: () => void, resolveSecond!: () => void;
    const firstCall = new Promise<void>(resolve => { resolveFirst = resolve; });
    const secondCall = new Promise<void>(resolve => { resolveSecond = resolve; });
    const exporter = createBotsContractExporter({
      home, intervalMs: 60_000,
      sources: { telemetry: async () => { calls += 1; if (calls === 1) resolveFirst(); if (calls === 2) resolveSecond(); return snapshot([]); }, attention: async () => null },
    });
    exporter.start();
    await firstCall;
    t.mock.timers.tick(60_000);
    await secondCall;
    assert.equal(calls, 2, "立即一次 + 一个周期后一次");

    exporter.stop();
    t.mock.timers.tick(10 * 60_000);
    assert.equal(calls, 2, "stop 后不再有新的写");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("60s 默认节奏", () => assert.equal(EXPORT_INTERVAL_MS, 60_000));
