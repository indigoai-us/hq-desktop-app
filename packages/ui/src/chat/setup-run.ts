// Native setup run on #welcome — the pure half.
//
// "Run Setup" no longer sends the person to the Sessions page to watch
// "Ran 1 command" rows. The hero turns into a four-step card (Tools · HQ
// Cloud · About you · Your first moves) that ticks as the `/setup` agent
// moves along, shows one plain sentence of status, and renders each question
// the agent asks as a native card. This module is everything that does NOT
// touch a host: the step vocabulary, the interpretation of a session's event
// stream into card state, the resume record in localStorage, and the shape of
// the host-provided API the card drives.
//
// The host (apps/sync) owns the session engine. `packages/ui` is Tauri-free,
// so the event types below are a structural subset of the host's session
// events — whatever the host folds, it hands over as-is.
//
// Heuristics live here, in one place, with tests. The `/setup` skill can also
// emit an explicit marker line (`[hq-setup] step=<id> status=<running|done>`)
// which always wins over prose matching.

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type SetupRunStepId = "tools" | "cloud" | "import" | "you" | "connect" | "moves";

export interface SetupRunStep {
  id: SetupRunStepId;
  label: string;
}

/** The four steps, in order. Labels are product copy — do not paraphrase. */
export const SETUP_RUN_STEPS: readonly SetupRunStep[] = [
  { id: "tools", label: "Tools" },
  { id: "cloud", label: "HQ Cloud" },
  { id: "import", label: "Import" },
  { id: "you", label: "About you" },
  { id: "connect", label: "Connect" },
  { id: "moves", label: "Your first moves" },
];

export type SetupRunStepStatus = "pending" | "running" | "done";

// ---------------------------------------------------------------------------
// Events — structural subset of the host's session events
// ---------------------------------------------------------------------------

export interface SetupRunQuestionOption {
  label: string;
  description?: string | null;
}

export interface SetupRunStructuredQuestion {
  id: string;
  header?: string;
  text: string;
  options: SetupRunQuestionOption[];
  multiSelect?: boolean;
}

export type SetupRunEvent =
  | { kind: "assistantMessage"; text: string; parentToolUseId?: string | null }
  | { kind: "userMessage"; text: string }
  | { kind: "toolCall"; id?: string; name?: string; parentToolUseId?: string | null }
  | { kind: "toolResult"; id?: string; isError?: boolean }
  | { kind: "questionRequest"; requestId: string; questions: SetupRunStructuredQuestion[] }
  | { kind: "permissionRequest"; requestId: string; toolName?: string }
  | { kind: "turnDone"; status?: "success" | "error" | "interrupted"; error?: string | null }
  | { kind: "error"; message?: string }
  | { kind: "exited"; code?: number | null }
  | { kind: string };

export type SetupRunPhase = "starting" | "idle" | "working" | "needsYou" | "ended";

/** What the host hands the card on every change. */
export interface SetupRunSnapshot {
  sessionId: string;
  events: readonly SetupRunEvent[];
  phase: SetupRunPhase;
  /**
   * Request ids this client already answered. The engine emits no event when
   * a question or permission is answered, so without this a card would keep
   * asking until the agent's next word lands.
   */
  resolvedRequestIds?: readonly string[];
}

// ---------------------------------------------------------------------------
// Card state
// ---------------------------------------------------------------------------

export type SetupRunQuestion =
  | {
      kind: "choice";
      requestId: string;
      questionId: string;
      /** The skill's short header ("Import", "Integrations", "Secret"), when given. */
      header?: string;
      text: string;
      options: SetupRunQuestionOption[];
      multiSelect: boolean;
    }
  | { kind: "text"; text: string }
  | {
      kind: "permission";
      requestId: string;
      text: string;
    };

/** Why a run stopped early, in a shape the channel can act on. */
export interface SetupRunFailure {
  /** `auth`: the coding agent's sign-in is missing or expired — connect again. */
  kind: "auth" | "other";
  /** The engine's own words (kept for support; the channel says it plainly). */
  message: string;
}

const AUTH_FAILURE = /oauth|authenticat|not logged in|sign(ed)?[- ]in|log ?in\b|session expired|token|credential|api key/i;

/** Classify an error the engine surfaced (an `error` event or the agent's last words before exiting). */
export function classifySetupFailure(message: string): SetupRunFailure | null {
  const text = message.trim();
  if (!text) return null;
  return { kind: AUTH_FAILURE.test(text) ? "auth" : "other", message: text };
}

/** Plain copy for the channel when a run stops. */
export const SETUP_FAILURE_COPY = {
  auth: {
    title: "Setup paused — your coding agent needs to sign in again.",
    agent: "I couldn't continue: the sign-in for your coding agent has expired. Sign in again below and I'll pick up where we left off.",
  },
  other: {
    title: "Setup stopped before finishing",
    agent: "I hit a snag and had to stop. Run Setup to try again.",
  },
} as const;

export interface SetupRunState {
  /** Index into `SETUP_RUN_STEPS` of the step in progress (or last finished). */
  step: number;
  stepStatuses: Record<SetupRunStepId, SetupRunStepStatus>;
  /** One plain sentence under the current step; empty while nothing has been said. */
  statusLine: string;
  question: SetupRunQuestion | null;
  /** The guided component the skill asked for alongside the open question, if any. */
  card: SetupCard | null;
  /** Setup finished: the agent said so, or the last step was marked done. */
  done: boolean;
  /** The session stopped (exited / errored / ended phase) before finishing. */
  ended: boolean;
  /** Why it stopped, when the engine said; null for a clean finish or an unexplained stop. */
  failure: SetupRunFailure | null;
  /** Short closing line for the done state. */
  summary: string;
}

const STEP_INDEX: Record<SetupRunStepId, number> = { tools: 0, cloud: 1, import: 2, you: 3, connect: 4, moves: 5 };

/**
 * Prose → step. Ordered from the LAST step to the first so a sentence that
 * mentions two phases ("signed in; now let's get to know you") lands on the
 * later one. Each pattern is what the `/setup` skill actually says (seen in
 * the VM) — tune here, with the tests beside this file.
 */
const STEP_PATTERNS: readonly { id: SetupRunStepId; pattern: RegExp }[] = [
  { id: "moves", pattern: /welcome page|first moves?|first move:|you're all set|you are all set|handoff habit/i },
  { id: "connect", pattern: /connect (an? |your )?(app|system|integration)|systems? of record|hq integrations|api key|credential/i },
  {
    id: "you",
    pattern:
      /get to know you|about you|what'?s your name|what do you do|your goals for using hq|biggest challenges|systems of record|who you are/i,
  },
  { id: "import", pattern: /prior (ai|claude) (work|footprint|usage|artifacts)|import(ing)? (your|prior|existing)|import-context|import-claude|mine (your )?past/i },
  {
    id: "cloud",
    pattern: /hq cloud|signed in as|sign in to hq cloud|synced|sync(ing)? (is|has|your)|claim(ed|ing)? invites?|membership/i,
  },
  {
    id: "tools",
    pattern:
      /already in place|installer|install(ing|ed)? (the )?(missing|core|hq)|tools? (are|is) (actually )?reachable|checking (what|which|the) tools|dependenc(y|ies)|prerequisites?/i,
  },
];

/** `[hq-setup] step=<id> status=<running|done>` — the explicit marker the skill may emit. */
const MARKER = /\[hq-setup\]\s+step=(tools|cloud|you|import|connect|moves)(?:\s+status=(running|done))?/gi;

/**
 * `[hq-setup] card=<json>` — a guided component the skill asks the desktop
 * to render for its next question. Everything after `card=` to the end of
 * the line is the JSON object (the skill writes it on its own line).
 */
const CARD_MARKER = /\[hq-setup\]\s+card=(\{.*\})\s*$/gim;

const DONE_PATTERNS =
  /you'?re (all )?set\b|you are (all )?set\b|setup (is )?(done|complete|finished)|all set — here'?s your welcome page|hq is (now )?set up|setup complete/i;

/** Copy for the done card. */
export const SETUP_RUN_DONE = {
  title: "You’re set up",
  summary: "Tools, HQ Cloud, and your profile are in place. Your first moves are below.",
} as const;

/** Copy for a run that stopped before finishing. */
export const SETUP_RUN_STOPPED = {
  title: "Setup stopped before finishing",
  body: "Run Setup again to pick up where it left off.",
} as const;

/** Copy for the permission card (plain words, no tool or command text). */
export const SETUP_RUN_PERMISSION = {
  text: "Setup needs your OK to take its next step on this Mac.",
  allowOnce: "Allow",
  allowSession: "Allow for the rest of setup",
  deny: "Not now",
} as const;

/** Label for the resume affordance: "Continue setup (2 of 4)". */
export function setupRunContinueLabel(step: number): string {
  const n = Math.min(Math.max(step, 0), SETUP_RUN_STEPS.length - 1) + 1;
  return `Continue setup (${n} of ${SETUP_RUN_STEPS.length})`;
}

function emptyStatuses(): Record<SetupRunStepId, SetupRunStepStatus> {
  return { tools: "pending", cloud: "pending", import: "pending", you: "pending", connect: "pending", moves: "pending" };
}

// ---------------------------------------------------------------------------
// Guided cards — what the skill asks the desktop to draw for a question
// ---------------------------------------------------------------------------

/** "Here's what I found": counts the import scan turned up, shown with the Import question. */
export interface SetupFoundCard {
  kind: "found";
  title?: string;
  items: { label: string; count?: number | null; detail?: string | null }[];
}

export type SetupIntegrationAuth = "oauth" | "key" | "none";

/** Connectable apps, one tile each; the paired question is multi-select by app name. */
export interface SetupIntegrationsCard {
  kind: "integrations";
  items: {
    /** Catalog slug / entry id — informational; answers go back by `name`. */
    id?: string;
    name: string;
    description?: string | null;
    auth?: SetupIntegrationAuth;
    status?: "connected" | "available";
  }[];
}

/**
 * One credential to store. The desktop writes it straight into the vault
 * (`hq secrets set --from-stdin`) and answers the paired question "Done";
 * the value never enters the session.
 */
export interface SetupSecretCard {
  kind: "secret";
  /** Vault secret name, e.g. `DATABASE_URL`. */
  name: string;
  /** Plain label, e.g. "Postgres connection string". */
  label?: string | null;
  hint?: string | null;
  scope?: "personal" | "company";
  company?: string | null;
}

export type SetupCard = SetupFoundCard | SetupIntegrationsCard | SetupSecretCard;

/** Parse one `card=` payload; anything malformed is ignored (the plain question still shows). */
export function parseSetupCard(raw: string): SetupCard | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const card = value as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  switch (card.kind) {
    case "found": {
      const items = Array.isArray(card.items) ? card.items : [];
      const parsed = items
        .map((item) => {
          const entry = (item ?? {}) as Record<string, unknown>;
          const label = str(entry.label);
          if (!label) return null;
          const count = typeof entry.count === "number" && Number.isFinite(entry.count) ? entry.count : null;
          return { label, count, detail: str(entry.detail) || null };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
      return { kind: "found", title: str(card.title) || undefined, items: parsed };
    }
    case "integrations": {
      const items = Array.isArray(card.items) ? card.items : [];
      const parsed = items
        .map((item) => {
          const entry = (item ?? {}) as Record<string, unknown>;
          const name = str(entry.name);
          if (!name) return null;
          const auth = entry.auth === "oauth" || entry.auth === "key" || entry.auth === "none" ? entry.auth : undefined;
          const status = entry.status === "connected" ? "connected" : "available";
          return { id: str(entry.id) || undefined, name, description: str(entry.description) || null, auth, status } as const;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
      if (parsed.length === 0) return null;
      return { kind: "integrations", items: parsed };
    }
    case "secret": {
      const name = str(card.name);
      if (!/^[A-Za-z][A-Za-z0-9_./-]{0,127}$/.test(name)) return null;
      const scope = card.scope === "company" ? "company" : "personal";
      return {
        kind: "secret",
        name,
        label: str(card.label) || null,
        hint: str(card.hint) || null,
        scope,
        company: str(card.company) || null,
      };
    }
    default:
      return null;
  }
}

/** Strip markdown emphasis, code ticks, headings, and bullets from one line. */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .trim();
}

/** A line that is really a command, path, or link — never shown as status. */
function looksTechnical(line: string): boolean {
  return (
    /^\$\s|^[a-z0-9_-]+\s+--?[a-z]|^(npm|npx|pnpm|brew|hq|git|curl|bash|sh)\b/i.test(line) ||
    /https?:\/\//i.test(line) ||
    /^[\w./~-]+\/[\w./-]+$/.test(line) ||
    /\[hq-setup\]/i.test(line)
  );
}

/** First plain sentence of a message, capped, or "" when nothing qualifies. */
export function setupRunStatusSentence(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(plainLine)
    .filter((line) => line.length > 0 && !looksTechnical(line));
  for (const line of lines) {
    // A question is the card, not the status line.
    if (/\?\s*$/.test(line)) continue;
    const sentence = line.split(/(?<=[.!])\s+/)[0]?.trim() ?? "";
    if (!sentence) continue;
    return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}…` : sentence;
  }
  return "";
}

/** The last non-empty plain line of a message, when it is a question. */
export function setupRunTrailingQuestion(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map(plainLine)
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (!last || !/\?\s*$/.test(last)) return null;
  // A numbered list of questions is the skill's own prose, not a prompt to
  // answer — the agent asks them one at a time afterwards.
  return last.replace(/\s+/g, " ");
}

/**
 * Fold a session's events (oldest first) into the card's state. Pure; safe on
 * partial or out-of-order-looking streams — unknown kinds are ignored.
 */
export function interpretSetupRun(
  events: readonly SetupRunEvent[],
  phase: SetupRunPhase = "working",
  resolvedRequestIds: readonly string[] = [],
): SetupRunState {
  const statuses = emptyStatuses();
  const resolved = new Set(resolvedRequestIds);
  let step = 0;
  let touched = false;
  let statusLine = "";
  let done = false;
  let exited = false;
  let errored = false;
  /** The last error text the engine surfaced (an error event, or a turn that ended in error). */
  let lastError = "";

  /** The latest open request (question/permission) and the latest assistant words. */
  let pendingRequest:
    | { kind: "question"; requestId: string; questions: SetupRunStructuredQuestion[] }
    | { kind: "permission"; requestId: string }
    | null = null;
  let lastAssistant: string | null = null;
  /** The latest card marker; it rides with the next request and clears once work resumes. */
  let card: SetupCard | null = null;
  /** Did anything happen after the last assistant message? A user turn clears a text question. */
  let assistantIsLatest = false;
  /** The turn ended after the latest assistant words — the agent is waiting on the person. */
  let turnDoneSinceAssistant = false;

  const advanceTo = (id: SetupRunStepId, status: "running" | "done") => {
    const index = STEP_INDEX[id];
    touched = true;
    if (index < step) return; // never move backwards
    if (index > step) {
      for (let i = 0; i < index; i += 1) statuses[SETUP_RUN_STEPS[i]!.id] = "done";
      step = index;
    }
    if (status === "running") {
      if (statuses[id] !== "done") statuses[id] = "running";
      return;
    }
    statuses[id] = "done";
    if (index < SETUP_RUN_STEPS.length - 1) {
      step = index + 1;
      statuses[SETUP_RUN_STEPS[step]!.id] = "running";
    }
  };

  for (const event of events) {
    switch (event.kind) {
      case "assistantMessage": {
        const text = String((event as { text?: unknown }).text ?? "");
        if ((event as { parentToolUseId?: unknown }).parentToolUseId) break; // sub-agent chatter
        if (!text.trim()) break;
        lastAssistant = text;
        assistantIsLatest = true;
        turnDoneSinceAssistant = false;
        pendingRequest = null;

        for (const match of text.matchAll(CARD_MARKER)) {
          const parsed = parseSetupCard(match[1]!);
          if (parsed) card = parsed;
        }

        let marked = false;
        for (const match of text.matchAll(MARKER)) {
          marked = true;
          advanceTo(match[1]!.toLowerCase() as SetupRunStepId, match[2]?.toLowerCase() === "done" ? "done" : "running");
        }
        if (!marked) {
          const hit = STEP_PATTERNS.find((entry) => entry.pattern.test(text));
          if (hit) advanceTo(hit.id, "running");
        }
        if (DONE_PATTERNS.test(text)) done = true;
        const sentence = setupRunStatusSentence(text);
        if (sentence) statusLine = sentence;
        break;
      }
      case "questionRequest": {
        const request = event as { requestId?: unknown; questions?: unknown };
        const requestId = String(request.requestId ?? "");
        const questions = Array.isArray(request.questions)
          ? (request.questions as SetupRunStructuredQuestion[])
          : [];
        assistantIsLatest = false;
        pendingRequest = resolved.has(requestId) ? null : { kind: "question", requestId, questions };
        // A structured question about the person is the "About you" step.
        const asked = questions.map((question) => `${question.header ?? ""} ${question.text ?? ""}`).join("\n");
        if (!touched) {
          const hit = STEP_PATTERNS.find((entry) => entry.pattern.test(asked));
          if (hit) advanceTo(hit.id, "running");
        }
        break;
      }
      case "permissionRequest": {
        const requestId = String((event as { requestId?: unknown }).requestId ?? "");
        assistantIsLatest = false;
        pendingRequest = resolved.has(requestId) ? null : { kind: "permission", requestId };
        break;
      }
      case "userMessage":
        assistantIsLatest = false;
        pendingRequest = null;
        card = null;
        break;
      case "toolCall":
      case "toolResult": {
        // Work resumed: whatever was asked has been answered.
        assistantIsLatest = false;
        pendingRequest = null;
        // The question itself arrives as a tool call (AskUserQuestion) right
        // after the card marker — that is the card's own question, not work
        // resuming, so the card must survive it.
        const toolName = String((event as { name?: unknown }).name ?? "");
        if (event.kind !== "toolCall" || !/askuserquestion/i.test(toolName)) card = null;
        if (!touched) advanceTo("tools", "running");
        break;
      }
      case "turnDone": {
        const status = (event as { status?: unknown }).status;
        if (status === "error") {
          errored = true;
          const detail = String((event as { error?: unknown }).error ?? "").trim();
          if (detail) lastError = detail;
          else if (lastAssistant) lastError = lastAssistant;
        }
        if (assistantIsLatest) turnDoneSinceAssistant = true;
        break;
      }
      case "error": {
        errored = true;
        const message = String((event as { message?: unknown }).message ?? "").trim();
        if (message) lastError = message;
        break;
      }
      case "exited":
        exited = true;
        break;
      default:
        break;
    }
  }

  if (done) {
    for (const entry of SETUP_RUN_STEPS) statuses[entry.id] = "done";
    step = SETUP_RUN_STEPS.length - 1;
  } else if (!touched && (phase === "starting" || phase === "working" || phase === "idle" || phase === "needsYou")) {
    statuses.tools = "running";
  }

  const ended = !done && (exited || phase === "ended" || (errored && phase !== "working"));
  // An agent that exits right after reporting a problem in prose: that prose is the reason.
  const failure = ended ? classifySetupFailure(lastError || (errored || exited ? (lastAssistant ?? "") : "")) : null;

  let question: SetupRunQuestion | null = null;
  if (!done && !ended) {
    if (pendingRequest?.kind === "question") {
      const first = pendingRequest.questions[0];
      if (first && Array.isArray(first.options) && first.options.length > 0) {
        question = {
          kind: "choice",
          requestId: pendingRequest.requestId,
          questionId: String(first.id ?? ""),
          header: String(first.header ?? "").trim() || undefined,
          text: plainLine(String(first.text ?? first.header ?? "")),
          options: first.options.map((option) => ({
            label: String(option.label ?? ""),
            description: option.description ?? null,
          })),
          multiSelect: Boolean(first.multiSelect),
        };
      } else if (first) {
        // A structured question without options is a free-text one; the
        // answer still goes back through the request so the agent unblocks.
        question = {
          kind: "choice",
          requestId: pendingRequest.requestId,
          questionId: String(first.id ?? ""),
          text: plainLine(String(first.text ?? first.header ?? "")),
          options: [],
          multiSelect: false,
        };
      }
    } else if (pendingRequest?.kind === "permission") {
      question = { kind: "permission", requestId: pendingRequest.requestId, text: SETUP_RUN_PERMISSION.text };
    } else if (
      assistantIsLatest &&
      lastAssistant &&
      (turnDoneSinceAssistant || phase === "idle" || phase === "needsYou")
    ) {
      const trailing = setupRunTrailingQuestion(lastAssistant);
      if (trailing) question = { kind: "text", text: trailing };
    }
  }

  // A card only means something while the agent is waiting on the person;
  // an answered secret / import card must not linger over the next step.
  const cardShown = !done && !ended && question !== null && question.kind !== "permission" ? card : null;

  return {
    step,
    stepStatuses: statuses,
    statusLine: done ? SETUP_RUN_DONE.summary : statusLine,
    question,
    card: cardShown,
    done,
    ended,
    failure,
    summary: done ? SETUP_RUN_DONE.summary : "",
  };
}

// ---------------------------------------------------------------------------
// Resume record
// ---------------------------------------------------------------------------

/**
 * The setup session on this machine and how it ended. A `running` record makes
 * a relaunch (or a trip to another channel) pick the run back up; `done` and
 * `ended` keep the card's outcome on #welcome instead of snapping back to a
 * fresh Run Setup. Namespaced beside `hq.welcome.setup-run.v1` (the
 * graduation flag).
 */
export const SETUP_RUN_SESSION_KEY = "hq.welcome.setup-run-session.v1";

export type SetupRunRecordStatus = "running" | "done" | "ended";

export interface SetupRunRecord {
  sessionId: string;
  /** Last known step index, for the resume label before re-attaching. */
  step: number;
  /** Defaults to `running` for records written before outcomes were kept. */
  status: SetupRunRecordStatus;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storageOf(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadSetupRunRecord(storage?: StorageLike | null): SetupRunRecord | null {
  try {
    const raw = storageOf(storage)?.getItem(SETUP_RUN_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sessionId?: unknown; step?: unknown; status?: unknown };
    if (typeof parsed?.sessionId !== "string" || !parsed.sessionId.trim()) return null;
    const step = typeof parsed.step === "number" && Number.isFinite(parsed.step) ? parsed.step : 0;
    const status: SetupRunRecordStatus =
      parsed.status === "done" || parsed.status === "ended" ? parsed.status : "running";
    return {
      sessionId: parsed.sessionId,
      step: Math.min(Math.max(Math.floor(step), 0), SETUP_RUN_STEPS.length - 1),
      status,
    };
  } catch {
    return null;
  }
}

export function saveSetupRunRecord(record: SetupRunRecord, storage?: StorageLike | null): void {
  try {
    storageOf(storage)?.setItem(SETUP_RUN_SESSION_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable: the run simply is not resumable after a relaunch.
  }
}

export function clearSetupRunRecord(storage?: StorageLike | null): void {
  try {
    storageOf(storage)?.removeItem(SETUP_RUN_SESSION_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Host API
// ---------------------------------------------------------------------------

export interface SetupRunAnswer {
  questionId: string;
  values: string[];
}

export type SetupRunPermissionDecision = "allowOnce" | "allowSession" | "deny";

/** What a preflight says about running setup natively on this Mac. */
export type SetupRunReadiness = "ready" | "needs-sessions-page";

/**
 * The guided-run seam a host provides on `extraPages.sessions.setupRun`. Built
 * in apps/sync on the live session store; `packages/ui` only calls it.
 */
/** Which coding agents this Mac can run setup with. */
export interface SetupProviderStatus {
  /** The HQ `.claude` layer is in place (skills, hooks) — nothing to repair. */
  hqReady: boolean;
  claudeAvailable: boolean;
  claudeLoggedIn: boolean;
  codexAvailable: boolean;
  codexLoggedIn: boolean;
}

export type SetupProviderTool = "claude" | "codex";

export interface SetupProviderLoginState {
  state: "disconnected" | "waiting" | "connected" | "error";
  message?: string;
}

/** True when at least one signed-in agent can run setup here. */
export function setupProvidersReady(status: SetupProviderStatus | null | undefined): boolean {
  if (!status || !status.hqReady) return false;
  return (status.claudeAvailable && status.claudeLoggedIn) || (status.codexAvailable && status.codexLoggedIn);
}

export interface SetupRunApi {
  /**
   * Which agents are installed / signed in on this Mac. Optional: hosts
   * without it skip the Connect step and rely on `preflight` alone.
   */
  providers?(refresh?: boolean): Promise<SetupProviderStatus>;
  /** Open the provider's browser sign-in; poll `providerLoginStatus` until connected. */
  providerLoginStart?(tool: SetupProviderTool): Promise<SetupProviderLoginState>;
  providerLoginStatus?(tool: SetupProviderTool): Promise<SetupProviderLoginState>;
  providerLoginCancel?(tool: SetupProviderTool): Promise<SetupProviderLoginState>;
  /** Where to get the provider's app; opened in the system browser by the host. */
  providerInstallUrl?(tool: SetupProviderTool): string;
  openExternal?(url: string): Promise<void>;
  /**
   * Can the run start here, or must the Sessions page's Connect / self-heal
   * UI go first? The card never duplicates that UI — it falls back to opening
   * the Sessions page as before.
   */
  preflight(): Promise<SetupRunReadiness>;
  /** Start a fresh session and send `prompt` (`/setup`). Resolves to the session id. */
  start(prompt: string): Promise<string>;
  /** Re-open an existing session by id; false when the engine no longer has it. */
  attach(sessionId: string): Promise<boolean>;
  /** Observe one session; fires with the current snapshot at once, then on every change. */
  subscribe(sessionId: string, cb: (snapshot: SetupRunSnapshot) => void): () => void;
  /** Answer a structured question the agent parked. */
  answerQuestion(sessionId: string, requestId: string, answers: SetupRunAnswer[]): Promise<void>;
  /** Answer a permission request the agent parked. */
  respondPermission(sessionId: string, requestId: string, decision: SetupRunPermissionDecision): Promise<void>;
  /** Send a plain user turn (a free-text answer). */
  send(sessionId: string, text: string): Promise<void>;
  /**
   * Store a credential the secret card collected, straight into the vault.
   * The value goes from the field to `hq secrets set --from-stdin` and is
   * never sent to the session. Optional: hosts without it show the plain
   * question instead of the card.
   */
  storeSecret?(card: SetupSecretCard, value: string): Promise<void>;
}
