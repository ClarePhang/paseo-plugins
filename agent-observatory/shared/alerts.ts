import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import type { AttentionPhase } from "./attention";

/**
 * 提醒 (2.17): the chime when something new needs you, 需要处理 written into the host's own sidebar labels, and the prompt cache
 * countdown. One host setting of its own (`alerts`, beside the language), so every device and the server read the same switches;
 * whether this one device stays quiet is the device's own (client/chime.ts). Everything is off on a new install.
 */
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const alertSettingsSchema = z.object({
  /** 提示音: one short sound when 需要处理 gets a new entry, on devices showing Paseo in the foreground. */
  chime: z.boolean().default(false),
  chimeQuestion: z.boolean().default(true),
  chimeApproval: z.boolean().default(true),
  chimeQuota: z.boolean().default(true),
  chimeError: z.boolean().default(true),
  /** Results and replies that ask you (完成未读、待回复): the most frequent, so off unless asked for. */
  chimeDone: z.boolean().default(false),
  /** Subagents' entries chime too. */
  chimeSubagents: z.boolean().default(false),
  /** 免打扰: from and to, in each device's own time ("" for none); a start later than the end runs overnight. */
  quietFrom: clock.or(z.literal("")).default(""),
  quietTo: clock.or(z.literal("")).default(""),
  /** 同步到侧栏标签: each workspace's reason as a native label, removed once it clears. */
  sidebarLabels: z.boolean().default(false),
  /** Pin the workspaces that wait for you while they do (only pins the plugin made are ever undone). */
  sidebarPin: z.boolean().default(false),
});
export type AlertSettings = z.infer<typeof alertSettingsSchema>;
export const ALERT_SETTINGS_ID = "alerts";
export const alertSettings = defineSettings({ id: ALERT_SETTINGS_ID, scope: "host", version: 1, schema: alertSettingsSchema });
export const defaultAlertSettings: AlertSettings = alertSettingsSchema.parse({});

/** The chime's sounds: a question, a request to approve (a tool or a plan), a usage limit, a failed or stopped turn, a result. */
export const CHIME_KINDS = ["question", "approval", "quota", "error", "done"] as const;
export type ChimeKind = typeof CHIME_KINDS[number];
/** Which sound a 需要处理 phase makes: an empty or unfinished turn sounds like a failure, a reply that asks like a result. */
export function chimeKindOf(phase: AttentionPhase): ChimeKind {
  switch (phase) {
    case "question": return "question";
    case "approval": case "plan": return "approval";
    case "quota": return "quota";
    case "error": case "silent": case "unfinished": case "looping": case "stuck": return "error";
    case "idle": case "unread": return "done";
  }
}
const KIND_SETTING: Record<ChimeKind, keyof AlertSettings> = { question: "chimeQuestion", approval: "chimeApproval", quota: "chimeQuota", error: "chimeError", done: "chimeDone" };
export const chimeKindEnabled = (settings: AlertSettings, kind: ChimeKind) => settings[KIND_SETTING[kind]] === true;

/**
 * What the badge's summary carries for the chime while it is on: the quiet hours and every waiting entry's event, one per
 * occurrence (a pending request by its id; anything else by the time it started waiting), with the turn it belongs to, so a
 * device chimes once per event and once per turn within 15 seconds. Only kinds the settings let chime, subagents only when
 * asked; null while the chime is off.
 */
export const chimeEventSchema = z.object({ id: z.string().min(1).max(600), kind: z.enum(CHIME_KINDS), turn: z.string().max(300) });
export const chimeSchema = z.object({ quiet: z.object({ from: clock, to: clock }).nullable(), events: z.array(chimeEventSchema).max(64) });
export type ChimeEvent = z.infer<typeof chimeEventSchema>;
export type ChimeState = z.infer<typeof chimeSchema>;
export const quietHours = (settings: Pick<AlertSettings, "quietFrom" | "quietTo">) => settings.quietFrom && settings.quietTo && settings.quietFrom !== settings.quietTo ? { from: settings.quietFrom, to: settings.quietTo } : null;

/** Labels the plugin writes and pins it holds, and whether this daemon can (the host's label protocol, Paseo 0.11.1). */
export const getSidebarLabelStatus = defineRpc({
  name: "observatory.alerts.labels",
  input: z.object({}),
  output: z.object({
    state: z.enum(["off", "starting", "on", "unsupported", "error"]),
    labels: z.number().int().nonnegative(), pins: z.number().int().nonnegative(),
    error: z.string().max(300).nullable(),
  }),
});
export type SidebarLabelStatus = z.infer<typeof getSidebarLabelStatus.output>;

/**
 * 提示缓存倒计时: the prompt cache state of Claude-based sessions (by the base a provider `extends`), read from their own Claude Code
 * logs. `expiresAt` is when the cache written by the latest request goes cold (5 minutes or an hour after the message that
 * request answered, so never later than the real expiry); `cold` says it is cold already for a reason the clock cannot show
 * (the conversation was compacted, or the model changed since). Sessions it cannot tell about are left out.
 */
const cacheEntrySchema = z.object({
  agentId: z.string().min(1).max(256),
  /** Null only for a compacted conversation (cold whatever the clock says). */
  touchedAt: z.iso.datetime().nullable(), expiresAt: z.iso.datetime().nullable(), ttl: z.enum(["5m", "1h"]).nullable(),
  cold: z.enum(["compacted", "model"]).nullable(),
});
export type CacheEntry = z.infer<typeof cacheEntrySchema>;
const revision = z.string().min(1).max(80);
export const getCacheClock = defineRpc({
  name: "observatory.cache.get",
  input: z.object({ revision: revision.optional() }),
  output: z.discriminatedUnion("mode", [z.object({ mode: z.literal("full"), revision, agents: z.array(cacheEntrySchema).max(200) }), z.object({ mode: z.literal("unchanged"), revision })]),
});
export type CacheClockResponse = z.infer<typeof getCacheClock.output>;
