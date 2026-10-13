/**
 * Cloud bot control (hq-pro-agents `/v1/agents/{uid}/control/*`): channels,
 * routines, persona and brain, read live from the bot's box and written back
 * to it. Every write is relayed to the box and answered with the box's
 * read-back, or refused with `{ error: { code, message } }`.
 *
 * Framework-free on purpose: the desktop adapter builds it on its hq-pro
 * request helper, and a web or mobile client can build the same client on a
 * plain `HqProFetch` with {@link agentControlRequestFromFetch}.
 */

import {
  failure,
  ok,
  type AdapterFailure,
  type AdapterPromise,
  type AdapterResult,
  type HqProFetch,
} from "./adapter.js";

export type AgentControlChannelKind = "hq" | "slack" | "telegram" | "email";

export interface AgentControlAgent {
  uid: string;
  displayName: string;
  title: string;
  avatarUrl: string | null;
  online: boolean;
  lastSeenAt: string | null;
}

export interface AgentControlChannel {
  kind: AgentControlChannelKind;
  enabled: boolean;
  status: "connected" | "not_connected" | "error";
  detail: string | null;
}

export interface AgentControlChannelPatch {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface AgentControlRoutine {
  id: string;
  name: string;
  schedule: string;
  timezone: string | null;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
}

export interface AgentControlRoutineInput {
  name: string;
  schedule: string;
  timezone?: string;
  prompt: string;
  enabled?: boolean;
}

export interface AgentControlPersona {
  displayName: string;
  title: string;
  description: string;
  instructions: string;
  instructionsPath: string | null;
  updatedAt: string | null;
}

export type AgentControlPersonaPatch = Partial<
  Pick<AgentControlPersona, "displayName" | "title" | "description" | "instructions">
>;

export interface AgentControlMemoryEntry {
  id: string;
  title: string;
  preview: string;
  updatedAt: string | null;
}

export interface AgentControlMemoryDoc {
  id: string;
  title: string;
  content: string;
  updatedAt: string | null;
}

export interface AgentControlKnowledgeFile {
  path: string;
  size: number | null;
  updatedAt: string | null;
}

export interface AgentControlKnowledgeDoc {
  path: string;
  content: string;
  size: number | null;
  updatedAt: string | null;
}

export interface AgentControlBrain {
  model: string;
  provider: string | null;
  availableModels: string[];
  memory: AgentControlMemoryEntry[];
  knowledge: AgentControlKnowledgeFile[];
}

export interface AgentControlView {
  agent: AgentControlAgent;
  channels: AgentControlChannel[];
  routines: AgentControlRoutine[];
  persona: AgentControlPersona;
  brain: AgentControlBrain;
  source: "live" | "snapshot";
  fetchedAt: string | null;
}

const base = (agentUid: string) => `/v1/agents/${encodeURIComponent(agentUid)}/control`;

export const AGENT_CONTROL_PATHS = {
  control: (agentUid: string) => base(agentUid),
  channels: (agentUid: string) => `${base(agentUid)}/channels`,
  channel: (agentUid: string, kind: AgentControlChannelKind) =>
    `${base(agentUid)}/channels/${encodeURIComponent(kind)}`,
  routines: (agentUid: string) => `${base(agentUid)}/routines`,
  routine: (agentUid: string, routineId: string) =>
    `${base(agentUid)}/routines/${encodeURIComponent(routineId)}`,
  runRoutine: (agentUid: string, routineId: string) =>
    `${base(agentUid)}/routines/${encodeURIComponent(routineId)}/run`,
  persona: (agentUid: string) => `${base(agentUid)}/persona`,
  brain: (agentUid: string) => `${base(agentUid)}/brain`,
  brainModel: (agentUid: string) => `${base(agentUid)}/brain/model`,
  memory: (agentUid: string) => `${base(agentUid)}/brain/memory`,
  memoryEntry: (agentUid: string, memoryId: string) =>
    `${base(agentUid)}/brain/memory/${encodeURIComponent(memoryId)}`,
  knowledge: (agentUid: string, path: string) =>
    `${base(agentUid)}/brain/knowledge?path=${encodeURIComponent(path)}`,
} as const;

/**
 * Every route answers JSON (an object, a list, or nothing). Values are
 * returned as the server sent them;
 * `@hq/ui`'s agent-control model reads them defensively, so a field the
 * backend renames shows as missing, never as a crash.
 */
export interface AgentControlApi {
  getControl(agentUid: string): AdapterPromise<unknown>;
  listChannels(agentUid: string): AdapterPromise<unknown>;
  updateChannel(
    agentUid: string,
    kind: AgentControlChannelKind,
    patch: AgentControlChannelPatch,
  ): AdapterPromise<unknown>;
  listRoutines(agentUid: string): AdapterPromise<unknown>;
  createRoutine(agentUid: string, input: AgentControlRoutineInput): AdapterPromise<unknown>;
  updateRoutine(
    agentUid: string,
    routineId: string,
    patch: Partial<AgentControlRoutineInput>,
  ): AdapterPromise<unknown>;
  deleteRoutine(agentUid: string, routineId: string): AdapterPromise<unknown>;
  runRoutine(agentUid: string, routineId: string): AdapterPromise<unknown>;
  getPersona(agentUid: string): AdapterPromise<unknown>;
  updatePersona(agentUid: string, patch: AgentControlPersonaPatch): AdapterPromise<unknown>;
  getBrain(agentUid: string): AdapterPromise<unknown>;
  setModel(agentUid: string, model: string): AdapterPromise<unknown>;
  createMemory(agentUid: string, input: { title?: string; content: string }): AdapterPromise<unknown>;
  getMemory(agentUid: string, memoryId: string): AdapterPromise<unknown>;
  updateMemory(agentUid: string, memoryId: string, content: string): AdapterPromise<unknown>;
  deleteMemory(agentUid: string, memoryId: string): AdapterPromise<unknown>;
  getKnowledge(agentUid: string, path: string): AdapterPromise<unknown>;
  putKnowledge(agentUid: string, path: string, content: string): AdapterPromise<unknown>;
  deleteKnowledge(agentUid: string, path: string): AdapterPromise<unknown>;
}

export type AgentControlMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One hq-pro request. `result` is the host's answer; on a non-2xx `status`
 * and `body` carry the refusal so the server's `{ error: { code, message } }`
 * reaches the caller. A transport failure has `status: null`.
 */
export type AgentControlRequest = (
  method: AgentControlMethod,
  path: string,
  body?: unknown,
) => Promise<{ result: AdapterResult<unknown>; status: number | null; body?: string }>;

/**
 * The failure for a refused control request. Reads the contract's
 * `{ error: { code, message } }`, and the older `{ code, error: "text" }`
 * shape other hq-pro routes send. The HTTP status rides along so callers can
 * tell a missing route (404) from a refusal.
 */
export function agentControlFailure(
  status: number | null,
  body: string,
  fallback: AdapterFailure,
): AdapterFailure {
  let rec: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = body ? JSON.parse(body) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      rec = parsed as Record<string, unknown>;
    }
  } catch {
    rec = null;
  }
  const nested =
    rec && rec.error && typeof rec.error === "object" && !Array.isArray(rec.error)
      ? (rec.error as Record<string, unknown>)
      : null;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const code =
    text(nested?.code) ?? text(rec?.code) ?? fallback.code ?? (status === null ? "http-error" : `http-${status}`);
  const message = text(nested?.message) ?? text(rec?.error) ?? text(rec?.message) ?? fallback.message;
  return {
    ...failure(code, message),
    ...(typeof status === "number" ? { status } : {}),
  };
}

/** A control request over a plain hq-pro REST transport (web, mobile, tests). */
export function agentControlRequestFromFetch(fetch: HqProFetch): AgentControlRequest {
  return async (method, path, body) => {
    let res: { status: number; text(): Promise<string> };
    try {
      res = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      console.warn("[agent-control] request failed", method, path, err);
      return { result: failure("network", "Could not reach HQ."), status: null };
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      return {
        result: failure(`http-${res.status}`, `${method} ${path} failed`),
        status: res.status,
        body: text,
      };
    }
    if (!text.trim()) return { result: ok(null), status: res.status };
    try {
      return { result: ok(JSON.parse(text) as unknown), status: res.status };
    } catch {
      return { result: failure("bad-json", "HQ sent an answer that could not be read."), status: res.status };
    }
  };
}

export function createAgentControlApi(request: AgentControlRequest): AgentControlApi {
  async function send(method: AgentControlMethod, path: string, body?: unknown): AdapterPromise<unknown> {
    const attempted = await request(method, path, body);
    if (attempted.result.ok) return attempted.result;
    if (attempted.status === null) return attempted.result;
    return agentControlFailure(attempted.status, attempted.body ?? "", attempted.result);
  }
  const P = AGENT_CONTROL_PATHS;
  return {
    getControl: (uid) => send("GET", P.control(uid)),
    listChannels: (uid) => send("GET", P.channels(uid)),
    updateChannel: (uid, kind, patch) => send("PATCH", P.channel(uid, kind), patch),
    listRoutines: (uid) => send("GET", P.routines(uid)),
    createRoutine: (uid, input) => send("POST", P.routines(uid), input),
    updateRoutine: (uid, id, patch) => send("PATCH", P.routine(uid, id), patch),
    deleteRoutine: (uid, id) => send("DELETE", P.routine(uid, id)),
    runRoutine: (uid, id) => send("POST", P.runRoutine(uid, id)),
    getPersona: (uid) => send("GET", P.persona(uid)),
    updatePersona: (uid, patch) => send("PUT", P.persona(uid), patch),
    getBrain: (uid) => send("GET", P.brain(uid)),
    setModel: (uid, model) => send("PATCH", P.brainModel(uid), { model }),
    createMemory: (uid, input) => send("POST", P.memory(uid), input),
    getMemory: (uid, id) => send("GET", P.memoryEntry(uid, id)),
    updateMemory: (uid, id, content) => send("PUT", P.memoryEntry(uid, id), { content }),
    deleteMemory: (uid, id) => send("DELETE", P.memoryEntry(uid, id)),
    getKnowledge: (uid, path) => send("GET", P.knowledge(uid, path)),
    putKnowledge: (uid, path, content) => send("PUT", P.knowledge(uid, path), { content }),
    deleteKnowledge: (uid, path) => send("DELETE", P.knowledge(uid, path)),
  };
}
