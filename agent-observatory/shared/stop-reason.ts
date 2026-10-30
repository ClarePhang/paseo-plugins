import { onTextChange } from "./i18n";
import { t } from "./text";
/**
 * Why a turn stopped when that is not simply "done": the provider's usage or rate limit (with when it resets), a turn that
 * produced nothing, or one that stopped after a tool call without a closing message. Decided on the server when a turn
 * ends (and when a missed end is backfilled); only the kind and the reset time are kept, never the text.
 */
import { string, type TimelineItem, type TimelineRow } from "./timeline";
import { isTurnStart, turnStartText } from "./turn-start";

export type StopKind = "quota" | "silent" | "unfinished";
export interface StopReason {
  kind: StopKind;
  /** When the limit resets (quota only), if the provider said so. */
  resetAt: string | null;
  /** The notice gave a clock time without a time zone: `resetAt` reads it in the devices' zone, so it is a guess (grok-F2). */
  resetGuessed?: boolean;
  /** When the stop was observed. */
  at: string;
  /**
   * 知道了 for a stop the host raised no attention for (a turn the host closed mid-way, opus-F34): when the user
   * acknowledged it in the observatory. Stops with the host's own attention are seen when that attention is cleared.
   */
  seenAt?: string | null;
}

/**
 * Right after a limit phrase, in the same notice: when it comes back ("Rate limit reached. Please try again in 20s",
 * "· resets 5am", "Your limit will reset at …", "usage limit reached|1791696000"). A closing reply about rate-limit work puts
 * other words there instead ("Usage limit exceeded now returns 429; clients should retry after 60s", F6).
 */
const THEN_RESET = String.raw`(?:\s*[.,:;!|·∙—–-])*\s*(?:(?:please\s+)?(?:try again|retry|wait)\b|(?:(?:your\s+)?(?:limit|quota|usage)\s+(?:will\s+)?)?(?:resets?|available again)\b)|\s*\|\s*\d{10,13}\b`;
/**
 * Limit notices providers print as the whole reply. Strict ones name the user's own limit and count at any length up to
 * 800 characters: Claude Code 2.1 "You've hit your limit · resets 3pm (America/New_York)" with a name from its table (session,
 * weekly, Opus, Sonnet, Fable, usage credit) or "You've hit your monthly spend limit", "You're out of usage credits …", Codex
 * "You've hit your usage limit … try again in 2 hours", and "5-hour limit reached ∙ resets 3pm". Without the "you" that names
 * the account, "Session limit reached" and its kin count only as the whole notice or with when it comes back right after
 * (THEN_RESET): "Session limit reached errors are now handled; …" opens a summary of work (codex-obs-attn-F2).
 */
const LIMIT_STRICT = [
  /^(you['’]ve|you have) (hit|reached|exceeded) your ((usage|rate|session|weekly|daily|monthly|5-hour|five-hour|opus|sonnet|haiku|fable|plan|spend|credit|extra)[ -])*limits?\b/i,
  /^you['’]re out of (usage |extra usage )?credits\b/i,
  new RegExp(String.raw`^(\d+-hour|five-hour|weekly|daily|session) limit (reached|exceeded|hit)(?:\s*[.!。]?\s*$|${THEN_RESET})`, "i"),
];
/**
 * Looser openings that a closing reply about rate-limit work starts with just as well ("Rate limit exceeded errors are now
 * caught …", 「超出配额时现在会自动降级…」, opus-F35). In a failure reason they count as they are (LIMIT_IN_ERROR). In a reply only
 * when the whole reply is short and gives a reset time or, in Chinese, is addressed to the user's account or says when it comes
 * back; the English ones only with that time right after the limit (LIMIT_LOOSE_REPLY), the Chinese ones never in words that
 * describe a change (ZH_WORK, F6).
 */
const LIMIT_LOOSE = [
  /^(you['’]ve|you have) (hit|reached|exceeded) (your|the) [\p{L}\p{N}'’ .-]{0,40}?\blimits?\b/iu,
  /^(claude( ai| code)?|codex|gemini|grok|cursor)?\s*((usage|rate|session|weekly|daily|5-hour|five-hour)[ -])+limits? (reached|exceeded|hit)\b/i,
  /^(rate|usage) limit(ed)? ?(reached|exceeded|hit)?\b.{0,40}(try again|resets?|retry)/i,
  /^(当前账[号户]|你的账[号户]|您的账[号户]|你|您)?(已经?)?(达到|用完|用尽|超出|超过)了?\s*(当前|本周|本月|今日|今天|每日|每周|\d+\s*小时|五小时)?\s*的?\s*(使用|用量|调用|请求)?\s*(额度|限额|上限|配额)/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  /^(本周|本月|今日|今天|当前)?的?(使用|用量|调用)?(额度|配额|限额)已经?(用完|用尽|耗尽|达到上限)/, // i18n-ignore: Match original Chinese provider/user text; this is parser data.
];
/** A loose English limit phrase in a reply counts only with when it comes back right after it (THEN_RESET, F6). */
const LIMIT_LOOSE_REPLY = [
  new RegExp(String.raw`^(you['’]ve|you have) (hit|reached|exceeded) (your|the) [\p{L}\p{N}'’ -]{0,40}?\blimits?(?:${THEN_RESET})`, "iu"),
  new RegExp(String.raw`^(claude( ai| code)?|codex|gemini|grok|cursor)?\s*((usage|rate|session|weekly|daily|5-hour|five-hour)[ -])+limits? (reached|exceeded|hit)(?:${THEN_RESET})`, "i"),
  new RegExp(String.raw`^(rate|usage) limit(ed)?( (reached|exceeded|hit))?(?:${THEN_RESET})`, "i"),
  ...LIMIT_LOOSE.slice(3),
];
const SHORT_NOTICE = 300;
/** Addressed to the user's account (「您已达到…」「当前账号…」), or saying when it comes back (「将于明天重置」「…后恢复。」). */
const ZH_ACCOUNT = /^(你|您)(的账[号户])?已|(当前|你的|您的)账[号户]/; // i18n-ignore: Match original Chinese provider/user text; this is parser data.
const ZH_RETURNS = /[将会](于|在)[^，。,.；;！!？?]{0,24}(恢复|重置)|(后|之后)(恢复|重置)(使用)?(?=[。！!，,；;\s]|$)|(恢复|重置)时间/; // i18n-ignore: Match original Chinese provider/user text; this is parser data.
/** How a reply describes a change it made (「超出配额时现在会自动降级」「已加上单测」「改为…」): never a limit notice (F6). */
const ZH_WORK = /现在会|时会|会自动|已经?(加上|加了|补上|补了|添加|新增|实现|改为|改成)|改为|改成|新增|实现了/; // i18n-ignore: Match original Chinese provider/user text; this is parser data.
/** In an error message (a failed turn, an error item) the vocabulary may be broader: it is never ordinary prose. */
const LIMIT_ERROR = /\b(rate[ _-]?limit(ed)?|usage[ _-]?limit|quota|insufficient_quota|too many requests|limit (reached|exceeded)|resource[ _-]?exhausted)\b|\b429\b|额度|限额|配额|限流|用量上限/i; // i18n-ignore: Match original Chinese provider/user text; this is parser data.
/** A failure reason that reads like one of the notices above is a limit too (opus-F36), wherever it starts ("Error: You've hit your limit"). */
// i18n-ignore: Literal Chinese syntax is matched against provider or user content.
const LIMIT_IN_ERROR = [...LIMIT_STRICT, ...LIMIT_LOOSE].map(pattern => new RegExp(pattern.source.replace(/^\^/, "(?:^|[\\s:：>\\]】)])"), pattern.flags));
/** "maximum context length" / "max tokens" are limits too, but not ones a wait resolves. */
const NOT_QUOTA = /context (window|length)|max(imum)?[ _-]?(output[ _-]?)?tokens|prompt is too long|上下文/i; // i18n-ignore: Match original Chinese provider/user text; this is parser data.
const MAX_NOTICE = 800;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const HALF_DAY = 43_200_000;

/** Minutes the zone is ahead of UTC at `at` (America/New_York in summer → -240). */
export function zoneOffsetMinutes(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(at);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  return Math.round((Date.UTC(value("year"), value("month") - 1, value("day"), value("hour") % 24, value("minute"), value("second")) - Math.floor(at / 1000) * 1000) / 60_000);
}
/** The UTC instant of a wall-clock time in `zone`; across a DST change the second guess wins. */
export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - zoneOffsetMinutes(guess, zone) * 60_000;
  const second = guess - zoneOffsetMinutes(first, zone) * 60_000;
  return second;
}
/**
 * Every UTC instant at which the clock in `zone` reads this wall time, earliest first (codex-F7, opus-F37): two in the hour a
 * fall-back repeats (01:30 PDT, then 01:30 PST), one on an ordinary day. A time the spring-forward skips (02:30 when 02:00 jumps
 * to 03:00) has none; it reads as the instant just past the skip, the wall time on the offset before the change (03:30 PDT).
 */
export function wallInstants(year: number, month: number, day: number, hour: number, minute: number, zone: string): number[] {
  const wall = Date.UTC(year, month, day, hour, minute);
  // The offsets in force around that day: a change happens at most once in it.
  const offsets = new Set([-HALF_DAY, 0, HALF_DAY].map(shift => zoneOffsetMinutes(wall + shift, zone)));
  const exact = [...offsets].map(offset => wall - offset * 60_000).filter(at => at + zoneOffsetMinutes(at, zone) * 60_000 === wall).sort((a, b) => a - b);
  return exact.length ? exact : [wall - zoneOffsetMinutes(wall - HALF_DAY, zone) * 60_000];
}
function validZone(zone: string | undefined): string | null {
  if (!zone || zone.length > 64 || !/^[A-Za-z][\w+-]*(\/[\w+-]+){0,2}$/.test(zone)) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return zone; } catch { return null; }
}
/** Calendar date of `at` in `zone`. */
function zonedDate(at: number, zone: string): { year: number; month: number; day: number } {
  const shifted = new Date(at + zoneOffsetMinutes(at, zone) * 60_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/**
 * When the limit resets, from the notice itself: an epoch after `|` (older Claude Code), an ISO time, "try again in 2h 30m" /
 * "in 45 minutes", or a clock time "resets 3pm (America/New_York)" / "resets Mon 9am" / "resets Oct 12, 9am". A clock time
 * without a (known) zone is read in `hostZone`, which since grok-F2 means the zone of the devices the user reads on
 * (DeviceZone.current() on the server; the host's own only when no device ever reported one), and marked `guessed`: the
 * plugin runs inside the daemon, often on a UTC server, while the CLI printed the time for the user. Days advance on the zone's calendar, so the 23-hour
 * spring-forward day is not skipped, and a repeated fall-back hour takes the nearest time not yet past (opus-F37, codex-F7), a
 * minute's grace for a time just gone only when neither is ahead (codex-obs-resume-F5).
 * Null when nothing plausible (within 8 days) is found.
 */
export function parseReset(text: string, now: number, hostZone?: string): { at: number; guessed: boolean } | null {
  const plausible = (at: number | null, guessed = false) => at !== null && Number.isFinite(at) && at >= now - 60 * 60_000 && at <= now + 8 * 86_400_000 ? { at, guessed } : null;
  const epoch = /\|\s*(\d{10,13})\b/.exec(text);
  if (epoch) { const value = Number(epoch[1]); const found = plausible(value < 1e12 ? value * 1000 : value); if (found) return found; }
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))\b/.exec(text);
  if (iso) { const found = plausible(Date.parse(iso[1]!)); if (found) return found; }
  const relative = /\b(?:try again|retry|resets?|available again|wait)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*(?:and\s*|,\s*)?)+)/i.exec(text)
    ?? /(\d+(?:\.\d+)?\s*(?:天|小时|分钟|秒)(?:\s*\d+(?:\.\d+)?\s*(?:天|小时|分钟|秒))*)\s*(?:后|之后)(?:重置|恢复|再试)/.exec(text); // i18n-ignore: Match original Chinese provider/user text; this is parser data.
  if (relative) {
    let total = 0;
    for (const [, amount, unit] of relative[1]!.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|天|小时|分钟|秒)(?![a-z])/gi)) { // i18n-ignore: Match original Chinese provider/user text; this is parser data.
      const u = unit!.toLowerCase();
// i18n-ignore: Literal Chinese syntax is matched against provider or user content.
// i18n-ignore: Literal Chinese syntax is matched against provider or user content.
// i18n-ignore: Literal Chinese syntax is matched against provider or user content.
      total += Number(amount) * (u.startsWith("d") || u === "天" ? 86_400_000 : u.startsWith("h") || u === "小时" ? 3_600_000 : u.startsWith("s") || u === "秒" ? 1000 : 60_000);
    }
    const found = total > 0 ? plausible(now + total) : null;
    if (found) return found;
  }
  const clock = /\b(?:resets?|reset at|available|try again at|again at|until)\s+(?:on\s+|at\s+)?(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!clock) return null;
  const [, weekdayName, monthName, dayText, yearText, hourText, minuteText, meridiem, zoneText] = clock;
  let hour = Number(hourText), minute = Number(minuteText ?? 0);
  if (!meridiem && !minuteText) return null; // "resets 3" alone is not a time
  if (meridiem) { if (hour < 1 || hour > 12) return null; hour = hour % 12 + (meridiem.toLowerCase() === "pm" ? 12 : 0); }
  if (hour > 23 || minute > 59) return null;
  const named = validZone(zoneText?.trim()), guessed = !named;
  const zone = named ?? validZone(hostZone) ?? "UTC";
  const today = zonedDate(now, zone);
  // The earliest instant not yet past: in a repeated fall-back hour the second one, even a second after the first went by
  // (codex-obs-resume-F5). Only when none is ahead does a notice printed within a minute after the time still mean it.
  const upcoming = (instants: readonly number[]) => instants.find(at => at >= now) ?? instants.findLast(at => at >= now - 60_000);
  if (monthName) {
    const month = MONTHS.indexOf(monthName.toLowerCase().slice(0, 3)), day = Number(dayText);
    const on = (year: number) => new Date(Date.UTC(year, month, day)).getUTCDate() === day ? wallInstants(year, month, day, hour, minute, zone) : [];
    if (yearText) { const instants = on(Number(yearText)); return plausible(upcoming(instants) ?? instants.at(-1) ?? null, guessed); }
    // This year's date up to an hour past (额度应已恢复), else next year's.
    const instants = on(today.year), recent = upcoming(instants) ?? instants.filter(at => at >= now - 60 * 60_000).at(-1);
    return plausible(recent ?? upcoming(on(today.year + 1)) ?? null, guessed);
  }
  for (let offset = 0; offset <= 7; offset++) {
    // Calendar days, not 24-hour steps: the spring-forward day has 23 hours.
    const date = new Date(Date.UTC(today.year, today.month, today.day + offset));
    if (weekdayName && WEEKDAYS[date.getUTCDay()] !== weekdayName.toLowerCase().slice(0, 3)) continue;
    const at = upcoming(wallInstants(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, zone));
    if (at !== undefined) return plausible(at, guessed);
  }
  return null;
}
/** `parseReset` without the guess flag (null when nothing plausible is found); `hostZone` as there. */
export function parseResetTime(text: string, now: number, hostZone?: string): number | null {
  return parseReset(text, now, hostZone)?.at ?? null;
}

/**
 * A limit notice in a closing reply (anchored and short; see LIMIT_STRICT / LIMIT_LOOSE_REPLY), in one message judged on its
 * own ("strict": only the notices that name the user's own limit, F6) or in an error message (broader). `hostZone` is the zone
 * a clock time without one is read in: the devices' zone, the host's only when none is known. Null when it is not one.
 */
export function quotaNotice(text: string | null | undefined, source: "reply" | "strict" | "error", now: number, hostZone?: string): { resetAt: string | null; resetGuessed?: true } | null {
  const notice = string(text).trim();
  if (!notice || notice.length > (source === "error" ? 4000 : MAX_NOTICE) || NOT_QUOTA.test(notice)) return null;
  const reset = () => parseReset(notice, now, hostZone);
  let found: ReturnType<typeof parseReset> | undefined;
  if (source === "error") { if (!LIMIT_ERROR.test(notice) && !LIMIT_IN_ERROR.some(pattern => pattern.test(notice))) return null; }
  else if (!LIMIT_STRICT.some(pattern => pattern.test(notice))) {
    if (source === "strict" || notice.length > SHORT_NOTICE || ZH_WORK.test(notice) || !LIMIT_LOOSE_REPLY.some(pattern => pattern.test(notice))) return null;
    found = reset();
    if (!found && !ZH_ACCOUNT.test(notice) && !ZH_RETURNS.test(notice)) return null;
  }
  found ??= reset();
  return found ? { resetAt: new Date(found.at).toISOString(), ...(found.guessed ? { resetGuessed: true as const } : {}) } : { resetAt: null };
}

/** Items that do not change what a turn produced. */
const NEUTRAL = new Set(["todo", "notification", "compaction", "plugin", "user_message"]);
const OUTPUT = new Set(["assistant_message", "tool_call", "reasoning"]);
/** opencode and pi log every automatic retry as an error item ("Provider retry (attempt 2): 429 …"); the turn usually goes on. */
const RETRY = /^provider retry\b/i;
/** A local command (/compact, /clear, /model …) is not answered by design. */
const LOCAL_COMMAND = /^\/[a-z][\w:-]*(\s|$)/i;

/**
 * The items of the latest turn: everything after the row that started it (all items when there is none). A turn starts at
 * a user message, another agent's message or (Paseo 0.14) a schedule or heartbeat prompt, recorded as tool calls.
 */
function latestTurn(items: readonly TimelineItem[]): { items: readonly TimelineItem[]; prompted: boolean; prompt: string; scheduled: boolean } {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (isTurnStart(item)) return { items: items.slice(index + 1), prompted: true, prompt: turnStartText(item).trim(), scheduled: item.type === "tool_call" && item.agentMessage == null };
  }
  return { items, prompted: false, prompt: "", scheduled: false };
}

/**
 * Why the turn that just ended stopped, from the lifecycle hook's outcome and the Agent's timeline. Canceled turns are the
 * user's own doing and never get a reason. `hostZone`: the zone a reset clock time without one is read in — the devices'
 * zone (DeviceZone.current()), the host's only when none is known; such a reset is marked `resetGuessed`.
 */
export function turnStop(input: { outcome: "completed" | "failed" | "canceled"; error?: string | null; items: readonly TimelineItem[]; now: number; hostZone?: string }): StopReason | null {
  const at = new Date(input.now).toISOString();
  if (input.outcome === "canceled") return null;
  const turn = latestTurn(input.items);
  const stopFor = (quota: ReturnType<typeof quotaNotice>): StopReason | null => quota ? { kind: "quota", ...quota, at } : null;
  const quotaIn = (message: string | null | undefined): StopReason | null => stopFor(quotaNotice(message, "error", input.now, input.hostZone));
  if (input.outcome === "failed") {
    // The failure itself says why; an earlier retried 429 does not make an unrelated failure a limit. Without one, the last error item.
    if (string(input.error).trim()) return quotaIn(input.error);
    const last = turn.items.findLast(item => item.type === "error");
    return last ? quotaIn(string(last.message)) : null;
  }
  // A completed turn went on after its errors, so only one still standing at the end can explain it (retries never do).
  let index = turn.items.length - 1;
  while (index >= 0 && (NEUTRAL.has(turn.items[index]!.type) || turn.items[index]!.type === "reasoning" || turn.items[index]!.type === "error")) {
    const item = turn.items[index]!;
    if (item.type === "error" && !RETRY.test(string(item.message).trim())) { const quota = quotaIn(string(item.message)); if (quota) return quota; }
    index--;
  }
  const parts: string[] = [];
  for (let cursor = index; cursor >= 0 && turn.items[cursor]!.type === "assistant_message"; cursor--) parts.unshift(string(turn.items[cursor]!.text));
  const reply = parts.join("").trim();
  // The notice may follow text the Agent streamed before the limit hit, as its own message: that last message alone counts too,
  // but only as a notice naming the user's own limit (the closing line of a summary about rate-limit work is not one, F6).
  if (reply) return stopFor(quotaNotice(reply, "reply", input.now, input.hostZone) ?? (parts.length > 1 ? quotaNotice(parts.at(-1), "strict", input.now, input.hostZone) : null));
  if (!turn.prompted) return null;
  // Nothing produced: an empty turn, unless it was a local command, a compaction or a schedule's prompt (a heartbeat with
  // nothing to do), which answer nothing by design.
  if (!turn.items.some(item => OUTPUT.has(item.type))) return LOCAL_COMMAND.test(turn.prompt) || turn.scheduled || turn.items.some(item => item.type === "compaction") ? null : { kind: "silent", resetAt: null, at };
  // Output, but the turn ended on a tool call without a closing message.
  return index >= 0 && turn.items[index]!.type === "tool_call" ? { kind: "unfinished", resetAt: null, at } : null;
}

/**
 * For a turn whose end the hooks missed (read later from the projected timeline tail): stopped after tool calls with no
 * closing message → unfinished; nothing at all after the user message → silent. Null when a reply closes it or it is unknown.
 * `hostZone` as in `turnStop`.
 */
export function tailStop(rows: readonly TimelineRow[], userAt: number, now: number, hostZone?: string): StopReason | null {
  const after = rows.filter(row => Date.parse(row.timestamp) >= userAt && row.item.type !== "user_message");
  const prompt = rows.find(row => row.item.type === "user_message" && Date.parse(row.timestamp) >= userAt - 1000);
  if (!prompt) return null;
  return turnStop({ outcome: "completed", items: [prompt.item, ...after.map(row => row.item)], now, hostZone });
}

export let stopLabels: Record<StopKind, string> = { quota: t("sharedStopReason.m005"), silent: t("sharedStopReason.m006"), unfinished: t("sharedStopReason.m007") };

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  stopLabels = { quota: t("sharedStopReason.m005"), silent: t("sharedStopReason.m006"), unfinished: t("sharedStopReason.m007") };
});
