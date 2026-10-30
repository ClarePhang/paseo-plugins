/**
 * A running turn that is going nowhere (2.18, after Cindy's loop guard): the same tool call over and over, a few calls in
 * rotation, or the same argument error again and again (原地打转); or nothing new for a long while (可能卡住). Read from the
 * turn's projected tool calls only: no model, no provider logs. Conservative: calls 30 seconds or more apart are waiting, not
 * spinning, and known polling (sleep, waiting on a background task, tailing a log) never counts.
 */
import { object, string, type TimelineItem } from "./timeline";

export type IssueKind = "looping" | "stuck";
/** How the loop shows: one call repeated with the same result, two calls in turn, up to four in rotation, the same argument error. */
export type LoopPattern = "same" | "pingpong" | "rotation" | "contract";

/** What a row and the detail show about a live issue (memory only, from the server's live extras). */
export interface LiveIssue {
  kind: IssueKind;
  /** This occurrence: a new pattern or a later turn is a new key, so 知道了 covers exactly what was shown. */
  key: string;
  /** When it was first noticed (looping) or since when nothing changed (stuck). */
  since: string;
  pattern: LoopPattern | null;
  /** The tool the loop or the running call is about, redacted and short. */
  tool: string | null;
  /** Calls in the pattern (looping) or minutes without change (stuck). */
  count: number;
  /** Stuck while a tool call is still running (the longer limit applies). */
  toolRunning: boolean;
  /** The last calls of the pattern, redacted and short, oldest first. */
  evidence: string[];
  /** 知道了: still shown, no longer counted in 需要处理. */
  seen: boolean;
}

/** One finished or running tool call of the turn, reduced to what the rules compare. */
export interface ToolStep {
  /** The tool as shown: `Read`, `Bash`, an ACP kind. */
  name: string;
  /** What it was asked to do (name and arguments). */
  input: string;
  /** What it got back, with its status. */
  output: string;
  status: "running" | "completed" | "failed" | "canceled";
  /** Error or output text, for the argument-error rule. */
  errorText: string;
  /** A short label: the command, the file, the query. */
  label: string;
  at: number;
}

export const LOOP_SAME = 4;
export const LOOP_WINDOW = 12;
export const LOOP_WINDOW_DISTINCT = 2;
export const LOOP_ROTATION_WINDOW = 16;
export const LOOP_ROTATION_DISTINCT = 4;
export const LOOP_CONTRACT = 3;
/** Calls this far apart are waiting on something (CI, a slow command), not spinning. */
export const PACED_MS = 30_000;
/** However paced: this many identical calls in a row, or identical results for this long, is a loop. */
export const LOOP_FINAL_SAME = 30;
export const LOOP_FINAL_MS = 60 * 60_000;
/** No new row for this long while running; a tool still running gets the longer limit. */
export const STUCK_MS = 10 * 60_000;
export const STUCK_TOOL_MS = 45 * 60_000;
const EVIDENCE = 6;
const FIELD_MAX = 2_000;

/** Waiting on purpose: background task output, sleeping, writing to a session, sub-agent status. */
const POLLING_TOOLS = new Set(["TaskOutput", "BashOutput", "write_stdin", "wait", "sleep", "collab:wait", "KillShell"]);
const POLLING_COMMAND = /^\s*(?:sleep\s+\d+(?:\.\d+)?[smh]?|(?:\/usr\/bin\/|\/bin\/)?tail\s+(?:(?:-\d+|-n\s*\d+|-f)\s+)*[\w./@%+=,:-]+\.(?:log|out|txt))\s*$/;

/** Argument errors the agent can't get past by repeating the call (Cindy's contract errors), by tool. */
const CONTRACT_ERRORS: ReadonlyArray<{ category: string; tools: ReadonlySet<string>; pattern: RegExp }> = [
  { category: "missing", tools: new Set(["Edit", "Write", "Read", "NotebookEdit", "MultiEdit"]), pattern: /required parameter[\s\S]{0,80}\bmissing\b|missing required parameter/i },
  { category: "stale", tools: new Set(["Edit", "MultiEdit", "NotebookEdit"]), pattern: /string to replace not found|old_string[\s\S]{0,60}not found/i },
  { category: "ambiguous", tools: new Set(["Edit", "MultiEdit", "NotebookEdit"]), pattern: /found \d+ matches of the string/i },
  { category: "same", tools: new Set(["Edit", "MultiEdit", "NotebookEdit"]), pattern: /old_string and new_string are exactly the same|no changes to make/i },
];

const clip = (value: string, max = FIELD_MAX) => value.length > max ? value.slice(0, max) : value;
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}
function oneLine(value: string, max = 90): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A tool call row as a step; null for anything else. */
export function toolStepOf(item: TimelineItem, at: number): ToolStep | null {
  if (item.type !== "tool_call") return null;
  const detail = object(item.detail), metadata = object(item.metadata);
  const status = string(item.status);
  const rawName = string(item.name);
  // ACP tool calls are all named "other": their kind and title say what they are (0.13 projected timeline).
  const name = rawName === "other" || !rawName ? string(metadata.kind) || string(detail.label) || "tool" : rawName;
  const type = string(detail.type);
  let input = "", output = "", label = "";
  switch (type) {
    case "shell": input = string(detail.command); output = `${text(detail.exitCode)}:${clip(string(detail.output))}`; label = string(detail.command); break;
    case "read": input = `${string(detail.filePath)}:${text(detail.offset)}:${text(detail.limit)}`; output = clip(string(detail.content)); label = string(detail.filePath); break;
    case "edit": input = `${string(detail.filePath)}:${clip(string(detail.oldString))}:${clip(string(detail.newString))}`; output = clip(string(detail.unifiedDiff)); label = string(detail.filePath); break;
    case "write": input = `${string(detail.filePath)}:${clip(string(detail.content))}`; label = string(detail.filePath); break;
    case "search": input = `${string(detail.toolName)}:${string(detail.query)}`; output = `${text(detail.numMatches)}:${text(detail.numFiles)}:${clip(string(detail.content))}`; label = string(detail.query); break;
    case "fetch": input = string(detail.url); output = `${text(detail.code)}:${clip(string(detail.result))}`; label = string(detail.url); break;
    case "sub_agent": input = `${string(detail.subAgentType)}:${string(detail.description)}`; label = string(detail.description); break;
    case "plain_text": input = `${string(detail.label)}:${string(detail.text)}`; label = string(detail.label) || string(detail.text) || string(metadata.title); break;
    case "plan": input = clip(string(detail.text)); label = "plan"; break;
    default: input = clip(text(detail.input)); output = clip(text(detail.output)); label = string(metadata.title) || rawName;
  }
  const error = item.error === null || item.error === undefined ? "" : text(item.error);
  // An ACP call carries no arguments: its title (the file, the command, the tool) is what tells two calls apart.
  const title = rawName === "other" || !rawName ? string(metadata.title) : "";
  return {
    name, input: `${name}|${type}|${title}|${input}`, output: `${status}|${clip(error)}|${output}`,
    status: status === "running" || status === "failed" || status === "canceled" ? status : "completed",
    errorText: clip(`${error} ${type === "shell" ? string(detail.output) : text(detail.output)}`.trim(), 600),
    label: oneLine(label || name), at,
  };
}

/** Known polling: never evidence of spinning. */
export function isPolling(step: Pick<ToolStep, "name" | "label" | "input">): boolean {
  if (POLLING_TOOLS.has(step.name)) return true;
  return /^(?:Bash|bash|exec|shell|execute)\|shell\|/.test(step.input) && POLLING_COMMAND.test(step.label);
}

function contractCategory(step: ToolStep): string | null {
  if (step.status !== "failed" && !/error/i.test(step.errorText)) return null;
  if (!step.errorText || step.errorText.length > 600) return null;
  for (const matcher of CONTRACT_ERRORS) if (matcher.tools.has(step.name) && matcher.pattern.test(step.errorText)) return matcher.category;
  return null;
}

/** A short stable hash for keys (FNV-1a). */
export function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(36);
}

export interface LoopFinding { pattern: LoopPattern; count: number; tool: string; evidence: string[]; key: string }

/**
 * Whether the turn's tool calls (oldest first) end in a loop. Only finished, non-polling calls count; a call 30 seconds or
 * more after the previous one is paced (waiting on something) and breaks the fast rules, though not the final limits. A
 * newer call still running that isn't one of the loop's calls means the Agent moved on: no loop.
 */
export function detectLoop(all: readonly ToolStep[]): LoopFinding | null {
  const steps = all.filter(step => step.status !== "running" && !isPolling(step));
  const found = loopIn(steps);
  if (!found) return null;
  const newer = all.slice(all.lastIndexOf(steps[steps.length - 1]!) + 1);
  const inLoop = (step: ToolStep) => found.inputs.has(step.input) || (found.finding.pattern === "contract" && step.name === found.finding.tool);
  return newer.some(step => step.status === "running" && !isPolling(step) && !inLoop(step)) ? null : found.finding;
}

function loopIn(steps: readonly ToolStep[]): { finding: LoopFinding; inputs: Set<string> } | null {
  if (steps.length < LOOP_CONTRACT) return null;
  const full = (step: ToolStep) => `${step.input}\u0000${step.output}`;
  const evidence = (from: readonly ToolStep[]) => from.slice(-EVIDENCE).map(step => `${step.name} ${step.label}`.trim());
  const finding = (pattern: LoopPattern, count: number, run: readonly ToolStep[], signature: string) =>
    ({ finding: { pattern, count, tool: run[run.length - 1]!.name, evidence: evidence(run), key: `${pattern}:${shortHash(signature)}` }, inputs: new Set(run.map(step => step.input)) });

  // The trailing run of identical calls (same arguments, same result).
  let same = 1;
  while (same < steps.length && full(steps[steps.length - 1 - same]!) === full(steps[steps.length - 1]!)) same++;
  const run = steps.slice(-same);
  if (same >= LOOP_FINAL_SAME || (same >= 3 && run[run.length - 1]!.at - run[0]!.at >= LOOP_FINAL_MS)) return finding("same", same, run, full(run[0]!));

  // Fast calls only from here: the trailing stretch where each call came within 30 s of the one before.
  let start = steps.length - 1;
  while (start > 0 && steps[start]!.at - steps[start - 1]!.at < PACED_MS) start--;
  const fast = steps.slice(start);
  let fastSame = 1;
  while (fastSame < fast.length && full(fast[fast.length - 1 - fastSame]!) === full(fast[fast.length - 1]!)) fastSame++;
  if (fastSame >= LOOP_SAME) return finding("same", fastSame, fast.slice(-fastSame), full(fast[fast.length - 1]!));

  // The same argument error, three times in a row.
  const tail = fast.slice(-LOOP_CONTRACT);
  const categories = tail.map(contractCategory);
  if (tail.length === LOOP_CONTRACT && categories[0] && categories.every(category => category === categories[0]) && tail.every(step => step.name === tail[0]!.name))
    return finding("contract", LOOP_CONTRACT, tail, `${tail[0]!.name}:${categories[0]}`);

  // Few distinct calls over a window: two in turn, or a rotation of up to four.
  const windowed = (size: number, limit: number, pattern: LoopPattern): ReturnType<typeof loopIn> => {
    if (fast.length < size) return null;
    const window = fast.slice(-size), distinct = [...new Set(window.map(step => step.input))].sort();
    return distinct.length <= limit ? finding(pattern, size, window, distinct.join("\u0001")) : null;
  };
  return windowed(LOOP_WINDOW, LOOP_WINDOW_DISTINCT, "pingpong") ?? windowed(LOOP_ROTATION_WINDOW, LOOP_ROTATION_DISTINCT, "rotation");
}

/** A compact signature of the turn's latest rows: when it stops changing, nothing is happening (a sub-agent's growing log is change). */
export function activitySignature(items: readonly TimelineItem[]): string {
  return items.slice(-6).map(item => {
    const detail = object(item.detail), actions = Array.isArray(detail.actions) ? detail.actions.length : 0;
    return `${item.type}:${string(item.status)}:${string(item.callId)}:${string(item.text).length}:${string(detail.output).length}:${string(detail.content).length}:${string(detail.log).length}:${actions}`;
  }).join("|");
}

/** The stuck limit for the turn's latest row: longer while a tool call is still running. */
export function stuckLimit(items: readonly TimelineItem[]): { limitMs: number; running: ToolStep | null } {
  const last = items[items.length - 1];
  const step = last ? toolStepOf(last, 0) : null;
  return step && step.status === "running" ? { limitMs: STUCK_TOOL_MS, running: step } : { limitMs: STUCK_MS, running: null };
}
