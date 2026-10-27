import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import type { TokenSource } from "../../shared/tokens";
import type { Candidate, CallSink, LedgerCall, LogFile, ParserState } from "./types";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown, limit = 256): string => typeof value === "string" ? value.slice(0, limit) : "";
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const stamp = (value: unknown): number | null => {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at >= 0 ? at : null;
};
export const callKey = (parts: unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
export const validStart = (start: number | null, at: number): number | null => start !== null && at - start >= 100 && at - start <= 900_000 ? start : null;
/**
 * The thread that spawned a Codex subagent rollout: `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`
 * (`source.subagent.parent_thread_id` in some versions). Top-level sessions have a string source ("cli", "vscode", "exec").
 */
export function subagentParent(source: unknown): string | null {
  const subagent = object(object(source).subagent);
  return text(object(subagent.thread_spawn).parent_thread_id) || text(subagent.parent_thread_id) || null;
}
/** Grok keeps one directory per session (`<encoded cwd>/<session id>/usage.json`); the directory is the session id. */
export const GROK_USAGE_FILE = "usage.json";
/** A Pi or oh-my-pi session log is `<time>_<session id>.jsonl`, the id as in its `session` header. */
function piSessionId(name: string): string {
  const id = name.slice(name.lastIndexOf("_") + 1);
  return id && id !== name && /^[A-Za-z0-9-]{8,256}$/.test(id) ? id : name;
}
/** The Pi session id of a `parentSession` header (the forked session's log path), or "". */
const piParent = (path: string): string => path.endsWith(".jsonl") ? piSessionId(basename(path, ".jsonl")) : "";
/** When Pi created a session log, from its name: `<time>_<id>.jsonl` is the header's timestamp with `-` for `:` and `.`. Null for other names. */
function piCreatedAt(path: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(basename(path));
  const at = match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : NaN;
  return Number.isFinite(at) ? at : null;
}
export function initialParser(path: string, parentSession: string | null, source?: TokenSource): ParserState {
  const name = basename(path, ".jsonl");
  const grok = source === "grok" || (source === undefined && basename(path) === GROK_USAGE_FILE);
  // OpenCode: a legacy message file's session is its directory; the database file's id is never used.
  const opencodeSession = source === "opencode" && basename(path) !== "opencode.db" ? basename(dirname(path)) : null;
  let sessionId: string;
  if (parentSession) sessionId = parentSession;
  else if (grok) sessionId = basename(dirname(path));
  else if (opencodeSession) sessionId = opencodeSession;
  else if (source === "pi" || source === "omp") sessionId = piSessionId(name);
  else if (name.startsWith("rollout-")) sessionId = name.match(/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i)?.[1] ?? name;
  else sessionId = name;
  return { sessionId: sessionId.slice(0, 256), cwd: "", model: null, inputAt: null, lastTotal: null, open: null, openInputAt: null,
    sessions: [sessionId.slice(0, 256)], links: [], hasForks: false, metaSeen: false, pendingRecord: false, legacySessionId: sessionId.slice(0, 256), parentThread: null };
}
function remember(list: string[], id: string): void { if (id && !list.includes(id) && list.length < 256) list.push(id); }
export function emit(file: LogFile, candidate: Candidate, start: number | null, sink: CallSink): void {
  const state = file.state, previous = state.open?.call.key === candidate.call.key ? state.open : null;
  const settled = previous ? null : state.open;
  if (previous) {
    candidate.call = { ...previous.call, at: Math.max(previous.call.at, candidate.call.at),
      output: Math.max(previous.call.output, candidate.call.output), reasoning: Math.max(previous.call.reasoning, candidate.call.reasoning) };
    candidate.call.start = validStart(state.openInputAt, candidate.call.at);
    candidate.forked = previous.forked;
  } else state.openInputAt = start;
  state.open = candidate;
  sink(candidate, previous, file, settled);
}

/**
 * Pi (2.14) and oh-my-pi (2.18), counted as each totals a session (`core/usage-totals`): every assistant message, a tool
 * result carrying the usage of LLM work it did, a compaction or branch summary's own usage and, in oh-my-pi, a
 * `model_usage` entry's (a call outside the transcript, under the model it names). A compaction's `retainedTail` holds
 * copies of earlier messages and is never read. An assistant entry's timestamp is written when the response ends and its
 * message's `timestamp` when the request started. A response is keyed by its provider response id, so the copies a `/fork`
 * or `/clone` writes into a new session count once; usage without a model name (tool results, summaries) is the session's
 * current model's.
 */
function parsePiLine(line: string, file: LogFile, sink: CallSink): void {
  if (!/"type"\s*:\s*"(?:session|message|compaction|branch_summary|model_change|model_usage)"/.test(line)) return;
  let row: ObjectValue;
  try { row = object(JSON.parse(line)); } catch { return; }
  const state = file.state;
  if (row.type === "session") {
    state.sessionId = text(row.id) || state.sessionId; state.legacySessionId = state.sessionId; remember(state.sessions, state.sessionId);
    state.cwd = text(row.cwd, 4096) || state.cwd;
    const parentPath = text(row.parentSession, 4096), parent = piParent(parentPath);
    if (parent !== state.sessionId) remember(state.links, parent);
    // A /fork or /clone names the session it came from, and the entries it copied keep their own, earlier timestamps.
    state.hasForks ||= !!parentPath;
    return;
  }
  if (row.type === "model_change") { state.model = text(row.modelId, 240) || state.model; return; }
  const at = stamp(row.timestamp), entry = text(row.id, 64);
  if (at === null) return;
  let usage: ObjectValue, model = state.model, start: number | null = null, key: unknown[];
  if (row.type === "message") {
    const message = object(row.message);
    if (message.role === "assistant") {
      model = text(message.responseModel, 240) || text(message.model, 240) || state.model; state.model = model;
      start = typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : null;
      const response = text(message.responseId, 1024);
      key = response ? [file.source, response] : [file.source, entry, text(row.timestamp, 64)];
    } else if (message.role === "toolResult") key = [file.source, "tool", entry, text(row.timestamp, 64)];
    else return;
    usage = object(message.usage);
  } else { usage = object(row.usage); model = text(row.model, 240) || model; key = [file.source, row.type, entry, text(row.timestamp, 64)]; }
  const input = count(usage.input), cacheWrite = count(usage.cacheWrite), cacheRead = count(usage.cacheRead), output = count(usage.output);
  // Failed requests write an all-zero usage: no tokens, and not a call that produced anything.
  if (!input && !cacheWrite && !cacheRead && !output) return;
  const call: LedgerCall = { key: callKey(key), source: file.source, sessionId: state.sessionId, cwd: state.cwd, model, at, start: validStart(start, at),
    input, cacheWrite, cacheRead, output, reasoning: Math.min(output, count(usage.reasoning)), subagent: false };
  // In a fork, what predates the fork itself is a copy: the ingester reads it after every original (r3-F4). A fork whose log name
  // carries no time has every entry treated so; its own replies are still counted, only after the originals.
  const created = state.hasForks ? piCreatedAt(file.path) : null;
  emit(file, { call, forked: state.hasForks && (created === null || at < created) }, call.start, sink);
}

/**
 * Grok CLI (2.14): the session's `usage.json`, rewritten when a turn ends, read whole (server/tokens/reader). Every turn
 * is emitted again on each read; already counted ones are recognised by their key, which is the turn's content (its end
 * time, number, model and totals), not the session, because a resumed or forked session carries the turns it inherited.
 * One record per model of a turn; `inputTokens` includes the cache reads and writes, which are split out. Returns false
 * when the text is not (yet) a complete JSON object, so the file is read again.
 */
export function parseGrokUsage(content: string, file: LogFile, sink: CallSink): boolean {
  let row: ObjectValue;
  try { row = object(JSON.parse(content)); } catch { return false; }
  const state = file.state;
  remember(state.sessions, text(row.sessionId));
  for (const raw of Array.isArray(row.turns) ? row.turns.slice(0, 20_000) : []) {
    const turn = object(raw), at = stamp(turn.endedAt);
    if (at === null) continue;
    const models = Object.entries(object(turn.modelUsage)).filter(([, usage]) => usage && typeof usage === "object").slice(0, 16);
    const parts: Array<[string | null, ObjectValue]> = models.length ? models.map(([model, usage]) => [model.slice(0, 240) || null, object(usage)]) : [[text(turn.primaryModelId, 240) || null, turn]];
    for (const [model, usage] of parts) {
      const all = count(usage.inputTokens), cacheRead = Math.min(all, count(usage.cachedReadTokens)), cacheWrite = Math.min(all - cacheRead, count(usage.cacheCreationTokens));
      const output = count(usage.outputTokens), calls = Math.max(1, count(usage.modelCalls));
      if (!all && !output) continue;
      const call: LedgerCall = { key: callKey(["grok", text(turn.endedAt, 64), count(turn.turnNumber), model, all, output]), source: "grok", sessionId: state.sessionId,
        cwd: state.cwd, model, at, start: null, input: all - cacheRead - cacheWrite, cacheWrite, cacheRead, output, reasoning: Math.min(output, count(usage.reasoningTokens)),
        subagent: false, ...(calls > 1 ? { calls } : {}) };
      emit(file, { call, forked: false }, null, sink);
    }
  }
  return true;
}

/**
 * OpenCode (2.18), one assistant message from either backend, counted the way OpenCode totals it: the `tokens` of the
 * message's `data` (a database row's JSON, or a legacy storage file), the response time from `time.created` to
 * `time.completed`; `reasoning` is its own counter there, not part of the output. A message still streaming has no
 * completed time and is not a call yet; an all-zero one (aborted) never is. A message is keyed by its id — the same
 * one a legacy file and its migrated database row carry, so both backends count it once. A session with a parent
 * (`session.parent_id`) is a sub-agent's.
 */
export function parseOpendencodeMessage(message: ObjectValue, file: LogFile, sink: CallSink, subagent: boolean): void {
  const time = object(message.time), at = stamp(time.completed), start = stamp(time.created);
  if (at === null) return;
  const tokens = object(message.tokens), cache = object(tokens.cache);
  const input = count(tokens.input), cacheWrite = count(cache.write), cacheRead = count(cache.read), output = count(tokens.output);
  if (!input && !cacheWrite && !cacheRead && !output) return;
  const id = text(message.id, 256);
  if (!id) return;
  const state = file.state;
  state.sessionId = text(message.sessionID, 256) || state.sessionId;
  remember(state.sessions, state.sessionId);
  const cwd = text(object(message.path).cwd, 4096);
  if (cwd) state.cwd = cwd;
  const call: LedgerCall = { key: callKey(["opencode", id]), source: "opencode", sessionId: state.sessionId, cwd: state.cwd,
    model: text(message.modelID, 240) || null, at, start: validStart(start, at), input, cacheWrite, cacheRead, output,
    reasoning: count(tokens.reasoning), subagent };
  emit(file, { call, forked: false }, start, sink);
}

/** A legacy storage message file, one JSON document read whole: parsed, re-read by the reader when its size or mtime changes.
 *  The legacy tree carries no parent relation, so its messages count as top-level sessions of their own. */
export function parseOpendencodeDoc(content: string, file: LogFile, sink: CallSink): boolean {
  let row: ObjectValue;
  try { row = object(JSON.parse(content)); } catch { return false; }
  if (text(row.role, 32) !== "assistant") return true;
  parseOpendencodeMessage(row, file, sink, false);
  return true;
}

/** A cheap discriminator precedes JSON.parse; parsed objects never escape this function. */
export function parseLine(line: string, file: LogFile, sink: CallSink): void {
  if (file.source === "pi" || file.source === "omp") { parsePiLine(line, file, sink); return; }
  if (file.source === "grok") return; // a JSON document, not lines: parseGrokUsage
  if (file.source === "claude") {
    if (!/"type"\s*:\s*"(?:assistant|user)"/.test(line)) return;
  } else if (!/"(?:session_meta|turn_context|token_count|token_usage_record|user_message|function_call_output|custom_tool_call_output|task_started)"/.test(line) && !/"role"\s*:\s*"user"/.test(line)) return;
  let row: ObjectValue;
  try { row = object(JSON.parse(line)); } catch { return; }
  const state = file.state, at = stamp(row.timestamp);
  if (file.source === "claude") {
    const session = file.parentSession ?? (text(row.sessionId) || state.sessionId);
    state.sessionId = session; remember(state.sessions, session);
    if (typeof row.cwd === "string") state.cwd = text(row.cwd, 4096);
    const fork = object(row.forkedFrom), parent = text(fork.sessionId);
    remember(state.links, parent);
    if (row.type === "user") { if (at !== null) state.inputAt = at; return; }
    if (row.type !== "assistant" || at === null || row.isApiErrorMessage === true) return;
    const message = object(row.message), usage = object(message.usage), messageId = text(message.id, 1024);
    if (!messageId || message.model === "<synthetic>" || !Object.keys(usage).length) return;
    const model = text(message.model, 240) || null;
    const call: LedgerCall = { key: callKey(["claude", messageId, text(row.requestId, 1024)]), source: "claude", sessionId: session,
      cwd: state.cwd, model, at, start: validStart(state.inputAt, at), input: count(usage.input_tokens), cacheWrite: count(usage.cache_creation_input_tokens),
      cacheRead: count(usage.cache_read_input_tokens), output: count(usage.output_tokens), reasoning: 0,
      subagent: file.parentSession !== null || row.isSidechain === true };
    const forked = !!row.forkedFrom; state.hasForks ||= forked;
    emit(file, { call, forked }, state.inputAt, sink);
    return;
  }
  const payload = object(row.payload);
  if (row.type === "session_meta") {
    // Fork rollouts can contain a second, copied parent session_meta. The first owns the file.
    if (state.metaSeen) {
      state.legacySessionId = text(payload.id) || state.legacySessionId;
      if (state.legacySessionId !== state.sessionId) remember(state.links, state.legacySessionId);
      return;
    }
    state.metaSeen = true;
    state.sessionId = text(payload.id) || state.sessionId;
    state.legacySessionId = state.sessionId;
    remember(state.sessions, state.sessionId);
    state.cwd = text(payload.cwd, 4096) || state.cwd;
    remember(state.links, text(payload.forked_from_id));
    // A subagent thread belongs to the session that spawned it: its calls are subagent calls, attributed when read (data.rootSession).
    const parent = subagentParent(payload.source);
    state.threadId = state.sessionId; state.parentThread = parent && parent !== state.sessionId ? parent : null;
    if (state.parentThread) remember(state.links, state.parentThread);
    return;
  }
  if (row.type === "turn_context") {
    state.model = text(payload.model, 240) || state.model; state.cwd = text(payload.cwd, 4096) || state.cwd; return;
  }
  if ((row.type === "event_msg" && (payload.type === "user_message" || payload.type === "task_started")) ||
      (row.type === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output" || (payload.type === "message" && payload.role === "user")))) {
    if (at !== null) state.inputAt = at;
    return;
  }
  const isRecord = row.type === "token_usage_record";
  if ((!isRecord && (row.type !== "event_msg" || payload.type !== "token_count")) || at === null) return;
  const info = object(payload.info), usage = object(isRecord ? payload.usage : info.last_token_usage);
  const total = object(isRecord ? payload.thread_token_usage : info.total_token_usage);
  if (!Object.keys(usage).length || !Object.keys(total).length) return;
  const cumulative = JSON.stringify([total.input_tokens, total.cached_input_tokens, total.cache_write_input_tokens, total.output_tokens, total.reasoning_output_tokens, total.total_tokens].map(count));
  if (!isRecord && state.pendingRecord && cumulative === state.lastTotal && state.open) {
    // The next tool result can arrive between the record and its token_count. It belongs to the NEXT call.
    emit(file, { ...state.open, call: { ...state.open.call, at } }, state.openInputAt, sink);
    state.pendingRecord = false;
    return;
  }
  if (state.lastTotal === cumulative) return;
  state.lastTotal = cumulative;
  if (isRecord) { state.sessionId = text(payload.thread_id) || state.sessionId; state.legacySessionId = state.sessionId; remember(state.sessions, state.sessionId); }
  const cached = count(usage.cached_input_tokens), written = count(usage.cache_write_input_tokens);
  const response = text(payload.response_id, 1024);
  const call: LedgerCall = { key: callKey(isRecord && response ? ["codex", response] : ["codex", state.legacySessionId, at, cumulative]), source: "codex", sessionId: state.sessionId,
    cwd: state.cwd, model: state.model, at, start: validStart(state.inputAt, at), input: Math.max(0, count(usage.input_tokens) - cached - written),
    cacheRead: cached, cacheWrite: written, output: count(usage.output_tokens), reasoning: count(usage.reasoning_output_tokens),
    // Records a subagent rollout inherited from another thread (their thread_id is not its own) are that thread's calls.
    subagent: !!state.parentThread && state.sessionId === state.threadId };
  emit(file, { call, forked: false }, state.inputAt, sink);
  state.inputAt = null; state.pendingRecord = isRecord;
}
