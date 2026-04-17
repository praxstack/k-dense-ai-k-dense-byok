"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  XIcon,
  CheckIcon,
  CopyIcon,
  CircleIcon,
  ArrowRightIcon,
  SparklesIcon,
  WrenchIcon,
  MessageSquareIcon,
  UserIcon,
  ClockIcon,
  PlayIcon,
  Loader2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/lib/use-agent";
import {
  buildTimeline,
  exportMethodsSection,
  exportMethodsSectionFromManifests,
  fetchManifests,
  type ProvenanceEvent,
  type RunManifest,
  type TurnMeta,
} from "@/lib/provenance";

const EVENT_STYLES: Record<
  ProvenanceEvent["type"],
  { dot: string; icon: typeof CircleIcon }
> = {
  user_query: { dot: "bg-blue-500", icon: UserIcon },
  delegation_start: { dot: "bg-violet-500", icon: ArrowRightIcon },
  tool_call: { dot: "bg-slate-400", icon: WrenchIcon },
  delegation_complete: { dot: "bg-emerald-500", icon: SparklesIcon },
  assistant_response: { dot: "bg-sky-400", icon: MessageSquareIcon },
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

function MetaPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px]">
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}

function TimelineNode({ event }: { event: ProvenanceEvent }) {
  const style = EVENT_STYLES[event.type];
  const Icon = style.icon;

  return (
    <div className="relative flex gap-3 pb-6 last:pb-0">
      {/* Vertical connector line */}
      <div className="absolute left-[11px] top-6 bottom-0 w-px bg-border last:hidden" />

      {/* Dot */}
      <div
        className={cn(
          "relative z-10 mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full border-2 border-background",
          style.dot
        )}
      >
        <Icon className="size-2.5 text-white" />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 pt-px">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">
            {event.label}
          </span>
          <span className="text-[10px] text-muted-foreground/60 tabular-nums">
            {relativeTime(event.timestamp)}
          </span>
        </div>

        {event.detail && (
          <p className="mt-0.5 text-xs text-muted-foreground/80 line-clamp-2 leading-relaxed">
            {event.detail}
          </p>
        )}

        {event.meta && Object.keys(event.meta).length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {typeof event.meta.model === "string" && (
              <MetaPill label="Model" value={event.meta.model} />
            )}
            {Array.isArray(event.meta.databases) &&
              event.meta.databases.map((db) => (
                <MetaPill key={db} label="DB" value={db} />
              ))}
            {typeof event.meta.compute === "string" && (
              <MetaPill label="Compute" value={event.meta.compute} />
            )}
            {Array.isArray(event.meta.skills) &&
              event.meta.skills.map((s) => (
                <MetaPill key={s} label="Skill" value={s} />
              ))}
            {Array.isArray(event.meta.files) &&
              event.meta.files.map((f) => (
                <MetaPill
                  key={f}
                  label="File"
                  value={f.split("/").pop() ?? f}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProvenancePanel({
  messages,
  turnMeta,
  sessionId,
  onClose,
}: {
  messages: ChatMessage[];
  turnMeta: Map<string, TurnMeta>;
  sessionId: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [manifests, setManifests] = useState<RunManifest[]>([]);
  const [replayState, setReplayState] = useState<{
    status: "idle" | "confirming" | "running" | "complete" | "error";
    events: Array<{ event: string; [k: string]: unknown }>;
    error?: string;
  }>({ status: "idle", events: [] });

  const events = useMemo(
    () => buildTimeline(messages, turnMeta),
    [messages, turnMeta]
  );

  const turnIds = useMemo(
    () =>
      messages
        .filter((m) => m.role === "assistant" && m.turnId)
        .map((m) => m.turnId as string),
    [messages]
  );

  useEffect(() => {
    if (!sessionId || turnIds.length === 0) {
      setManifests([]);
      return;
    }
    let cancelled = false;
    void fetchManifests(sessionId, turnIds).then((result) => {
      if (!cancelled) setManifests(result);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, turnIds]);

  const sessionDuration = useMemo(() => {
    if (events.length < 2) return null;
    const first = events[0].timestamp;
    const last = events.at(-1)!.timestamp;
    const diffMin = Math.round((last - first) / 60_000);
    if (diffMin < 1) return "< 1 min";
    if (diffMin < 60) return `${diffMin} min`;
    const hrs = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    return `${hrs}h ${mins}m`;
  }, [events]);

  const apiBase =
    process.env.NEXT_PUBLIC_ADK_API_URL ?? "http://localhost:8000";

  const handleReplayConfirm = useCallback(() => {
    setReplayState({ status: "confirming", events: [] });
  }, []);

  const handleReplayRun = useCallback(async () => {
    if (!sessionId || turnIds.length === 0) return;
    setReplayState({ status: "running", events: [] });
    try {
      const resp = await fetch(`${apiBase}/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, turnIds }),
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`replay ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            setReplayState((prev) => ({
              ...prev,
              events: [...prev.events, event],
            }));
          } catch {
            // skip malformed
          }
        }
      }
      setReplayState((prev) => ({ ...prev, status: "complete" }));
    } catch (exc) {
      setReplayState((prev) => ({
        ...prev,
        status: "error",
        error: exc instanceof Error ? exc.message : "Replay failed",
      }));
    }
  }, [apiBase, sessionId, turnIds]);

  const handleCopyMethods = useCallback(() => {
    const text =
      manifests.length > 0
        ? exportMethodsSectionFromManifests(manifests)
        : exportMethodsSection(events);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [events, manifests]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px] transition-opacity"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 z-50 flex h-full w-[380px] max-w-[90vw] flex-col border-l bg-background shadow-2xl animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <ClockIcon className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Session Provenance</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleReplayConfirm}
              disabled={
                !sessionId ||
                turnIds.length === 0 ||
                replayState.status === "running"
              }
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              title="Re-run every saved delegation for this session"
            >
              {replayState.status === "running" ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <PlayIcon className="size-3" />
              )}
              Re-run
            </button>
            <button
              onClick={handleCopyMethods}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                copied
                  ? "bg-emerald-500/10 text-emerald-600"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
              title="Copy as Methods section"
            >
              {copied ? (
                <CheckIcon className="size-3" />
              ) : (
                <CopyIcon className="size-3" />
              )}
              {copied ? "Copied" : "Copy as Methods"}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        </div>

        {replayState.status !== "idle" && (
          <div className="border-b bg-muted/30 px-4 py-3 text-xs">
            {replayState.status === "confirming" ? (
              <div className="flex flex-col gap-2">
                <p className="font-medium text-foreground">
                  Re-run this session?
                </p>
                <p className="text-muted-foreground">
                  Re-runs every delegation using the saved prompts, session
                  seed, and attachment SHAs. LLM output may differ because
                  upstream providers are nondeterministic. The original
                  session is preserved; a new replay manifest is created.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleReplayRun}
                    className="rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:opacity-90"
                  >
                    Re-run {turnIds.length} turn{turnIds.length !== 1 ? "s" : ""}
                  </button>
                  <button
                    onClick={() =>
                      setReplayState({ status: "idle", events: [] })
                    }
                    className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">
                    Replay{" "}
                    {replayState.status === "running"
                      ? "in progress"
                      : replayState.status === "complete"
                      ? "complete"
                      : "error"}
                  </span>
                  <button
                    onClick={() =>
                      setReplayState({ status: "idle", events: [] })
                    }
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
                {replayState.error && (
                  <span className="text-red-600 dark:text-red-400">
                    {replayState.error}
                  </span>
                )}
                <div className="mt-1 max-h-56 overflow-y-auto rounded border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  {replayState.events.slice(-60).map((ev, i) => {
                    const diff = ev.diff as
                      | {
                          inputHashMatch?: boolean;
                          delegationsOriginal?: number;
                          delegationsReplayed?: number;
                        }
                      | undefined;
                    return (
                      <div key={i} className="whitespace-pre-wrap break-all">
                        <span className="text-foreground/80">{ev.event}</span>
                        {typeof ev.originalTurnId === "string"
                          ? ` original=${String(ev.originalTurnId).slice(-6)}`
                          : ""}
                        {typeof ev.newTurnId === "string"
                          ? ` new=${String(ev.newTurnId).slice(-6)}`
                          : ""}
                        {typeof ev.durationMs === "number"
                          ? ` ${ev.durationMs}ms`
                          : ""}
                        {typeof ev.detail === "string"
                          ? ` - ${ev.detail}`
                          : ""}
                        {diff ? (
                          <span
                            className={cn(
                              "ml-1",
                              diff.inputHashMatch
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-amber-600 dark:text-amber-400"
                            )}
                          >
                            {diff.inputHashMatch
                              ? " input✓"
                              : " input≠"}
                            {typeof diff.delegationsReplayed === "number"
                              ? ` delegs=${diff.delegationsReplayed}/${diff.delegationsOriginal}`
                              : ""}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Timeline body */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {events.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-xs text-muted-foreground">
                No activity recorded yet.
              </p>
            </div>
          ) : (
            <div>
              {events.map((event) => (
                <TimelineNode key={event.id} event={event} />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {events.length > 0 && (
          <div className="flex flex-col gap-1 border-t px-4 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">
                {events.length} event{events.length !== 1 ? "s" : ""}
                {manifests.length > 0
                  ? ` \u00b7 ${manifests.length} manifest${manifests.length !== 1 ? "s" : ""}`
                  : ""}
              </span>
              {sessionDuration && (
                <span className="text-[10px] text-muted-foreground">
                  Duration: {sessionDuration}
                </span>
              )}
            </div>
            {manifests.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {manifests.map((m) => (
                  <a
                    key={m.turnId}
                    href={`${process.env.NEXT_PUBLIC_ADK_API_URL ?? "http://localhost:8000"}/turns/${m.sessionId}/${m.turnId}/manifest`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-muted-foreground underline decoration-dotted hover:text-foreground"
                    title={`Manifest for turn ${m.turnId} (sha256:${(m.manifestSha256 ?? "").slice(0, 8)})`}
                  >
                    turn {m.turnId.slice(-6)}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
