import { t } from "../shared/text";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginPopoverProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { popoverReplies, reasonText, type AttentionEntry } from "../shared/attention";
import { Button, EmptyState, MetaLine, Skeleton, aria, fontSize, hairline, hue, radius, relativeTime, space } from "./kit";
import { StatusGlyph, hueColor, type Phase } from "./status";
import { attentionCount, attentionUnreliable, useAttentionView, type AttentionStore } from "./use-attention";
import { AgentApprovals } from "./permission-panel";
import { QuickReplies } from "./quick-replies";
import { CacheChip } from "./cache-clock";
import { ScheduledSends } from "./schedule-send";
import { recapLook, type RecapView } from "../shared/recap";
import { recapsQueryKey, useRecaps } from "./use-recaps";
import { useQueryClient } from "@tanstack/react-query";
import { RecapLine } from "./recap";

/** Screen params travel in the URL; `t` makes a second tap on the same entry select it again. */
const stamp = () => Date.now().toString(36);

/**
 * The badge's popover (a sheet on phones), loaded with the UI chunk on its first open: the longest-waiting Agents, each with its
 * one-line reason, an approval to answer right here (opus-B12) and the quick replies a reply asks for (opus-B26). It reads the
 * resident badge's own store (`store`), so its count and the badge's never disagree.
 */
export function AttentionPopover({ theme, layout, host, close, openScreen, store }: PluginPopoverProps & { store: AttentionStore }) {
  const view = useAttentionView(store), now = view.now ?? Date.now(), { colors } = theme;
  // 每轮小结 under each entry, read while the popover is open (shared with the page's list).
  const recaps = useRecaps(host.id), byAgent = recaps.data?.enabled ? recaps.data.byAgent : null, cache = useQueryClient();
  const count = attentionCount(view, now), state = view.state;
  const open = (params: Record<string, string>) => { close(); openScreen({ screenId: "observatory", params: { ...params, t: stamp() } }); };
  // An answered request or a sent reply changes the count: read it now, and again once the host has caught up.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // A reply sent here starts a turn: the recaps (out of date, then 更新中) are read again too.
  const changed = () => { store.invalidate(); void cache.invalidateQueries({ queryKey: recapsQueryKey(host.id) }); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { store.invalidate(); void cache.invalidateQueries({ queryKey: recapsQueryKey(host.id) }); }, 2000); };
  // The host already pads the popover, and caps it at 440 px on wide layouts (PluginPopoverSurface): the list gets what is left
  // after the header, the notes under it and the button, so the button never scrolls out of a desktop popover.
  const notes = (state?.truncated ? 1 : 0) + (count && state && count.value > state.entries.length ? 1 : 0);
  const listHeight = layout.compact ? 420 : 300 - notes * 25;
  return <View testID="attention-popover" style={{ width: "100%", maxWidth: 380, gap: space.sm }}>
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: fontSize.title, fontWeight: "700" }}>{t("coreAttentionPopover.needsAttention")}</Text>
      {count ? <Text style={{ color: hueColor(theme, "amber", "text"), fontSize: fontSize.title, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{count.label}</Text> : null}
      <View style={{ flex: 1 }} />
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreAttentionPopover.longestWaitingFirst")}</Text>
    </View>
    {!state ? view.error ? <EmptyState theme={theme} icon="WifiOff" title={t("coreAttentionPopover.temporarilyUnavailable")} message={t("coreAttentionPopover.willRetryAutomaticallyWhenTheConnectionReturns")} tone="warning" /> : <Skeleton theme={theme} rows={3} />
      : !count ? attentionUnreliable(view, now) ? <EmptyState theme={theme} icon="WifiOff" title={t("coreAttentionPopover.temporarilyUnavailable")} message={t("coreAttentionPopover.theSessionListFailedToLoadOr")} tone="warning" />
        : <EmptyState theme={theme} icon="Hourglass" title={t("coreAttentionPopover.loadingSessions")} message={t("coreAttentionPopover.checkAgainInAMoment")} />
      // The list scrolls inside a bounded height, so the way to the full page always stays in view (room for an opened approval).
      : state.entries.length ? <ScrollView style={{ flexGrow: 0, maxHeight: listHeight }} contentContainerStyle={{ gap: 2 }} keyboardShouldPersistTaps="handled">
        {state.entries.map(entry => <EntryBlock key={entry.agentId} theme={theme} entry={entry} recap={byAgent?.get(entry.agentId) ?? null} now={now} compact={layout.compact} onOpen={() => open({ agent: entry.agentId })} onChanged={changed} />)}
        {/* 定时消息 (2.17): every scheduled message on this host, collapsed under the list. */}
        <ScheduledSends theme={theme} compact collapsible titleOf={agentId => state.entries.find(entry => entry.agentId === agentId)?.title || null} />
      </ScrollView>
      : <><EmptyState theme={theme} icon="CircleCheck" title={t("coreAttentionPopover.noSessionsNeedAttention")} message={t("coreAttentionPopover.approvalsQuestionsIssuesAndUnreadResultsAppear")} tone="success" />
        <ScheduledSends theme={theme} compact collapsible /></>}
    {state?.truncated ? <MetaLine theme={theme} numberOfLines={2} parts={[t("coreAttentionPopover.thereAreManySessionsCountsCoverOnly")]} /> : null}
    {count && count.value > state!.entries.length ? <MetaLine theme={theme} parts={[t("coreAttentionPopover.moreInObservatory", { value1: count.value - state!.entries.length })]} /> : null}
    <Button theme={theme} variant="primary" icon="Orbit" label={t("coreAttentionPopover.viewAllInObservatory")} onPress={() => open({ focus: "attention" })} />
  </View>;
}

/**
 * One waiting Agent and what can be done about it right here: a tool approval expands into its requests (opus-B12), a reply
 * that asks to go on gets its quick replies (opus-B26) under the sentence they answer, and only then (`popoverReplies`,
 * P2-1); they answer that turn only (`promptAt`, P1-1; `roundAt`, codex-obs-attn-F1). Both sit beside the row, never inside
 * it (the row is a button).
 */
function EntryBlock({ theme, entry, recap, now, compact, onOpen, onChanged }: { theme: PluginTheme; entry: AttentionEntry; recap: RecapView | null; now: number; compact: boolean; onOpen: () => void; onChanged: () => void }) {
  const [approving, setApproving] = useState(false), { colors } = theme;
  const nudge = popoverReplies(entry), title = entry.title || t("coreAttentionPopover.untitledAgent");
  // The recap of the turn this entry is about (its start as the plugin saw it), and its 建议回复 where a reply is what is
  // wanted (a result or a reply that asks); an approval, a question or a stop is answered otherwise.
  const look = recapLook(recap, { startedAt: entry.roundAt }), suggestion = look?.state === "fresh" && (entry.phase === "idle" || entry.phase === "unread") ? look.reply : null;
  // Under the row's text on wide layouts; nearly full width on phones, so a request's choices fit on one line.
  const amber = hue(theme, "amber", "text"), indent = compact ? space.sm : 32;
  return <View style={{ gap: space.xs }}>
    <EntryRow theme={theme} entry={entry} now={now} onPress={onOpen} />
    {look ? <View style={{ paddingLeft: indent, paddingRight: space.sm, marginTop: -2 }}><RecapLine theme={theme} look={look} /></View> : null}
    {entry.phase === "approval" ? <View style={{ gap: space.sm, paddingLeft: indent, paddingRight: space.sm, paddingBottom: approving ? space.sm : 0 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={approving ? t("coreAttentionPopover.collapseApprovalsFor", { value1: title }) : t("coreAttentionPopover.reviewRequestsForHere", { value1: title })} accessibilityState={{ expanded: approving }} {...aria({ expanded: approving })}
        onPress={() => setApproving(!approving)} hitSlop={{ top: 6, bottom: 6 }}
        style={state => ({ flexDirection: "row", alignItems: "center", gap: space.xs + 2, alignSelf: "flex-start", minHeight: 28, paddingHorizontal: 10, borderRadius: radius.full,
          borderWidth: hairline, borderColor: hue(theme, "amber", "line"), backgroundColor: approving ? hue(theme, "amber", "soft") : "transparent", opacity: state.pressed ? 0.8 : 1 })}>
        <Icon name="Hand" size={13} color={hue(theme, "amber")} />
        <Text style={{ color: amber, fontSize: fontSize.small, fontWeight: "600" }}>{approving ? t("coreAttentionPopover.collapseApprovals") : t("coreAttentionPopover.reviewHere")}</Text>
        <Icon name={approving ? "ChevronUp" : "ChevronDown"} size={13} color={colors.foregroundMuted} />
      </Pressable>
      {approving ? <AgentApprovals theme={theme} agentId={entry.agentId} compact={compact} onOpen={onOpen} onSettled={onChanged} /> : null}
    </View> : null}
    {nudge || suggestion ? <View style={{ paddingLeft: indent, paddingRight: space.sm, paddingBottom: space.sm }}>
      <QuickReplies key={`${entry.agentId}:${entry.promptAt ?? ""}:${entry.roundAt ?? ""}:${entry.since ?? ""}:${nudge}:${suggestion ?? ""}`} theme={theme} agentId={entry.agentId} agentTitle={title} nudge={nudge} suggestion={suggestion} expectPrompt={entry.promptAt} expectRound={entry.roundAt} ask={entry.ask} compact={compact} onSent={onChanged} />
    </View> : null}
  </View>;
}

/** One waiting Agent: its state's mark, its title and the reason in the state's colour, and how long it has waited. */
function EntryRow({ theme, entry, now, onPress }: { theme: PluginTheme; entry: AttentionEntry; now: number; onPress: () => void }) {
  const { colors } = theme;
  const reason = reasonText({ phase: entry.phase, pending: entry.pending, pendingCount: entry.pendingCount, stop: entry.stop, lastError: entry.lastError, note: entry.note, issue: entry.issue }, now);
  return <Pressable accessibilityRole="button" accessibilityLabel={t("coreAttentionPopover.open", { value1: entry.title || t("coreAttentionPopover.untitledAgent"), value2: reason.text })} onPress={onPress}
    style={state => ({ flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.sm, borderRadius: radius.md,
      backgroundColor: state.pressed || (state as { hovered?: boolean }).hovered ? colors.surface1 : "transparent" })}>
    <View style={{ paddingTop: 2 }}><StatusGlyph theme={theme} phase={entry.phase as Phase} size={16} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{entry.title || t("coreAttentionPopover.untitledAgent")}</Text>
        {entry.since ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{relativeTime(entry.since, now)}</Text> : null}
      </View>
      <Text numberOfLines={2} style={{ color: hueColor(theme, reason.hue, "text"), fontSize: fontSize.meta, lineHeight: 17, fontWeight: "600" }}>{reason.text}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2 }}>
        <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: 11 }}>{entry.projectName}</Text>
        <CacheChip theme={theme} agentId={entry.agentId} />
      </View>
    </View>
  </Pressable>;
}
