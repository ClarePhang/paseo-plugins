import { t } from "./text";
/**
 * The 需要处理 summary's RPC contract (opus-B1): what the server sends the sidebar badge and its popover. Apart from the rest of
 * shared/attention.ts so the resident badge can share its types without its rules; the server validates with it, and the UI
 * chunk's popover reads the same entries.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ATTENTION_PHASES } from "./attention-phases";
import { REPLY_NUDGES } from "./reply";
import { TIME_ZONE } from "./time-zone";
import { chimeSchema } from "./alerts";

const id = z.string().min(1).max(256);
const pendingSchema = z.object({ kind: z.enum(["tool", "plan", "question", "mode", "other"]), title: z.string().max(240).nullable(), detail: z.string().max(240).nullable(), options: z.array(z.string().max(60)).max(4) });
export const attentionEntrySchema = z.object({
  agentId: id, title: z.string().max(160), projectName: z.string().max(160), phase: z.enum(ATTENTION_PHASES), since: z.iso.datetime().nullable(),
  pending: z.array(pendingSchema).max(4), pendingCount: z.number().int().nonnegative(),
  // `resetGuessed`: the reset was read in the devices' zone from a notice that named none (grok-F2). `closedMidTurn`: the
  // host closed the Agent while the turn was open (opus-F34).
  stop: z.object({ kind: z.enum(["quota", "silent", "unfinished"]), resetAt: z.iso.datetime().nullable(), resetGuessed: z.boolean(), closedMidTurn: z.boolean() }).nullable(),
  lastError: z.string().max(200).nullable(), note: z.string().max(200).nullable(),
  /** 原地打转 / 可能卡住 (2.18): what the popover's reason line says; older servers send none. */
  issue: z.object({ kind: z.enum(["looping", "stuck"]), pattern: z.enum(["same", "pingpong", "rotation", "contract"]).nullable(), tool: z.string().max(160).nullable(),
    count: z.number().int().nonnegative(), toolRunning: z.boolean(), since: z.iso.datetime() }).nullable().default(null),
  /** What the latest reply invites (快捷回复, opus-B26): its category; null when nothing. */
  nudge: z.enum(REPLY_NUDGES).nullable(),
  /**
   * The sentence that invites it, redacted (the turn's end saw it; memory only, so none after a reload): the popover quotes
   * it above its quick replies and offers none without it (P2-1). `promptAt`: the prompt of the turn they answer, so a tap
   * after another turn began sends nothing (P1-1). `roundAt`: when the plugin saw that turn start, as a heartbeat's rounds share
   * their prompt (codex-obs-attn-F1). Older servers send none of them.
   */
  // 120 characters (server/attention.ts `askOf`), which is up to 240 UTF-16 units.
  ask: z.string().max(320).nullable().default(null),
  promptAt: z.iso.datetime().nullable().default(null),
  roundAt: z.iso.datetime().nullable().default(null),
});
export type AttentionEntry = z.infer<typeof attentionEntrySchema>;
const revision = z.string().min(1).max(80);
const summarySchema = z.object({
  /** Everything that needs you; `truncated` when the host directory was too large to read whole (shown as N+). */
  count: z.number().int().nonnegative(), truncated: z.boolean(),
  /** Blocking requests (approvals, questions, plans) among them: the badge radiates while there are any. */
  blocking: z.number().int().nonnegative(),
  entries: z.array(attentionEntrySchema).max(8),
  /** Failed scheduled runs in the last 24 hours (定时运行 row), null when unknown. */
  scheduleFailures: z.number().int().nonnegative().nullable(),
  /** Failures and usage limits among them (any turns the badge red, also beyond the first 8 entries). */
  loud: z.number().int().nonnegative(),
  /** False until the server has read the directory once; the badge shows no number before that. */
  ready: z.boolean(),
  /** The server's latest directory read failed: no number either, and the popover says so. */
  failed: z.boolean(),
  /** 提示音 (2.17): every waiting entry's event while the chime is on, null while it is off; older servers send none. */
  chime: chimeSchema.nullable().optional(),
});
export type AttentionSummary = z.infer<typeof summarySchema>;
export const getAttention = defineRpc({
  name: "observatory.attention.get",
  // `timeZone`: the device's IANA zone, so the server reads a limit notice without one in the user's time (grok-F2).
  input: z.object({ revision: revision.optional(), timeZone: z.string().min(1).max(64).regex(TIME_ZONE).optional() }),
  output: z.discriminatedUnion("mode", [summarySchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }), z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision })]),
});
export type AttentionResponse = z.infer<typeof getAttention.output>;
export type AttentionState = AttentionSummary & { revision: string };
export function mergeAttention(previous: AttentionState | undefined, response: AttentionResponse): AttentionState {
  if (response.mode === "full") { const { mode: _mode, unchanged: _unchanged, ...summary } = response; return summary; }
  if (!previous) throw new Error(t("sharedAttentionRpc.m001"));
  return previous;
}
