import { t } from "../shared/text";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { FlatList, Icon } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { PluginTheme } from "@getpaseo/plugin";
import type { AgentRecord, AgentStatus } from "../shared/model";
import { subtaskForest, flattenSubtasks } from "../shared/subtask-tree";
import { providerSubagentsRpc, providerTimelineRpc, type ProviderSubagent } from "../shared/provider-subagents";
import { nativeChildResult } from "../shared/native-results";
import { Banner, Button, EmptyState, IconButton, MetaLine, Row, SectionHeader, Segmented, Skeleton, fontSize, hairline, radius, relativeTime, space } from "./kit";
import { providerLine, readLabel, statusNames } from "./ui";
import { LiveTimer, PhaseLine, PhasePill, StatusGlyph, hueColor, phaseOf, type Phase } from "./status";
import { useTimeline } from "./use-timeline";
import { TimelineContent } from "./timeline-view";
import { ResultView } from "./result-view";
import { useForeground } from "./use-foreground";

const nativeStatus = (status: ProviderSubagent["status"]): AgentStatus => status === "failed" ? "error" : status;
/** Native children have no read state: a finished one is simply done. */
const nativePhase = (status: AgentStatus): Phase => status === "running" ? "running" : status === "initializing" ? "starting" : status === "error" ? "error" : status === "waiting" ? "approval"
  : status === "completed" ? "done" : status === "canceled" ? "canceled" : status === "closed" ? "closed" : status === "idle" ? "idle" : "quiet";
/** A managed child's state at the end of its row: a live timer while running, a pill when it needs you. */
function ChildState({ theme, agent }: { theme: PluginTheme; agent: AgentRecord }) {
  const phase = phaseOf(agent);
  if (phase === "running" && agent.activeTurnStartedAt) return <LiveTimer since={agent.activeTurnStartedAt} color={hueColor(theme, "run", "text")} />;
  if (phase === "approval") return <PhasePill theme={theme} hue="warn" label={t("secondarySubtasksView.waitingForApproval")} />;
  if (phase === "error") return <PhasePill theme={theme} hue="fail" label={t("secondarySubtasksView.error")} />;
  if (phase === "unread") return <PhasePill theme={theme} hue="ok" label={t("secondarySubtasksView.unread")} />;
  if (phase === "idle") return <PhasePill theme={theme} hue="violet" label={t("secondarySubtasksView.waitingForReply")} />;
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{statusNames[agent.status]}</Text>;
}
function NativeChild({ child, parentAgent, theme, inset, onBack, header }: { child: ProviderSubagent; parentAgent: AgentRecord; theme: PluginTheme; inset: number; onBack: () => void; header?: ReactNode }) {
  const [tab, setTab] = useState<"result" | "timeline">("result"), [focusRef, setFocusRef] = useState<string | null>(null), foreground = useForeground();
  // Reading a native sub-task loads its parent; a closed parent is read once, not polled (see AgentDetail).
  const rootId = parentAgent.id, timeline = useTimeline({ agentId: rootId, subagentId: child.id }, true, parentAgent.rawStatus !== "closed"), fetchHead = useRpc(providerTimelineRpc);
  const first = useQuery({ queryKey: ["observatory-native-first-input", rootId, child.id, timeline.page?.epoch, child.status], queryFn: async () => {
    const result = await fetchHead({ parentAgentId: rootId, subagentId: child.id, direction: "after", limit: 100 }); if (result.error) throw new Error(result.error); return result.page;
  }, enabled: foreground && tab === "result" && !!timeline.page, staleTime: Infinity, retry: 1 });
  const data = useMemo(() => nativeChildResult(rootId, child, timeline.page, first.data), [rootId, child, timeline.page, first.data]);
  const status = nativeStatus(child.status);
  const shownAgent: AgentRecord = { ...parentAgent, id: data.agentId, title: child.description || child.title || t("secondarySubtasksView.nativeSubtasks"), provider: child.provider,
    status, rawStatus: child.status, cwd: child.cwd ?? parentAgent.cwd, createdAt: child.createdAt, updatedAt: child.updatedAt,
    parentAgentId: rootId, pendingPermissionCount: 0, attentionReason: null, attentionTimestamp: null, requiresAttention: undefined, archivedAt: null };
  const openEvidence = (ref: string) => { setFocusRef(ref); setTab("timeline"); };
  const childHeader = <View style={{ gap: space.sm, paddingTop: space.md }}>
    {header}
    <View style={{ alignItems: "flex-start", marginLeft: -space.sm }}><Button theme={theme} label={t("secondarySubtasksView.subtask")} icon="ChevronLeft" variant="ghost" size="sm" accessibilityLabel={t("secondarySubtasksView.backToSubtaskTree")} onPress={onBack} /></View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}><PhaseLine theme={theme} agent={shownAgent} /><MetaLine theme={theme} parts={[child.provider, t("secondarySubtasksView.nativeSubtasks"), t("secondarySubtasksView.readOnly")]} /></View>
    <Text selectable style={{ color: theme.colors.foreground, fontSize: fontSize.title, fontWeight: "500", lineHeight: 22 }}>{shownAgent.title}</Text>
    <Segmented theme={theme} size="sm" value={tab} onChange={setTab} accessibilityLabel={t("secondarySubtasksView.subtaskView")} options={[{ value: "result", label: t("secondarySubtasksView.result") }, { value: "timeline", label: t("secondarySubtasksView.timeline") }]} />
  </View>;
  return tab === "result" ? <ResultView theme={theme} agent={shownAgent} data={data} loading={timeline.loading || (first.isPending && first.fetchStatus === "fetching")} error={timeline.error || first.error?.message}
    header={childHeader} inset={inset} onRefresh={() => { timeline.refresh(); void first.refetch(); }} onOpenEvidence={openEvidence} />
    : <TimelineContent timeline={timeline} theme={theme} cacheKey={`${rootId}:${child.id}`} focusRef={focusRef} header={childHeader} inset={inset} />;
}

type SubtaskRow = { kind: "section"; id: string; label: string; count: number; action?: ReactNode } | { kind: "managed"; id: string; item: AgentRecord; depth: number } | { kind: "native"; id: string; item: ProviderSubagent; depth: number; children: number; broken: boolean };
export function SubtasksView({ agent, agents, theme, inset, onSelectAgent, onViewParent, header }: { agent: AgentRecord; agents: AgentRecord[]; theme: PluginTheme; inset: number; onSelectAgent: (id: string) => void;
  /** 查看上级 Agent: here, or in Paseo when the parent runs on another host; absent: it cannot be opened from here. */
  onViewParent?: () => void; header?: ReactNode }) {
  const fetch = useRpc(providerSubagentsRpc), [selected, setSelected] = useState<string | null>(null), [collapsed, setCollapsed] = useState<Set<string>>(new Set()), foreground = useForeground();
  const { colors } = theme;
  // Listing native sub-tasks loads a closed Agent: read once, not polled, while it is closed (see AgentDetail).
  const query = useQuery({ queryKey: ["observatory-provider-subagents", agent.id], queryFn: async () => { const result = await fetch({ parentAgentId: agent.id }); if (result.error) throw new Error(result.error); return result; }, enabled: foreground, refetchInterval: foreground && agent.rawStatus !== "closed" ? 15000 : false, staleTime: 5000, retry: 1 });
  const native = query.data?.subagents ?? [];
  const managed = useMemo(() => { const byParent = new Map<string, AgentRecord[]>(); for (const item of agents) { if (!item.parentAgentId) continue; const bucket = byParent.get(item.parentAgentId) ?? []; bucket.push(item); byParent.set(item.parentAgentId, bucket); } const stack = (byParent.get(agent.id) ?? []).slice().reverse().map(item => ({ item, depth: 0 })); const seen = new Set([agent.id]), rows: Array<{ item: AgentRecord; depth: number }> = []; while (stack.length) { const entry = stack.pop()!; if (seen.has(entry.item.id)) continue; seen.add(entry.item.id); rows.push(entry); const children = byParent.get(entry.item.id) ?? []; for (let i = children.length - 1; i >= 0; i--) stack.push({ item: children[i]!, depth: entry.depth + 1 }); } return rows; }, [agent.id, agents]);
  const nativeRows = useMemo(() => flattenSubtasks(subtaskForest(native, item => item.id, item => item.parentSubagentId), collapsed, item => item.id), [native, collapsed]);
  const child = native.find(candidate => candidate.id === selected);
  if (child) return <NativeChild key={`${agent.id}:${child.id}`} child={child} parentAgent={agent} theme={theme} inset={inset} onBack={() => setSelected(null)} header={header} />;
  const rows: SubtaskRow[] = [
    ...(managed.length ? [{ kind: "section" as const, id: "managed", label: t("secondarySubtasksView.paseoSubagents"), count: managed.length }, ...managed.map(row => ({ ...row, kind: "managed" as const, id: `managed:${row.item.id}` }))] : []),
    { kind: "section", id: "native", label: t("secondarySubtasksView.nativeSubtasks"), count: native.length, action: <IconButton theme={theme} icon="RefreshCw" label={t("secondarySubtasksView.refreshNativeSubtasks")} size="sm" onPress={() => void query.refetch()} disabled={query.isFetching} /> },
    ...nativeRows.map(row => ({ ...row, kind: "native" as const, id: `native:${row.item.id}` })),
  ];
  const indent = (depth: number) => depth ? { marginLeft: 16 + (Math.min(depth, 3) - 1) * 22, paddingLeft: 6, borderLeftWidth: hairline, borderLeftColor: colors.border } : undefined;
  return <FlatList data={rows} keyExtractor={row => row.id} style={{ flex: 1, minHeight: 0 }} initialNumToRender={12} windowSize={5} contentContainerStyle={{ paddingHorizontal: inset, paddingBottom: space.xxl }}
    ListHeaderComponent={<View style={{ gap: space.md, paddingBottom: space.xs }}>{header}
      {agent.parentAgentId && onViewParent ? <View style={{ alignItems: "flex-start", marginLeft: -space.sm, marginTop: header ? 0 : space.md }}><Button theme={theme} label={t("secondarySubtasksView.viewParentAgent")} icon="CornerLeftUp" variant="ghost" size="sm" onPress={onViewParent} /></View> : null}
      {query.error ? <Banner theme={theme} tone="danger" message={query.error.message} action={{ label: t("secondarySubtasksView.retry"), onPress: () => void query.refetch() }} /> : null}
    </View>}
    renderItem={({ item: row }) => {
      if (row.kind === "section") return <View style={{ marginHorizontal: -space.md }}><SectionHeader theme={theme} title={row.label} count={row.count} action={row.action} /></View>;
      if (row.kind === "managed") return <View style={[{ marginHorizontal: -space.md }, indent(row.depth)]}>
        <Row theme={theme} title={row.item.title} accessibilityLabel={t("secondarySubtasksView.viewSubagent", { value1: row.item.title })} onPress={() => onSelectAgent(row.item.id)}
          leading={<View accessibilityLabel={readLabel(row.item)}><StatusGlyph theme={theme} phase={phaseOf(row.item)} /></View>}
          trailing={<ChildState theme={theme} agent={row.item} />}
          subtitle={<MetaLine theme={theme} parts={[providerLine(row.item), relativeTime(row.item.lastActivityAt)]} />} />
      </View>;
      const status = nativeStatus(row.item.status), open = !collapsed.has(row.item.id);
      return <View style={[{ marginHorizontal: -space.md }, indent(row.depth)]}>
        <Row theme={theme} title={row.item.description || row.item.title || row.item.id} accessibilityLabel={t("secondarySubtasksView.viewNativeSubtask", { value1: row.item.description || row.item.title || row.item.id })} onPress={() => setSelected(row.item.id)}
          leading={<StatusGlyph theme={theme} phase={nativePhase(status)} />} trailing={<Text style={{ color: hueColor(theme, status === "running" ? "run" : status === "error" ? "fail" : "muted", "text"), fontSize: fontSize.meta }}>{statusNames[status]}</Text>}
          subtitle={<MetaLine theme={theme} parts={[row.item.provider, relativeTime(row.item.updatedAt), row.broken ? t("secondarySubtasksView.invalidParentChainDisconnected") : null]} />} />
        {row.children > 0 ? <Pressable accessibilityRole="button" accessibilityLabel={t("secondarySubtasksView.subtasks", { value1: open ? t("secondarySubtasksView.fold") : t("secondarySubtasksView.expand"), value2: row.children })} accessibilityState={{ expanded: open }} hitSlop={{ top: 6, bottom: 8, left: 6, right: 6 }}
          onPress={() => setCollapsed(previous => { const next = new Set(previous); next.has(row.item.id) ? next.delete(row.item.id) : next.add(row.item.id); return next; })}
          style={state => ({ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: space.xs, marginLeft: 24, marginTop: -6, marginBottom: space.xs, minHeight: 24, paddingHorizontal: 6, borderRadius: radius.sm, backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? colors.surface1 : "transparent" })}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={12} color={colors.foregroundMuted} />
          <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondarySubtasksView.subtasks2", { count: row.children })}</Text>
        </Pressable> : null}
      </View>;
    }}
    ListFooterComponent={query.isPending ? <Skeleton theme={theme} rows={2} /> : !managed.length && !native.length ? <EmptyState theme={theme} icon="GitBranch" title={t("secondarySubtasksView.noSubtasks")} message={t("secondarySubtasksView.thisSessionHasNotCreatedAny")} /> : query.data?.truncated ? <View style={{ paddingTop: space.sm }}><MetaLine theme={theme} parts={[t("secondarySubtasksView.someSubtasksAreOutsideTheRetained")]} /></View> : null} />;
}
