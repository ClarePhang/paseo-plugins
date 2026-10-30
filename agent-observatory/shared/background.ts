import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { applyTelemetry, timestamp, type AgentBackground, type AgentRecord } from "./model";
import type { TelemetrySnapshot } from "./telemetry";

/**
 * 后台执行中: provider subagents (Claude Code background Task agents and the like) keep working after their parent's
 * turn ended. Paseo shows them as "N working" and counts the workspace as running while the Agent itself is idle.
 */
export const backgroundAgentSchema = z.object({
  agentId: z.string().min(1).max(256),
  running: z.number().int().positive().max(100),
  since: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  labels: z.array(z.string().max(120)).max(3),
});
export type BackgroundAgent = z.infer<typeof backgroundAgentSchema>;

const revision = z.string().min(1).max(80);
export const backgroundResponseSchema = z.discriminatedUnion("mode", [
  // `available` is false while the host's subagent stream is not open (older hosts never open it).
  z.object({ mode: z.literal("full"), unchanged: z.literal(false), revision, available: z.boolean(), agents: z.array(backgroundAgentSchema).max(500) }),
  z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
]);
export type BackgroundResponse = z.infer<typeof backgroundResponseSchema>;
export const getBackground = defineRpc({
  name: "observatory.background.get",
  input: z.object({ revision: revision.optional() }),
  output: backgroundResponseSchema,
});

export interface BackgroundState { available: boolean; agents: BackgroundAgent[]; revision: string }
export function mergeBackground(previous: BackgroundState | undefined, response: BackgroundResponse): BackgroundState {
  if (response.mode === "full") return { available: response.available, agents: response.agents, revision: response.revision };
  if (!previous) throw new Error(t("sharedBackground.m001"));
  return previous;
}

const SETTLED = new Set(["idle", "completed", "quiet", "canceled"]);
/**
 * An Agent whose own turn ended while its subagents still work is 执行中. Approvals, errors, starting and closed
 * sessions keep their state; a running one only gains the background details.
 */
export function applyBackground(agent: AgentRecord, background?: AgentBackground | null): AgentRecord {
  if (!background || background.running < 1 || agent.archivedAt) return agent;
  const settled = SETTLED.has(agent.status);
  if (!settled && agent.status !== "running") return agent;
  const activity = (timestamp(background.updatedAt) ?? 0) > (timestamp(agent.lastActivityAt) ?? 0) ? background.updatedAt : agent.lastActivityAt;
  return { ...agent, ...(settled ? { status: "running" as const } : {}), background, lastActivityAt: activity };
}

const BUSY = new Set(["running", "initializing", "waiting"]);
const MAX_DEPTH = 8;
/**
 * Paseo sub-agents an Agent started (`paseo.parent-agent-id`) that still work (2.18): while one runs, waits for an approval or
 * has busy sub-agents of its own, the parent's finished turn is not its result yet, so the parent stays 执行中 like it does for
 * provider background agents, and its 完成 is held until they are done.
 */
export function childBackground(agents: readonly AgentRecord[]): Map<string, AgentBackground> {
  const children = new Map<string, AgentRecord[]>();
  for (const agent of agents) {
    if (!agent.parentAgentId || agent.archivedAt || agent.parentAgentId === agent.id) continue;
    const list = children.get(agent.parentAgentId);
    if (list) list.push(agent); else children.set(agent.parentAgentId, [agent]);
  }
  const memo = new Map<string, boolean>();
  const busy = (agent: AgentRecord, depth: number): boolean => {
    const known = memo.get(agent.id);
    if (known !== undefined) return known;
    memo.set(agent.id, false); // a cycle counts as not busy
    const result = BUSY.has(agent.status) || agent.pendingPermissionCount > 0 || (depth < MAX_DEPTH && (children.get(agent.id) ?? []).some(child => busy(child, depth + 1)));
    memo.set(agent.id, result);
    return result;
  };
  const found = new Map<string, AgentBackground>();
  for (const [parentId, list] of children) {
    const working = list.filter(child => busy(child, 0));
    if (!working.length) continue;
    const starts = working.map(child => timestamp(child.activeTurnStartedAt) ?? timestamp(child.background?.since)).filter((value): value is number => value !== null);
    const updates = working.map(child => timestamp(child.lastActivityAt)).filter((value): value is number => value !== null);
    found.set(parentId, { running: working.length, since: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
      updatedAt: updates.length ? new Date(Math.max(...updates)).toISOString() : null, labels: working.slice(0, 3).map(child => child.title.slice(0, 120)) });
  }
  return found;
}

/** Provider background agents and busy Paseo sub-agents, as one: counts add up, the earliest start and latest update win. */
function combineBackground(one: AgentBackground | undefined, other: AgentBackground | undefined): AgentBackground | undefined {
  if (!one || !other) return one ?? other;
  const earliest = [one.since, other.since].map(value => timestamp(value)).filter((value): value is number => value !== null);
  const latest = [one.updatedAt, other.updatedAt].map(value => timestamp(value)).filter((value): value is number => value !== null);
  return { running: one.running + other.running, since: earliest.length ? new Date(Math.min(...earliest)).toISOString() : null,
    updatedAt: latest.length ? new Date(Math.max(...latest)).toISOString() : null, labels: [...one.labels, ...other.labels].slice(0, 3) };
}

/** Lifecycle outcomes first, then background work (provider subagents and busy Paseo sub-agents), which outranks a finished turn. */
export function enrichAgents(agents: AgentRecord[], telemetry?: TelemetrySnapshot, background?: Pick<BackgroundState, "agents">): AgentRecord[] {
  const records = new Map((telemetry?.agents ?? []).map(item => [item.agentId, item]));
  const working = new Map((background?.agents ?? []).map(item => [item.agentId, item]));
  const withTelemetry = telemetry ? agents.map(agent => {
    const record = records.get(agent.id), enriched = applyTelemetry(agent, record);
    return record?.link ? { ...enriched, changeRequest: record.link } : enriched;
  }) : agents;
  // Provider background first: a sub-agent busy only with its own background agents still holds its parent.
  const withProvider = working.size ? withTelemetry.map(agent => applyBackground(agent, working.get(agent.id))) : withTelemetry;
  const children = childBackground(withProvider);
  if (!children.size) return withProvider;
  return withTelemetry.map(agent => applyBackground(agent, combineBackground(working.get(agent.id), children.get(agent.id))));
}
