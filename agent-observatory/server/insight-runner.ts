import { onTextChange, translator } from "../shared/i18n";
import { t } from "../shared/text";
import type { PaseoApi, PaseoAgent, PaseoAgentCreateOptions, PaseoAgentHandle, PaseoAgentRunResult, PaseoProviderSnapshotResult, AgentMode } from "./paseo-types";
import { z } from "zod";
import { GROK_DEFAULT_EFFORT, GROK_DEFAULT_MODEL, grokRunnerLabel, type InsightJob, type InsightModelOption, type InsightRunner, type InsightRunnerInfo, type InsightRunnerOption, type InsightRunners } from "../shared/insights";
import { findGrokBinary } from "./grok-runner";
import { redactSecrets } from "./insight-analysis";
import { defaultModelOf, providerModelId } from "../shared/provider-model";

export const BUILTIN_INSIGHT_RUNNER: InsightRunnerInfo = { kind: "grok", label: "Grok 4.7 · xhigh", provider: null, model: GROK_DEFAULT_MODEL, thinkingOptionId: GROK_DEFAULT_EFFORT, modeId: null, sessionAgentId: null };
/** The built-in Grok CLI with its saved model and reasoning effort (grok-4.7 · xhigh when unset). */
export function grokPlan(runner: Extract<InsightRunner, { kind: "grok" }>): InsightRunnerPlan {
  const model = runner.model ?? GROK_DEFAULT_MODEL, effort = runner.effort ?? GROK_DEFAULT_EFFORT;
  return { info: { ...BUILTIN_INSIGHT_RUNNER, label: grokRunnerLabel({ model, effort }), model, thinkingOptionId: effort }, model, effort, access: "none", featureValues: {} };
}
export let AUTO_RUNNER_LABEL = t("serverInsightRunner.m001");
/** What the built-in runner really does (grok-runner.ts): no tools offered and every call refused; its session is deleted when the run ends. */
export let GROK_RUNNER_DETAIL = t("serverInsightRunner.m002");
export let NO_RUNNER_ERROR = t("serverInsightRunner.m003");
export let INSIGHT_PERMISSION_MESSAGE = t("serverInsightRunner.m004");
/** Shown for `ask` access: only requests that need approval reach the observatory, so say so. */
let ASK_REASON = t("serverInsightRunner.m005");
let NO_MODES_REASON = t("serverInsightRunner.m006");
let UNSAFE_REASON = t("serverInsightRunner.m007");
let UNVERIFIED_MODE_ERROR = t("serverInsightRunner.m008");
let WORKSPACE_ERROR = t("serverInsightRunner.m009");
/** What `auto` may run, in order: Claude Code, Codex, then custom providers that extend them (`extends` in the daemon config). */
const AUTO_BASES = ["claude", "codex"] as const;
/**
 * Profile feature switches an analysis keeps: speed and reasoning effort only (Paseo 0.11: Claude Code / Oh My Pi `fast_mode`,
 * Cursor `fast`, Codex `service_tier`). Everything else (auto-accept, plan or agent switches, provider-specific access settings)
 * belongs to the profile's coding sessions, not to an analysis that reads untrusted transcripts.
 */
const INSIGHT_FEATURES = new Set(["fast_mode", "fast", "service_tier", "reasoning", "reasoning_effort", "effort", "thinking"]);
/** Providers whose daemon client turns auto-accept on for a child of an unattended Agent unless the request sets it. */
const AUTO_ACCEPT_BASES = new Set(["acp", "copilot", "opencode"]);
type Access = InsightRunnerOption["access"];
type Profile = NonNullable<Awaited<ReturnType<PaseoApi["config"]["get"]>>["config"]["agentProfiles"]>[number];
interface CatalogEntry { provider: string; label: string; description: string | null; enabled: boolean; status: string; error: string | null; modes: AgentMode[]; models: InsightModelOption[];
  /** The built-in provider a custom one extends, from the daemon config. */ extends: string | null }
interface Catalog { entries: CatalogEntry[]; profiles: Profile[] }
export interface InsightRunnerPlan { info: InsightRunnerInfo; model: string; effort: string | null; access: Access; featureValues: Record<string, unknown>; providerOptions?: Record<string, unknown> }
export interface InsightRunnerRegistryOptions { now?: () => number; findBinary?: () => Promise<string | null>; cacheMs?: number }
const clipped = (value: string | undefined | null, length: number) => value?.trim().slice(0, length) || null;
const safeError = (value: unknown, length = 300) => redactSecrets(value instanceof Error ? value.message : String(value)).slice(0, length);
const validId = (value: string | undefined, max: number) => value && value.length <= max ? value : null;

/** The allowlisted switches with plain values; `auto_accept: false` (switching approval prompts back on) always passes. */
export function filterInsightFeatures(values: Record<string, unknown> = {}): Record<string, unknown> {
  const plain = (value: unknown) => typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 120);
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => (INSIGHT_FEATURES.has(key) && plain(value)) || (key === "auto_accept" && value === false)));
}
export interface InsightAnalysisMode { modeId: string | null; access: Access; providerOptions?: Record<string, unknown>; unsafe?: true }
/** Codex's read-only sandbox, applied on top of its default mode (create_agent rejects modes a provider does not list). */
export const CODEX_READ_ONLY_OPTIONS = { sandbox_mode: "read-only", approval_policy: "never" } as const;
/**
 * The mode an analysis runs in, always explicit (create_agent otherwise inherits the analysed Agent's mode, often
 * unattended, or maps an unattended parent to the target's unattended mode). Only modes whose restriction is known qualify:
 * - Codex and providers that extend it: the default mode in Codex's read-only sandbox without approvals (`read`);
 * - an `ask` mode (Cursor's read-only Ask; Oh My Pi's Always Ask) (`read`);
 * - a `default` mode the provider marks as safe, Claude Code's Always Ask: every tool that needs approval asks (`ask`);
 * - a plan mode (`read`).
 * A mode id alone proves nothing (an ACP agent's "default" or "agent" mode may edit without asking), and a provider with
 * no listed modes cannot be pinned to one: both are `unsafe` and never run.
 */
export function insightAnalysisMode(modes: readonly AgentMode[], provider: { codex?: boolean } = {}): InsightAnalysisMode {
  const usable = modes.filter(mode => !(mode as AgentMode & { isUnattended?: boolean }).isUnattended && mode.colorTier !== "dangerous");
  if (provider.codex && usable.some(mode => mode.id === "auto")) return { modeId: "auto", access: "read", providerOptions: { ...CODEX_READ_ONLY_OPTIONS } };
  const ask = usable.find(mode => mode.id === "ask");
  if (ask) return { modeId: ask.id, access: "read" };
  const gated = usable.find(mode => mode.id === "default" && mode.colorTier === "safe");
  if (gated) return { modeId: gated.id, access: "ask" };
  const plan = usable.find(mode => mode.id === "plan" || mode.colorTier === "planning");
  if (plan) return { modeId: plan.id, access: "read" };
  return { modeId: null, access: "ask", unsafe: true };
}
/** The built-ins a provider is or extends (custom providers name theirs in `extends`). */
const lineage = (entry: Pick<CatalogEntry, "provider" | "extends">) => [entry.provider, entry.extends].filter((id): id is string => !!id);
const analysisModeOf = (entry: CatalogEntry) => insightAnalysisMode(entry.modes, { codex: lineage(entry).includes("codex") });
/** An analysis never auto-accepts: ACP and OpenCode clients otherwise switch it on for children of unattended Agents. */
const lockedFeatures = (entry: CatalogEntry): Record<string, unknown> => lineage(entry).some(id => AUTO_ACCEPT_BASES.has(id)) ? { auto_accept: false } : {};

function normalizeModels(entry: PaseoProviderSnapshotResult["entries"][number], snapshot: PaseoProviderSnapshotResult): InsightModelOption[] {
  const compact = snapshot.compactSnapshot?.entries.find(candidate => candidate.provider === entry.provider);
  const raw = entry.models?.length ? entry.models : compact?.models ?? [];
  const seen = new Set<string>();
  return raw.flatMap(model => {
    if (!validId(model.id, 240) || seen.has(model.id)) return [];
    seen.add(model.id);
    const compactModel = compact?.models?.find(candidate => candidate.id === model.id);
    const setIndex = "thinkingSet" in model && typeof model.thinkingSet === "number" ? model.thinkingSet : compactModel?.thinkingSet;
    const set = setIndex === undefined ? undefined : snapshot.compactSnapshot?.thinkingSets[setIndex];
    const options = "thinkingOptions" in model && model.thinkingOptions?.length ? model.thinkingOptions : set?.options ?? [];
    const defaultThinkingOptionId = validId(model.defaultThinkingOptionId ?? set?.defaultOptionId ?? options.find(option => option.isDefault)?.id, 120);
    return [{ id: model.id, label: clipped(model.label, 240) ?? model.id, isDefault: !!model.isDefault,
      thinking: options.filter(option => validId(option.id, 120)).slice(0, 16).map(option => ({ id: option.id, label: clipped(option.label, 120) ?? option.id })), defaultThinkingOptionId }];
  }).sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).slice(0, 150);
}

async function catalogRequest<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([request, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(t("serverInsightRunner.m010"))), 12_000); timer.unref(); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** One registry per daemon connection; no cwd/provider probing and shared in-flight reads. */
export class InsightRunnerRegistry {
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly findBinary: () => Promise<string | null>;
  private catalogCache: { at: number; promise: Promise<Catalog>; textKey: string } | null = null;
  private binaryCache: { at: number; promise: Promise<boolean> } | null = null;
  constructor(private readonly paseo: PaseoApi, options: InsightRunnerRegistryOptions = {}) {
    this.now = options.now ?? Date.now; this.cacheMs = Math.max(60_000, options.cacheMs ?? 60_000); this.findBinary = options.findBinary ?? findGrokBinary;
  }
  private catalog(): Promise<Catalog> {
    const textKey = `${translator().language}:${translator().hash}`;
    if (!this.catalogCache || this.catalogCache.textKey !== textKey || this.now() - this.catalogCache.at >= this.cacheMs) {
      const promise = catalogRequest(Promise.all([this.paseo.config.get(), this.providerSnapshot()])).then(([{ config }, snapshot]) => {
        const entries = snapshot.entries.length ? snapshot.entries : (snapshot.compactSnapshot?.entries ?? []);
        return { profiles: (config.agentProfiles ?? []).filter(profile => validId(profile.id, 200)), entries: entries.filter(entry => validId(entry.provider, 120)).map(entry => {
          const compact = snapshot.compactSnapshot?.entries.find(candidate => candidate.provider === entry.provider);
          // Compact models have their thinking data stored once in thinkingSets.
          const full = snapshot.entries.find(candidate => candidate.provider === entry.provider) ?? { ...entry, models: undefined };
          return { provider: entry.provider, label: clipped(entry.label, 160) ?? entry.provider, description: clipped(entry.description, 400), enabled: entry.enabled !== false && config.providers?.[entry.provider]?.enabled !== false,
            status: entry.status, error: entry.error ? safeError(entry.error) : null, modes: entry.modes ?? compact?.modes ?? [], models: normalizeModels(full, snapshot),
            extends: validId((config.providers?.[entry.provider] as { extends?: unknown } | undefined)?.extends as string | undefined, 120) ?? null };
        }) };
      }).catch(error => { throw new Error(t("serverInsightRunner.m011", { value1: safeError(error) })); });
      this.catalogCache = { at: this.now(), promise, textKey };
    }
    return this.catalogCache.promise;
  }
  /**
   * The providers as the daemon knows them. Right after it starts, discovery is lazy and entries still read `loading` with no
   * modes, which would count as unusable for a minute (the cache): wait for discovery a little (2.18).
   */
  private async providerSnapshot(): Promise<Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>> {
    const first = await this.paseo.providers.snapshot();
    if (!first.entries.some(entry => entry.status === "loading") || typeof this.paseo.providers.waitForReady !== "function") return first;
    return this.paseo.providers.waitForReady({ timeoutMs: 8_000 }).catch(() => first);
  }
  private binaryAvailable(): Promise<boolean> {
    if (!this.binaryCache || this.now() - this.binaryCache.at >= this.cacheMs) this.binaryCache = { at: this.now(), promise: this.findBinary().then(Boolean).catch(() => false) };
    return this.binaryCache.promise;
  }
  private unavailable(entry: CatalogEntry | undefined): string | null {
    if (!entry) return t("serverInsightRunner.m012");
    if (!entry.enabled) return t("serverInsightRunner.m013");
    if (entry.status === "unavailable" || entry.status === "error") return clipped(entry.error, 300) ?? t("serverInsightRunner.m014");
    if (!entry.modes.length) return NO_MODES_REASON;
    if (analysisModeOf(entry).unsafe) return UNSAFE_REASON;
    return null;
  }
  /**
   * What `auto` runs now: the Grok CLI when it is installed (no tools; its session is deleted after each run), else Claude Code, Codex, then a
   * custom provider that extends one of them, each with its default model; within a rank, read-only modes come first.
   * Other providers are never picked automatically. Null: nothing usable.
   */
  async autoRunner(): Promise<Exclude<InsightRunner, { kind: "auto" }> | null> {
    if (await this.binaryAvailable()) return { kind: "grok" };
    const rank = (entry: CatalogEntry) => {
      const own = AUTO_BASES.indexOf(entry.provider as typeof AUTO_BASES[number]);
      if (own >= 0) return own;
      const base = AUTO_BASES.indexOf(entry.extends as typeof AUTO_BASES[number]);
      return base >= 0 ? AUTO_BASES.length + base : -1;
    };
    const choice = (await this.catalog()).entries.map((entry, index) => ({ entry, index, rank: rank(entry), read: analysisModeOf(entry).access === "read" ? 0 : 1 }))
      .filter(item => item.rank >= 0 && !this.unavailable(item.entry))
      .sort((a, b) => a.rank - b.rank || a.read - b.read || a.index - b.index)[0]?.entry;
    return choice ? { kind: "provider", provider: choice.provider, model: null, thinkingOptionId: null } : null;
  }
  async resolve(runner: InsightRunner): Promise<InsightRunnerPlan> {
    if (runner.kind === "auto") {
      const chosen = await this.autoRunner();
      if (!chosen) throw new Error(NO_RUNNER_ERROR);
      return this.resolve(chosen);
    }
    if (runner.kind === "grok") return grokPlan(runner);
    const catalog = await this.catalog();
    const profile = runner.kind === "profile" ? catalog.profiles.find(candidate => candidate.id === runner.profileId) : undefined;
    if (runner.kind === "profile" && !profile) throw new Error(t("serverInsightRunner.m015"));
    const provider = runner.kind === "provider" ? runner.provider : profile!.provider;
    const entry = catalog.entries.find(candidate => candidate.provider === provider);
    const reason = this.unavailable(entry); if (reason || !entry) throw new Error(t("serverInsightRunner.m016", { reason: reason }));
    // No model chosen: the provider's default (or first) one; a provider that lists none runs as "<provider>/default".
    const modelId = (runner.kind === "provider" ? runner.model : profile?.model) ?? defaultModelOf(entry.models);
    const model = entry.models.find(candidate => candidate.id === modelId);
    const thinkingOptionId = (runner.kind === "provider" ? runner.thinkingOptionId : profile?.thinkingOptionId) ?? model?.defaultThinkingOptionId ?? null;
    const thinkingLabel = model?.thinking.find(option => option.id === thinkingOptionId)?.label ?? thinkingOptionId;
    const { modeId, access, providerOptions } = analysisModeOf(entry);
    const label = runner.kind === "profile" ? profile!.name : [entry.label, entry.label.includes(provider) ? null : provider, model?.label ?? modelId, thinkingLabel].filter(Boolean).join(" · ");
    return { info: { kind: runner.kind, label: clipped(label, 160) ?? provider, provider, model: modelId, thinkingOptionId, modeId, sessionAgentId: null }, model: modelId ?? provider, effort: thinkingOptionId, access, featureValues: { ...filterInsightFeatures(profile?.featureValues), ...lockedFeatures(entry) }, ...(providerOptions ? { providerOptions } : {}) };
  }
  async runners(): Promise<InsightRunners> {
    const [catalog, available] = await Promise.all([this.catalog(), this.binaryAvailable()]);
    const builtin: InsightRunnerOption = { runner: { kind: "grok" }, label: BUILTIN_INSIGHT_RUNNER.label, detail: GROK_RUNNER_DETAIL, providerLabel: "Grok", modelLabel: "Grok 4.7", thinkingLabel: "xhigh", available, reason: available ? null : t("serverInsightRunner.m017"), access: "none", modeId: null };
    const chosen = await this.resolve({ kind: "auto" }).catch(() => null);
    const auto: InsightRunnerOption = { runner: { kind: "auto" }, label: AUTO_RUNNER_LABEL, detail: t("serverInsightRunner.m018"),
      providerLabel: chosen ? t("serverInsightRunner.m019", { value1: chosen.info.label }) : null, modelLabel: null, thinkingLabel: null, available: !!chosen,
      reason: chosen ? (chosen.access === "ask" ? ASK_REASON : null) : NO_RUNNER_ERROR, access: chosen?.access ?? "none", modeId: chosen?.info.modeId ?? null };
    const profiles: InsightRunnerOption[] = catalog.profiles.slice(0, 40).map(profile => {
      const entry = catalog.entries.find(candidate => candidate.provider === profile.provider), reason = this.unavailable(entry);
      const { modeId, access } = entry ? analysisModeOf(entry) : insightAnalysisMode([]), mode = { modeId, access }, model = entry?.models.find(candidate => candidate.id === (profile.model ?? entry.models.find(candidate => candidate.isDefault)?.id));
      const thinking = profile.thinkingOptionId ?? model?.defaultThinkingOptionId ?? null;
      return { runner: { kind: "profile", profileId: profile.id }, label: clipped(profile.name, 160) ?? profile.id.slice(0, 160), detail: clipped(profile.notes, 400), providerLabel: entry?.label ?? profile.provider.slice(0, 160), modelLabel: model?.label ?? clipped(profile.model, 240),
        thinkingLabel: model?.thinking.find(option => option.id === thinking)?.label ?? clipped(thinking, 120), available: !reason, reason: reason ?? (mode.access === "ask" ? ASK_REASON : null), ...mode };
    });
    return { auto, builtin, profiles, providers: catalog.entries.filter(entry => entry.enabled).slice(0, 40).map(entry => { const { modeId, access } = analysisModeOf(entry), mode = { modeId, access }, reason = this.unavailable(entry);
      return { provider: entry.provider, label: entry.label, available: !reason, reason: reason ?? (mode.access === "ask" ? ASK_REASON : null), ...mode, defaultModel: entry.models.find(model => model.isDefault)?.id ?? null };
    }) };
  }
  async models(provider: string): Promise<{ provider: string; models: InsightModelOption[] }> {
    const entry = (await this.catalog()).entries.find(candidate => candidate.provider === provider), reason = this.unavailable(entry);
    if (reason || !entry) throw new Error(t("serverInsightRunner.m020", { reason: reason }));
    return { provider, models: entry.models };
  }
}

export interface InsightRunnerParent { id: string; cwd: string | null; workspaceId: string | null; archived: boolean; title: string }
export interface InsightRunnerTimers { set(callback: () => void, delayMs: number): unknown; clear(timer: unknown): void }
export interface PaseoStructuredRunOptions<T> {
  paseo: PaseoApi; plan: InsightRunnerPlan; parent: InsightRunnerParent; jobId: string; prompt: string; systemPrompt: string;
  schema: z.ZodType; parse: (text: string) => T; signal: AbortSignal; title?: string;
  onSession?: (runner: InsightRunnerInfo) => void | Promise<void>; onRetry?: () => void | Promise<void>; onCleanupError?: (error: Error) => void;
  now?: () => number; timeoutMs?: number; timers?: InsightRunnerTimers;
}
export interface PaseoStructuredResult<T> { value: T; usage: InsightJob["usage"]; runner: InsightRunnerInfo }
const defaultTimers: InsightRunnerTimers = { set(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return timer; }, clear(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>); } };
async function boundedCleanup<T>(operation: Promise<T>, timers: InsightRunnerTimers, timeoutMs = 5000): Promise<T> {
  let timer: unknown;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = timers.set(() => reject(new Error(t("serverInsightRunner.m021"))), timeoutMs); })]); }
  finally { if (timer !== undefined) timers.clear(timer); }
}
const usageNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function snapshotUsage(snapshot: PaseoAgent | null): InsightJob["usage"] {
  const usage = snapshot?.lastUsage;
  return usage ? { inputTokens: usageNumber(usage.inputTokens), outputTokens: usageNumber(usage.outputTokens), costUsd: usageNumber(usage.totalCostUsd) } : null;
}

/** Owns precisely one temporary handle, including its single structured-output retry. */
export async function runPaseoStructured<T>(options: PaseoStructuredRunOptions<T>): Promise<PaseoStructuredResult<T>> {
  const { paseo, plan, parent, signal } = options;
  if (plan.info.kind === "grok" || plan.info.kind === "auto" || !plan.info.provider) throw new Error(t("serverInsightRunner.m022"));
  // Never create a helper whose mode is not pinned to a verified restricted one: without a mode it would inherit the analysed Agent's.
  if (!plan.info.modeId || (plan.access !== "read" && plan.access !== "ask")) throw new Error(UNVERIFIED_MODE_ERROR);
  if (signal.aborted) throw new Error(t("serverInsightRunner.m023"));
  const now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? 20 * 60_000, deadline = now() + timeoutMs, timers = options.timers ?? defaultTimers;
  let handle: PaseoAgentHandle | undefined, terminated: Error | undefined, denials = 0;
  let rejectStop!: (error: Error) => void;
  const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  void stop.catch(() => {});
  const terminate = (message: string) => { terminated ??= new Error(message); rejectStop(terminated); };
  const cancel = () => terminate(t("serverInsightRunner.m024"));
  const timer = timers.set(() => terminate(t("serverInsightRunner.m025")), timeoutMs);
  signal.addEventListener("abort", cancel, { once: true });
  const remaining = () => { if (signal.aborted) cancel(); if (now() >= deadline) terminate(t("serverInsightRunner.m026")); if (terminated) throw terminated; return Math.max(1, deadline - now()); };
  const guarded = async <V>(operation: Promise<V>): Promise<V> => { remaining(); return Promise.race([operation, stop]); };
  const archive = async (target: PaseoAgentHandle) => { try { await boundedCleanup(target.archive(), timers); } catch (error) { const failure = new Error(t("serverInsightRunner.m027", { value1: safeError(error) })); if (options.onCleanupError) options.onCleanupError(failure); else console.warn(failure.message); } };
  const wait = async (initial?: PaseoAgentRunResult): Promise<PaseoAgentRunResult> => {
    let result = initial;
    for (;;) {
      result ??= await guarded(handle!.waitForFinish(remaining()));
      if (result.status === "timeout") throw new Error(t("serverInsightRunner.m028"));
      if (result.status === "error") throw new Error(t("serverInsightRunner.m029", { value1: safeError(result.error ?? result.final?.lastError ?? t("serverInsightRunner.m030"), 1200) }));
      if (result.status === "idle") return result;
      let permissions = result.final?.pendingPermissions ?? handle!.current()?.pendingPermissions ?? [];
      if (!permissions.length) permissions = (await guarded(handle!.refresh()))?.agent.pendingPermissions ?? [];
      if (!permissions.length) throw new Error(t("serverInsightRunner.m031"));
      for (const permission of permissions) {
        await guarded(handle!.respondToPermission({ requestId: permission.id, response: { behavior: "deny", message: INSIGHT_PERMISSION_MESSAGE } }));
        denials++;
      }
      if (denials > 8) throw new Error(t("serverInsightRunner.m032"));
      result = undefined;
    }
  };
  try {
    remaining();
    const config: PaseoAgentCreateOptions["config"] = { provider: providerModelId(plan.info.provider, plan.info.model),
      modeId: plan.info.modeId, ...(plan.info.thinkingOptionId ? { thinkingOptionId: plan.info.thinkingOptionId } : {}), featureValues: filterInsightFeatures(plan.featureValues),
      ...(plan.providerOptions ? { options: plan.providerOptions as NonNullable<PaseoAgentCreateOptions["config"]["options"]> } : {}), systemPrompt: options.systemPrompt };
    const common = { config, title: (options.title ?? t("serverInsightRunner.m033", { value1: parent.title })).slice(0, 60), prompt: options.prompt, outputSchema: z.toJSONSchema(options.schema), labels: { "observatory.role": "insight", "observatory.job": options.jobId } };
    let creation: Promise<PaseoAgentHandle>;
    if (parent.archived) {
      if (!parent.workspaceId) throw new Error(WORKSPACE_ERROR);
      creation = paseo.workspaces.ref(parent.workspaceId).agents.create(common).catch(() => { throw new Error(WORKSPACE_ERROR); });
    } else if (parent.workspaceId && parent.id) {
      // In the analysed Agent's workspace, labelled as its sub-agent (2.18). Not with `parent`: on Paseo 0.13 a parent-created
      // Agent's first prompt arrives wrapped as another Agent's message with XML entities, so the helper reads `&lt;` for `<`.
      creation = paseo.workspaces.ref(parent.workspaceId).agents.create({ ...common, labels: { ...common.labels, "paseo.parent-agent-id": parent.id } });
    } else {
      if (!parent.id || !parent.cwd) throw new Error(WORKSPACE_ERROR);
      creation = paseo.agents.create({ ...common, cwd: parent.cwd, parent: parent.id });
    }
    // Creation may complete after cancellation. The resulting handle still belongs to us.
    void creation.then(async created => { if (terminated && !handle) await archive(created); }).catch(() => {});
    handle = await guarded(creation);
    const runner = { ...plan.info, sessionAgentId: handle.id };
    await options.onSession?.(runner);
    let result = await wait();
    for (let attempt = 0; attempt < 2; attempt++) {
      try { remaining(); const value = options.parse(result.lastMessage ?? ""); return { value, usage: snapshotUsage(result.final ?? handle.current()), runner }; }
      catch (error) {
        if (terminated || signal.aborted || attempt) throw error;
        await options.onRetry?.();
        const retry = t("serverInsightRunner.m034", { value1: safeError(error, 600) });
        result = await wait(await guarded(handle.run(retry, { timeoutMs: remaining() })));
      }
    }
    throw new Error(t("serverInsightRunner.m035"));
  } finally {
    timers.clear(timer); signal.removeEventListener("abort", cancel);
    if (handle) await archive(handle);
  }
}

export function isInsightAgent(agent: { labels?: Record<string, string> } | null | undefined): boolean { return agent?.labels?.["observatory.role"] === "insight"; }

/** Crash recovery: collect before archiving so mutations do not disturb list cursors. */
export async function cleanupInsightAgents(paseo: PaseoApi, ownedJobIds: ReadonlySet<string> = new Set(), options: { now?: () => number; timers?: InsightRunnerTimers; timeoutMs?: number } = {}): Promise<{ archived: number; errors: string[] }> {
  // Some embedding tests deliberately supply only the portion of PaseoApi they exercise.
  if (typeof paseo.agents?.list !== "function") return { archived: 0, errors: [] };
  const now = options.now ?? Date.now, deadline = now() + (options.timeoutMs ?? 20_000), timers = options.timers ?? defaultTimers;
  const remaining = () => { const left = deadline - now(); if (left <= 0) throw new Error(t("serverInsightRunner.m036")); return Math.min(left, 5000); };
  const stale = new Set<string>(), cursors = new Set<string>(); let cursor: string | undefined;
  for (;;) {
    const page = await boundedCleanup(paseo.agents.list({ filter: { includeArchived: false, labels: { "observatory.role": "insight" } }, page: { limit: 100, ...(cursor ? { cursor } : {}) } }), timers, remaining());
    for (const { agent } of page.entries) if (isInsightAgent(agent) && !agent.archivedAt && !ownedJobIds.has(agent.labels["observatory.job"])) stale.add(agent.id);
    if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
    if (cursors.has(page.pageInfo.nextCursor)) throw new Error(t("serverInsightRunner.m037"));
    cursors.add(page.pageInfo.nextCursor); cursor = page.pageInfo.nextCursor;
  }
  let archived = 0; const errors: string[] = [];
  for (const id of stale) { try { const timeout = remaining(); await boundedCleanup(paseo.agents.ref(id).archive(), timers, timeout); archived++; } catch (error) { errors.push(t("serverInsightRunner.m038", { id: id, value2: safeError(error) })); if (now() >= deadline) break; } }
  return { archived, errors };
}

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  AUTO_RUNNER_LABEL = t("serverInsightRunner.m001");
  GROK_RUNNER_DETAIL = t("serverInsightRunner.m002");
  NO_RUNNER_ERROR = t("serverInsightRunner.m003");
  INSIGHT_PERMISSION_MESSAGE = t("serverInsightRunner.m004");
  ASK_REASON = t("serverInsightRunner.m005");
  NO_MODES_REASON = t("serverInsightRunner.m006");
  UNSAFE_REASON = t("serverInsightRunner.m007");
  UNVERIFIED_MODE_ERROR = t("serverInsightRunner.m008");
  WORKSPACE_ERROR = t("serverInsightRunner.m009");
});
