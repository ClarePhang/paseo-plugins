import assert from "node:assert/strict";
import test from "node:test";
import { childBackground, enrichAgents } from "../shared/background";
import { needsAttention } from "../shared/dashboard-model";
import { sessionPhase } from "../shared/attention";
import { normalizeAgent, type AgentRecord } from "../shared/model";

// A parent's finished turn is held while the Paseo sub-agents it started still work (2.18).

const T = "2026-10-28T20:00:00.000Z";
const parent = (patch: Record<string, unknown> = {}) => normalizeAgent({ id: "lead", title: "带队", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: T, updatedAt: T, lastUserMessageAt: "2026-10-28T19:00:00.000Z", ...patch });
const child = (id: string, patch: Record<string, unknown>) => normalizeAgent({ id, title: `子任务 ${id}`, labels: { "paseo.parent-agent-id": "lead" }, updatedAt: T, ...patch });

test("a parent whose sub-agents still run stays 执行中, its result held until they are done", () => {
  const before = parent();
  assert.equal(needsAttention(before), true, "alone, a finished turn is an unread result");
  const [lead, worker] = enrichAgents([before, child("w1", { status: "running", activeTurn: { startedAt: "2026-10-28T19:30:00.000Z" } })]);
  assert.equal(lead!.status, "running");
  assert.equal(sessionPhase(lead!), "running");
  assert.equal(needsAttention(lead!), false, "held: nothing to read yet");
  assert.deepEqual(lead!.background, { running: 1, since: "2026-10-28T19:30:00.000Z", updatedAt: lead!.background!.updatedAt, labels: ["子任务 w1"] });
  assert.equal(worker!.status, "running");
  // Done: the parent's result counts again.
  const [released] = enrichAgents([parent(), child("w1", { status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: T })]);
  assert.equal(released!.background, undefined);
  assert.equal(needsAttention(released!), true);
});

test("a sub-agent waiting for an approval, or one whose own sub-agents run, keeps the parent held", () => {
  const waiting = child("w2", { status: "running", pendingPermissions: [{ id: "p", kind: "tool", name: "Bash" }] });
  assert.equal(childBackground([parent(), waiting]).get("lead")?.running, 1);
  const middle = child("mid", { status: "idle" });
  const grandchild = normalizeAgent({ id: "g", title: "孙任务", status: "running", labels: { "paseo.parent-agent-id": "mid" }, updatedAt: T });
  assert.equal(childBackground([parent(), middle, grandchild]).get("lead")?.running, 1, "busy below counts");
  // An archived or failed sub-agent holds nothing; a cycle can't hang the check.
  assert.equal(childBackground([parent(), child("x", { status: "running", archivedAt: T })]).size, 0);
  assert.equal(childBackground([parent(), child("y", { status: "error" })]).size, 0);
  const loopA = normalizeAgent({ id: "a", title: "a", status: "idle", labels: { "paseo.parent-agent-id": "b" } }) as AgentRecord;
  const loopB = normalizeAgent({ id: "b", title: "b", status: "idle", labels: { "paseo.parent-agent-id": "a" } }) as AgentRecord;
  assert.equal(childBackground([loopA, loopB]).size, 0);
});

test("a sub-agent whose own provider background agents still work keeps the parent held", () => {
  const worker = child("w3", { status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: T });
  const background = { agents: [{ agentId: "w3", running: 1, since: "2026-10-28T19:40:00.000Z", updatedAt: T, labels: ["后台测试"] }] };
  const [lead, busy] = enrichAgents([parent(), worker], undefined, background);
  assert.equal(busy!.status, "running");
  assert.equal(busy!.background?.running, 1);
  assert.equal(lead!.status, "running");
  assert.equal(needsAttention(lead!), false, "held while the sub-agent's background work runs");
  assert.deepEqual(lead!.background, { running: 1, since: "2026-10-28T19:40:00.000Z", updatedAt: T, labels: ["子任务 w3"] });
});
