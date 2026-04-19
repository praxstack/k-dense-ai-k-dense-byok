"use client";

import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import type {
  CostEntry,
  CostTurnBucket,
  SessionCostSummary,
} from "@/lib/use-session-cost";

interface SessionCostPillProps {
  summary: SessionCostSummary;
  loading?: boolean;
  className?: string;
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function shortModel(model: string): string {
  // Trim `openrouter/` prefix for readability; keep the vendor/name body.
  return model.startsWith("openrouter/") ? model.slice("openrouter/".length) : model;
}

export function SessionCostPill({
  summary,
  loading = false,
  className,
}: SessionCostPillProps) {
  const hasData = summary.entries.length > 0 || summary.totalUsd > 0;

  const orderedTurns = useMemo<CostTurnBucket[]>(() => {
    const buckets = Object.values(summary.byTurn);
    // Turn ids are ordered "<timestamp>-<slug>" by manifest.open_turn, so
    // lexicographic sort is equivalent to chronological.
    buckets.sort((a, b) => (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0));
    return buckets;
  }, [summary]);

  if (!hasData) {
    return null;
  }

  return (
    <HoverCard closeDelay={120} openDelay={80}>
      <HoverCardTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 gap-1.5 font-mono text-xs tabular-nums",
            loading && "opacity-70",
            className,
          )}
          aria-label={`Session cost ${formatCost(summary.totalUsd)}`}
        >
          <span className="text-muted-foreground">cost</span>
          <span className="font-semibold">{formatCost(summary.totalUsd)}</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-96 p-0">
        <div className="border-b p-4">
          <div className="text-muted-foreground text-xs uppercase tracking-wide">
            Session cost
          </div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">
            {formatCost(summary.totalUsd)}
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            {formatTokens(summary.totalTokens)} tokens across{" "}
            {summary.entries.length} call{summary.entries.length === 1 ? "" : "s"}
          </div>
        </div>

        <div className="border-b p-4">
          <CostRow
            label="Orchestrator"
            costUsd={summary.orchestratorUsd}
            tokens={summary.orchestratorTokens}
          />
          <CostRow
            label="Expert"
            costUsd={summary.expertUsd}
            tokens={summary.expertTokens}
          />
        </div>

        <div className="max-h-60 overflow-y-auto p-2">
          {orderedTurns.length === 0 ? (
            <div className="text-muted-foreground px-2 py-1 text-xs">
              No turn-level breakdown yet.
            </div>
          ) : (
            orderedTurns.map((bucket) => (
              <TurnBlock key={bucket.turnId} bucket={bucket} />
            ))
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function CostRow({
  label,
  costUsd,
  tokens,
}: {
  label: string;
  costUsd: number;
  tokens: number;
}) {
  return (
    <div className="flex items-baseline justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-2 font-mono tabular-nums">
        <span className="text-muted-foreground text-xs">
          {formatTokens(tokens)} tok
        </span>
        <span>{formatCost(costUsd)}</span>
      </span>
    </div>
  );
}

function TurnBlock({ bucket }: { bucket: CostTurnBucket }) {
  return (
    <div className="px-2 py-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground truncate" title={bucket.turnId}>
          {bucket.turnId}
        </span>
        <span className="font-mono tabular-nums">
          {formatCost(bucket.totalUsd)}
        </span>
      </div>
      <ul className="mt-1 space-y-0.5">
        {bucket.entries.map((entry, idx) => (
          <EntryRow key={`${bucket.turnId}-${idx}`} entry={entry} />
        ))}
      </ul>
    </div>
  );
}

function EntryRow({ entry }: { entry: CostEntry }) {
  return (
    <li className="text-muted-foreground flex items-center justify-between gap-2 text-[11px]">
      <span
        className="flex min-w-0 items-center gap-1 truncate"
        title={`${entry.role} · ${entry.model}`}
      >
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
            entry.role === "orchestrator" ? "bg-sky-500" : "bg-amber-500",
          )}
          aria-hidden
        />
        <span className="truncate">{shortModel(entry.model)}</span>
      </span>
      <span className="shrink-0 font-mono tabular-nums">
        {formatTokens(entry.totalTokens)} · {formatCost(entry.costUsd)}
      </span>
    </li>
  );
}
