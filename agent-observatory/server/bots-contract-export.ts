import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONTRACT_VERSION, observatoryExportV1, type ObservatoryExportV1 } from "../shared/bots-contract";
import type { AttentionEntry, AttentionSummary } from "../shared/attention-rpc";
import type { TelemetrySnapshot } from "../shared/telemetry";
import { resolvePaseoHome } from "./paseo-home";

/** bots-contract/v1 快照的节奏（02-design §3.5）：周期写 + contribute 时立即写一次。 */
export const EXPORT_INTERVAL_MS = 60_000;
const PREFIX = "agent-observatory";

/**
 * 停因与需要处理的现有取数点（依赖注入，纯模块；P2-契约）。
 * - 停因：`TelemetryStore.snapshot()`（./telemetry.ts）——每个 Agent 最新一轮的 `stop`
 *   （shared/stop-reason.ts `turnStop` 的结果：quota / silent / unfinished，quota 带 resetAt）。
 * - 需要处理：`AttentionIndex.summary()`（./attention.ts）——角标同一套规则的 entries（≤8 条）；
 *   没人读角标且侧栏标签关闭时索引未挂载，返回空 entries（降级，不阻塞）。
 */
export interface BotsContractExportSources {
  telemetry(): Promise<TelemetrySnapshot>;
  attention(): Promise<AttentionSummary | null>;
}

export interface BotsContractExporterOptions {
  sources: BotsContractExportSources;
  /** 契约目录的根（$PASEO_HOME 的解析处）；测试注入临时目录。默认 resolvePaseoHome()。 */
  home?: string;
  intervalMs?: number;
  now?: () => number;
  /** 每次（成功或失败）写都过这里；默认 console 成功 log、失败 warn。 */
  log?: (message: string) => void;
}

/** 停因行：`kind` 是停因（quota/silent/unfinished），`reason` 说何时恢复或该轮怎样结束，`ts` 是停因的观察时刻。 */
export function stopReasonRows(snapshot: TelemetrySnapshot): ObservatoryExportV1["stopReasons"] {
  const rows: ObservatoryExportV1["stopReasons"] = [];
  for (const agent of snapshot.agents) {
    const stop = agent.stop;
    if (!stop) continue;
    rows.push({ agentId: agent.agentId, kind: stop.kind, reason: stop.resetAt ? `resets ${stop.resetAt}` : agent.outcome ?? stop.kind, ts: stop.at });
  }
  return rows;
}

/** 需要处理行：`kind` 是 attention phase，`reason` 是该条目的 lastError 或 host 注意事项（都已脱敏），`ts` 是等待开始（缺失时退 generatedAt）。 */
export function attentionRows(summary: AttentionSummary | null, at: string): ObservatoryExportV1["attention"] {
  return (summary?.entries ?? []).map((entry: AttentionEntry) => ({
    agentId: entry.agentId, kind: entry.phase, reason: entry.lastError ?? entry.note ?? "", ts: entry.since ?? at,
  }));
}

/** 原子写（tmp + rename，同目录）；tmp 在 finally 里清掉，成功与失败都不留残片（同 tokens/persistence.ts）。 */
async function writeAtomic(file: string, payload: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, payload);
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

export interface BotsContractExporter {
  /** 组装并原子写一次；失败只告警并返回 false（旧文件留给容错的读方）。 */
  writeOnce(): Promise<boolean>;
  /** 启动周期写并立即写一次；重复调用无副作用。 */
  start(): void;
  /** 清定时器（插件 cleanup）；在途的一次写自行完成，不再排新的。 */
  stop(): void;
}

export function createBotsContractExporter(options: BotsContractExporterOptions): BotsContractExporter {
  const say = options.log ?? (message => console.log(message));
  const moan = options.log ?? (message => console.warn(message));
  const now = options.now ?? Date.now;
  const file = () => join(options.home ?? resolvePaseoHome(), "plugin-data", "bots-contract", "observatory-export.json");
  let timer: ReturnType<typeof setInterval> | null = null;

  const writeOnce = async (): Promise<boolean> => {
    try {
      const [snapshot, summary] = await Promise.all([options.sources.telemetry(), options.sources.attention()]);
      const at = new Date(now()).toISOString();
      const document: ObservatoryExportV1 = {
        version: CONTRACT_VERSION, generatedAt: at,
        stopReasons: snapshot ? stopReasonRows(snapshot) : [],
        attention: attentionRows(summary, at),
      };
      await writeAtomic(file(), JSON.stringify(document));
      say(`${PREFIX}: bots-contract export written to ${file()} (${document.stopReasons.length} stops, ${document.attention.length} attention)`);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : String(error).slice(0, 200);
      moan(`${PREFIX}: bots-contract export failed (${detail}); keeping the previous file`);
      return false;
    }
  };

  return {
    writeOnce,
    start() {
      if (timer) return;
      void writeOnce();
      timer = setInterval(() => { void writeOnce(); }, options.intervalMs ?? EXPORT_INTERVAL_MS);
      timer.unref?.();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}
