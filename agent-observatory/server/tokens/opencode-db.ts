import { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";
import { parseOpendencodeMessage } from "./parser";
import type { CallSink, LogFile } from "./types";

/** OpenCode ≥ 1.2 keeps every session, message and part in one database next to the legacy `storage/` tree. */
export const OPENCODE_DB_FILE = "opencode.db";
/**
 * Rows newer than the watermark minus this many are read again on every poll: a message's row appears when the
 * message starts and gains its tokens and completed time only when it ends, so the window is what catches a message
 * completed after the watermark first passed it. At most a few hundred rows, read many times a minute at worst.
 */
export const OPENCODE_DB_WINDOW = 512;

export const isOpendencodeDb = (file: LogFile): boolean => file.source === "opencode" && basename(file.path) === OPENCODE_DB_FILE;

/**
 * Reads the assistant messages a database holds past the watermark, earliest first, and moves the watermark to the
 * newest row read. A database replaced whole (a reinstall) has a smaller top rowid than the watermark: it is read
 * from its first row again, and the message ids deduplicate what both versions counted. Opens read-only: the
 * database is OpenCode's, never written, never locked for writing; a failed open throws (the root shows it).
 */
export async function readOpendencodeDb(file: LogFile, sink: CallSink, onBytes?: (bytes: number) => void): Promise<boolean> {
  const db = new DatabaseSync(file.path, { readOnly: true });
  try {
    const top = (db.prepare("SELECT max(rowid) AS top FROM message").get() as { top: number | null }).top ?? 0;
    if (top < file.offset) file.offset = 0;
    const rows = db.prepare(
      "SELECT m.rowid AS rowid, m.id AS id, m.session_id AS sessionId, m.data AS data, s.parent_id AS parent FROM message m JOIN session s ON s.id = m.session_id WHERE m.rowid > ? ORDER BY m.rowid",
    ).all(Math.max(0, file.offset - OPENCODE_DB_WINDOW));
    let newest = file.offset;
    for (const row of rows) {
      const rowid = Number(row.rowid);
      newest = Math.max(newest, rowid);
      let message: unknown;
      try { message = JSON.parse(String(row.data)); } catch { continue; }
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const fields = message as Record<string, unknown>;
      if (typeof fields.role === "string" && fields.role !== "assistant") continue;
      // The row's session id is the column; legacy data carried it in the JSON, migrated rows do not. Same for the id.
      if (typeof fields.id !== "string") fields.id = String(row.id ?? "");
      if (typeof fields.sessionID !== "string") fields.sessionID = String(row.sessionId ?? "");
      parseOpendencodeMessage(fields, file, sink, row.parent != null);
      onBytes?.(String(row.data).length);
    }
    file.offset = newest;
    return true;
  } finally { db.close(); }
}
