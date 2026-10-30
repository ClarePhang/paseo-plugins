import assert from "node:assert/strict";
import test from "node:test";
import { parseReset, parseResetTime, quotaNotice, tailStop, turnStop, wallInstants, zonedInstant, zoneOffsetMinutes } from "../shared/stop-reason";
import type { TimelineRow } from "../shared/timeline";

// 2026-10-10 21:00 in Los Angeles (PDT, UTC-7).
const now = Date.parse("2026-10-11T04:00:00Z");
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();

test("zone offsets and wall-clock instants follow the zone's own DST", () => {
  assert.equal(zoneOffsetMinutes(Date.parse("2026-07-01T12:00:00Z"), "US/Pacific"), -420);
  assert.equal(zoneOffsetMinutes(Date.parse("2026-12-01T12:00:00Z"), "US/Pacific"), -480);
  assert.equal(zoneOffsetMinutes(Date.parse("2026-12-01T12:00:00Z"), "Asia/Singapore"), 480);
  assert.equal(iso(zonedInstant(2026, 10, 1, 9, 0, "US/Pacific")), "2026-11-01T17:00:00.000Z", "after the fall-back hour PST applies");
  assert.equal(iso(zonedInstant(2026, 9, 10, 15, 0, "US/Pacific")), "2026-10-10T22:00:00.000Z");
});

test("a wall time has two instants in the repeated fall-back hour, one on an ordinary day, and reads past a spring-forward gap", () => {
  // 2026-11-01: 02:00 PDT falls back to 01:00 PST, so 01:30 happens twice.
  assert.deepEqual(wallInstants(2026, 10, 1, 1, 30, "US/Pacific").map(iso), ["2026-11-01T08:30:00.000Z", "2026-11-01T09:30:00.000Z"]);
  assert.deepEqual(wallInstants(2026, 10, 1, 9, 0, "US/Pacific").map(iso), ["2026-11-01T17:00:00.000Z"]);
  assert.deepEqual(wallInstants(2026, 9, 12, 5, 0, "America/New_York").map(iso), ["2026-10-12T09:00:00.000Z"]);
  // 2027-03-14: 02:00 PST jumps to 03:00 PDT; 02:30 does not exist and reads as 03:30 PDT.
  assert.deepEqual(wallInstants(2027, 2, 14, 2, 30, "US/Pacific").map(iso), ["2027-03-14T10:30:00.000Z"]);
  assert.deepEqual(wallInstants(2026, 9, 12, 5, 0, "Asia/Singapore").map(iso), ["2026-10-11T21:00:00.000Z"]);
});

test("reset times: relative, clock with zone, weekday, month day, epoch and ISO", () => {
  assert.equal(iso(parseResetTime("You've hit your usage limit. Upgrade to Pro or try again in 2 hours 30 minutes.", now)), "2026-10-11T06:30:00.000Z");
  assert.equal(iso(parseResetTime("Rate limit reached. Please try again in 20s.", now)), "2026-10-11T04:00:20.000Z");
  assert.equal(iso(parseResetTime("You've hit your limit · resets 5am (US/Pacific)", now)), "2026-10-11T12:00:00.000Z", "the next 5am in LA is tomorrow morning");
  assert.equal(iso(parseResetTime("You've hit your limit · resets 11pm (US/Pacific)", now)), "2026-10-11T06:00:00.000Z", "later tonight");
  assert.equal(iso(parseResetTime("Weekly limit reached ∙ resets Mon 9am (US/Pacific)", now)), "2026-10-12T16:00:00.000Z");
  assert.equal(iso(parseResetTime("Your limit will reset at Oct 13, 9:30am (Asia/Singapore)", now)), "2026-10-13T01:30:00.000Z");
  assert.equal(iso(parseResetTime("Claude AI usage limit reached|1791696000", now)), "2026-10-11T05:20:00.000Z");
  assert.equal(iso(parseResetTime("quota resets 2026-10-11T07:00:00Z", now)), "2026-10-11T07:00:00.000Z");
  assert.equal(iso(parseResetTime("You've hit your limit · resets 3pm", now, "UTC")), "2026-10-11T15:00:00.000Z", "a clock time without a zone is read in the given zone");
  assert.equal(iso(parseResetTime("额度已用完，2 小时后恢复", now)), "2026-10-11T06:00:00.000Z");
  assert.equal(iso(parseResetTime("You've hit your weekly limit · resets Oct 10, 9pm (US/Pacific)", now)), "2026-10-11T04:00:00.000Z", "a reset just past still reads this year");
  assert.equal(parseResetTime("You've hit your weekly limit · resets Feb 30, 9am (US/Pacific)", now), null, "no such date");
  assert.equal(parseResetTime("resets 3", now), null);
  assert.equal(parseResetTime("try again in 30 days", now), null, "implausibly far");
});

test("a clock time without a zone is read in the devices' zone and marked as a guess; a named zone, a duration, an epoch or ISO are not guesses (grok-F2)", () => {
  // The daemon runs in UTC; the devices are in Los Angeles: 5am is 12:00Z there, not 05:00Z.
  assert.deepEqual(parseReset("You've hit your limit · resets 5am", now, "US/Pacific"), { at: Date.parse("2026-10-11T12:00:00Z"), guessed: true });
  assert.deepEqual(parseReset("You've hit your limit · resets 5am", now, "UTC"), { at: Date.parse("2026-10-11T05:00:00Z"), guessed: true });
  assert.deepEqual(parseReset("You've hit your limit · resets Mon 9am", now, "America/New_York"), { at: Date.parse("2026-10-12T13:00:00Z"), guessed: true });
  assert.deepEqual(parseReset("You've hit your weekly limit · resets Oct 12, 9am", now, "US/Pacific"), { at: Date.parse("2026-10-12T16:00:00Z"), guessed: true });
  assert.deepEqual(parseReset("You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 9:45 PM.", now, "US/Pacific"), { at: Date.parse("2026-10-11T04:45:00Z"), guessed: true });
  assert.equal(parseReset("You've hit your limit · resets 5am (PT)", now, "US/Pacific")?.guessed, true, "an unknown zone name is no better than none");
  assert.equal(parseReset("You've hit your limit · resets 5am", now)?.guessed, true, "no zone at all: UTC, still a guess");
  assert.deepEqual(parseReset("You've hit your limit · resets 5am (America/New_York)", now, "US/Pacific"), { at: Date.parse("2026-10-11T09:00:00Z"), guessed: false });
  assert.equal(parseReset("Rate limit reached. Please try again in 20s.", now, "US/Pacific")?.guessed, false);
  assert.equal(parseReset("Claude AI usage limit reached|1791696000", now, "US/Pacific")?.guessed, false);
  assert.equal(parseReset("quota resets 2026-10-11T07:00:00+02:00", now, "US/Pacific")?.guessed, false);
  assert.deepEqual(quotaNotice("You've hit your limit · resets 5am", "reply", now, "US/Pacific"), { resetAt: "2026-10-11T12:00:00.000Z", resetGuessed: true });
  assert.deepEqual(turnStop({ outcome: "completed", items: [{ type: "user_message", text: "继续" }, { type: "assistant_message", text: "You've hit your limit · resets 5am" }], now, hostZone: "US/Pacific" }),
    { kind: "quota", resetAt: "2026-10-11T12:00:00.000Z", resetGuessed: true, at: "2026-10-11T04:00:00.000Z" });
  const row = (seq: number, item: TimelineRow["item"]): TimelineRow => ({ key: String(seq), epoch: "e", seqStart: seq, seqEnd: seq, timestamp: "2026-10-11T03:00:00Z", item });
  assert.equal(tailStop([row(1, { type: "user_message", text: "继续" }), row(2, { type: "assistant_message", text: "You've hit your limit · resets 5am" })], Date.parse("2026-10-11T03:00:00Z"), now, "US/Pacific")?.resetAt,
    "2026-10-11T12:00:00.000Z", "the backfill reads it in the same zone");
});

test("DST: the repeated fall-back hour takes the nearest time not yet past; the 23-hour spring day is not skipped (codex-F7, opus-F37)", () => {
  // 2026-11-01 in US/Pacific: 08:05Z is the first 01:05 (PDT), 09:05Z the second (PST).
  assert.equal(iso(parseResetTime("You've hit your limit · resets 1:30am (US/Pacific)", Date.parse("2026-11-01T09:05:00Z"), "UTC")), "2026-11-01T09:30:00.000Z", "the second 01:30 is still ahead");
  assert.equal(iso(parseResetTime("You've hit your limit · resets 1:30am (US/Pacific)", Date.parse("2026-11-01T08:05:00Z"), "UTC")), "2026-11-01T08:30:00.000Z", "the first 01:30 comes first");
  assert.equal(iso(parseResetTime("You've hit your limit · resets 1:30am", Date.parse("2026-11-01T09:05:00Z"), "US/Pacific")), "2026-11-01T09:30:00.000Z", "the same in the devices' zone");
  // Saturday 2027-03-13 23:30 PST: the next 5am is Sunday 05:00 PDT, not Monday.
  assert.equal(iso(parseResetTime("You've hit your limit · resets 5am (US/Pacific)", Date.parse("2027-03-13T23:30:00-08:00"), "UTC")), "2027-03-14T12:00:00.000Z");
  assert.equal(iso(parseResetTime("You've hit your limit · resets 5am (US/Pacific)", Date.parse("2027-03-13T22:59:00-08:00"), "UTC")), "2027-03-14T12:00:00.000Z");
  assert.equal(iso(parseResetTime("You've hit your limit · resets Sun 5am (US/Pacific)", Date.parse("2027-03-13T23:30:00-08:00"), "UTC")), "2027-03-14T12:00:00.000Z", "weekdays on the zone's calendar");
  assert.equal(iso(parseResetTime("You've hit your limit · resets 2:30am (US/Pacific)", Date.parse("2027-03-13T23:30:00-08:00"), "UTC")), "2027-03-14T10:30:00.000Z", "a skipped time reads just past the skip");
  assert.equal(iso(parseResetTime("You've hit your weekly limit · resets Nov 1, 1:30am (US/Pacific)", Date.parse("2026-11-01T09:05:00Z"), "UTC")), "2026-11-01T09:30:00.000Z", "a dated repeated time too");
  assert.equal(iso(parseResetTime("You've hit your limit · resets 5am (US/Pacific)", Date.parse("2026-10-31T23:30:00-07:00"), "UTC")), "2026-11-01T13:00:00.000Z", "fall-back night: 05:00 PST");
});

test("DST: right after the first of two 01:30s the second one is the reset; a minute's grace only when neither is ahead (codex-obs-resume-F5)", () => {
  const notice = "You've hit your limit · resets 1:30am (US/Pacific)", first = Date.parse("2026-11-01T08:30:00Z"), second = "2026-11-01T09:30:00.000Z";
  // 1, 30 and 59 seconds after the first 01:30 (PDT), and exactly a minute after it: the second 01:30 (PST) is still ahead.
  for (const seconds of [1, 30, 59, 60]) assert.equal(iso(parseResetTime(notice, first + seconds * 1000, "UTC")), second, `${seconds} s after the first 01:30`);
  assert.equal(iso(parseResetTime(notice, first - 1000, "UTC")), "2026-11-01T08:30:00.000Z", "a second before the first: the first");
  // The review's case: the devices' zone, no zone in the notice (a guess either way).
  assert.deepEqual(parseReset("You've hit your limit · resets 1:30am", first + 30_000, "US/Pacific"), { at: Date.parse(second), guessed: true });
  assert.equal(iso(parseResetTime("You've hit your weekly limit · resets Nov 1, 1:30am (US/Pacific)", first + 30_000, "UTC")), second, "a dated notice too");
  assert.equal(iso(parseResetTime("You've hit your weekly limit · resets Nov 1, 2026, 1:30am (US/Pacific)", first + 30_000, "UTC")), second, "and one with its year");
  // Both past: the second one within a minute after it (额度应已恢复), the minute itself included; past that, the next day's.
  assert.equal(iso(parseResetTime(notice, Date.parse(second) + 30_000, "UTC")), second);
  assert.equal(iso(parseResetTime(notice, Date.parse(second) + 60_000, "UTC")), second, "exactly a minute after the second");
  assert.equal(iso(parseResetTime(notice, Date.parse(second) + 61_000, "UTC")), "2026-11-02T09:30:00.000Z");
  // An ordinary day has no later 01:30 that day: half a minute past it still means the one just gone, not tomorrow's.
  assert.equal(iso(parseResetTime(notice, Date.parse("2026-10-11T08:30:30Z"), "UTC")), "2026-10-11T08:30:00.000Z");
  assert.equal(iso(parseResetTime(notice, Date.parse("2026-10-11T08:31:00Z"), "UTC")), "2026-10-11T08:30:00.000Z", "a whole minute: still the grace");
  assert.equal(iso(parseResetTime(notice, Date.parse("2026-10-11T08:31:01Z"), "UTC")), "2026-10-12T08:30:00.000Z");
});

test("limit notices: anchored in replies, broader in errors; context limits are not quota", () => {
  assert.deepEqual(quotaNotice("You've hit your limit · resets 5am (US/Pacific)", "reply", now), { resetAt: "2026-10-11T12:00:00.000Z" });
  assert.ok(quotaNotice("Claude AI usage limit reached|1791696000", "reply", now));
  assert.ok(quotaNotice("5-hour limit reached ∙ resets 3pm", "reply", now));
  assert.ok(quotaNotice("Rate limit reached. Please try again in 20s.", "reply", now));
  assert.equal(quotaNotice("I added retries for HTTP 429 responses and a rate limit test.", "reply", now), null, "prose about rate limits is not a stop");
  assert.equal(quotaNotice("Done. You've hit your limit on how many tests can run in parallel? No — fixed.", "reply", now), null);
  assert.deepEqual(quotaNotice("429 Too Many Requests: rate_limit_error", "error", now), { resetAt: null });
  assert.ok(quotaNotice("Error: insufficient_quota", "error", now));
  assert.equal(quotaNotice("prompt is too long: 210000 tokens > 200000 maximum context length", "error", now), null);
  assert.equal(quotaNotice("ENOENT: no such file", "error", now), null);
});

test("closing replies about rate-limit work are not limit notices (opus-F35)", () => {
  const work = [
    "Rate limited requests now return 429 and the client will retry with backoff.",
    "Rate limit exceeded errors are now caught; the worker waits and retries the batch.",
    "Usage limit reached events are logged now, and the job retries after the window resets.",
    "超出配额时现在会自动降级到备用模型，相关测试已补上。",
    "达到上限后不再重试，已加上单测。",
    "超过限额的请求会直接返回 429，客户端按 Retry-After 重试。",
    "超出配额后恢复为默认模型，已经补了测试。",
    "配额已用完时会提示用户切换模型，并记录一条日志。",
    `Rate limit exceeded is now handled in the client. ${"The worker backs off and tries again in 5 minutes when it sees one. ".repeat(5)}`,
  ];
  for (const text of work) {
    assert.equal(quotaNotice(text, "reply", now, "UTC"), null, text);
    const stop = turnStop({ outcome: "completed", items: [{ type: "user_message", text: "fix it" }, { type: "tool_call", name: "Edit" }, { type: "assistant_message", text }], now, hostZone: "UTC" });
    assert.equal(stop, null, text);
  }
  // A short loose notice with a reset time, or addressed to the user's account in Chinese, still counts.
  assert.equal(quotaNotice("Rate limit exceeded, try again in 45 minutes", "reply", now)?.resetAt, "2026-10-11T04:45:00.000Z");
  assert.deepEqual(quotaNotice("您已达到本周使用额度上限，将于 3 天后重置。", "reply", now), { resetAt: "2026-10-14T04:00:00.000Z" });
  assert.deepEqual(quotaNotice("你已用完今日的调用额度。", "reply", now), { resetAt: null });
  assert.deepEqual(quotaNotice("当前账号已达到 5 小时用量上限", "reply", now), { resetAt: null });
  assert.deepEqual(quotaNotice("已达到本周用量上限，将于明天重置", "reply", now), { resetAt: null });
  assert.deepEqual(quotaNotice("额度已用完，2 小时后恢复", "reply", now), { resetAt: "2026-10-11T06:00:00.000Z" });
  assert.equal(quotaNotice("已达到 5 小时用量上限", "reply", now), null, "neither addressed to the user nor saying when it comes back");
});

test("a closing reply about rate-limit work is no notice with a duration in it either, nor its last message alone (F6)", () => {
  const user = { type: "user_message", text: "fix it" }, edit = { type: "tool_call", name: "Edit" };
  // The four of the review: each read as a limit, with a reset time out of its duration.
  const work = [
    "Usage limit exceeded now returns 429; clients should retry after 60s.",
    "Rate limit handling done — requests retry after 2 minutes on 429.",
    "超出配额时现在会自动降级到备用模型，5 分钟后恢复。",
    "Rate limit exceeded responses now retry after 30 seconds with jitter.",
    // And close variants: a duration phrase further on in the same sentence, or the change described in other words.
    "Rate limit exceeded responses now try again in 30 seconds.",
    "Usage limit reached events now reset after 5 minutes.",
    "达到上限后不再重试，已加上单测，5 分钟后恢复。",
    "超出配额后改为备用模型，2 小时后恢复。",
    "额度已用完时会提示用户，并在 1 小时后恢复。",
    "超过限额的请求新增了退避，30 秒后恢复。",
  ];
  for (const text of work) {
    assert.equal(quotaNotice(text, "reply", now, "UTC"), null, text);
    assert.equal(turnStop({ outcome: "completed", items: [user, edit, { type: "assistant_message", text }], now, hostZone: "UTC" }), null, text);
  }
  // A summary streamed first, its last line as a message of its own: the whole reply opens with "Done.", the last line alone is
  // judged on the strict notices only.
  const parts = [{ type: "assistant_message", text: "Done. Summary of the change:" }, { type: "assistant_message", text: "Rate limit exceeded responses now retry after 30 seconds with jitter." }];
  assert.equal(turnStop({ outcome: "completed", items: [user, edit, ...parts], now, hostZone: "UTC" }), null);
  assert.equal(quotaNotice(parts[1]!.text, "strict", now, "UTC"), null);
  const handled = [parts[0]!, { type: "assistant_message", text: "Rate limit exceeded, retry after 60s is now handled by the client." }];
  assert.equal(turnStop({ outcome: "completed", items: [user, edit, ...handled], now, hostZone: "UTC" }), null, "a last line a short reply of its own would pass for a notice");
  assert.equal(quotaNotice("You've hit your limit · resets 5am (US/Pacific)", "strict", now)?.resetAt, "2026-10-11T12:00:00.000Z");
  // Real notices still count: the reset right after the limit, in the same notice.
  assert.equal(quotaNotice("Rate limit reached. Please try again in 20s.", "reply", now)?.resetAt, "2026-10-11T04:00:20.000Z");
  assert.equal(quotaNotice("Rate limit exceeded, try again in 45 minutes", "reply", now)?.resetAt, "2026-10-11T04:45:00.000Z");
  assert.equal(quotaNotice("Rate limited. Retry after 90 seconds.", "reply", now)?.resetAt, "2026-10-11T04:01:30.000Z");
  assert.equal(quotaNotice("Usage limit reached · resets 5am (US/Pacific)", "reply", now)?.resetAt, "2026-10-11T12:00:00.000Z");
  assert.equal(quotaNotice("Usage limit reached. Your limit will reset at 5am (US/Pacific).", "reply", now)?.resetAt, "2026-10-11T12:00:00.000Z");
  assert.equal(quotaNotice("You've hit the rate limit. Try again in 5 minutes.", "reply", now)?.resetAt, "2026-10-11T04:05:00.000Z");
  assert.equal(quotaNotice("Claude AI usage limit reached|1791696000", "reply", now)?.resetAt, "2026-10-11T05:20:00.000Z");
  assert.deepEqual(quotaNotice("您已达到本周使用额度上限，将于 3 天后重置。", "reply", now), { resetAt: "2026-10-14T04:00:00.000Z" });
  assert.deepEqual(quotaNotice("额度已用完，2 小时后恢复", "reply", now), { resetAt: "2026-10-11T06:00:00.000Z" });
  // A failed turn's own error keeps its broader reading.
  assert.ok(quotaNotice("Usage limit exceeded now; retry later", "error", now));
});

test("a bare session, weekly or daily limit counts as the whole notice or with when it comes back right after it, never as the start of a summary (codex-obs-attn-F2)", () => {
  const user = { type: "user_message", text: "fix limit error handling" }, edit = { type: "tool_call", callId: "edit", name: "Edit", status: "completed" };
  const work = [
    // The two of the review.
    "Session limit reached errors are now handled; the worker retries after 60 seconds.",
    "Weekly limit exceeded events are now logged, and the tests pass.",
    // Their kin: a noun right after the phrase, or the change it made.
    "Daily limit hit counter now resets at midnight UTC and is covered by a test.",
    "5-hour limit reached banner is shown once per session now.",
    "Session limit reached handling: the client now waits and retries.",
  ];
  for (const text of work) {
    assert.equal(quotaNotice(text, "reply", now, "UTC"), null, text);
    assert.equal(quotaNotice(text, "strict", now, "UTC"), null, `${text} (its last message alone)`);
    assert.equal(turnStop({ outcome: "completed", items: [user, edit, { type: "assistant_message", text }], now, hostZone: "UTC" }), null, text);
    assert.equal(turnStop({ outcome: "completed", items: [user, edit, { type: "assistant_message", text: "Done." }, { type: "assistant_message", text }], now, hostZone: "UTC" }), null, `${text} (after a first message)`);
  }
  // Real notices: the whole notice, or when it comes back right after the phrase (as reply, as its last message, as a failure).
  const notices: Array<[string, string | null]> = [
    ["5-hour limit reached ∙ resets 3pm (US/Pacific)", "2026-10-11T22:00:00.000Z"],
    ["5-hour limit reached · resets 3pm (US/Pacific)", "2026-10-11T22:00:00.000Z"],
    ["Weekly limit reached ∙ resets Mon 9am (US/Pacific)", "2026-10-12T16:00:00.000Z"],
    ["Session limit reached. Try again in 2 hours.", "2026-10-11T06:00:00.000Z"],
    ["Daily limit exceeded — please try again in 45 minutes", "2026-10-11T04:45:00.000Z"],
    ["Daily limit exceeded, please wait", null],
    ["Session limit reached", null],
    ["Weekly limit hit.", null],
  ];
  for (const [text, resetAt] of notices) {
    assert.equal(quotaNotice(text, "reply", now, "UTC")?.resetAt, resetAt, text);
    assert.equal(quotaNotice(text, "strict", now, "UTC")?.resetAt, resetAt, `${text} (strict)`);
    assert.ok(quotaNotice(`Error: ${text}`, "error", now, "UTC"), `${text} (as a failure)`);
    assert.equal(turnStop({ outcome: "completed", items: [{ type: "user_message", text: "继续" }, { type: "assistant_message", text: "我先跑一遍测试。" }, { type: "assistant_message", text }], now, hostZone: "UTC" })?.kind, "quota", `${text} (after streamed text)`);
  }
  // A clock time without a zone is still read in the devices' zone, and the notices that name the account are unchanged.
  assert.deepEqual(quotaNotice("5-hour limit reached ∙ resets 3pm", "reply", now, "US/Pacific"), { resetAt: "2026-10-11T22:00:00.000Z", resetGuessed: true });
  assert.ok(quotaNotice("You've hit your session limit · resets 3pm (US/Pacific)", "reply", now, "UTC"));
  assert.ok(quotaNotice("You've hit your weekly limit", "strict", now, "UTC"));
});

test("Claude Code 2.1's limit names, spend limit and credits are notices, and a failure reason in their words is a limit (opus-F36)", () => {
  const at = Date.parse("2026-10-11T10:00:00Z");
  for (const text of ["You've hit your session limit · resets 3pm (UTC)", "You've hit your weekly limit · resets Oct 14, 9am (UTC)", "You've hit your Opus limit · resets Mon 9am (UTC)",
    "You've hit your Sonnet limit · resets 5pm (UTC)", "You've hit your Fable limit · resets 5pm (UTC)", "You've hit your usage credit limit · resets Nov 1 (UTC)",
    "You've hit your monthly spend limit · raise it at https://example.test/settings", "You're out of usage credits · add funds to continue", "You’ve hit your limit · resets 5am (UTC)"]) {
    assert.ok(quotaNotice(text, "reply", at, "UTC"), text);
    assert.ok(quotaNotice(text, "error", at, "UTC"), `${text} (as a failure)`);
  }
  assert.equal(quotaNotice("You've hit your Fable limit · resets 5pm (UTC)", "reply", at, "UTC")?.resetAt, "2026-10-11T17:00:00.000Z");
  assert.equal(quotaNotice("You've hit your usage credit limit · resets Nov 1 (UTC)", "reply", at, "UTC")?.resetAt, null, "a date without a time stays unknown");
  const user = { type: "user_message", text: "继续" };
  assert.deepEqual(turnStop({ outcome: "failed", error: "You've hit your limit · resets 5am (US/Pacific)", items: [user], now: Date.parse("2026-10-11T03:00:00Z"), hostZone: "UTC" }),
    { kind: "quota", resetAt: "2026-10-11T12:00:00.000Z", at: "2026-10-11T03:00:00.000Z" });
  assert.equal(turnStop({ outcome: "failed", error: "Claude Code process exited: You've hit your weekly limit · resets Mon 9am (US/Pacific)", items: [user], now, hostZone: "UTC" })?.resetAt, "2026-10-12T16:00:00.000Z");
  assert.equal(turnStop({ outcome: "failed", error: "Error: You're out of usage credits", items: [user], now })?.kind, "quota");
  assert.equal(turnStop({ outcome: "failed", error: "Tool output exceeded the limit of 30000 characters", items: [user], now }), null, "other limits are not a usage limit");
  // The notice arrived as its own message after text the Agent had already streamed.
  assert.equal(turnStop({ outcome: "completed", items: [user, { type: "assistant_message", text: "我先跑一遍测试。" }, { type: "assistant_message", text: "You've hit your limit · resets 5am (US/Pacific)" }], now })?.resetAt, "2026-10-11T12:00:00.000Z");
});

test("turn stops: quota reply, failed with a limit error, silent and unfinished turns", () => {
  const user = { type: "user_message", text: "继续" };
  assert.equal(turnStop({ outcome: "completed", items: [user, { type: "tool_call", name: "Bash" }, { type: "assistant_message", text: "全部完成。" }], now }), null);
  assert.deepEqual(turnStop({ outcome: "completed", items: [user, { type: "assistant_message", text: "You've hit your limit · resets 5am (US/Pacific)" }], now }),
    { kind: "quota", resetAt: "2026-10-11T12:00:00.000Z", at: "2026-10-11T04:00:00.000Z" });
  assert.equal(turnStop({ outcome: "failed", error: "Rate limit exceeded, try again in 45 minutes", items: [user], now })?.resetAt, "2026-10-11T04:45:00.000Z");
  assert.equal(turnStop({ outcome: "failed", error: "spawn ENOENT", items: [user], now }), null, "other failures stay plain errors");
  assert.equal(turnStop({ outcome: "completed", items: [{ type: "assistant_message", text: "上一轮" }, user, { type: "notification", level: "info", message: "x" }], now })?.kind, "silent");
  assert.equal(turnStop({ outcome: "completed", items: [user, { type: "assistant_message", text: "先看看" }, { type: "tool_call", name: "Bash" }, { type: "todo", items: [] }], now })?.kind, "unfinished");
  assert.equal(turnStop({ outcome: "canceled", items: [user], now }), null);
  assert.equal(turnStop({ outcome: "completed", items: [], now }), null, "no prompt in the timeline: unknown, not silent");
});

test("retries, overloads, local commands and compactions are not stops", () => {
  const user = { type: "user_message", text: "继续" };
  const retry = (message: string) => ({ type: "error", message: `Provider retry (attempt 1): ${message}` });
  const done = { type: "assistant_message", text: "完成。" };
  assert.equal(turnStop({ outcome: "completed", items: [user, retry("429 Too Many Requests"), done], now }), null, "a retried 429 the turn got past");
  assert.equal(turnStop({ outcome: "completed", items: [user, retry("overloaded_error"), done], now }), null);
  assert.equal(quotaNotice("529 overloaded_error: Overloaded", "error", now), null, "the provider's capacity, not the user's limit");
  assert.equal(turnStop({ outcome: "failed", error: "read ECONNRESET", items: [user, retry("rate limit exceeded")], now }), null, "the failure's own reason decides");
  assert.equal(turnStop({ outcome: "failed", error: null, items: [user, retry("Rate limit exceeded, try again in 45 minutes")], now })?.resetAt, "2026-10-11T04:45:00.000Z", "without one, the last error item");
  assert.equal(turnStop({ outcome: "completed", items: [user, { type: "assistant_message", text: "好的" }, { type: "error", message: "Usage limit reached" }], now })?.kind, "quota", "an error still standing at the end");
  assert.equal(turnStop({ outcome: "completed", items: [{ type: "user_message", text: "/compact" }], now }), null, "a local command answers nothing by design");
  assert.equal(turnStop({ outcome: "completed", items: [user, { type: "compaction", status: "completed" }], now }), null);
  assert.equal(turnStop({ outcome: "completed", items: [{ type: "user_message", text: "/srv/app 下的日志看一下" }], now })?.kind, "silent", "a path is not a command");
  const row = (seq: number, item: TimelineRow["item"]): TimelineRow => ({ key: String(seq), epoch: "e", seqStart: seq, seqEnd: seq, timestamp: "2026-10-11T03:00:00Z", item });
  assert.equal(tailStop([row(1, { type: "user_message", text: "/compact" })], Date.parse("2026-10-11T03:00:00Z"), now), null, "the tail keeps the prompt's text");
});

test("a missed end read from the timeline tail", () => {
  const row = (seq: number, item: TimelineRow["item"], at: string): TimelineRow => ({ key: String(seq), epoch: "e", seqStart: seq, seqEnd: seq, timestamp: at, item });
  const userAt = Date.parse("2026-10-11T03:00:00Z");
  const prompt = row(1, { type: "user_message", text: "继续" }, "2026-10-11T03:00:00Z");
  assert.equal(tailStop([prompt, row(2, { type: "tool_call", name: "Edit" }, "2026-10-11T03:02:00Z")], userAt, now)?.kind, "unfinished");
  assert.equal(tailStop([prompt], userAt, now)?.kind, "silent");
  assert.equal(tailStop([prompt, row(2, { type: "assistant_message", text: "好了" }, "2026-10-11T03:03:00Z")], userAt, now), null);
  assert.equal(tailStop([row(5, { type: "tool_call", name: "Edit" }, "2026-10-11T03:02:00Z")], userAt, now), null, "the tail does not reach the prompt: unknown");
});

test("a schedule's prompt or another agent's message starts the turn (Paseo 0.14 records them as tool calls)", () => {
  const user = { type: "user_message", text: "检查一下" } as const, reply = { type: "assistant_message", text: "都好。" } as const;
  const heartbeat = { type: "tool_call", name: "heartbeat", callId: "paseo-system:3f2a", status: "completed", detail: { type: "plain_text", text: "Schedule \"nightly\" fired.\n看看有没有新任务" } } as const;
  const shell = { type: "tool_call", name: "Bash", callId: "toolu_1", status: "completed", detail: { type: "shell", command: "ls" } } as const;
  // A heartbeat with nothing to do answers nothing by design; the earlier turn's reply is not this turn's.
  assert.equal(turnStop({ outcome: "completed", items: [user, reply, heartbeat] as never, now }), null);
  assert.deepEqual(turnStop({ outcome: "completed", items: [user, reply, heartbeat, shell] as never, now }), { kind: "unfinished", resetAt: null, at: new Date(now).toISOString() });
  assert.equal(turnStop({ outcome: "completed", items: [user, reply, heartbeat, shell, reply] as never, now }), null);
  // Another agent's message that got no answer at all is silent, like a user message.
  const message = { type: "tool_call", name: "agent_message", callId: "paseo-agent-message:m1", status: "completed", agentMessage: { event: "finished", sender: { id: "child" }, text: "做完了" }, detail: { type: "plain_text", text: "做完了" } } as const;
  assert.deepEqual(turnStop({ outcome: "completed", items: [user, reply, message] as never, now }), { kind: "silent", resetAt: null, at: new Date(now).toISOString() });
  // A tool that is merely named "heartbeat" is a step of the user's turn.
  assert.deepEqual(turnStop({ outcome: "completed", items: [user, { ...heartbeat, callId: "toolu_2" }] as never, now }), { kind: "unfinished", resetAt: null, at: new Date(now).toISOString() });
});
