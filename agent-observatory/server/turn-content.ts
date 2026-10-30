import { createHash } from "node:crypto";
import type { AgentTimelineItem, ToolCallDetail } from "./paseo-types";
import { emptyStatsMetrics, type StatsMetrics, type StatsTool, type ToolKind } from "../shared/stats";
import { isTurnStart, type TurnStartItem } from "../shared/turn-start";

const MAX_ITEM_LINES = 20_000;

function itemKey(item: AgentTimelineItem, index: number): string {
  if (item.type === "tool_call") return `tool:${item.callId}`;
  if ((item.type === "user_message" || item.type === "assistant_message") && item.messageId) return `msg:${item.messageId}`;
  const text = "text" in item && typeof item.text === "string" ? item.text
    : "message" in item && typeof item.message === "string" ? item.message : "";
  return `${item.type}:${index}:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

function toolKind(detail: ToolCallDetail): ToolKind {
  switch (detail.type) {
    case "shell": case "read": case "plan": return detail.type;
    case "edit": case "write": return "edit";
    case "search": return detail.toolName === "web_search" ? "web" : "search";
    case "fetch": return "web";
    case "sub_agent": return "agent";
    default: return "other";
  }
}

/** Empty text has no lines; a final newline terminates the last line instead of adding another one. */
function countLines(text: string | undefined, maximum: number): number {
  if (!text || maximum <= 0) return 0;
  let count = 0, start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n" && text[index] !== "\r") continue;
    count++;
    if (count >= maximum) return maximum;
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    start = index + 1;
  }
  return count + (start < text.length ? 1 : 0);
}

function changedLines(detail: Extract<ToolCallDetail, { type: "edit" | "write" }>): { added: number; removed: number } {
  let added = 0, removed = 0;
  if (detail.type === "write") return { added: countLines(detail.content, MAX_ITEM_LINES), removed };
  if (typeof detail.unifiedDiff !== "string") {
    removed = countLines(detail.oldString, MAX_ITEM_LINES);
    added = countLines(detail.newString, MAX_ITEM_LINES - removed);
    return { added, removed };
  }
  // Read only the leading characters of each diff line and stop at the per-item budget.
  // This avoids allocating an array proportional to a possibly very large tool result.
  const diff = detail.unifiedDiff;
  for (let start = 0; start < diff.length;) {
    if (diff[start] === "+" && !diff.startsWith("+++", start)) added++;
    else if (diff[start] === "-" && !diff.startsWith("---", start)) removed++;
    if (added + removed >= MAX_ITEM_LINES) break;
    const end = diff.indexOf("\n", start);
    if (end < 0) break;
    start = end + 1;
  }
  return { added, removed };
}

/**
 * Extract the new suffix of a timeline: the whole in-memory conversation (Paseo 0.12), or the end of it read at turn end
 * (0.13, see lifecycle-hub.ts), where `positions` are the rows' sequence numbers, so keys stay the same from one read to
 * the next, and `partial` says the window does not reach the start of the conversation. The caller persists only
 * lastKey, counters and tool names; message text, commands, output and file paths never leave this function.
 */
export function extractTurnContent(timeline: readonly AgentTimelineItem[], lastKey: string | null,
  window: { positions?: readonly number[]; partial?: boolean } = {}): {
  metrics: StatsMetrics; tools: StatsTool[]; lastKey: string | null;
} {
  const metrics = emptyStatsMetrics(), tools = new Map<string, StatsTool>(), files = new Set<string>();
  const position = (index: number) => window.positions?.[index] ?? index;
  const nextKey = timeline.length ? itemKey(timeline[timeline.length - 1], position(timeline.length - 1)) : null;
  let start = -1;
  if (lastKey !== null) {
    // Searching from the tail also chooses the last match if a provider repeats an ID.
    for (let index = timeline.length - 1; index >= 0; index--) {
      if ((index === timeline.length - 1 ? nextKey : itemKey(timeline[index], position(index))) === lastKey) {
        start = index + 1;
        break;
      }
    }
  }
  if (start < 0) {
    for (let index = timeline.length - 1; index >= 0; index--) {
      if (isTurnStart(timeline[index] as TurnStartItem)) { start = index; break; }
    }
  }
  // A turn longer than the window read: count what was read rather than nothing.
  if (start < 0 && window.partial) start = 0;
  if (start >= 0) for (let index = start; index < timeline.length; index++) {
    const item = timeline[index];
    switch (item.type) {
      case "user_message": metrics.userMessages++; break;
      case "assistant_message": metrics.assistantMessages++; break;
      case "error": metrics.errors++; break;
      case "notification": if (item.level === "error") metrics.errors++; break;
      case "compaction": if (item.status === "completed") metrics.compactions++; break;
      case "tool_call": {
        // Another agent's message and a schedule's prompt (Paseo 0.14) are tool-call rows that start a turn, not tools.
        if (isTurnStart(item as TurnStartItem)) break;
        const detail = item.detail, kind = toolKind(detail), name = item.name.trim().slice(0, 160).trim();
        const failed = item.status === "failed" || (detail.type === "shell" && detail.exitCode != null && detail.exitCode !== 0);
        metrics.toolCalls++;
        if (failed) metrics.toolFailures++;
        if (kind === "shell") metrics.shellCalls++;
        if (kind === "web") metrics.webCalls++;
        if (kind === "agent") metrics.subagentCalls++;
        if (detail.type === "edit" || detail.type === "write") {
          const lines = changedLines(detail);
          metrics.edits++;
          metrics.linesAdded += lines.added;
          metrics.linesRemoved += lines.removed;
          if (detail.filePath) files.add(detail.filePath);
        }
        const key = JSON.stringify([name, kind]);
        let tool = tools.get(key);
        if (!tool) { tool = { name, kind, calls: 0, failures: 0 }; tools.set(key, tool); }
        tool.calls++;
        if (failed) tool.failures++;
        break;
      }
    }
  }
  metrics.filesChanged = files.size;
  // Nothing read (a failed read on 0.13) keeps the place, so the next turn is not counted from scratch.
  return { metrics, tools: [...tools.values()], lastKey: nextKey ?? lastKey };
}
