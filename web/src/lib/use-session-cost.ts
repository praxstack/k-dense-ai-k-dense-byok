"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/projects";

export interface CostEntry {
  ts: number;
  sessionId: string;
  turnId: string;
  role: "orchestrator" | "expert" | string;
  delegationId: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export interface CostTurnBucket {
  turnId: string;
  totalUsd: number;
  orchestratorUsd: number;
  expertUsd: number;
  totalTokens: number;
  entries: CostEntry[];
}

export interface SessionCostSummary {
  sessionId: string;
  totalUsd: number;
  orchestratorUsd: number;
  expertUsd: number;
  totalTokens: number;
  orchestratorTokens: number;
  expertTokens: number;
  entries: CostEntry[];
  byTurn: Record<string, CostTurnBucket>;
}

const EMPTY: SessionCostSummary = {
  sessionId: "",
  totalUsd: 0,
  orchestratorUsd: 0,
  expertUsd: 0,
  totalTokens: 0,
  orchestratorTokens: 0,
  expertTokens: 0,
  entries: [],
  byTurn: {},
};

/**
 * Fetches the OpenRouter cost ledger for a session.
 *
 * `refreshKey` is a monotonic counter — bump it whenever a turn completes so
 * the summary refetches. We poll on demand rather than streaming; real-time
 * cost updates during a turn would need a new SSE channel and are rarely
 * what users want when the question is "what did this session cost".
 */
export function useSessionCost(
  sessionId: string | null | undefined,
  refreshKey: number,
): { summary: SessionCostSummary; loading: boolean } {
  const [summary, setSummary] = useState<SessionCostSummary>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setSummary(EMPTY);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/costs`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data && typeof data === "object") {
          setSummary({ ...EMPTY, ...data });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  return { summary, loading };
}
