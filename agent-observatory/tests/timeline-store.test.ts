import assert from "node:assert/strict";
import test from "node:test";
import { createTimelineCache, createTimelineStore, type TimelineClock, type TimelineTransport } from "../client/timeline-store";
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function clock() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const value: TimelineClock = { now: () => now, setTimeout(fn, ms) { const id = ++next; timers.set(id, { at: now + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; }, clearTimeout(id) { timers.delete(id as unknown as number); } };
  return { value, async advance(ms: number) { const end = now + ms; for (;;) { const timer = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!timer) break; now = timer[1].at; timers.delete(timer[0]); timer[1].fn(); await settle(); } now = end; await settle(); }, get timers() { return timers.size; } };
}
const page = (seq: number[], epoch = "one") => ({ epoch, rows: seq.map(n => ({ seqStart: n, seqEnd: n, timestamp: "2026-09-17T00:00:00Z", item: { type: "assistant_message", text: `message-${n}` } })), hasOlder: seq[0] > 1, hasNewer: false });
type Fetch = Parameters<TimelineTransport["fetch"]>[0];
const live = (emitter: { emit?: (event: unknown) => void }) => (listener: (event: unknown) => void) => { emitter.emit = listener; return Object.assign(() => {}, { ready: Promise.resolve() }); };
const delta = { event: { type: "timeline", item: { type: "assistant_message", text: "delta" } } };
test("streaming deltas are read incrementally at most every 5 s and once more after 2 s of quiet", async () => {
  const time = clock(), inputs: Fetch[] = [], emitter: { emit?: (event: unknown) => void } = {};
  const store = createTimelineStore({ fetch: async input => { inputs.push(input); return input.direction === "after" ? { ...page([]), epoch: "one" } : page([10, 11]); }, subscribe: live(emitter) }, { clock: time.value });
  const release = store.acquire(); await settle();
  // 18 s of deltas every 100 ms: the old 2 s pace re-read the 100-row tail nine times.
  for (let i = 0; i < 180; i++) { emitter.emit!(delta); await time.advance(100); }
  assert.deepEqual(inputs.map(input => input.direction), ["tail", "after", "after", "after"]);
  assert.deepEqual(inputs[1], { direction: "after", cursor: { epoch: "one", seq: 11 }, limit: 100 });
  await time.advance(1_800); assert.equal(inputs.length, 4, "no read before the stream has been quiet for 2 s");
  await time.advance(200); assert.equal(inputs.length, 5); assert.equal(inputs[4].direction, "after");
  await time.advance(29_000); assert.equal(inputs.length, 5, "an idle stream waits for the 30 s fallback");
  assert.equal(store.getSnapshot().page?.rows.length, 2);
  release(); assert.equal(time.timers, 0);
});
test("a finished turn is read promptly; a reconnect and a manual refresh read the authoritative tail", async () => {
  const time = clock(), directions: string[] = [], emitter: { emit?: (event: unknown) => void } = {};
  const store = createTimelineStore({ fetch: async input => { directions.push(input.direction); return page([10, 11]); }, subscribe: live(emitter) }, { clock: time.value });
  const release = store.acquire(); await settle();
  await time.advance(1_000); emitter.emit!(delta); await time.advance(500);
  emitter.emit!({ event: { type: "turn_completed", provider: "fake" } }); await time.advance(499);
  assert.deepEqual(directions, ["tail"]); await time.advance(1);
  assert.deepEqual(directions, ["tail", "after"], "the turn end is read 2 s after the previous read, not at the streaming pace");
  emitter.emit!({ event: { type: "subscription_restored" } }); await time.advance(2_000);
  assert.deepEqual(directions, ["tail", "after", "tail"], "missed events are not replayed after a reconnect");
  await store.refresh(); await time.advance(2_000);
  assert.deepEqual(directions, ["tail", "after", "tail", "tail"]);
  release();
});
const entry = (seqStart: number, seqEnd: number, item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ seqStart, seqEnd, timestamp: "2026-09-17T00:00:00Z", turnId: "turn", item, ...extra });
const tool = (status: string, output: string) => ({ type: "tool_call", callId: "call", name: "exec", status, detail: { type: "shell", command: "npm test", output } });
test("increments merge new rows and re-sent earlier anchors from the cached end", async () => {
  const time = clock(), inputs: Fetch[] = [], emitter: { emit?: (event: unknown) => void } = {};
  const responses: unknown[] = [
    { epoch: "one", entries: [entry(1, 1, { type: "user_message", text: "run the checks" }), entry(2, 2, tool("running", "")), entry(3, 3, { type: "assistant_message", text: "waiting" })], hasOlder: false },
    // The running tool (anchored at 2) completed at 5: projected `after` pages re-send it whole.
    { epoch: "one", entries: [entry(2, 5, tool("completed", "ok"), { sourceSeqRanges: [{ startSeq: 2, endSeq: 2 }, { startSeq: 5, endSeq: 5 }] }), entry(4, 4, { type: "assistant_message", text: "done" })], hasOlder: true },
    { epoch: "one", entries: [], hasOlder: true },
  ];
  const store = createTimelineStore({ fetch: async input => { inputs.push(input); return responses.shift(); }, subscribe: live(emitter) }, { clock: time.value });
  const release = store.acquire(); await settle();
  emitter.emit!(delta); await time.advance(2_000);
  assert.deepEqual(inputs[1], { direction: "after", cursor: { epoch: "one", seq: 3 }, limit: 100 });
  const merged = store.getSnapshot().page!;
  assert.deepEqual(merged.rows.map(row => [row.seqStart, row.seqEnd, row.item.type]), [[1, 1, "user_message"], [2, 5, "tool_call"], [3, 3, "assistant_message"], [4, 4, "assistant_message"]]);
  assert.equal(merged.rows[1].item.status, "completed"); assert.equal(merged.endCursor?.seq, 5); assert.equal(merged.hasOlder, false);
  let renders = 0; const unsubscribe = store.subscribe(() => { renders++; });
  emitter.emit!(delta); await time.advance(2_000);
  assert.deepEqual(inputs[2].cursor, { epoch: "one", seq: 5 });
  assert.equal(store.getSnapshot().page, merged, "an empty increment keeps the page object"); assert.equal(renders, 1, "only the sync time changes");
  unsubscribe(); release();
});
test("increments that cannot join the cached window fall back to one authoritative tail", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a host gap or stale cursor", { epoch: "one", entries: [entry(30, 30, { type: "assistant_message", text: "later" })], reset: true, gap: true }],
    ["another epoch", { epoch: "two", entries: [entry(1, 1, { type: "assistant_message", text: "replaced" })] }],
    ["more rows than one page", { epoch: "one", entries: [entry(12, 12, { type: "assistant_message", text: "next" })], hasNewer: true }],
    ["an anchor before the cached window", { epoch: "one", entries: [entry(4, 13, tool("completed", "ok"))], hasOlder: true }],
  ];
  for (const [label, after] of cases) {
    const time = clock(), directions: string[] = [], emitter: { emit?: (event: unknown) => void } = {};
    let tails = 0;
    const store = createTimelineStore({ fetch: async input => { directions.push(input.direction); if (input.direction === "after") return after; return tails++ ? { ...page([10, 11, 12, 13]), epoch: String(after.epoch) } : page([10, 11]); }, subscribe: live(emitter) }, { clock: time.value });
    const release = store.acquire(); await settle();
    emitter.emit!(delta); await time.advance(2_000);
    assert.deepEqual(directions, ["tail", "after", "tail"], label);
    assert.deepEqual(store.getSnapshot().page?.rows.map(row => row.seqStart), [10, 11, 12, 13], label);
    assert.equal(store.getSnapshot().page?.gap, false, label); assert.equal(store.getSnapshot().refreshing, false, label);
    release();
  }
});
test("each row is measured once and publishing never serializes the page", async () => {
  const time = clock(), emitter: { emit?: (event: unknown) => void } = {}, output = "y".repeat(20_000);
  let next = 41;
  const head = Array.from({ length: 40 }, (_, index) => index % 4 ? entry(index + 1, index + 1, { type: "assistant_message", text: `message-${index}` })
    : entry(index + 1, index + 1, { ...tool("completed", output), callId: `call-${index}` }));
  const store = createTimelineStore({ fetch: async input => {
    if (input.direction !== "after") return { epoch: "one", entries: head, hasOlder: true };
    const seq = next; next += 2;
    // Each increment re-sends the first tool (a later update) and adds two rows.
    return { epoch: "one", entries: [entry(1, seq, { ...tool("completed", output), callId: "call-0" }), entry(seq, seq, { type: "assistant_message", text: `new-${seq}` }), entry(seq + 1, seq + 1, { type: "assistant_message", text: `new-${seq + 1}` })] };
  }, subscribe: live(emitter) }, { clock: time.value });
  const stringify = JSON.stringify, measured = new Map<object, number>();
  let pages = 0;
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    if (value && typeof value === "object") { if ("rows" in value) pages++; else if ("seqStart" in value && "item" in value) measured.set(value, (measured.get(value) ?? 0) + 1); }
    return (stringify as (...args: unknown[]) => string)(value, ...rest);
  }) as typeof JSON.stringify;
  let release = () => {};
  try {
    release = store.acquire(); await settle();
    for (let i = 0; i < 6; i++) { emitter.emit!(delta); await time.advance(2_000); }
  } finally { JSON.stringify = stringify; }
  const rows = store.getSnapshot().page!.rows;
  assert.equal(rows.length, 52); assert.equal(pages, 0);
  assert.equal(Math.max(...measured.values()), 1, "no row object is serialized twice");
  // 40 tail rows plus three rows per increment; the old store serialized every row twice and the whole page once per read.
  assert.equal(measured.size, 40 + 6 * 3);
  assert.equal(store.bytes, rows.reduce((sum, row) => sum + JSON.stringify(row).length * 2, 0));
  release();
});
test("shared subscribers pause independently and retain history and scroll state", async () => {
  const time = clock(); let subscriptions = 0, unsubscriptions = 0, calls = 0;
  const transport: TimelineTransport = { fetch: async input => { calls++; return input.direction === "before" ? page([1, 2]) : page([10, 11]); }, subscribe() { subscriptions++; return () => { unsubscriptions++; }; } };
  const store = createTimelineStore(transport, { clock: time.value });
  const release1 = store.acquire(), release2 = store.acquire(); await settle();
  assert.equal(subscriptions, 1);
  await store.loadOlder(); store.setViewState({ scrollOffset: 880, filter: "tools", followTail: false });
  release1(); assert.equal(unsubscriptions, 0); release2(); assert.equal(unsubscriptions, 1);
  assert.deepEqual(store.getSnapshot().page?.rows.map(row => row.seqStart), [1, 2, 10, 11]);
  await time.advance(60_000); assert.equal(calls, 2);
  const release3 = store.acquire(); await settle();
  assert.equal(subscriptions, 2); assert.equal(store.getSnapshot().viewState.scrollOffset, 880);
  assert.equal(store.getSnapshot().viewState.filter, "tools"); assert.equal(store.getSnapshot().page?.hasOlder, false);
  release3();
});
test("epoch replacement discards old page response and resets only epoch-bound scroll", async () => {
  const time = clock(); let emit!: (event: unknown) => void, resolve!: (page: unknown) => void;
  let calls = 0;
  const store = createTimelineStore({ fetch: () => ++calls === 1 ? new Promise(yes => { resolve = yes; }) : Promise.resolve(page([1], "two")), subscribe(fn) { emit = fn; return () => {}; } }, { clock: time.value });
  const release = store.acquire(); await settle(); store.setViewState({ scrollOffset: 90, filter: "errors" });
  emit({ event: { type: "replacement", epoch: "two" } }); resolve(page([10], "one")); await settle();
  assert.equal(store.getSnapshot().page, null); await time.advance(2000);
  assert.equal(store.getSnapshot().page?.epoch, "two"); assert.equal(store.getSnapshot().viewState.scrollOffset, 0); assert.equal(store.getSnapshot().viewState.filter, "errors"); release();
});
test("errors retain last successful page and periodic fallback recovers", async () => {
  const time = clock(); let fail = false;
  const store = createTimelineStore({ fetch: async () => { if (fail) throw new Error("offline"); return page([1]); } }, { clock: time.value });
  const release = store.acquire(); await settle(); fail = true; await time.advance(30_000);
  assert.equal(store.getSnapshot().error, "offline"); assert.equal(store.getSnapshot().page?.rows.length, 1);
  fail = false; await time.advance(30_000); assert.equal(store.getSnapshot().error, null); release();
});
test("LRU evicts inactive histories but retains stores with mounted observers", () => {
  const cache = createTimelineCache({ limit: 2 });
  const create = (onChange: () => void) => createTimelineStore({ fetch: async () => page([]) }, { onChange });
  const one = cache.get("one", create), unsubscribe = one.subscribe(() => {});
  cache.get("two", create); cache.get("three", create);
  assert.equal(cache.size, 2); assert.equal(cache.get("one", create), one); unsubscribe();
});
test("oversized row content is bounded with explicit truncation", async () => {
  const time = clock();
  const store = createTimelineStore({ fetch: async () => ({ ...page([1]), rows: [{ seqStart: 1, seqEnd: 1, item: { type: "tool_call", name: "exec", detail: { output: "x".repeat(5_000_000) } } }] }) }, { clock: time.value });
  const release = store.acquire(); await settle(); assert.equal(store.getSnapshot().page?.truncated, true); assert.ok(store.bytes < 4 * 1024 * 1024); release();
});

test("an old subscription readiness failure cannot overwrite a newly resumed connection", async () => {
  const time = clock(); let rejectOld!: (error: Error) => void, subscriptions = 0;
  const store = createTimelineStore({ fetch: async () => page([1]), subscribe() {
    subscriptions++;
    return Object.assign(() => {}, { ready: subscriptions === 1 ? new Promise<void>((_, reject) => { rejectOld = reject; }) : Promise.resolve() });
  } }, { clock: time.value });
  const release = store.acquire(); await settle(); release();
  const releaseNext = store.acquire(); await settle();
  assert.equal(store.getSnapshot().live, true);
  rejectOld(new Error("Old connection closed")); await settle();
  assert.equal(store.getSnapshot().live, true); assert.equal(store.getSnapshot().error, null);
  releaseNext();
});

test("subscription_restored re-reads the tail because 0.9 does not replay missed events", async () => {
  const time = clock(); let calls = 0, emit!: (event: unknown) => void;
  const store = createTimelineStore({ fetch: async () => { calls++; return page([10, 11]); }, subscribe(listener) { emit = listener; return Object.assign(() => {}, { ready: Promise.resolve() }); } }, { clock: time.value });
  const release = store.acquire(); await settle();
  assert.equal(calls, 1); assert.equal(store.getSnapshot().live, true);
  emit({ agentId: "a", event: { type: "error", error: "stream closed" } }); await settle();
  assert.equal(store.getSnapshot().live, false);
  emit({ agentId: "a", subscriptionId: "s2", event: { type: "subscription_restored" } }); await time.advance(2_000);
  assert.equal(store.getSnapshot().live, true); assert.ok(calls >= 2);
  release();
});

test("an observation error releases it; a new subscription is established with backoff while open", async () => {
  const time = clock(); let subscriptions = 0, emit!: (event: unknown) => void, unsubscribed = 0;
  const store = createTimelineStore({ fetch: async () => page([1]), subscribe(listener) {
    subscriptions++; emit = listener;
    return Object.assign(() => { unsubscribed++; }, { ready: subscriptions === 2 ? Promise.reject(new Error("still offline")) : Promise.resolve() });
  } }, { clock: time.value });
  const release = store.acquire(); await settle();
  emit({ agentId: "a", event: { type: "error", error: "Timeline observation failed" } }); await settle();
  assert.equal(store.getSnapshot().live, false); assert.equal(store.getSnapshot().error, "Timeline observation failed");
  await time.advance(2_000); assert.equal(subscriptions, 2); assert.equal(store.getSnapshot().live, false);
  await time.advance(5_000); assert.equal(subscriptions, 3); assert.equal(store.getSnapshot().live, true);
  release(); assert.equal(time.timers, 0); assert.ok(unsubscribed >= 2);
});

test("a tail that starts beyond the cached end replaces it instead of leaving a silent gap", async () => {
  const time = clock(); let tail = page([1, 2, 3]);
  const store = createTimelineStore({ fetch: async () => tail }, { clock: time.value });
  const release = store.acquire(); await settle();
  tail = { ...page([400, 401]), hasOlder: true }; await store.refresh(); await time.advance(2_000);
  assert.deepEqual(store.getSnapshot().page?.rows.map(row => row.seqStart), [400, 401]);
  assert.equal(store.getSnapshot().page?.hasOlder, true);
  tail = { ...page([401, 402]), hasOlder: true }; await time.advance(30_000);
  assert.deepEqual(store.getSnapshot().page?.rows.map(row => row.seqStart), [400, 401, 402], "overlapping tails still merge");
  release();
});
test("no fallback poll while the Agent is closed (each read would load it again); turning polling back on reads what was missed", async () => {
  const time = clock(), directions: string[] = [], emitter: { emit?: (event: unknown) => void } = {};
  const store = createTimelineStore({ fetch: async input => { directions.push(input.direction); return page([10, 11]); }, subscribe: live(emitter) }, { clock: time.value });
  store.setPolling(false);
  const release = store.acquire(); await settle();
  assert.deepEqual(directions, ["tail"], "opening still reads once");
  await time.advance(5 * 60_000);
  assert.deepEqual(directions, ["tail"], "no 30 s fallback while closed");
  emitter.emit!({ event: { type: "error", error: "released" } }); await time.advance(60_000);
  assert.deepEqual(directions, ["tail"], "a dropped observation does not read either");
  await store.refresh(); await time.advance(1);
  assert.deepEqual(directions, ["tail", "tail"], "a refresh the user asks for still reads");
  store.setPolling(true); await time.advance(2_000);
  assert.equal(directions.length, 3, "loaded again: one read for what was missed");
  await time.advance(30_000);
  assert.equal(directions.length, 4, "then the fallback poll as before");
  release(); assert.equal(time.timers, 0);
});
