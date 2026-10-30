import { t } from "./text";
/**
 * 需要处理 in one sentence: what each waiting Agent wants from you (opus-B3), and the host-wide summary behind the sidebar
 * badge and its popover (opus-B1). No model is asked: the question and its choices, the plan's title and the command come
 * from the pending requests; errors from the Agent's last error; limits from the turn's stop reason; questions and results
 * from the host's own attention note. The summary is computed on the server with the same rules as the page.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { isUnreadCompletion, stopShown, timestamp, waitingKind, type AgentRecord, type AgentTreeNode, type ObservedStop, type PendingRequest } from "./model";
import type { ReplyNudge } from "./reply";
import { ATTENTION_PHASES } from "./attention-phases";
import type { AttentionEntry } from "./attention-rpc";
import type { LiveIssue } from "./live-issue";

/** What kind of attention an Agent needs (or `null`: none to show). */
export type AttentionPhase = "approval" | "question" | "plan" | "error" | "quota" | "silent" | "unfinished" | "looping" | "stuck" | "idle" | "unread";
export { ATTENTION_PHASES };

export function attentionPhase(agent: AgentRecord): AttentionPhase | null {
  const waiting = waitingKind(agent);
  if (waiting) return waiting;
  // A running turn going in circles, or quiet for long (2.18): shown while it runs, counted until 知道了.
  if (agent.status === "running" && agent.issue) return agent.issue.kind;
  // A usage limit outranks the turn's outcome; a closed session shows the turn the host cut off (opus-F34).
  if (stopShown(agent)) return agent.stop!.kind;
  if (agent.status === "error") return "error";
  if (agent.status === "idle") return "idle";
  return isUnreadCompletion(agent) ? "unread" : null;
}
/** Every state a session row, the detail and the legend show (client/status.tsx gives each its colour, glyph and label). */
export type SessionPhase = "approval" | "question" | "plan" | "error" | "quota" | "silent" | "unfinished" | "looping" | "stuck" | "running" | "starting" | "unread" | "snoozed" | "done" | "idle" | "quiet" | "closed" | "canceled";
/**
 * The phase a session shows, by the rules 需要处理 counts with: why the turn stopped (`stopShown`) outranks how it ended (a
 * usage limit outranks a failure too), and a closed session shows the turn the host cut off. A stop cannot be put off:
 * `snoozed` (稍后处理) applies to unread results only.
 */
export function sessionPhase(agent: AgentRecord, snoozed = false): SessionPhase {
  const waiting = waitingKind(agent);
  if (waiting) return waiting;
  if (stopShown(agent)) return agent.stop!.kind;
  if (agent.status === "error") return "error";
  if (agent.status === "running") return agent.issue?.kind ?? "running";
  if (agent.status === "initializing") return "starting";
  if (agent.status === "completed") return isUnreadCompletion(agent) ? snoozed ? "snoozed" : "unread" : "done";
  return agent.status === "canceled" ? "canceled" : agent.status === "closed" ? "closed" : agent.status === "idle" ? "idle" : "quiet";
}
/** Failures and usage limits: the badge turns red while any waits. */
export const loudPhases: ReadonlySet<AttentionPhase> = new Set<AttentionPhase>(["error", "quota"]);
/** Blocking requests first, then failures and stops, then results and questions to read. */
export const phaseRank: Record<AttentionPhase, number> = { approval: 0, question: 0, plan: 0, error: 1, quota: 1, silent: 2, unfinished: 2, looping: 2, stuck: 2, idle: 3, unread: 3 };

export interface ReasonInput {
  phase: AttentionPhase;
  pending?: readonly PendingRequest[];
  pendingCount?: number;
  stop?: Pick<ObservedStop, "kind" | "resetAt" | "resetGuessed" | "closedMidTurn"> | null;
  lastError?: string | null;
  note?: string | null;
  issue?: Pick<LiveIssue, "pattern" | "tool" | "count" | "toolRunning" | "since"> | null;
}
export interface ReasonLine { text: string; hue: "amber" | "violet" | "red" | "orange" | "pink"; icon: string }

const firstLine = (value: string | null | undefined, max = 120): string | null => {
  const line = value?.split("\n").map(part => part.trim()).find(Boolean);
  return line ? line.length > max ? `${line.slice(0, max - 1)}…` : line : null;
};
const two = (value: number) => String(value).padStart(2, "0");
/** A reset or wake-up time on this device's clock: 「05:00」 today, 「明天 05:00」, else 「10月12日 05:00」. */
export function clockLabel(value: string | number, now = Date.now()): string {
  const at = new Date(value), today = new Date(now);
  if (!Number.isFinite(at.getTime())) return t("sharedAttention.m001");
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(at) - midnight(today)) / 86_400_000);
  return days === 0 ? time : days === 1 ? t("sharedAttention.m002", { time: time }) : days === -1 ? t("sharedAttention.m003", { time: time }) : t("sharedAttention.m004", { value1: at.getMonth() + 1, value2: at.getDate(), time: time });
}

/** The one-line reason, rendered on the client (times use the device's clock). */
export function reasonText(input: ReasonInput, now = Date.now()): ReasonLine {
  const first = input.pending?.[0];
  switch (input.phase) {
    case "question": {
      const options = first?.options.length ? t("sharedAttention.m005", { value1: first.options.slice(0, 3).join(" / "), value2: first.options.length > 3 ? " …" : "" }) : "";
      return { text: t("sharedAttention.m006", { value1: first?.title ?? t("sharedAttention.m007"), options: options }), hue: "violet", icon: "MessageCircleQuestion" };
    }
    case "plan": return { text: t("sharedAttention.m008", { value1: first?.title ?? t("sharedAttention.m009") }), hue: "amber", icon: "ClipboardList" };
    case "approval": {
      const tool = input.pending?.find(request => request.kind === "tool") ?? first, count = input.pendingCount ?? input.pending?.length ?? 0;
      const what = tool?.detail ? t("sharedAttention.m010", { value1: tool.detail }) : tool?.title ? t("sharedAttention.m011", { value1: tool.title }) : t("sharedAttention.m012");
      return { text: count > 1 ? t("sharedAttention.m013", { what: what, count: count }) : what, hue: "amber", icon: "Hand" };
    }
    // A reset the notice gave without a time zone is read in the device's zone: about then, not exactly (grok-F2).
    case "quota": return { text: input.stop?.resetAt ? t("sharedAttention.m014", { value1: input.stop.resetGuessed ? t("sharedAttention.m015") : "", value2: clockLabel(input.stop.resetAt, now), value3: input.stop.resetGuessed ? t("sharedAttention.m016") : "" }) : t("sharedAttention.m017"), hue: "orange", icon: "BatteryWarning" };
    case "error": return { text: t("sharedAttention.m018", { value1: firstLine(input.lastError) ?? t("sharedAttention.m019") }), hue: "red", icon: "CircleX" };
    case "silent": return { text: t("sharedAttention.m020"), hue: "amber", icon: "CircleDashed" };
    case "unfinished": return { text: input.stop?.closedMidTurn ? t("sharedAttention.m021") : t("sharedAttention.m022"), hue: "amber", icon: "CircleDotDashed" };
    case "looping": return { text: loopText(input.issue), hue: "orange", icon: "Repeat" };
    case "stuck": {
      const minutes = Math.max(1, Math.floor((now - (timestamp(input.issue?.since) ?? now)) / 60_000));
      return { text: input.issue?.toolRunning && input.issue.tool ? t("sharedAttention.stuckTool", { tool: input.issue.tool, minutes }) : t("sharedAttention.stuckIdle", { minutes }), hue: "amber", icon: "Hourglass" };
    }
    case "idle": return { text: input.note ? t("sharedAttention.m023", { value1: input.note }) : t("sharedAttention.m024"), hue: "violet", icon: "MessageCircleMore" };
    case "unread": return { text: input.note ? t("sharedAttention.m025", { value1: input.note }) : t("sharedAttention.m026"), hue: "pink", icon: "Mail" };
  }
}
/** What a loop looks like, in one line: 「Read a.ts 连续 6 次结果相同」 and the like. */
export function loopText(issue: Pick<LiveIssue, "pattern" | "tool" | "count"> | null | undefined): string {
  const tool = issue?.tool ?? t("sharedAttention.loopSomeTool"), count = issue?.count ?? 0;
  switch (issue?.pattern) {
    case "pingpong": return t("sharedAttention.loopPingpong", { count });
    case "rotation": return t("sharedAttention.loopRotation", { count });
    case "contract": return t("sharedAttention.loopContract", { tool });
    default: return t("sharedAttention.loopSame", { tool, count });
  }
}
export function reasonLine(agent: AgentRecord, now = Date.now()): ReasonLine | null {
  const phase = attentionPhase(agent);
  return phase ? reasonText({ phase, pending: agent.pending, pendingCount: agent.pendingPermissionCount, stop: agent.stop, lastError: agent.lastError, note: agent.note, issue: agent.issue ?? null }, now) : null;
}

/**
 * When the Agent started waiting for you, for "waiting longest first". The host's attention time is edge-triggered: while an
 * unread result is outstanding it stays at that result, so a later request or reply that asks goes by the latest activity.
 */
export function waitingSince(agent: AgentRecord, phase = attentionPhase(agent)): string | null {
  const order = phase === "unread" ? [agent.completionAt, agent.attentionTimestamp, agent.lastActivityAt]
    : phase === "looping" || phase === "stuck" ? [agent.issue?.since, agent.lastActivityAt]
    : phase === "quota" || phase === "silent" || phase === "unfinished" ? [agent.stop?.at, agent.completionAt, agent.lastActivityAt]
    : [agent.lastActivityAt, agent.attentionTimestamp];
  return order.find((value): value is string => timestamp(value) !== null) ?? null;
}

// The summary's RPC contract is in attention-rpc.ts and the zone pattern in time-zone.ts: the resident badge uses them without
// these rules.
export { attentionEntrySchema, getAttention, mergeAttention } from "./attention-rpc";
export type { AttentionEntry, AttentionResponse, AttentionState, AttentionSummary } from "./attention-rpc";
export { TIME_ZONE } from "./time-zone";
const id = z.string().min(1).max(256), revision = z.string().min(1).max(80);
export function entryOf(agent: AgentRecord, phase: AttentionPhase): AttentionEntry {
  // 快捷回复 are not offered to subagents (their parent drives them); the popover cannot tell, so the entry carries none.
  const nudge = agent.parentAgentId ? null : agent.replyNudge ?? null, prompt = timestamp(agent.lastUserMessageAt), round = timestamp(agent.observedTurnStartedAt);
  return { agentId: agent.id, title: agent.title.slice(0, 160), projectName: agent.projectName.slice(0, 160), phase, since: waitingSince(agent, phase),
    pending: (agent.pending ?? []).slice(0, 4).map(request => ({ kind: request.kind, title: request.title?.slice(0, 240) ?? null, detail: request.detail?.slice(0, 240) ?? null, options: request.options.slice(0, 4).map(option => option.slice(0, 60)) })),
    pendingCount: agent.pendingPermissionCount,
    stop: agent.stop ? { kind: agent.stop.kind, resetAt: agent.stop.resetAt, resetGuessed: agent.stop.resetGuessed === true, closedMidTurn: agent.stop.closedMidTurn === true } : null,
    lastError: firstLine(agent.lastError, 200), note: agent.note?.slice(0, 200) ?? null,
    issue: (phase === "looping" || phase === "stuck") && agent.issue ? { kind: agent.issue.kind, pattern: agent.issue.pattern, tool: agent.issue.tool?.slice(0, 120) ?? null, count: agent.issue.count, toolRunning: agent.issue.toolRunning, since: agent.issue.since } : null,
    nudge, ask: nudge ? agent.replyAsk?.slice(0, 320) ?? null : null, promptAt: prompt === null ? null : new Date(prompt).toISOString(),
    roundAt: round === null ? null : new Date(round).toISOString() };
}
/**
 * The quick replies the popover offers under an entry (P2-1): only beside the sentence they answer. The popover shows no
 * reply, and the host's note is the reply's start, so without that sentence (after a reload, for a reply read back later) a
 * tap would agree to something nobody saw there; the detail, with the whole reply above them, offers them anyway.
 */
export function popoverReplies(entry: Pick<AttentionEntry, "phase" | "nudge" | "ask">): ReplyNudge | null {
  return (entry.phase === "idle" || entry.phase === "unread") && entry.ask ? entry.nudge : null;
}

/**
 * What a thread's descendants want (P3-3), for its parent row: how many need you (`attention`: the rule 需要处理 groups the
 * thread by) and the most urgent of their phases, so a collapsed thread pulled into 需要处理 says why; and how many are only
 * unread (a subagent's result while the setting leaves those out), so no descendant is counted twice.
 */
export function threadAttention(node: Pick<AgentTreeNode, "children">, attention: (agent: AgentRecord) => boolean): { count: number; phase: AttentionPhase | null; unread: number } {
  let count = 0, unread = 0, phase: AttentionPhase | null = null;
  const stack = [...node.children];
  while (stack.length) {
    const child = stack.pop()!;
    stack.push(...child.children);
    if (attention(child.agent)) {
      count++;
      const own = attentionPhase(child.agent) ?? "unread";
      if (phase === null || ATTENTION_PHASES.indexOf(own) < ATTENTION_PHASES.indexOf(phase)) phase = own;
    } else if (isUnreadCompletion(child.agent)) unread++;
  }
  return { count, phase, unread };
}

/**
 * Live extras of loaded Agents (memory only, never stored): the running turn's todo progress, the host's latest note, and the
 * closing sentence the latest reply's 快捷回复 answer (`ask`, redacted, from the turn's end).
 */
export const liveIssueSchema = z.object({
  kind: z.enum(["looping", "stuck"]), key: z.string().min(1).max(300), since: z.iso.datetime(),
  pattern: z.enum(["same", "pingpong", "rotation", "contract"]).nullable(), tool: z.string().max(160).nullable(),
  count: z.number().int().nonnegative(), toolRunning: z.boolean(), evidence: z.array(z.string().max(200)).max(8), seen: z.boolean(),
});
const extraSchema = z.object({
  agentId: id,
  todo: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative(), current: z.string().max(80).nullable(), at: z.iso.datetime() }).nullable(),
  note: z.string().max(200).nullable(), noteAt: z.iso.datetime().nullable(),
  ask: z.string().max(320).nullable().default(null), askAt: z.iso.datetime().nullable().default(null),
  /** 原地打转 / 可能卡住 of the running turn (2.18); older servers send none. */
  issue: liveIssueSchema.nullable().default(null),
});
export type LiveExtra = z.infer<typeof extraSchema>;
export const getLiveExtras = defineRpc({
  name: "observatory.live.get",
  input: z.object({ revision: revision.optional() }),
  output: z.discriminatedUnion("mode", [z.object({ mode: z.literal("full"), unchanged: z.literal(false), revision, agents: z.array(extraSchema).max(500) }), z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision })]),
});
export type LiveExtrasResponse = z.infer<typeof getLiveExtras.output>;
/** 知道了 on 原地打转 / 可能卡住 (2.18): `ok` false when that exact issue is no longer there (a newer one or none). */
export const seeLiveIssue = defineRpc({
  name: "observatory.live.issue.seen",
  input: z.object({ agentId: id, key: z.string().min(1).max(300) }),
  output: z.object({ ok: z.boolean() }),
});
export interface LiveExtrasState { agents: LiveExtra[]; revision: string }
export function mergeLiveExtras(previous: LiveExtrasState | undefined, response: LiveExtrasResponse): LiveExtrasState {
  if (response.mode === "full") return { agents: response.agents, revision: response.revision };
  if (!previous) throw new Error(t("sharedAttention.m027"));
  return previous;
}
/**
 * Attach the extras to the records they belong to; a note or a reply's sentence older than the Agent's latest prompt is about
 * an earlier turn.
 */
export function applyLiveExtras(agents: AgentRecord[], extras: readonly z.input<typeof extraSchema>[] | undefined): AgentRecord[] {
  if (!extras?.length) return agents;
  const byId = new Map(extras.map(extra => [extra.agentId, extra]));
  return agents.map(agent => {
    const extra = byId.get(agent.id);
    if (!extra) return agent;
    const prompt = Math.max(timestamp(agent.lastUserMessageAt) ?? 0, timestamp(agent.activeTurnStartedAt) ?? 0);
    const note = extra.note && (timestamp(extra.noteAt) ?? 0) >= prompt ? extra.note : null;
    const todo = extra.todo && agent.status === "running" ? extra.todo : null;
    const ask = extra.ask && (timestamp(extra.askAt) ?? 0) >= prompt ? extra.ask : null;
    // Only about the turn that is running now: a finished turn's loop is history.
    const issue = extra.issue && agent.status === "running" && (timestamp(extra.issue.since) ?? 0) >= (timestamp(agent.activeTurnStartedAt) ?? 0) - 1000 ? extra.issue : null;
    return note || todo || ask || issue ? { ...agent, ...(note ? { note } : {}), ...(todo ? { todo } : {}), ...(ask ? { replyAsk: ask } : {}), ...(issue ? { issue } : {}) } : agent;
  });
}
