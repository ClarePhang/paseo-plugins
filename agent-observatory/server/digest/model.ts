import type { CheckKind, DigestLane, DigestSegment } from "../../shared/digest";

/** Only compact facts survive a page; no raw detail, tool output, diff or reasoning text is retained. */
export interface ToolFact {
  id: string; turn: number; seq: number; lastSeq: number;
  start: number; end: number; status: DigestSegment["status"];
  name: string; lane: DigestLane; target: string;
  path: string | null; pathKey?: string; added: number; removed: number; exitCode?: number | null;
  command: string; commandKey: string; program: string; check: CheckKind | null; git: string | null;
}
export interface TurnFact {
  index: number; turnId: string | null; start: number; end: number; seq: number; lastSeq: number;
  prompt: string; reply: string; tail: string; error: boolean; messages: number;
  replyId: string | null; replySeq: number; compactionOpen: boolean;
  lastRef?: number;
}
export interface EventFact { type: "error" | "compaction"; at: number; turn: number; seq: number; detail: string }
export interface FoldState {
  agentId: string; cwd: string; epoch: string | null; rows: number; lastSeq: number; lastStartSeq: number; truncated: boolean;
  turns: TurnFact[]; tools: Map<string, ToolFact>; events: EventFact[];
  modelSpans: { turn: number; start: number; end: number; seq: number }[];
  turnIds: Map<string, number>; callIds: Map<string, string>;
}
export interface CompactRow {
  seq: number; lastSeq: number; at: number; turnId: string | null; type: string; text?: string; messageId?: string;
  tool?: Partial<Omit<ToolFact, "turn" | "seq" | "lastSeq" | "start" | "end">> & { id: string };
  inferredSearch?: boolean;
  /** A tool-call row that starts a turn: another agent's message or a schedule's prompt (Paseo 0.14); `text` is its body. */
  trigger?: boolean;
  completed?: boolean;
  projected?: boolean;
  /** Estimated lower bound, recalculated from the compact window after each upsert. */
  start?: number;
}

/** Collapse whitespace without allocating another copy of a potentially huge output. */
export function excerpt(value: string, max: number): string {
  let result = "", pendingSpace = false;
  for (const character of value) {
    if (/\s/u.test(character)) { pendingSpace = result.length > 0; continue; }
    if (pendingSpace) result += " ";
    result += character; pendingSpace = false;
    if (result.length > max) return `${result.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
  }
  return result;
}

export const emptyLanes = (): Record<DigestLane, number> => ({ model: 0, read: 0, search: 0, edit: 0, shell: 0,
  web: 0, agent: 0, plan: 0, wait: 0, other: 0 });
