import { DatabaseSync } from "node:sqlite";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { CallSink, LedgerCall, LogFile } from "./types";
import { callKey } from "./parser";

/** Hermes keeps its session bookkeeping in one SQLite database under its home. */
export const HERMES_DB_FILE = "state.db";

export const isHermesDb = (file: LogFile): boolean => file.source === "hermes" && basename(file.path) === HERMES_DB_FILE;

/**
 * Reads Hermes's per-session per-model aggregates for sessions that have ended. One call per row — Hermes accumulates
 * the five token counters and the call count per session per model itself, so the ledger stores the aggregate rather
 * than per-request rows. A still-open session has no end time and waits; once it ends the row's values are final and
 * the seen index keeps the every-poll re-emission from counting it twice.
 */
export async function readHermesStateDb(file: LogFile, sink: CallSink, onBytes?: (bytes: number) => void): Promise<boolean> {
  // The database's own times keep it in the hot poll; a vanished file throws and the root shows it.
  const details = await stat(file.path);
  file.size = details.size; file.mtime = details.mtimeMs;
  const db = new DatabaseSync(file.path, { readOnly: true });
  try {
    const rows = db.prepare(
      "SELECT m.session_id AS sessionId, m.model AS model, m.api_call_count AS calls, m.input_tokens AS input, m.output_tokens AS output, " +
      "m.cache_read_tokens AS cacheRead, m.cache_write_tokens AS cacheWrite, m.reasoning_tokens AS reasoning, " +
      "m.last_seen AS lastSeen, s.parent_session_id AS parent, s.cwd AS cwd FROM session_model_usage m " +
      "JOIN sessions s ON s.id = m.session_id WHERE s.ended_at IS NOT NULL",
    ).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const sessionId = String(row.sessionId ?? "").slice(0, 256);
      if (!sessionId) continue;
      const atSeconds = Number(row.lastSeen ?? row.endedAt ?? 0);
      const at = Number.isFinite(atSeconds) && atSeconds > 0 ? Math.round(atSeconds * 1000) : null;
      if (at === null) continue;
      const input = Number(row.input ?? 0) || 0, cacheRead = Number(row.cacheRead ?? 0) || 0, cacheWrite = Number(row.cacheWrite ?? 0) || 0;
      const output = Number(row.output ?? 0) || 0, reasoning = Number(row.reasoning ?? 0) || 0;
      if (!input && !cacheRead && !cacheWrite && !output) continue;
      const model = String(row.model ?? "").slice(0, 240) || null;
      const calls = Math.max(1, Number(row.calls ?? 1) || 1);
      const call: LedgerCall = { key: callKey(["hermes", sessionId, model ?? "", calls]), source: "hermes", sessionId,
        cwd: String(row.cwd ?? "").slice(0, 4096), model, at, start: null, input, cacheWrite, cacheRead, output,
        reasoning: Math.min(output, reasoning), subagent: row.parent != null, calls };
      emitHermes(file, { call, forked: false }, sink);
      onBytes?.(512);
    }
    return true;
  } finally { db.close(); }
}

function emitHermes(file: LogFile, candidate: { call: LedgerCall; forked: boolean }, sink: CallSink): void {
  sink(candidate, null, file, null);
}
