import { t } from "../shared/text";
import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentRecord } from "../shared/model";
import { clockLabel, loopText, seeLiveIssue } from "../shared/attention";
import { Button, fontSize, space } from "./kit";
import { Card } from "./stop-card";
import { PhasePill, type Hue } from "./status";
import { monoFont, useClock } from "./ui";
import { liveExtrasQueryKey } from "./use-live-extras";
import { useInvalidateAttention } from "./attention-context";

/**
 * 原地打转 / 可能卡住 on top of a running Agent's detail (2.18): what the loop looks like (the last calls of the pattern) or how
 * long nothing has changed, with 打开会话 and 知道了. Nothing is stopped for you: interrupting is the user's call, in the session.
 */
export function IssueCard({ theme, agent, hostId, onOpenConversation }: { theme: PluginTheme; agent: AgentRecord; hostId: string; onOpenConversation?: () => void }) {
  const issue = agent.issue, see = useRpc(seeLiveIssue), cache = useQueryClient(), toast = useToast(), now = useClock(30_000), invalidateAttention = useInvalidateAttention();
  const [busy, setBusy] = useState(false);
  if (!issue || agent.status !== "running" || agent.archivedAt) return null;
  const looping = issue.kind === "looping", hue: Hue = looping ? "orange" : "amber", time = clockLabel(issue.since, now);
  const text = looping ? t("secondaryIssueCard.loopText")
    : issue.toolRunning && issue.tool ? t("secondaryIssueCard.stuckToolText", { tool: issue.tool, time }) : t("secondaryIssueCard.stuckText", { time });
  const acknowledge = async () => {
    setBusy(true);
    try {
      await see({ agentId: agent.id, key: issue.key });
      void cache.invalidateQueries({ queryKey: liveExtrasQueryKey(hostId) });
      // The sidebar badge stops counting it now, not at its next read.
      invalidateAttention(hostId);
    } catch (error) {
      toast.error(t("secondaryIssueCard.seenFailed", { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  };
  return <Card theme={theme} hue={hue} icon={looping ? "Repeat" : "Hourglass"} title={looping ? t("secondaryIssueCard.loopTitle") : t("secondaryIssueCard.stuckTitle")} pulse={!issue.seen}
    pill={<PhasePill theme={theme} hue={hue} label={t("secondaryIssueCard.since", { time })} />} text={text}
    note={issue.seen ? t("secondaryIssueCard.seenHint") : null}
    actions={<>
      {onOpenConversation ? <Button theme={theme} size="sm" tone={hue} icon="ArrowUpRight" label={t("secondaryIssueCard.openSession")} onPress={onOpenConversation} /> : null}
      {!issue.seen ? <Button theme={theme} size="sm" tone="neutral" icon="Check" label={t("secondaryIssueCard.seen")} busy={busy} onPress={() => void acknowledge()} /> : null}
    </>}>
    {looping ? <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{loopText(issue)}</Text> : null}
    {issue.evidence.length ? <View style={{ gap: 2 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondaryIssueCard.recentCalls")}</Text>
      {issue.evidence.map((line, index) => <Text key={index} numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.meta, fontFamily: monoFont }}>{line}</Text>)}
    </View> : null}
  </Card>;
}
