import { useEffect, useMemo, useSyncExternalStore } from "react";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { providerTimelineRpc } from "../shared/provider-subagents";
import { createTimelineCache, createTimelineStore } from "./timeline-store";
import { useForeground } from "./use-foreground";

export interface TimelineTarget { agentId: string; subagentId?: string }
const hostCaches = new WeakMap<object, ReturnType<typeof createTimelineCache>>();
/** `polling`: false while the Agent (for a native sub-task, its parent) is closed, so the fallback poll doesn't load it again. */
export function useTimeline(target: TimelineTarget, enabled = true, polling = true) {
  const paseo = usePaseo(), fetchProviderTimeline = useRpc(providerTimelineRpc);
  const foreground = useForeground();
  const { agentId, subagentId } = target;
  const store = useMemo(() => {
    let cache = hostCaches.get(paseo); if (!cache) { cache = createTimelineCache(); hostCaches.set(paseo, cache); }
    return cache.get(JSON.stringify([agentId, subagentId ?? null]), onChange => {
      const handle = paseo.agents.ref(agentId);
      return createTimelineStore({
        fetch: async input => {
          if (!subagentId) return handle.timeline.refetch({ ...input, projection: "projected" });
          const response = await fetchProviderTimeline({ parentAgentId: agentId, subagentId, ...input });
          if (response.error) throw new Error(response.error); return response.page;
        },
        ...(!subagentId ? { subscribe: (listener: (update: unknown) => void) => handle.timeline.subscribe(listener) } : {}),
      }, { onChange, fallbackMs: subagentId ? 15_000 : 30_000 });
    });
  }, [paseo, agentId, subagentId, fetchProviderTimeline]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => { store.setPolling(polling); }, [store, polling]);
  useEffect(() => { if (enabled && foreground) return store.acquire(); }, [store, enabled, foreground]);
  return { ...state, refresh: store.refresh, loadOlder: store.loadOlder, setViewState: store.setViewState };
}
