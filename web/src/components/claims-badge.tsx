"use client";

import {
  AlertCircleIcon,
  CheckCircle2Icon,
  FileIcon,
  Loader2Icon,
} from "lucide-react";
import { useEffect, useMemo } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ClaimEntry, ClaimsReport } from "@/lib/use-agent";
import { cn } from "@/lib/utils";

const STATUS_META: Record<
  ClaimEntry["status"],
  { label: string; underline: string; dotClass: string; textClass: string }
> = {
  verified: {
    label: "verified",
    underline: "underline decoration-emerald-500/60 decoration-dotted",
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-600 dark:text-emerald-400",
  },
  approximate: {
    label: "approximate",
    underline: "underline decoration-amber-500/60 decoration-dotted",
    dotClass: "bg-amber-500",
    textClass: "text-amber-600 dark:text-amber-400",
  },
  unbacked: {
    label: "unbacked",
    underline: "underline decoration-red-500/70 decoration-dotted decoration-2",
    dotClass: "bg-red-500",
    textClass: "text-red-600 dark:text-red-400",
  },
  ambiguous: {
    label: "ambiguous",
    underline: "underline decoration-slate-400/60 decoration-dotted",
    dotClass: "bg-slate-400",
    textClass: "text-muted-foreground",
  },
};

/**
 * Walks the rendered markdown DOM and wraps claim-text occurrences in
 * classed spans. We do this post-render (rather than via a Streamdown
 * rehype plugin) because Streamdown's plugin surface is fixed and the
 * auditor output is asynchronous. Safe to re-run on every render — the
 * walker skips nodes already inside a `.kady-claim` span.
 */
export function useClaimsUnderlines(
  ref: React.RefObject<HTMLElement | null>,
  claims: ClaimEntry[] | undefined
) {
  useEffect(() => {
    const root = ref.current;
    if (!root || !claims || claims.length === 0) return;

    const sorted = [...claims].sort((a, b) => b.text.length - a.text.length);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = (node as Text).parentElement;
        if (parent?.closest(".kady-claim")) return NodeFilter.FILTER_REJECT;
        if (parent?.closest("pre, code")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) textNodes.push(n as Text);

    for (const node of textNodes) {
      const original = node.nodeValue ?? "";
      if (!original.trim()) continue;

      let match: { claim: ClaimEntry; index: number } | null = null;
      for (const claim of sorted) {
        if (!claim.text) continue;
        const idx = original.indexOf(claim.text);
        if (idx >= 0 && (!match || idx < match.index)) {
          match = { claim, index: idx };
        }
      }
      if (!match) continue;

      const before = original.slice(0, match.index);
      const matched = original.slice(
        match.index,
        match.index + match.claim.text.length
      );
      const after = original.slice(match.index + match.claim.text.length);

      const span = document.createElement("span");
      span.className = cn(
        "kady-claim",
        STATUS_META[match.claim.status].underline
      );
      span.dataset.claimStatus = match.claim.status;
      if (match.claim.source?.file) {
        span.title = `${match.claim.status} - ${match.claim.source.file}${
          match.claim.source.line ? `:${match.claim.source.line}` : ""
        }${match.claim.source.value ? ` (value: ${match.claim.source.value})` : ""}`;
      } else {
        span.title = `${match.claim.status} - no source located`;
      }
      span.textContent = matched;

      const parent = node.parentNode;
      if (!parent) continue;
      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(span, node);
      if (after) parent.insertBefore(document.createTextNode(after), node);
      parent.removeChild(node);
    }
  }, [ref, claims]);
}

export function ClaimsBadge({
  report,
  onRun,
}: {
  report?: ClaimsReport;
  onRun?: () => void;
}) {
  const counts = useMemo(() => {
    const acc = { verified: 0, approximate: 0, unbacked: 0, ambiguous: 0 };
    for (const c of report?.claims ?? []) acc[c.status] += 1;
    return acc;
  }, [report]);

  if (!report && !onRun) return null;

  if (report?.loading) {
    return (
      <div className="inline-flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" />
        Running claims auditor...
      </div>
    );
  }

  if (!report || report.claims.length === 0) {
    if (!onRun) return null;
    return (
      <button
        type="button"
        onClick={onRun}
        className="inline-flex items-center gap-1.5 mt-2 rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
      >
        <AlertCircleIcon className="size-3" />
        Audit numbers
      </button>
    );
  }

  const total = report.claims.length;
  const allOk = counts.unbacked === 0 && counts.ambiguous === 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 mt-2 rounded-full border px-2.5 py-1 text-xs transition-colors",
            allOk
              ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400"
              : "border-red-500/30 bg-red-500/5 text-red-700 hover:bg-red-500/10 dark:text-red-400"
          )}
        >
          {allOk ? (
            <CheckCircle2Icon className="size-3" />
          ) : (
            <AlertCircleIcon className="size-3" />
          )}
          <span>
            {total} numeric claim{total === 1 ? "" : "s"}
            {` \u00b7 ${counts.verified} verified`}
            {counts.unbacked > 0 ? ` \u00b7 ${counts.unbacked} unbacked` : ""}
            {counts.approximate > 0 ? ` \u00b7 ${counts.approximate} approximate` : ""}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[440px] max-h-[480px] overflow-y-auto p-0"
      >
        <div className="px-3 py-2 border-b text-xs text-muted-foreground">
          Quantitative claims auditor. Hover an underline in the message to
          see its source. Sources that could not be located are marked
          unbacked.
        </div>
        <ul className="divide-y">
          {report.claims.map((claim, idx) => {
            const meta = STATUS_META[claim.status];
            return (
              <li key={`${claim.text}-${idx}`} className="px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", meta.dotClass)} />
                  <span className={cn("font-medium", meta.textClass)}>
                    {meta.label}
                  </span>
                  <span className="font-mono truncate">{claim.text}</span>
                </div>
                {claim.context && (
                  <div className="mt-1 text-muted-foreground line-clamp-2">
                    {claim.context}
                  </div>
                )}
                {claim.source?.file && (
                  <div className="mt-1 flex items-center gap-1 text-muted-foreground">
                    <FileIcon className="size-3 shrink-0" />
                    <span className="font-mono break-all">
                      {claim.source.file}
                      {claim.source.line ? `:${claim.source.line}` : ""}
                      {claim.source.cell !== undefined
                        ? ` (cell ${claim.source.cell})`
                        : ""}
                    </span>
                    {claim.source.value && (
                      <span className="text-muted-foreground/80">
                        = {claim.source.value}
                      </span>
                    )}
                  </div>
                )}
                {claim.status === "unbacked" && !claim.source?.file && (
                  <div className="mt-1 text-muted-foreground italic">
                    Auditor found no source; may exist in working notes.
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
