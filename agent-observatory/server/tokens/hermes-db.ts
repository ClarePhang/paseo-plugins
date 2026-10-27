import { DatabaseSync } from "node:sqlite";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import type { CallSink, LedgerCall, LogFile } from "./types";
import { callKey } from "./parser";

/** Hermes keeps its session bookkeeping in one SQLite database under its home. */
export const HERMES_DB_FILE = "state.db";
/** Aggregated rows per read: `node:sqlite` is synchronous, so one poll never holds the event loop for a whole import. */
const HERMES_BATCH = 512;
/** A session's usage row is written while the session runs and finalised when it ends (`ended_at` set); its values are
 * final afterwards. The watermark is the newest end time already counted; a session that ends late — after newer ones
 * were counted — can fall behind it and is missed (the same trade the windowed sources make). */
const HERMES_LOOKBACK = 86_400;

export const isHermesDb = (file: LogFile): boolean => file.source === "hermes" && basename(file.path) === HERMES_DB_FILE;

/**
 * Reads Hermes's per-session per-model aggregates for sessions that have ended. One call per row — Hermes accumulates
 * the five token counters and the call count per session per model itself, so the ledger stores the aggregate rather
 * than per-request rows. A still-open session has no end time and waits; once it ends the row's values are final and
 * the seen index keeps the re-reads from counting it twice. Rows of a session whose `sessions` row is gone still
 * count, as top-level. `file.offset` carries the watermark: the newest end time (seconds) already counted.
 * Returns whether this read counted anything new — a poll over an unchanged database must not dirty the ledger.
 */
export async function readHermesStateDb(file: LogFile, sink: CallSink, onBytes?: (bytes: number) => void): Promise<boolean> {
  // The database's own times keep it in the hot poll; a vanished file throws and the root shows it.
  const details = await stat(file.path);
  file.size = details.size; file.mtime = details.mtimeMs;
  const db = new DatabaseSync(file.path, { readOnly: true });
  try {
    const read = db.prepare(
      "SELECT m.session_id AS sessionId, m.model AS model, m.api_call_count AS calls, m.input_tokens AS input, m.output_tokens AS output, " +
      "m.cache_read_tokens AS cacheRead, m.cache_write_tokens AS cacheWrite, m.reasoning_tokens AS reasoning, " +
      "s.ended_at AS endedAt, s.parent_session_id AS parent, s.cwd AS cwd FROM session_model_usage m " +
      "LEFT JOIN sessions s ON s.id = m.session_id WHERE s.ended_at IS NOT NULL AND s.ended_at > ? ORDER BY s.ended_at LIMIT " + HERMES_BATCH,
    );
    // The watermark is the newest end time (seconds) already counted; a look-back window still re-reads sessions that
    // ended just before it, whose usage rows the extension finalises afterwards. Seen keys drop the re-emissions.
    let cursor = Math.max(0, file.offset - HERMES_LOOKBACK), watermark = cursor, emitted = 0;
    for (;;) {
      const batch = read.all(cursor) as Array<Record<string, unknown>>;
      for (const row of batch) {
        cursor = Math.max(cursor, Number(row.endedAt ?? 0));
        watermark = Math.max(watermark, cursor);
        const sessionId = String(row.sessionId ?? "").slice(0, 256);
        if (!sessionId) continue;
        const atSeconds = Number(row.endedAt ?? 0);
        const at = Number.isFinite(atSeconds) && atSeconds > 0 ? Math.round(atSeconds * 1000) : null;
        if (at === null) continue;
        const input = Number(row.input ?? 0) || 0, cacheRead = Number(row.cacheRead ?? 0) || 0, cacheWrite = Number(row.cacheWrite ?? 0) || 0;
        const output = Number(row.output ?? 0) || 0, reasoning = Number(row.reasoning ?? 0) || 0;
        if (!input && !cacheRead && !cacheWrite && !output) continue;
        const model = String(row.model ?? "").slice(0, 240) || null;
        const calls = Math.max(1, Number(row.calls ?? 1) || 1);
        // Hermes counts reasoning separately from the output tokens (unlike OpenCode, where it is inside).
        const call: LedgerCall = { key: callKey(["hermes", sessionId, model ?? ""]), source: "hermes", sessionId,
          cwd: String(row.cwd ?? "").slice(0, 4096), model, at, start: null, input, cacheWrite, cacheRead, output,
          reasoning, subagent: row.parent != null, calls };
        sink({ call, forked: false }, null, file, null);
        emitted++;
        onBytes?.(512);
      }
      if (batch.length < HERMES_BATCH) break;
      await yieldLoop();
    }
    file.offset = watermark;
    return emitted > 0;
  } finally { db.close(); }
}
