import { agentAttentionPriority, buildAgentForest, completionReadState, isUnreadCompletion, matchesAgentStatus, stopShown, stopUnseen, timestamp, type AgentRecord, type AgentStatus, type AgentTreeNode, type CompletionReadFilter } from "./model";

export interface DashboardRow {
  node: AgentTreeNode;
  depth: number;
  /** Visible only to show the ancestry of a matching descendant. */
  context: boolean;
}

export interface DashboardRowOptions {
  query: string;
  status: AgentStatus | "all";
  view: "tree" | "list";
  sort: "attention" | "recent";
  expanded: ReadonlySet<string>;
  readFilter?: CompletionReadFilter;
  /** Quick scope (「需要处理」): keeps only agents it accepts, revealing their ancestry like other filters. */
  focus?: (agent: AgentRecord) => boolean;
}

const activityTime = (agent: AgentRecord) => timestamp(agent.lastActivityAt) ?? timestamp(agent.updatedAt) ?? timestamp(agent.createdAt) ?? 0;

/**
 * Produce virtualized rows without rendering or recursion. Filters reveal the
 * path to each match; ordinary browsing honors the user's expansion state.
 * Ancestors never count toward matchingCount unless they match themselves.
 */
export function buildDashboardRows(agents: readonly AgentRecord[], options: DashboardRowOptions): { rows: DashboardRow[]; matchingCount: number } {
  const search = options.query.trim().toLocaleLowerCase();
  const filtered = !!search || options.status !== "all" || options.readFilter !== undefined && options.readFilter !== "all" || !!options.focus;
  const matches = (agent: AgentRecord) => matchesAgentStatus(agent, options.status) && (!options.focus || options.focus(agent))
    && (options.readFilter !== "unread" || isUnreadCompletion(agent)) && (options.readFilter !== "read" || completionReadState(agent) === "read")
    && (!search || [agent.title, agent.id, agent.cwd, agent.provider, agent.model, agent.projectId, agent.projectName, agent.projectRootPath, agent.workspaceName, agent.worktreeName, agent.worktreePath, agent.branch].filter(Boolean).join(" ").toLocaleLowerCase().includes(search));
  const compare = (a: AgentRecord, b: AgentRecord) => (options.sort === "attention" ? agentAttentionPriority(a) - agentAttentionPriority(b) : 0) || activityTime(b) - activityTime(a) || a.id.localeCompare(b.id);
  const forest = buildAgentForest(agents);
  const traversal: AgentTreeNode[] = [];
  const stack = [...forest];
  while (stack.length) {
    const node = stack.pop()!;
    traversal.push(node);
    for (const child of node.children) stack.push(child);
  }
  const directMatches = new Set<string>();
  for (const node of traversal) if (matches(node.agent)) directMatches.add(node.agent.id);
  const matchingCount = directMatches.size;
  if (options.view === "list") {
    const rows = traversal.filter((node) => directMatches.has(node.agent.id)).sort((a, b) => compare(a.agent, b.agent)).map((node) => ({ node: { ...node, children: [] }, depth: 0, context: false }));
    return { rows, matchingCount };
  }
  const visible = new Set<string>();
  const branchPriority = new Map<string, number>();
  const compareBranches = (a: AgentTreeNode, b: AgentTreeNode) => (options.sort === "attention" ? (branchPriority.get(a.agent.id) ?? agentAttentionPriority(a.agent)) - (branchPriority.get(b.agent.id) ?? agentAttentionPriority(b.agent)) : 0)
    || activityTime(b.agent) - activityTime(a.agent) || a.agent.id.localeCompare(b.agent.id);
  for (let index = traversal.length - 1; index >= 0; index--) {
    const node = traversal[index]!;
    if (directMatches.has(node.agent.id) || node.children.some((child) => visible.has(child.agent.id))) visible.add(node.agent.id);
    branchPriority.set(node.agent.id, Math.min(agentAttentionPriority(node.agent), ...node.children.map(child => branchPriority.get(child.agent.id) ?? agentAttentionPriority(child.agent))));
    node.children.sort(compareBranches);
  }
  forest.sort(compareBranches);
  const pending = forest.slice().reverse().map((node) => ({ node, depth: 0, context: !directMatches.has(node.agent.id) }));
  const rows: DashboardRow[] = [];
  while (pending.length) {
    const row = pending.pop()!;
    if (!visible.has(row.node.agent.id)) continue;
    rows.push(row);
    if (!filtered && !options.expanded.has(row.node.agent.id)) continue;
    for (let index = row.node.children.length - 1; index >= 0; index--) {
      const child = row.node.children[index]!;
      pending.push({ node: child, depth: row.depth + 1, context: !directMatches.has(child.agent.id) });
    }
  }
  return { rows, matchingCount };
}

export interface AttentionOptions {
  /**
   * Whether a subagent's finished turn (an Agent with a parent) counts: its parent has the result already. Off by default
   * (the 「子 Agent 完成计入需要处理」 setting); a subagent's approval, error or stop always counts.
   */
  childCompletions?: boolean;
}

/**
 * Needs the user now: a pending approval or question, an error or a stop (usage limit, empty or unfinished turn) not seen yet,
 * an unread result that is not snoozed, or a question not opened yet. Archived sessions never do.
 * Seen means native attention is cleared — opening the Agent in Paseo, or 知道了 / 标记已读 here — and for a turn the host
 * closed mid-way, which raised no attention, 知道了 here (see `stopUnseen`).
 */
export function needsAttention(agent: AgentRecord, snoozed = false, options: AttentionOptions = {}): boolean {
  if (agent.archivedAt) return false;
  if (agent.pendingPermissionCount > 0 || agent.status === "waiting") return true;
  // A running turn going in circles or quiet for long counts until 知道了 (a subagent's too: nobody else watches it).
  if (agent.status === "running" && agent.issue) return !agent.issue.seen;
  // A stop decides on its own, before the subagent setting (a child's parent may not have stopped) and never snoozed.
  if (stopShown(agent)) return stopUnseen(agent);
  if (agent.status === "error") return agent.requiresAttention !== false;
  if (agent.parentAgentId && options.childCompletions !== true) return false;
  // A question the user has not opened yet is as urgent as an unread result; once read it stays 待回复 but leaves 需要处理.
  const unreadQuestion = agent.status === "idle" && agent.requiresAttention === true && agent.attentionReason === "finished";
  return !snoozed && (isUnreadCompletion(agent) || unreadQuestion);
}

export type DashboardGroup = "attention" | "running" | "recent";
export interface DashboardSection { group: DashboardGroup; rows: DashboardRow[]; threads: number }
const live = (agent: AgentRecord) => !agent.archivedAt && (agent.status === "running" || agent.status === "initializing");

/**
 * Split rows into 需要处理 → 执行中 → 最近. A top-level thread moves as one block (children stay under
 * their parent) and is classified by its whole subtree, collapsed descendants included, so a finished
 * parent with an unread child still surfaces. Order inside a group is the order of `rows`.
 */
export function groupDashboardRows(rows: readonly DashboardRow[], attention: (agent: AgentRecord) => boolean): DashboardSection[] {
  const sections = new Map<DashboardGroup, DashboardSection>((["attention", "running", "recent"] as const).map(group => [group, { group, rows: [], threads: 0 }]));
  let current: DashboardSection | undefined;
  for (const row of rows) {
    if (row.depth === 0 || !current) {
      let group: DashboardGroup = "recent";
      const stack: AgentTreeNode[] = [row.node];
      while (stack.length && group !== "attention") {
        const node = stack.pop()!;
        if (attention(node.agent)) group = "attention";
        else if (live(node.agent)) group = "running";
        stack.push(...node.children);
      }
      current = sections.get(group)!;
      current.threads++;
    }
    current.rows.push(row);
  }
  return [...sections.values()].filter(section => section.rows.length > 0);
}
