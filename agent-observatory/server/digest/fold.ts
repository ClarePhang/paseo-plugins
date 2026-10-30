import { t } from "../../shared/text";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentTimelineItem } from "../paseo-types";
import { object, string, type TimelineRow } from "../../shared/timeline";
import { extractTurnContent } from "../turn-content";
import { analyzeCommand } from "./commands";
import { excerpt, type CompactRow, type FoldState, type ToolFact, type TurnFact } from "./model";
import { isTurnStart, turnStartText, type TurnStartItem } from "../../shared/turn-start";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function filePath(path: string, cwd: string): string {
  const absolute = resolve(cwd || "/", path), inside = relative(cwd || "/", absolute);
  return !inside.startsWith("../") && inside !== ".." && !isAbsolute(inside) ? inside || "." : absolute;
}

/** Strip large bodies immediately, before retaining anything from a fetched page. */
export function compactRow(row: TimelineRow, cwd: string, projected = row.seqStart !== row.seqEnd): CompactRow {
  const item = row.item, type = item.type, timestamp = Date.parse(row.timestamp);
  const fact: CompactRow = { seq: row.seqStart, lastSeq: row.seqEnd, at: Number.isFinite(timestamp) ? Math.max(0, timestamp) : 0,
    turnId: row.turnId || null, type, projected };
  if (type === "user_message" || type === "assistant_message") {
    // Preserve one boundary space when joining provider deltas. Keep one extra character to prove clipping.
    const text = string(item.text);
    fact.text = `${/^\s/u.test(text) ? " " : ""}${excerpt(text, 242)}${/\s$/u.test(text) ? " " : ""}`;
    fact.messageId = string(item.messageId) || row.providerMessageId;
  } else if (type === "tool_call" && isTurnStart(item as TurnStartItem)) {
    // Another agent's message or a schedule's prompt opens a turn like a user message; it is no tool.
    fact.trigger = true; fact.text = excerpt(turnStartText(item as TurnStartItem), 242);
  } else if (type === "error" || type === "notification" && item.level === "error") {
    fact.type = "error"; fact.text = excerpt(string(item.message), 160);
  } else if (type === "compaction") fact.completed = item.status === "completed";
  else if (type === "tool_call" || type === "todo") {
    const detail = object(item.detail);
    // Reuse the existing tool-kind and diff-line counting implementation without changing its API.
    const metrics = type === "tool_call" ? extractTurnContent([{ type: "user_message", text: "" },
      { ...item, name: string(item.name), detail: { type: "unknown", ...detail } } as AgentTimelineItem], null) : null;
    const patch: CompactRow["tool"] = { id: type === "todo" ? `todo:${row.seqStart}` : string(item.callId) || `seq:${row.seqStart}` };
    if (string(item.name)) patch.name = excerpt(string(item.name), 40);
    if (detail.type && detail.type !== "unknown") patch.lane = metrics?.tools[0]?.kind ?? "other";
    if (detail.type === "search" && !detail.toolName) fact.inferredSearch = true;
    if (type === "todo") { patch.name = "Todo"; patch.lane = "plan"; patch.status = "ok"; }
    else if (item.status === "failed" || detail.type === "shell" && typeof detail.exitCode === "number" && detail.exitCode !== 0) patch.status = "failed";
    else if (item.status === "completed") patch.status = "ok";
    else if (item.status === "canceled") patch.status = "canceled";
    else if (item.status === "running") patch.status = "running";
    if (detail.type === "shell" && (typeof detail.exitCode === "number" || detail.exitCode === null)) patch.exitCode = detail.exitCode;
    if (["read", "edit", "write"].includes(string(detail.type)) && string(detail.filePath)) {
      const path = filePath(string(detail.filePath), cwd);
      patch.path = excerpt(path, 240); patch.pathKey = hash(path); patch.target = patch.path;
    }
    if (detail.type === "edit" && (typeof detail.unifiedDiff === "string" || typeof detail.oldString === "string" || typeof detail.newString === "string")
      || detail.type === "write" && typeof detail.content === "string") {
      patch.added = metrics?.metrics.linesAdded ?? 0; patch.removed = metrics?.metrics.linesRemoved ?? 0;
    }
    if (typeof detail.command === "string" && detail.command.trim()) {
      const analysis = analyzeCommand(detail.command);
      patch.command = excerpt(detail.command.split(/\r?\n/, 1)[0]!, 120); patch.commandKey = hash(detail.command);
      patch.program = analysis.program; patch.check = analysis.check; patch.git = analysis.git; patch.target = excerpt(patch.command, 80);
    }
    if (detail.type === "search" && typeof detail.query === "string") patch.target = excerpt(detail.query, 80);
    if (detail.type === "fetch" && typeof detail.url === "string") {
      try { patch.target = new URL(string(detail.url)).host; } catch { patch.target = t("serverDigestFold.m001"); }
    }
    if (detail.type === "sub_agent" && (typeof detail.description === "string" || typeof detail.subAgentType === "string")) {
      patch.target = excerpt(string(detail.description) || string(detail.subAgentType), 160);
    }
    fact.tool = patch;
  }
  return fact;
}

export function createFold(agentId: string, cwd = "", epoch: string | null = null): FoldState {
  return { agentId, cwd, epoch, rows: 0, lastSeq: -1, lastStartSeq: -1, truncated: false, turns: [], tools: new Map(), events: [], modelSpans: [], turnIds: new Map(), callIds: new Map() };
}

/** Projected timestamps are ends. Only entries wholly before an anchor can bound that entry's start. */
export function withTimeBounds(rows: readonly CompactRow[]): CompactRow[] {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq), ended = [...rows].sort((a, b) => a.lastSeq - b.lastSeq);
  let endIndex = 0, previous: number | undefined;
  return ordered.map(row => {
    while (endIndex < ended.length && ended[endIndex]!.lastSeq < row.seq) previous = Math.max(previous ?? 0, ended[endIndex++]!.at);
    const estimated = row.projected && (row.tool || row.type === "assistant_message" || row.type === "reasoning");
    return estimated ? { ...row, start: Math.min(row.at, previous ?? row.at) } : row;
  });
}

function newTurn(state: FoldState, row: CompactRow): TurnFact {
  const turn: TurnFact = { index: state.turns.length + 1, turnId: row.turnId, start: row.at, end: row.at, seq: row.seq, lastSeq: row.lastSeq,
    prompt: "", reply: "", tail: "", error: false, messages: 0, replyId: null, replySeq: -1, compactionOpen: false };
  state.turns.push(turn);
  if (row.turnId) state.turnIds.set(row.turnId, turn.index - 1);
  return turn;
}

/** Ordered, incremental reducer. Replayed canonical sequences are idempotent. */
export function foldRows(state: FoldState, rows: readonly CompactRow[]): FoldState {
  for (const row of rows) {
    if (row.seq <= state.lastStartSeq) continue;
    state.rows++; state.lastSeq = Math.max(state.lastSeq, row.lastSeq); state.lastStartSeq = row.seq;
    const known = row.turnId ? state.turnIds.get(row.turnId) : undefined;
    let turn = known === undefined ? undefined : state.turns[known];
    const current = state.turns.at(-1);
    if (row.type === "user_message" || row.trigger) turn = newTurn(state, row);
    if (!turn && row.turnId && current?.turnId === null && current.tail === "user_message") {
      turn = current; turn.turnId = row.turnId; state.turnIds.set(row.turnId, turn.index - 1);
    }
    if (!turn && row.turnId) turn = newTurn(state, row);
    if (!turn) turn = current ?? newTurn(state, row);
    const latest = row.lastSeq >= turn.lastSeq;
    if (row.tool) {
      let key = `${turn.index}:${row.tool.id}`;
      // Some providers omit turnId on a status-only completion.
      if (!row.turnId && state.callIds.has(row.tool.id)) key = state.callIds.get(row.tool.id)!;
      const previous = state.tools.get(key);
      if (previous) turn = state.turns[previous.turn - 1]!;
      const tool: ToolFact = { turn: turn.index, seq: row.seq, lastSeq: row.lastSeq, start: Math.max(turn.start, row.start ?? row.at), end: row.at,
        status: "running", name: "Tool", lane: "other", target: "", path: null, added: 0, removed: 0, command: "", commandKey: "",
        program: "", check: null, git: null, ...previous, ...row.tool };
      tool.end = Math.max(tool.end, row.at); tool.lastSeq = row.lastSeq;
      if (row.inferredSearch && previous) tool.lane = previous.lane;
      if (tool.lane === "shell" && tool.exitCode != null && tool.exitCode !== 0) tool.status = "failed";
      state.tools.set(key, tool); state.callIds.set(row.tool.id, key);
      if (latest) turn.tail = tool.status;
    } else if (row.type === "user_message" || row.trigger) {
      turn.prompt = excerpt(row.text ?? "", 200); turn.messages++; turn.tail = "user_message";
    } else if (row.type === "assistant_message") {
      const continuation = turn.tail === "assistant_message" && turn.replySeq + 1 === row.seq && (!row.messageId || turn.replyId === row.messageId);
      turn.reply = continuation ? `${turn.reply}${row.text ?? ""}`.slice(0, 244) : row.text ?? "";
      if (!continuation) { turn.messages++; turn.replyId = row.messageId || null; }
      turn.replySeq = row.lastSeq; if (latest) turn.tail = row.type;
    } else if (row.type === "error") {
      turn.error = true; if (latest) turn.tail = "error";
      state.events.push({ type: "error", at: row.at, turn: turn.index, seq: row.seq, detail: row.text ?? "" });
    } else if (row.type === "compaction") {
      if (!turn.compactionOpen) state.events.push({ type: "compaction", at: row.at, turn: turn.index, seq: row.seq, detail: t("serverDigestFold.m002") });
      turn.compactionOpen = !row.completed;
    } else if (row.type === "reasoning" && latest) turn.tail = row.type;
    if ((row.type === "assistant_message" || row.type === "reasoning") && row.start !== undefined && row.start < row.at) {
      state.modelSpans.push({ turn: turn.index, start: Math.max(turn.start, row.start), end: row.at, seq: row.seq });
    }
    turn.start = Math.min(turn.start, row.at); turn.end = Math.max(turn.end, row.at);
    if (latest) { turn.lastSeq = row.lastSeq; turn.lastRef = row.seq; }
  }
  return state;
}
