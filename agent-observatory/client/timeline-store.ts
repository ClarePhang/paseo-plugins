import { t } from "../shared/text";
import { normalizeTimelinePage, object, reconcileTimelinePage, type TimelineCursor, type TimelinePage, type TimelineRow } from "../shared/timeline";

export interface TimelineViewState { scrollOffset: number; filter: "all" | "tools" | "messages" | "errors"; followTail: boolean }
export interface TimelineState {
  page: TimelinePage | null; error: string | null; loading: boolean; refreshing: boolean; loadingOlder: boolean;
  lastSyncedAt: string | null; live: boolean; snapshot: Record<string, unknown> | null; viewState: TimelineViewState;
}
type FetchInput = { direction: "tail" | "before" | "after"; cursor?: TimelineCursor; limit: number };
export interface TimelineTransport {
  fetch(input: FetchInput): Promise<unknown>;
  subscribe?(handler: (update: unknown) => void): (() => void) & { ready?: Promise<void> };
}
export interface TimelineClock { now(): number; setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimeout(id: ReturnType<typeof setTimeout>): void }
const systemClock: TimelineClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };

const RESUBSCRIBE_DELAYS = [2_000, 5_000, 15_000, 30_000];
const PAGE_LIMIT = 100, CLIP_CHARS = 256_000, WINDOW_BYTES = 4 * 1024 * 1024;
const TURN_ENDS = new Set(["turn_completed", "turn_failed", "turn_canceled"]);
// Rows are immutable and can carry megabytes of tool output: each object is serialized once to size it, never per merge or publish.
const rowSizes = new WeakMap<TimelineRow, number>();
function rowChars(row: TimelineRow): number {
  let size = rowSizes.get(row);
  if (size === undefined) { size = JSON.stringify(row).length; rowSizes.set(row, size); }
  return size;
}
/** reconcileTimelinePage rebuilds every tool row it keeps; rows the incoming page did not touch keep their object, so their size and the view's memoised entries stay valid. */
function merge(previous: TimelinePage | null, incoming: TimelinePage, direction: "tail" | "before" = "tail"): TimelinePage {
  const page = reconcileTimelinePage(previous, incoming, direction);
  if (!previous || previous.epoch !== incoming.epoch || incoming.reset) return page;
  const touched = new Set(incoming.rows.map(row => row.key)), kept = new Map(previous.rows.map(row => [row.key, row]));
  let reused = false;
  const rows = page.rows.map(row => {
    const prior = touched.has(row.key) ? undefined : kept.get(row.key);
    if (!prior || prior === row || prior.seqStart !== row.seqStart || prior.seqEnd !== row.seqEnd) return row;
    reused = true; return prior;
  });
  return reused ? { ...page, rows } : page;
}
/**
 * Projected `after` pages re-send earlier anchors that changed (a tool's end, a growing reply); merging them by identity is exact
 * while every anchor lies inside the cached window. Another epoch, a reset or stale cursor, a host gap, a page limit (`hasNewer`)
 * or an anchor before the window (a tool started before the oldest cached row) would leave a hole: those read the tail instead.
 */
function joins(cached: TimelinePage, incoming: TimelinePage): boolean {
  if (incoming.epoch !== cached.epoch || incoming.reset || incoming.gap || incoming.hasNewer) return false;
  const start = cached.hasOlder ? cached.startCursor?.seq : undefined;
  return start === undefined || incoming.rows.every(row => row.seqStart >= start);
}
function boundPage(page: TimelinePage, direction: "tail" | "before" = "tail"): TimelinePage {
  let clipped = false;
  const rows = page.rows.map(row => {
    if (rowChars(row) < CLIP_CHARS) return row;
    clipped = true;
    let budget = 128_000;
    const bounded = (value: unknown, depth = 0): unknown => {
      if (depth > 10 || budget <= 0) return t("secondaryTimelineStore.cachedContentTruncated");
      if (typeof value === "string") { const limit = Math.min(30_000, budget); budget -= Math.min(value.length, limit); return value.length > limit ? t("secondaryTimelineStore.cachedContentTruncated2", { value1: value.slice(0, limit) }) : value; }
      if (Array.isArray(value)) return value.slice(0, 300).map(item => bounded(item, depth + 1));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 150).map(([key, item]) => [key, bounded(item, depth + 1)]));
      return value;
    };
    return { ...row, item: bounded(row.item) as typeof row.item };
  });
  if (clipped) page = { ...page, rows, truncated: true };
  if (direction === "before") {
    let size = 0, end = 0;
    for (const row of page.rows) { const bytes = rowChars(row) * 2; if (size + bytes > WINDOW_BYTES && end > 0) break; size += bytes; end++; }
    return end < page.rows.length ? { ...page, rows: page.rows.slice(0, end), endCursor: { epoch: page.epoch, seq: page.rows[end - 1].seqEnd }, hasNewer: true, truncated: true } : page;
  }
  let size = 0, start = page.rows.length;
  for (let index = page.rows.length - 1; index >= 0; index--) {
    const bytes = rowChars(page.rows[index]) * 2;
    if (size + bytes > WINDOW_BYTES && start < page.rows.length) break;
    size += bytes; start = index;
  }
  return start ? { ...page, rows: page.rows.slice(start), startCursor: page.rows[start] ? { epoch: page.epoch, seq: page.rows[start].seqStart } : page.startCursor, hasOlder: true, truncated: true } : page;
}
/**
 * Enabled consumers share one subscription; pausing retains pages and view state. Paseo 0.9 subscriptions deliver live events
 * only, and a text delta carries no projected row, so events just mark the cache dirty. While they stream, the page is read
 * incrementally (`after` the cached end) at most every `busyRefetchMs`, once more after `quietMs` of silence, and promptly when
 * a turn ends. A reconnect (`subscription_restored`: missed events are not replayed), a replacement or a manual refresh reads
 * the authoritative tail. An `error` releases the observation, so a new one is established with backoff while the view stays open.
 */
export function createTimelineStore(transport: TimelineTransport, options: { clock?: TimelineClock; minRefetchMs?: number; busyRefetchMs?: number; quietMs?: number; fallbackMs?: number; onChange?: () => void } = {}) {
  const clock = options.clock ?? systemClock, minimum = Math.max(2_000, options.minRefetchMs ?? 2_000), busy = Math.max(minimum, options.busyRefetchMs ?? 5_000);
  const quiet = Math.max(0, options.quietMs ?? 2_000), fallback = Math.max(minimum, options.fallbackMs ?? 30_000);
  let state: TimelineState = { page: null, error: null, loading: true, refreshing: false, loadingOlder: false, lastSyncedAt: null, live: false, snapshot: null,
    viewState: { scrollOffset: 0, filter: "all", followTail: true } };
  const listeners = new Set<() => void>();
  let owners = 0, revision = 0, lastFetch = -Infinity, lastEvent = -Infinity, dirty = false, authoritative = false, promptly = false, disposed = false;
  // Off while the Agent is closed (not loaded): reading its timeline would load it again, and Paseo 0.14 closes an idle
  // Agent after an hour, so a fallback poll would load and release it over and over. Live events and asked-for reads stay.
  let polling = true;
  let cachedBytes = 0;
  let subscriptionVersion = 0;
  let fetching: Promise<void> | null = null, unsubscribe: (() => void) | null = null;
  let dirtyTimer: ReturnType<typeof setTimeout> | null = null, pollTimer: ReturnType<typeof setTimeout> | null = null;
  let resubscribeTimer: ReturnType<typeof setTimeout> | null = null, resubscribes = 0;
  function publish(patch: Partial<TimelineState>) {
    // An empty increment or a repeated flag neither re-renders nor re-sums the page.
    if (disposed || (Object.keys(patch) as Array<keyof TimelineState>).every(key => Object.is(state[key], patch[key]))) return;
    state = { ...state, ...patch };
    if ("page" in patch) cachedBytes = state.page ? state.page.rows.reduce((sum, row) => sum + rowChars(row) * 2, 0) : 0;
    for (const listener of listeners) listener(); options.onChange?.();
  }
  function clearTimers() { if (dirtyTimer !== null) clock.clearTimeout(dirtyTimer); if (pollTimer !== null) clock.clearTimeout(pollTimer); if (resubscribeTimer !== null) clock.clearTimeout(resubscribeTimer); dirtyTimer = pollTimer = resubscribeTimer = null; }
  function schedulePoll() { if (pollTimer !== null) clock.clearTimeout(pollTimer); pollTimer = null; if (!owners || disposed || !polling) return; pollTimer = clock.setTimeout(() => { pollTimer = null; dirty = true; scheduleDirty(); }, fallback); }
  const dueAt = () => authoritative || promptly ? lastFetch + minimum : Math.max(lastFetch + minimum, Math.min(lastFetch + busy, lastEvent + quiet));
  function scheduleDirty() {
    if (!owners || disposed || !dirty || dirtyTimer !== null || fetching) return;
    dirtyTimer = clock.setTimeout(() => {
      dirtyTimer = null;
      // Events that arrived meanwhile postpone the quiet read; never read before it is due.
      if (clock.now() < dueAt()) scheduleDirty(); else void read(authoritative ? "full" : "increment");
    }, Math.max(0, dueAt() - clock.now()));
  }
  function rescheduleDirty() { if (dirtyTimer !== null) clock.clearTimeout(dirtyTimer); dirtyTimer = null; scheduleDirty(); }
  function read(kind: "full" | "increment" | "older"): Promise<void> {
    if (disposed || !owners) return Promise.resolve();
    const older = kind === "older";
    if (fetching) { if (!older) { dirty = true; authoritative ||= kind === "full"; } return fetching; }
    const startCursor = state.page?.startCursor;
    if (older && (!startCursor || !state.page?.hasOlder)) return Promise.resolve();
    if (!older && clock.now() - lastFetch < minimum) { dirty = true; authoritative ||= kind === "full"; scheduleDirty(); return Promise.resolve(); }
    let after: TimelineCursor | null = null;
    if (!older) {
      if (dirtyTimer !== null) clock.clearTimeout(dirtyTimer); dirtyTimer = null;
      const end = state.page?.endCursor;
      if (kind === "increment" && !authoritative && end && end.epoch === state.page!.epoch) after = end;
      lastFetch = clock.now(); dirty = promptly = authoritative = false;
    }
    const requestRevision = revision;
    publish({ refreshing: !older && !after, loadingOlder: older });
    // Null: the store was disposed or the epoch was replaced meanwhile, and the response is discarded.
    const load = async (input: FetchInput) => {
      const payload = await transport.fetch(input);
      if (disposed) return null;
      if (requestRevision !== revision) { dirty = true; return null; }
      const raw = object(payload);
      if (typeof raw.error === "string" && raw.error) throw new Error(raw.error);
      return { raw, page: normalizeTimelinePage(payload) };
    };
    fetching = Promise.resolve().then(async () => {
      let response = await load(older ? { direction: "before", cursor: startCursor!, limit: PAGE_LIMIT } : after ? { direction: "after", cursor: after, limit: PAGE_LIMIT } : { direction: "tail", limit: PAGE_LIMIT });
      if (!response) return;
      if (after) {
        const cached = state.page, incoming = response.page, raw = response.raw;
        if (cached && joins(cached, incoming)) {
          publish({ ...(incoming.rows.length ? { page: boundPage(merge(cached, incoming)) } : {}), loading: false, error: null, lastSyncedAt: new Date(clock.now()).toISOString(),
            ...(raw.agent ? { snapshot: object(raw.agent) } : {}) });
          return;
        }
        publish({ refreshing: true });
        response = await load({ direction: "tail", limit: PAGE_LIMIT });
        if (!response) return;
      }
      const { raw, page: incoming } = response, direction = older ? "before" : "tail";
      const changedEpoch = !!state.page && (incoming.epoch !== state.page.epoch || incoming.reset);
      // A tail that starts after the cached end (e.g. many rows missed while disconnected) must not be
      // stitched onto the old rows with a silent hole; it replaces them and older rows stay loadable.
      const detached = direction === "tail" && !!state.page && !changedEpoch && incoming.hasOlder && !!state.page.endCursor && !!incoming.startCursor
        && incoming.startCursor.seq > state.page.endCursor.seq + 1;
      const page = boundPage(merge(detached ? null : state.page, incoming, direction), direction);
      publish({ page, loading: false, error: null, lastSyncedAt: new Date(clock.now()).toISOString(),
        ...(raw.agent ? { snapshot: object(raw.agent) } : {}), ...(changedEpoch ? { viewState: { ...state.viewState, scrollOffset: 0 } } : {}) });
    }).catch(error => { publish({ loading: false, error: error instanceof Error ? error.message : t("secondaryTimelineStore.couldNotReadExecutionRecords") }); })
      .finally(() => { fetching = null; publish({ refreshing: false, loadingOlder: false }); schedulePoll(); scheduleDirty(); });
    return fetching;
  }
  function subscribeLive() {
    if (!transport.subscribe || !owners || disposed) return;
    const currentSubscription = ++subscriptionVersion;
    const failed = (error: unknown) => {
      if (!owners || disposed || currentSubscription !== subscriptionVersion) return;
      publish({ live: false, error: error instanceof Error ? error.message : typeof error === "string" ? error : t("secondaryTimelineStore.liveConnectionUnavailable") });
      scheduleResubscribe();
    };
    try {
      const sub = transport.subscribe(update => { if (currentSubscription === subscriptionVersion) handleEvent(update, failed); });
      unsubscribe = sub;
      Promise.resolve(sub.ready).then(() => { if (owners && !disposed && currentSubscription === subscriptionVersion) { resubscribes = 0; publish({ live: true }); } }).catch(failed);
    } catch (error) { failed(error); }
  }
  function scheduleResubscribe() {
    if (resubscribeTimer !== null || !owners || disposed) return;
    unsubscribe?.(); unsubscribe = null;
    const delay = RESUBSCRIBE_DELAYS[Math.min(resubscribes, RESUBSCRIBE_DELAYS.length - 1)];
    resubscribes += 1;
    resubscribeTimer = clock.setTimeout(() => { resubscribeTimer = null; subscribeLive(); if (polling) { dirty = true; scheduleDirty(); } }, delay);
  }
  function handleEvent(update: unknown, failed: (error: unknown) => void) {
    const payload = object(update), event = object(payload.event);
    // The SDK has released this observation; establish a new one and keep polling meanwhile.
    if (event.type === "error") { failed(typeof event.error === "string" ? event.error : t("secondaryTimelineStore.liveConnectionInterrupted")); if (polling) { dirty = true; scheduleDirty(); } return; }
    // Live delivery resumed after a reconnect; events in between were not replayed.
    if (event.type === "subscription_restored") { publish({ live: true, error: null }); dirty = authoritative = true; rescheduleDirty(); return; }
    if (event.type === "replacement") { revision++; authoritative = true; publish({ page: null, loading: true, viewState: { ...state.viewState, scrollOffset: 0 } }); }
    // Cursor-bearing pages are safe to merge. Unidentified text deltas only mark
    // the cache dirty, avoiding duplicate text on the next authoritative read.
    if (typeof payload.epoch === "string" && Array.isArray(payload.entries) && payload.entries.length) {
      const incoming = normalizeTimelinePage(payload);
      if (!state.page || state.page.epoch === incoming.epoch) publish({ page: boundPage(merge(state.page, incoming)), lastSyncedAt: new Date(clock.now()).toISOString() });
    }
    lastEvent = clock.now(); dirty = true;
    // A finished turn settles its rows: read them without waiting for the streaming pace (an increment is exact, see joins).
    if (typeof event.type === "string" && TURN_ENDS.has(event.type)) promptly = true;
    if (authoritative || promptly) rescheduleDirty(); else scheduleDirty();
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    acquire() {
      if (disposed) throw new Error(t("secondaryTimelineStore.disposed"));
      owners++;
      if (owners === 1) {
        resubscribes = 0;
        subscribeLive();
        // Events missed while paused are covered by an increment from the cached end.
        if (!state.page || clock.now() - lastFetch >= minimum) void read("increment"); else { schedulePoll(); scheduleDirty(); }
      }
      let released = false;
      return () => { if (released) return; released = true; owners--; if (!owners) { subscriptionVersion++; clearTimers(); unsubscribe?.(); unsubscribe = null; publish({ live: false }); } };
    },
    refresh: () => read("full"),
    loadOlder: () => read("older"),
    /** Whether to poll as a fallback to live events (off while the Agent is closed); turning it on reads what was missed. */
    setPolling(on: boolean) {
      if (polling === on) return;
      polling = on;
      if (!on) { if (pollTimer !== null) clock.clearTimeout(pollTimer); pollTimer = null; return; }
      if (owners && !disposed) { dirty = true; scheduleDirty(); schedulePoll(); }
    },
    setViewState(patch: Partial<TimelineViewState>) {
      const scrollOffset = patch.scrollOffset === undefined ? state.viewState.scrollOffset : Math.max(0, Number.isFinite(patch.scrollOffset) ? patch.scrollOffset : 0);
      if (scrollOffset === state.viewState.scrollOffset && (patch.filter === undefined || patch.filter === state.viewState.filter) && (patch.followTail === undefined || patch.followTail === state.viewState.followTail)) return;
      publish({ viewState: { ...state.viewState, ...patch, scrollOffset } });
    },
    get active() { return owners > 0; },
    get bytes() { return cachedBytes; },
    dispose() { if (owners || listeners.size) return false; disposed = true; clearTimers(); unsubscribe?.(); listeners.clear(); state.page = null; cachedBytes = 0; return true; },
  };
}
export type TimelineStore = ReturnType<typeof createTimelineStore>;
export function createTimelineCache(options: { limit?: number; maxBytes?: number } = {}) {
  const entries = new Map<string, TimelineStore>();
  const limit = options.limit ?? 12, maxBytes = options.maxBytes ?? 24 * 1024 * 1024;
  const prune = (protectedKey: string) => {
    let bytes = [...entries.values()].reduce((sum, store) => sum + store.bytes, 0);
    for (const [key, store] of entries) {
      if (entries.size <= limit && bytes <= maxBytes) break;
      if (key === protectedKey || store.active) continue;
      const size = store.bytes;
      if (store.dispose()) { entries.delete(key); bytes -= size; }
    }
  };
  return { get(key: string, create: (onChange: () => void) => TimelineStore) {
    let store = entries.get(key);
    if (store) entries.delete(key); else store = create(() => prune(key));
    entries.set(key, store); prune(key); return store;
  }, get size() { return entries.size; } };
}
