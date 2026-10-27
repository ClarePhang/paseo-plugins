import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { initialParser, parseGrokUsage, parseLine, parseOpendencodeDoc } from "./parser";
import { isOpendencodeDb } from "./opencode-db";
import type { CallSink, LogFile, ParserState } from "./types";

const CHUNK = 256 * 1024, MAX_LINE = 16 * 1024 * 1024;
/** A Grok `usage.json` is a few KB per turn (13 KB at most on a heavy host in October 2026); larger ones are skipped. */
const MAX_WHOLE_FILE = 4 * 1024 * 1024;
/** A log path that has become a symlink is not followed (`ELOOP`); the next scan stops tracking it. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** A log's first line (for its `session_meta`), at most `limit` bytes, or null (missing, a symlink, no newline within the limit). */
export async function readFirstLine(path: string, limit = 1024 * 1024): Promise<string | null> {
  let handle;
  try { handle = await open(path, OPEN_FLAGS); } catch { return null; }
  try {
    const parts: Buffer[] = [], buffer = Buffer.allocUnsafe(64 * 1024);
    for (let position = 0; position < limit;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - position), position);
      if (!bytesRead) return null;
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      parts.push(Buffer.from(buffer.subarray(0, end < 0 ? bytesRead : end)));
      if (end >= 0) return Buffer.concat(parts).toString("utf8");
      position += bytesRead;
    }
    return null;
  } catch { return null; }
  finally { await handle.close(); }
}

/**
 * The working directory of a Grok session: its group directory is the URL-encoded cwd; a cwd too long for a file name
 * becomes a slug plus a hash, with the original path in the group's `.cwd` file (Grok's session docs). "" when unknown.
 */
export async function grokCwd(path: string): Promise<string> {
  const group = dirname(dirname(path));
  try { const decoded = decodeURIComponent(basename(group)); if (isAbsolute(decoded)) return decoded.slice(0, 4096); } catch { /* not URL-encoded */ }
  let handle;
  try { handle = await open(join(group, ".cwd"), OPEN_FLAGS); } catch { return ""; }
  try {
    const buffer = Buffer.alloc(4096), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0), text = buffer.subarray(0, bytesRead).toString("utf8").trim();
    return isAbsolute(text) && !text.includes("\n") ? text : "";
  } catch { return ""; }
  finally { await handle.close(); }
}

/**
 * No readFile, locks or writes on provider roots. Incomplete lines stay on disk, not in the checkpoint. `onReset`: the log is read
 * again from the start (replaced, cut short, rewritten), told with the state read of it so far before `file` takes in the new one.
 */
export async function tailFile(file: LogFile, sink: CallSink, onBytes?: (bytes: number) => void, onReset?: (lost: ParserState) => void): Promise<boolean> {
  let handle;
  try { handle = await open(file.path, OPEN_FLAGS); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOOP") return false; throw error; }
  try {
    return await (file.source === "grok" ? readWhole(file, handle, sink, parseGrokUsage, true, onBytes)
      : file.source === "opencode" && !isOpendencodeDb(file) ? readWhole(file, handle, sink, parseOpendencodeDoc, false, onBytes)
      : tailOpen(file, handle, sink, onBytes, onReset));
  } finally { await handle.close(); }
}

/**
 * A document rewritten in place or replaced (Grok's `usage.json`, an OpenCode legacy message file) is read whole whenever
 * its identity, size or modification time changes; `offset` is the size of the version read. Text that does not parse yet
 * (a write in progress) leaves the offset behind, so the next poll reads it again.
 */
async function readWhole(file: LogFile, handle: FileHandle, sink: CallSink, parse: (content: string, file: LogFile, sink: CallSink) => boolean,
  workingDirectory: boolean, onBytes?: (bytes: number) => void): Promise<boolean> {
  const details = await handle.stat();
  if (!details.isFile()) return false;
  const changed = details.dev !== file.dev || details.ino !== file.ino || details.size !== file.size || details.mtimeMs !== file.mtime;
  if (!changed && file.offset === details.size) return false;
  file.dev = details.dev; file.ino = details.ino; file.size = details.size; file.mtime = details.mtimeMs; file.partialBytes = 0;
  if (details.size > MAX_WHOLE_FILE) { file.offset = details.size; return changed; }
  const buffer = Buffer.alloc(details.size);
  let read = 0;
  while (read < buffer.length) { const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read); if (!bytesRead) break; read += bytesRead; }
  onBytes?.(read);
  if (workingDirectory && !file.state.cwd) file.state.cwd = await grokCwd(file.path);
  const parsed = read === details.size && parse(buffer.subarray(0, read).toString("utf8"), file, sink);
  if (parsed) file.offset = details.size;
  return changed || parsed;
}

async function tailOpen(file: LogFile, handle: FileHandle, sink: CallSink, onBytes?: (bytes: number) => void, onReset?: (lost: ParserState) => void): Promise<boolean> {
  const details = await handle.stat();
  if (!details.isFile()) return false;
  const initialOffset = file.offset;
  const changed = details.dev !== file.dev || details.ino !== file.ino || details.size !== file.size || details.mtimeMs !== file.mtime;
  if (details.dev !== file.dev || details.ino !== file.ino || details.size < file.offset || details.size < file.size ||
      (details.size === file.size && details.mtimeMs !== file.mtime && file.offset === details.size)) {
    onReset?.(file.state);
    file.offset = 0; file.partialBytes = 0; file.state = initialParser(file.path, file.parentSession, file.source);
  }
  // The unchanged partial suffix remains on disk. Retrying it cannot complete a line and must not dirty the ledger.
  if (!changed && file.partialBytes > 0 && file.offset + file.partialBytes === details.size) return false;
  file.dev = details.dev; file.ino = details.ino; file.size = details.size; file.mtime = details.mtimeMs;
  if (file.offset >= details.size) return changed;
  let position = file.offset, committed = file.offset, carry = Buffer.alloc(0), skipping = false, yieldedAt = performance.now();
  const buffer = Buffer.allocUnsafe(CHUNK);
  while (position < details.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, details.size - position), position);
    if (!bytesRead) break;
    const chunkStart = position; position += bytesRead; onBytes?.(bytesRead);
    let begin = 0;
    for (let end = buffer.indexOf(10, begin); end !== -1 && end < bytesRead; end = buffer.indexOf(10, begin)) {
      if (!skipping) {
        const line = carry.length ? Buffer.concat([carry, buffer.subarray(begin, end)]) : buffer.subarray(begin, end);
        if (line.length <= MAX_LINE) parseLine(line.toString("utf8"), file, sink);
      }
      carry = Buffer.alloc(0); skipping = false; begin = end + 1;
      committed = chunkStart + begin; file.offset = committed;
      if (performance.now() - yieldedAt >= 20) { await yieldLoop(); yieldedAt = performance.now(); }
    }
    if (!skipping && begin < bytesRead) {
      carry = Buffer.concat([carry, buffer.subarray(begin, bytesRead)]);
      if (carry.length > MAX_LINE) { carry = Buffer.alloc(0); skipping = true; }
    }
    if (performance.now() - yieldedAt >= 20) { await yieldLoop(); yieldedAt = performance.now(); }
  }
  file.partialBytes = position - committed;
  return changed || file.offset !== initialOffset;
}
