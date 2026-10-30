import { t } from "../shared/text";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import * as host from "@getpaseo/plugin/client";
import { usePaseo, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { applyArchiveReadOrigin, applyReadReceipt, normalizeAgent, type AgentProjectPlacement, type AgentSource } from "../shared/model";
import { enrichAgents } from "../shared/background";
import { applyLiveExtras } from "../shared/attention";
import type { ScheduleFocus } from "./schedule-focus";
import { AgentDetail } from "./agent-detail";
import { EmptyState, Skeleton, useCompactLayout, type MenuAction } from "./kit";
import { useTelemetry } from "./use-telemetry";
import { useReadReceipts } from "./use-read-receipts";
import { useBackground } from "./use-background";
import { useLiveExtras } from "./use-live-extras";
import { useHeartbeats } from "./use-schedules";
import { useForeground } from "./use-foreground";

type AgentSignal = (agentId: string, selector: (agent: { status: string; updatedAt: string; requiresAttention: boolean; attentionReason: string | null; title: string | null }) => string) => string | null;
/** The app's own copy of an Agent (Paseo 0.11 `useAgent`); hosts without it re-read on the slow interval only. */
const useAgentSignal: AgentSignal = (host as { useAgent?: AgentSignal }).useAgent ?? (() => null);

/**
 * 执行详情 (the agent panel) shows one Agent, not a whole observatory (opus-F7): that Agent's snapshot, archived ones included,
 * re-read when the app's own copy of it changes, plus the page's shared lifecycle, read-receipt and background queries. The
 * directory is read only while 子任务 is open; 「在观测台中查看」 opens the full page on this Agent.
 */
export function AgentInspector({ theme, layout, host: target, navigation, agentId: initialId, onOpenSchedules, onOpenOverview }: PluginAgentPanelProps & {
  onOpenSchedules?: (focus: ScheduleFocus) => void; onOpenOverview?: (agentId: string) => void }) {
  const paseo = usePaseo(), foreground = useForeground(), hostId = target.id;
  const { compact, onLayout } = useCompactLayout(layout.compact);
  // Parent and child links move within the panel; a new panel target starts over.
  const [agentId, setAgentId] = useState(initialId);
  useEffect(() => { setAgentId(initialId); }, [initialId]);
  const signal = useAgentSignal(agentId, agent => `${agent.status}|${agent.updatedAt}|${agent.requiresAttention}|${agent.attentionReason}|${agent.title}`);
  // The app's copy does not change when a running turn asks for approval, so a running Agent is re-read more often.
  const snapshot = useQuery({ queryKey: ["agent-observatory", hostId, "inspector", agentId, signal], queryFn: () => paseo.agents.ref(agentId).refresh(),
    enabled: foreground, placeholderData: keepPreviousData, staleTime: 2000, refetchOnWindowFocus: false, retry: 1,
    refetchInterval: query => !foreground ? false : (query.state.data as { agent?: { status?: string } } | null | undefined)?.agent?.status === "running" ? 8_000 : 30_000 });
  const source = snapshot.data?.agent?.id === agentId ? snapshot.data.agent as unknown as AgentSource : null;
  const live = !!source && !source.archivedAt;
  const telemetry = useTelemetry(hostId), receipts = useReadReceipts(), background = useBackground(hostId, live);
  const extras = useLiveExtras(hostId, live && (source?.status === "running" || source?.requiresAttention === true));
  const heartbeats = useHeartbeats(hostId, !!source);
  // Its Paseo sub-agents (2.18), so a parent whose sub-agents still work is held here as on the full page (direct ones only,
  // every page up to 1,000).
  const children = useQuery({ queryKey: ["agent-observatory", hostId, "inspector-children", agentId],
    queryFn: async () => {
      const entries: Array<{ agent: unknown }> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const result: { entries: Array<{ agent: unknown }>; pageInfo?: { hasMore?: boolean; nextCursor?: string | null } } = await paseo.agents.list({ filter: { includeArchived: false, labels: { "paseo.parent-agent-id": agentId } }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
        entries.push(...result.entries);
        cursor = result.pageInfo?.hasMore ? result.pageInfo.nextCursor ?? null : null;
        if (!cursor) break;
      }
      return entries;
    },
    enabled: foreground && live, staleTime: 5000, refetchOnWindowFocus: false, retry: 1, refetchInterval: foreground ? 15_000 : false });
  const agent = useMemo(() => {
    if (!source) return null;
    const base = normalizeAgent(source, { project: (snapshot.data as { project?: AgentProjectPlacement | null } | undefined)?.project ?? null });
    const kids = (children.data ?? []).map(entry => normalizeAgent(entry.agent as unknown as AgentSource)).filter(child => child.parentAgentId === agentId && child.id !== agentId && child.labels["observatory.role"] !== "insight");
    const [enriched] = applyLiveExtras(enrichAgents([base, ...kids], telemetry.data, background.data), extras.data?.agents);
    const origin = receipts.data?.archiveOrigins.find(item => item.agentId === agentId), receipt = receipts.data?.receipts.find(item => item.agentId === agentId);
    return applyReadReceipt(applyArchiveReadOrigin(enriched!, origin), receipt);
  }, [source, snapshot.data, children.data, telemetry.data, background.data, extras.data, receipts.data, agentId]);
  const actions: MenuAction[] = onOpenOverview ? [{ key: "overview", label: t("coreAgentInspector.viewInObservatory"), icon: "Orbit", hint: t("coreAgentInspector.openTheFullSessionListWithThis"), onPress: () => onOpenOverview(agentId) }] : [];
  return <View onLayout={onLayout} style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
    {agent ? <AgentDetail key={`${hostId}:${agent.id}`} hostId={hostId} agent={agent} theme={theme} compact={compact} navigation={navigation} onSelectAgent={setAgentId}
      onClose={agentId !== initialId ? () => setAgentId(initialId) : undefined} telemetry={telemetry.data} onOpenSchedules={onOpenSchedules}
      heartbeats={heartbeats.data?.byAgent.get(agent.id)} extraActions={actions} />
      // Moving to a parent or child keeps the previous Agent as a placeholder until this one is read: not "not found".
      : snapshot.isPending || snapshot.isPlaceholderData ? <Skeleton theme={theme} rows={6} />
      : <View style={{ flex: 1, justifyContent: "center" }}><EmptyState theme={theme} icon={snapshot.error ? "WifiOff" : "SearchX"} title={snapshot.error ? t("coreAgentInspector.cannotReadThisAgentRightNow") : t("coreAgentInspector.thisAgentWasNotFoundOnThe")}
        message={snapshot.error ? t("coreAgentInspector.willRetryAutomaticallyWhenTheConnectionReturns") : undefined} action={snapshot.error ? { label: t("coreAgentInspector.retry"), icon: "RefreshCw", onPress: () => void snapshot.refetch() } : undefined} /></View>}
  </View>;
}
