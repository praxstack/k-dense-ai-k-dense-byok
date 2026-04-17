import type { ChatMessage } from "@/lib/use-agent";

export interface TurnMeta {
  model: string;
  databases: string[];
  compute: string | null;
  skills: string[];
  filesAttached: string[];
  timestamp: number;
}

export interface ProvenanceEvent {
  id: string;
  timestamp: number;
  type:
    | "user_query"
    | "delegation_start"
    | "tool_call"
    | "delegation_complete"
    | "assistant_response";
  label: string;
  detail?: string;
  meta?: Record<string, string | string[]>;
}

export function buildTimeline(
  messages: ChatMessage[],
  turnMeta: Map<string, TurnMeta>
): ProvenanceEvent[] {
  const events: ProvenanceEvent[] = [];
  let eventCounter = 0;
  const eid = () => `prov-${++eventCounter}`;

  for (const msg of messages) {
    if (msg.role === "user") {
      const meta = turnMeta.get(msg.id);
      const metaFields: Record<string, string | string[]> = {};
      if (meta) {
        if (meta.model) metaFields.model = meta.model;
        if (meta.databases.length > 0) metaFields.databases = meta.databases;
        if (meta.compute) metaFields.compute = meta.compute;
        if (meta.skills.length > 0) metaFields.skills = meta.skills;
        if (meta.filesAttached.length > 0) metaFields.files = meta.filesAttached;
      }

      const queryPreview =
        msg.content.length > 100
          ? `${msg.content.slice(0, 97)}...`
          : msg.content;

      events.push({
        id: eid(),
        timestamp: meta?.timestamp ?? msg.timestamp,
        type: "user_query",
        label: "User query",
        detail: queryPreview,
        ...(Object.keys(metaFields).length > 0 ? { meta: metaFields } : {}),
      });
      continue;
    }

    // Assistant message -- emit events from its activities
    const activities = msg.activities ?? [];
    for (const act of activities) {
      const isDelegation = act.label.toLowerCase().includes("delegat");
      const isComplete =
        act.label.toLowerCase().includes("finished") ||
        act.label.toLowerCase().includes("specialist finished");

      let type: ProvenanceEvent["type"];
      if (isDelegation && act.status === "running") {
        type = "delegation_start";
      } else if (isComplete || (isDelegation && act.status !== "running")) {
        type = "delegation_complete";
      } else {
        type = "tool_call";
      }

      // Extract skills actually used from detail like "Used 'writing', 'parallel-web' skills"
      let meta: Record<string, string | string[]> | undefined;
      if (type === "delegation_complete" && act.detail) {
        const skillMatches = [...act.detail.matchAll(/'([^']+)'/g)].map(
          (m) => m[1]
        );
        if (skillMatches.length > 0) {
          meta = { skillsUsed: skillMatches };
        }
      }

      events.push({
        id: eid(),
        timestamp: act.timestamp,
        type,
        label: act.label,
        detail: act.detail,
        ...(meta ? { meta } : {}),
      });
    }

    if (msg.content && msg.content.trim()) {
      const preview =
        msg.content.length > 120
          ? `${msg.content.slice(0, 117)}...`
          : msg.content;
      events.push({
        id: eid(),
        timestamp: msg.timestamp,
        type: "assistant_response",
        label: "Assistant responded",
        detail: preview,
      });
    }
  }

  return events;
}

function collectUnique(
  events: ProvenanceEvent[],
  field: string
): string[] {
  const set = new Set<string>();
  for (const ev of events) {
    const val = ev.meta?.[field];
    if (typeof val === "string") {
      set.add(val);
    } else if (Array.isArray(val)) {
      for (const v of val) set.add(v);
    }
  }
  return [...set];
}

function formatList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export interface RunManifest {
  turnId: string;
  sessionId: string;
  timestamp: string;
  input: {
    promptSha256: string;
    promptPreview: string;
    attachments: Array<{ path: string; sha256: string; bytes: number; storedAt: string }>;
    databases: string[];
    skills: string[];
    compute: string | null;
  };
  env: {
    kadyVersion: string;
    kadyCommitSha: string | null;
    model: string | null;
    litellmConfigSha256: string | null;
    pythonVersion: string;
    nodeVersion: string | null;
    geminiCliVersion: string | null;
    platform: string;
    mcpServers: Array<{ name: string; spec: Record<string, unknown> }>;
    seed: string;
  };
  delegations: Array<{
    id: string;
    prompt: string;
    cwd: string;
    skillsUsed: string[];
    toolsUsed: Record<string, number>;
    durationMs: number;
    envLockPath: string | null;
    deliverables: string[] | null;
  }>;
  output: {
    assistantTextSha256: string | null;
    assistantTextPreview?: string;
    deliverables: string[];
    durationMs: number;
  };
  citations?: { total: number; verified: number; unresolved: number } | null;
  claims?: { total: number; verified: number; unbacked: number } | null;
  manifestSha256?: string;
}

const API_BASE =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_ADK_API_URL ?? "http://localhost:8000"
    : "http://localhost:8000";

export async function fetchManifests(
  sessionId: string,
  turnIds: string[]
): Promise<RunManifest[]> {
  if (!sessionId || turnIds.length === 0) return [];
  const results = await Promise.all(
    turnIds.map(async (turnId) => {
      try {
        const resp = await fetch(
          `${API_BASE}/turns/${sessionId}/${turnId}/manifest`
        );
        if (!resp.ok) return null;
        return (await resp.json()) as RunManifest;
      } catch {
        return null;
      }
    })
  );
  return results.filter((m): m is RunManifest => m !== null);
}

function formatAccessDate(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    return d.toISOString().slice(0, 10);
  } catch {
    return timestamp.slice(0, 10);
  }
}

/**
 * Build a journal-grade Methods paragraph from the per-turn run manifests.
 *
 * The manifest-driven version is strictly more accurate than the
 * event-stream-derived one because it includes real package versions,
 * database access dates, session seed, and manifest SHA. Use this whenever
 * manifests are available; fall back to {@link exportMethodsSection} when
 * they are not.
 */
export function exportMethodsSectionFromManifests(
  manifests: RunManifest[]
): string {
  if (manifests.length === 0) return "";

  const models = new Set<string>();
  const databases = new Set<string>();
  const skills = new Set<string>();
  const computes = new Set<string>();
  const inputFiles = new Set<string>();
  const mcpServers = new Set<string>();
  const pythonVersions = new Set<string>();
  const geminiVersions = new Set<string>();
  const seeds = new Set<string>();
  const commits = new Set<string>();
  const kadyVersions = new Set<string>();
  let delegations = 0;
  let citationTotal = 0;
  let citationVerified = 0;
  let citationUnresolved = 0;

  for (const m of manifests) {
    if (m.env.model) models.add(m.env.model);
    for (const db of m.input.databases) databases.add(db);
    for (const s of m.input.skills) skills.add(s);
    for (const d of m.delegations) {
      delegations += 1;
      for (const s of d.skillsUsed) skills.add(s);
    }
    if (m.input.compute) computes.add(m.input.compute);
    for (const a of m.input.attachments) inputFiles.add(a.path);
    for (const srv of m.env.mcpServers) mcpServers.add(srv.name);
    pythonVersions.add(m.env.pythonVersion);
    if (m.env.geminiCliVersion) geminiVersions.add(m.env.geminiCliVersion);
    seeds.add(m.env.seed);
    if (m.env.kadyCommitSha) commits.add(m.env.kadyCommitSha);
    kadyVersions.add(m.env.kadyVersion);
    if (m.citations) {
      citationTotal += m.citations.total;
      citationVerified += m.citations.verified;
      citationUnresolved += m.citations.unresolved;
    }
  }

  const firstTs = new Date(manifests[0].timestamp).getTime();
  const lastTs = new Date(manifests.at(-1)!.timestamp).getTime();
  const accessFirst = formatAccessDate(manifests[0].timestamp);
  const accessLast = formatAccessDate(manifests.at(-1)!.timestamp);
  const durationMs = manifests.reduce((acc, m) => acc + m.output.durationMs, 0);
  const durationMin = Math.max(1, Math.round(durationMs / 60_000));

  const parts: string[] = [];
  parts.push("## Methods\n");

  if (models.size > 0) {
    parts.push(
      `Analysis was conducted using ${formatList([...models])} via the K-Dense BYOK platform (version ${formatList([...kadyVersions])}${commits.size > 0 ? `, git ${formatList([...commits].map((c) => c.slice(0, 7)))}` : ""}).`
    );
  }

  parts.push(
    `The session comprised ${manifests.length} turn${manifests.length > 1 ? "s" : ""} and ${delegations} specialist delegation${delegations === 1 ? "" : "s"}.`
  );

  if (skills.size > 0) {
    const quoted = [...skills].map((s) => `'${s}'`);
    parts.push(
      `Expert skills activated: ${formatList(quoted)}.`
    );
  }

  if (databases.size > 0) {
    const accessNote =
      accessFirst === accessLast
        ? `accessed on ${accessFirst}`
        : `accessed between ${accessFirst} and ${accessLast}`;
    parts.push(
      `Data sources consulted included ${formatList([...databases])} (${accessNote}).`
    );
  }

  if (computes.size > 0) {
    parts.push(`Compute was provisioned on ${formatList([...computes])} via Modal.`);
  }

  if (inputFiles.size > 0) {
    parts.push(
      `Input files included ${formatList([...inputFiles].map((f) => f.split("/").pop() ?? f))}.`
    );
  }

  const envParts: string[] = [`Python ${formatList([...pythonVersions])}`];
  if (geminiVersions.size > 0) {
    envParts.push(`Gemini CLI ${formatList([...geminiVersions])}`);
  }
  if (mcpServers.size > 0) {
    envParts.push(`MCP servers (${formatList([...mcpServers])})`);
  }
  parts.push(`Runtime environment: ${envParts.join("; ")}.`);

  if (seeds.size > 0) {
    parts.push(
      `Session RNG seed${seeds.size > 1 ? "s" : ""}: ${formatList([...seeds])}.`
    );
  }

  if (citationTotal > 0) {
    parts.push(
      `Citation resolver pass: ${citationVerified}/${citationTotal} references verified against authority services (doi.org, arXiv API, PubMed E-utilities)${citationUnresolved > 0 ? `; ${citationUnresolved} remain unresolved` : ""}.`
    );
  }

  if (durationMs > 0) {
    parts.push(
      `Total active compute time was approximately ${durationMin} minute${durationMin > 1 ? "s" : ""}${lastTs > firstTs ? ` (wall-clock ${Math.max(1, Math.round((lastTs - firstTs) / 60_000))} min)` : ""}.`
    );
  }

  const turnRefs = manifests.map((m) =>
    `sandbox/.kady/runs/${m.sessionId}/${m.turnId}/manifest.json`
  );
  parts.push(
    `Full run manifests (sha256-addressed inputs, package versions, tool invocations): ${formatList(turnRefs)}.`
  );

  parts.push(
    `LLM outputs are not bit-exact reproducible because upstream providers give no determinism guarantees; the manifest pins the requested model slug, LiteLLM routing config hash, and session seed so the pipeline can be faithfully re-run.`
  );

  return parts.join(" ");
}

export function exportMethodsSection(events: ProvenanceEvent[]): string {
  if (events.length === 0) return "";

  const models = collectUnique(events, "model");
  const databases = collectUnique(events, "databases");
  const requestedSkills = collectUnique(events, "skills");
  const usedSkills = collectUnique(events, "skillsUsed");
  const skills = [...new Set([...requestedSkills, ...usedSkills])];
  const computes = collectUnique(events, "compute");
  const files = collectUnique(events, "files");

  const delegations = events.filter((e) => e.type === "delegation_start").length;
  const toolCalls = events.filter((e) => e.type === "tool_call").length;
  const queries = events.filter((e) => e.type === "user_query").length;

  const firstTs = events[0]?.timestamp;
  const lastTs = events.at(-1)?.timestamp;
  const durationMs = firstTs && lastTs ? lastTs - firstTs : 0;
  const durationMin = Math.max(1, Math.round(durationMs / 60_000));

  const parts: string[] = [];

  parts.push("## Methods\n");

  if (models.length > 0) {
    parts.push(
      `Analysis was conducted using ${formatList(models)} via the K-Dense BYOK platform.`
    );
  }

  if (queries > 1) {
    parts.push(`The session consisted of ${queries} user queries.`);
  }

  if (delegations > 0) {
    const word = delegations === 1 ? "delegation" : "delegations";
    let sentence = `${delegations} ${word} to specialist agents were performed`;
    if (skills.length > 0) {
      const quoted = skills.map((s) => `'${s}'`);
      sentence += `, activating the ${formatList(quoted)} skill${skills.length > 1 ? "s" : ""}`;
    }
    parts.push(`${sentence}.`);
  }

  if (toolCalls > 0) {
    parts.push(
      `The agent executed ${toolCalls} tool call${toolCalls > 1 ? "s" : ""} during processing.`
    );
  }

  if (databases.length > 0) {
    parts.push(
      `Data sources consulted included ${formatList(databases)}.`
    );
  }

  if (computes.length > 0) {
    parts.push(
      `Compute was provisioned on ${formatList(computes)} via Modal.`
    );
  }

  if (files.length > 0) {
    parts.push(
      `Input files included ${formatList(files.map((f) => f.split("/").pop() ?? f))}.`
    );
  }

  if (durationMs > 0) {
    parts.push(
      `Total session duration was approximately ${durationMin} minute${durationMin > 1 ? "s" : ""}.`
    );
  }

  return parts.join(" ");
}
