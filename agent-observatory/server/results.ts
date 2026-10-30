import { translator } from "../shared/i18n";
import { t } from "../shared/text";
import type { PaseoApi } from "./paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getAgentResult, type AgentResult, type AgentResultResponse, type ResultExcerpt } from "../shared/results";
import { contentRevision } from "./revision";
import { excerptText } from "../shared/evidence";
import { normalizeTimelinePage, object, projectTimelineRows, string, type TimelineRow } from "../shared/timeline";
import type { AgentTelemetry } from "../shared/telemetry";
import { finalReplyAfter, replyAsksUser, replyNudge, type ReplyNudge } from "../shared/reply";
import { findChangeRequest } from "../shared/change-request";
import type { ChangeRequestLink } from "../shared/telemetry";
import { applyTelemetry, knownCompletionAt, normalizeAgent, observedRound, type AgentSource } from "../shared/model";
import { isTurnStart, turnStartText, type TurnStartItem } from "../shared/turn-start";

/** The final reply of a stopped Agent, reduced to what 待回复 needs; no text leaves the result reader this way. */
export type ReplyObservation = { userAt: string; at: string; asks: boolean; link?: ChangeRequestLink | null; nudge?: ReplyNudge | null };
/** Only the link to a merge or pull request leaves the reply (opus-B16), and only when there is one. */
const linkIn = (text: string) => { const link = findChangeRequest(text); return link ? { link } : {}; };

const PROMPT_STAMP_SKEW_MS = 1000;
const finiteTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const reference = (agentId: string, row: TimelineRow) => `${agentId}:${row.epoch}:${row.seqStart}-${row.seqEnd}`;
type ExpectedSource = { expectedLastUserMessageAt?: string | null; expectedAttentionTimestamp?: string | null };
function verifySource(source: Record<string, unknown>, expected: ExpectedSource) {
  if (expected.expectedLastUserMessageAt !== undefined && (string(source.lastUserMessageAt) || null) !== expected.expectedLastUserMessageAt
    || expected.expectedAttentionTimestamp !== undefined && (string(source.attentionTimestamp) || null) !== expected.expectedAttentionTimestamp) {
    throw new Error(t("serverResults.m001"));
  }
}
function excerpt(agentId: string, row: TimelineRow): ResultExcerpt {
  const full = string(row.item.text) || string(row.item.message) || turnStartText(row.item as TurnStartItem) || t("serverResults.m002");
  const clipped = excerptText(full, 60_000);
  return { ...clipped, ref: reference(agentId, row), at: finiteTime(row.timestamp) === null ? null : row.timestamp };
}
function uniqueRows(rows: TimelineRow[]): TimelineRow[] {
  return projectTimelineRows([...new Map(rows.map(row => [row.key, row])).values()].sort((a, b) => a.seqStart - b.seqStart));
}

/** A deliberately small shell recognizer; embedded programs never count as tests. */
export function recognizeTestCommands(command: string): { command: string; safeSuccess: boolean; safeFailure: boolean } | null {
  if (!command.trim() || command.includes("<<") || command.includes("$(") || command.includes("`")) return null;
  const segments: string[] = [], operators: string[] = [];
  let quote: "'" | '"' | null = null, escaped = false, segment = "";
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (escaped) { segment += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { segment += character; escaped = true; continue; }
    if (quote) { segment += character; if (character === quote) quote = null; continue; }
    if (character === "'" || character === '"') { quote = character; segment += character; continue; }
    if (character === "(" || character === ")" || character === "{" || character === "}") return null;
    if (character === ";" || character === "\n" || character === "|" || character === "&") {
      segments.push(segment.trim()); segment = "";
      const paired = command[index + 1] === character && (character === "|" || character === "&");
      operators.push(paired ? character + command[++index] : character); continue;
    }
    segment += character;
  }
  if (quote || escaped) return null;
  segments.push(segment.trim());
  const isTest = (text: string): boolean => {
    let words = (text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(word => word.replace(/^(['"])(.*)\1$/, "$2"));
    if (words[0] === "env") words = words.slice(1);
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words = words.slice(1);
    if (!words.length || words.some(word => ["--version", "--help", "-h", "-V"].includes(word))) return false;
    const runner = words[0].split("/").at(-1)!;
    if (["npx", "bunx"].includes(runner)) { let index = 1; while (["--yes", "-y", "--no-install"].includes(words[index])) index++; return isTest(words.slice(index).join(" ")); }
    if (["npm", "pnpm", "yarn", "bun"].includes(runner)) {
      if (words[1] === "exec") return isTest(words.slice(words[2] === "--" ? 3 : 2).join(" "));
      const script = words[1] === "run" ? words[2] : words[1];
      return /^(?:test(?::[\w-]+)?|typecheck)$/.test(script ?? "");
    }
    if (["pytest", "vitest", "jest", "tsc"].includes(runner)) return true;
    if (runner === "playwright") return words[1] === "test";
    if (runner === "go" || runner === "cargo") return words[1] === "test";
    if (/^python\d*(?:\.\d+)?$/.test(runner)) return words[1] === "-m" && ["pytest", "unittest"].includes(words[2]);
    if (runner === "node") return words[1] === "--test";
    return false;
  };
  const tests = segments.filter(isTest);
  if (!tests.length) return null;
  const safeSuccess = operators.every(operator => operator === "&&");
  return { command: tests.join(" && "), safeSuccess, safeFailure: safeSuccess && tests.length === segments.length };
}

/** Reads a bounded head and tail independently; an old tail never masquerades as the first instruction. */
export async function fetchAgentResult(paseo: PaseoApi, agentId: string, observed?: AgentTelemetry | null, expected: ExpectedSource = {}, onReply?: (reply: ReplyObservation) => void): Promise<AgentResult> {
  const handle = paseo.agents.ref(agentId);
  const initial = await handle.refresh();
  if (!initial?.agent) throw new Error(t("serverResults.m003"));
  verifySource(object(initial.agent), expected);
  let [headRaw, tailRaw] = await Promise.all([
    handle.timeline.refetch({ direction: "after", limit: 100, projection: "projected" }),
    handle.timeline.refetch({ direction: "tail", limit: 100, projection: "projected" }),
  ]);
  let head = normalizeTimelinePage(headRaw), tail = normalizeTimelinePage(tailRaw);
  if (head.epoch !== tail.epoch) {
    [headRaw, tailRaw] = await Promise.all([handle.timeline.refetch({ direction: "after", limit: 100, projection: "projected" }), handle.timeline.refetch({ direction: "tail", limit: 100, projection: "projected" })]);
    head = normalizeTimelinePage(headRaw); tail = normalizeTimelinePage(tailRaw);
  }
  if (head.epoch !== tail.epoch) throw new Error(t("serverResults.m004"));
  let headRows = head.rows, tailRows = tail.rows, pages = 2;
  let first = headRows.find(row => row.item.type === "user_message");
  const cursors = new Set<string>();
  while (!first && head.hasNewer && head.endCursor && pages < 7) {
    const key = `head:${head.endCursor.epoch}:${head.endCursor.seq}`;
    if (cursors.has(key)) break; cursors.add(key);
    const raw = await handle.timeline.refetch({ direction: "after", cursor: head.endCursor, limit: 100, projection: "projected" });
    const next = normalizeTimelinePage(raw); pages++;
    if (next.epoch !== head.epoch || next.reset) break;
    head = next; headRows = uniqueRows([...headRows, ...next.rows]); first = headRows.find(row => row.item.type === "user_message");
  }
  while (tail.hasOlder && tail.startCursor && !tailRows.some(row => isTurnStart(row.item as TurnStartItem)) && pages < 12) {
    const key = `tail:${tail.startCursor.epoch}:${tail.startCursor.seq}`;
    if (cursors.has(key)) break; cursors.add(key);
    const next = normalizeTimelinePage(await handle.timeline.refetch({ direction: "before", cursor: tail.startCursor, limit: 100, projection: "projected" })); pages++;
    if (next.epoch !== tail.epoch || next.reset) break;
    tail = next; tailRows = uniqueRows([...next.rows, ...tailRows]);
  }
  tailRows = projectTimelineRows(tailRows);
  const confirmed = await handle.refresh();
  const source = object(confirmed?.agent ?? handle.current?.() ?? object(tailRaw).agent ?? initial.agent);
  verifySource(source, expected);
  const isRunning = source.status === "running" || source.status === "initializing" || !!source.activeTurn;
  // The row that started the latest turn: a user message, or (as tool calls) another agent's message or a schedule's prompt.
  const latestUser = [...tailRows].reverse().find(row => isTurnStart(row.item as TurnStartItem));
  const userAt = finiteTime(source.lastUserMessageAt);
  // The host stamps the prompt row and the Agent's lastUserMessageAt separately, a millisecond or two apart; only a prompt
  // clearly older than the latest one means the tail has not caught up with a newer turn yet.
  const staleTurn = !!latestUser && userAt !== null && finiteTime(latestUser.timestamp) !== null && finiteTime(latestUser.timestamp)! < userAt - PROMPT_STAMP_SKEW_MS;
  const replies = tailRows.filter(row => !staleTurn && row.item.type === "assistant_message" && !!(string(row.item.text).trim() || string(row.item.message).trim()) && (latestUser ? row.seqStart > latestUser.seqEnd
    : userAt === null || finiteTime(row.timestamp) !== null && finiteTime(row.timestamp)! >= userAt));
  const reply = replies.at(-1);
  const replyIsCurrent = !!reply && (!!latestUser || userAt !== null && finiteTime(reply.timestamp) !== null && finiteTime(reply.timestamp)! >= userAt);
  const finishedAt = finiteTime(source.attentionTimestamp);
  const observedEnd = finiteTime(observed?.turnEndedAt);
  const completion = source.attentionReason === "finished" && (userAt === null || finishedAt !== null && finishedAt >= userAt)
    || observed?.outcome === "completed" && observedEnd !== null && (userAt === null || observedEnd >= userAt);
  const isFinal = !isRunning && source.status !== "error" && source.attentionReason !== "error" && !!completion && replyIsCurrent;
  const window = object(object(headRaw).window);
  const firstInputConfirmed = !!first && typeof window.minSeq === "number" && window.minSeq <= 1 && !normalizeTimelinePage(headRaw).hasOlder && !normalizeTimelinePage(headRaw).gap;
  const artifacts: AgentResult["artifacts"] = [], testEvidence: AgentResult["testEvidence"] = [];
  const artifactKeys = new Set<string>();
  const tools = tailRows.filter(row => row.item.type === "tool_call" && !isTurnStart(row.item as TurnStartItem));
  for (const row of [...tools].reverse()) {
    const detail = object(row.item.detail), name = string(row.item.name), file = string(detail.filePath), command = string(detail.command);
    if (file && /write|edit|file_change|patch/.test(`${string(detail.type)} ${name}`) && !artifactKeys.has(file) && artifacts.length < 40) {
      artifactKeys.add(file); artifacts.push({ kind: "file", path: file.slice(0, 2000), label: file.split(/[\\/]/).pop()?.slice(0, 500) || file.slice(0, 500), ref: reference(agentId, row) });
    }
    const tests = recognizeTestCommands(command);
    if (testEvidence.length < 20 && tests) {
      const output = string(detail.output) || string(detail.result) || string(detail.text) || string(row.item.error);
      const failed = row.item.status === "failed" || typeof detail.exitCode === "number" && detail.exitCode !== 0;
      testEvidence.push({ command: excerptText(tests.command, 1000).text, text: excerptText(output, 4000).text,
        outcome: failed && tests.safeFailure ? "failed" : !failed && tests.safeSuccess && detail.exitCode === 0 && row.item.status === "completed" ? "passed" : "unknown", ref: reference(agentId, row) });
    }
  }
  if (reply) for (const match of string(reply.item.text).matchAll(/https?:\/\/[^\s<>\)\]"']+/g)) {
    const url = match[0]; if (artifactKeys.has(url) || artifacts.length >= 40) continue;
    artifactKeys.add(url); artifacts.push({ kind: "url", path: url.slice(0, 2000), label: url.slice(0, 500), ref: reference(agentId, reply) });
  }
  if (onReply && !isRunning && source.status === "idle" && userAt !== null) {
    // Opening a session reads its tail anyway: record whether its final reply asks the user (the backfill never loads idle sessions).
    const final = finalReplyAfter(tailRows, userAt), updated = finiteTime(source.updatedAt);
    if (final) onReply({ userAt: new Date(userAt).toISOString(), at: new Date(Math.min(Date.parse(final.at), updated !== null && updated >= userAt ? updated : Infinity)).toISOString(), asks: replyAsksUser(final.text), nudge: replyNudge(final.text), ...linkIn(final.text) });
  }
  const firstInput = first ? { ...excerpt(agentId, first), completeOrigin: firstInputConfirmed } : null;
  const latestReply = reply ? excerpt(agentId, reply) : null;
  const truncated = !!tail.hasOlder || !!head.gap || !!tail.gap || !firstInputConfirmed || !!firstInput?.truncated || !!latestReply?.truncated;
  // Which turn this was read for, from the host's record and the plugin's observation as the page derives it: the completion
  // it shows and a heartbeat round the host's tokens cannot name (shared/model.ts `resultSource`, codex-obs-attn-F1).
  const turn = applyTelemetry(normalizeAgent({ ...source as unknown as AgentSource, id: agentId }), observed);
  return { agentId, capturedAt: new Date().toISOString(), epoch: tail.epoch, source: { lastUserMessageAt: string(source.lastUserMessageAt) || null, attentionTimestamp: string(source.attentionTimestamp) || null,
    completionAt: knownCompletionAt(turn), roundEndedAt: observedRound(turn) }, firstInput,
    latestUserInput: latestUser && !staleTurn ? excerpt(agentId, latestUser) : null, latestReply, isRunning, isFinal, artifacts, testEvidence,
    metrics: { tools: tools.length, failedTools: tools.filter(row => row.item.status === "failed").length,
      changedFiles: artifacts.filter(item => item.kind === "file").length, userTurns: tailRows.filter(row => row.item.type === "user_message").length },
    coverage: { firstInputConfirmed, truncated, rows: tailRows.length, hasOlder: tail.hasOlder,
      reason: !firstInputConfirmed ? t("serverResults.m005") : tail.hasOlder ? t("serverResults.m006") : null } };
}

export function registerResults(server: PluginServerContext, telemetry?: (agentId: string) => Promise<AgentTelemetry | null>, onReply?: (agentId: string, reply: ReplyObservation) => void): () => void {
  const cache = new Map<string, { agentId: string; until: number; value: Promise<AgentResult> }>();
  let closed = false;
  const invalidate = (agentId: string) => { for (const [key, value] of cache) if (value.agentId === agentId) cache.delete(key); };
  const removers = [server.on("agent.turn_started", ({ agent }) => { invalidate(agent.id); }),
    server.on("agent.turn_ended", ({ agent }) => { invalidate(agent.id); })];
  const read = async (input: { agentId: string; expectedLastUserMessageAt?: string | null; expectedAttentionTimestamp?: string | null }, paseo: PaseoApi) => {
    if (closed) throw new Error(t("serverResults.m007"));
    const { agentId } = input;
    const observed = await (telemetry?.(agentId) ?? null);
    if (closed) throw new Error(t("serverResults.m008"));
    // The latest turn the plugin observed is part of what a result is read for: a heartbeat's turn leaves the host's tokens (this
    // request) as they were, so a result read for the turn before is never served for it (codex-obs-attn-F1).
    const key = JSON.stringify([translator().language, translator().hash, input, observed?.turnStartedAt ?? null, observed?.turnEndedAt ?? null]);
    const previous = cache.get(key);
    if (previous && previous.until > Date.now()) return previous.value;
    const value = fetchAgentResult(paseo, agentId, observed, input, onReply && (reply => onReply(agentId, reply))).catch(error => { if (cache.get(key)?.value === value) cache.delete(key); throw error; });
    cache.delete(key); cache.set(key, { agentId, until: Date.now() + 5000, value });
    while (cache.size > 40) cache.delete(cache.keys().next().value!);
    return value;
  };
  server.handle(getAgentResult, async ({ revision, ...input }, { paseo }): Promise<AgentResultResponse> => {
    const result = await read(input, paseo);
    const current = contentRevision({ ...result, capturedAt: null });
    return revision === current ? { mode: "unchanged", unchanged: true, revision: current } : { ...result, mode: "full", unchanged: false, revision: current };
  });
  return () => { closed = true; for (const remove of removers) remove(); cache.clear(); };
}
