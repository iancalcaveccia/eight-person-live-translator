"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GatheringStateView } from "@/lib/api-types";
import { api, ClientApiError } from "./api";

const POLL_MS = 3000;
const HIDDEN_POLL_MS = 15000;

export interface GatheringStateHook {
  state: GatheringStateView | null;
  error: ClientApiError | null;
  refresh: () => void;
}

/**
 * Polls gathering presence/groups/invitations. Data-channel nudges from the
 * server call `refresh()` for instant updates; polling is the safety net.
 */
export function useGatheringState(gid: string): GatheringStateHook {
  const [state, setState] = useState<GatheringStateView | null>(null);
  const [error, setError] = useState<ClientApiError | null>(null);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async (): Promise<void> => {
      if (stopped) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const s = await api.state(gid);
        if (!stopped) {
          setState(s);
          setError(null);
        }
      } catch (err) {
        const e = err instanceof ClientApiError ? err : new ClientApiError(0, "network", "Network error");
        if (!stopped) setError(e);
        // Terminal: no session, removed, or ended. Stop polling.
        if (e.status === 401 || e.status === 403 || e.status === 410) stopped = true;
      } finally {
        inFlight = false;
        if (queued && !stopped) {
          queued = false;
          void load();
        }
      }
    };

    const loop = async () => {
      await load();
      if (stopped) return;
      const delay = document.visibilityState === "visible" ? POLL_MS : HIDDEN_POLL_MS;
      timer = setTimeout(loop, delay);
    };

    refreshRef.current = () => void load();
    void loop();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      refreshRef.current = () => {};
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [gid]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return { state, error, refresh };
}
