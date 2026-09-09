// The Setup Agent: the guided `/setup` run as a conversation in #welcome.
//
// One object owns the run (start / re-attach / answer / finish) and exposes
// it two ways: a stepper for the hero, and a transcript of plain turns the
// channel renders as messages from "Setup Agent" and the person. The channel
// composer replies to it like any other conversation; structured questions,
// permission asks, and guided cards surface as a prompt under the messages.
//
// Runes-based so both the hero and the shell react to the same run without
// prop-drilling snapshots. No `$effect` here: the resume record is kept in
// the subscription callback so the object works outside a component too.

import {
  interpretSetupRun,
  loadSetupRunRecord,
  saveSetupRunRecord,
  SETUP_RUN_STEPS,
  setupProvidersReady,
  type SetupProviderStatus,
  type SetupRunApi,
  type SetupRunPermissionDecision,
  type SetupRunSnapshot,
  type SetupRunState,
  type SetupSecretCard,
} from "./setup-run";
import { SETUP_GUIDED_PROMPT } from "./setup-channel";

export type SetupAgentMode = "idle" | "starting" | "live" | "resume" | "stopped" | "done";

/** One turn of the conversation as the channel shows it. */
export interface SetupAgentTurn {
  /** Stable per session: `setup:<sessionId>:<eventIndex>`. */
  id: string;
  role: "agent" | "user";
  text: string;
  /** Event index, for ordering and for a stable synthetic timestamp. */
  seq: number;
}

export const SETUP_AGENT_NAME = "Setup Agent";
/** An `agt_` id so the channel draws it with the agent identity mark. */
export const SETUP_AGENT_UID = "agt_setup-agent";

export interface SetupAgentHooks {
  /** A run started or finished — the host graduates welcome-first boot. */
  onstarted?: () => void;
  onfinished?: () => void;
}

/** `[hq-setup] …` marker lines (optionally back-ticked) are protocol, never prose. */
const MARKER_LINE = /^\s*`?\[hq-setup\][^\n]*`?\s*$/gm;
const MARKER_INLINE = /`?\[hq-setup\]\s+(?:step|card)=[^`\n]*`?/g;

/** Strip protocol markers and tidy whitespace; "" when nothing is left. */
export function setupAgentProse(text: string): string {
  return text
    .replace(MARKER_LINE, "")
    .replace(MARKER_INLINE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The person's own words, minus the launch command that started the run. */
function isLaunchPrompt(text: string): boolean {
  return /^\/setup(?:\s|$)/.test(text.trim());
}

/**
 * Answers to structured questions and permission asks go back through the
 * request, not as a user turn, so the engine never echoes them. The store
 * records them here (keyed by the request id) and the transcript places
 * each right after the request it answered — the person sees what they said.
 */
export type SetupAgentAnswers = ReadonlyMap<string, string>;

/** The transcript cache: what the channel showed, so leaving and coming back (or relaunching) keeps it. */
export const SETUP_AGENT_TRANSCRIPT_KEY = "hq.welcome.setup-run-transcript.v1";

interface TranscriptCache {
  sessionId: string;
  turns: SetupAgentTurn[];
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadTranscriptCache(sessionId: string): SetupAgentTurn[] {
  try {
    const raw = storage()?.getItem(SETUP_AGENT_TRANSCRIPT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<TranscriptCache>;
    if (parsed.sessionId !== sessionId || !Array.isArray(parsed.turns)) return [];
    return parsed.turns.filter(
      (turn): turn is SetupAgentTurn =>
        Boolean(turn) && typeof turn.id === "string" && (turn.role === "agent" || turn.role === "user") && typeof turn.text === "string",
    );
  } catch {
    return [];
  }
}

export function saveTranscriptCache(sessionId: string, turns: readonly SetupAgentTurn[]): void {
  try {
    storage()?.setItem(SETUP_AGENT_TRANSCRIPT_KEY, JSON.stringify({ sessionId, turns: [...turns] } satisfies TranscriptCache));
  } catch {
    // Storage unavailable: the transcript simply is not kept across a relaunch.
  }
}

export function setupAgentTranscript(
  sessionId: string,
  events: SetupRunSnapshot["events"],
  answers: SetupAgentAnswers = new Map(),
): SetupAgentTurn[] {
  const turns: SetupAgentTurn[] = [];
  events.forEach((event, seq) => {
    if (event.kind === "questionRequest" || event.kind === "permissionRequest") {
      const requestId = String((event as { requestId?: unknown }).requestId ?? "");
      const text = answers.get(requestId);
      if (text) turns.push({ id: `setup:${sessionId}:${seq}:answer`, role: "user", text, seq });
      return;
    }
    if (event.kind === "assistantMessage") {
      if ((event as { parentToolUseId?: unknown }).parentToolUseId) return; // sub-agent chatter
      const text = setupAgentProse(String((event as { text?: unknown }).text ?? ""));
      if (!text) return;
      const last = turns[turns.length - 1];
      // Streaming re-emits a growing message: replace rather than duplicate.
      if (last && last.role === "agent" && last.seq === seq - 1 && text.startsWith(last.text)) {
        turns[turns.length - 1] = { ...last, text, seq };
        return;
      }
      turns.push({ id: `setup:${sessionId}:${seq}`, role: "agent", text, seq });
    } else if (event.kind === "userMessage") {
      const text = String((event as { text?: unknown }).text ?? "").trim();
      if (!text || isLaunchPrompt(text)) return;
      turns.push({ id: `setup:${sessionId}:${seq}`, role: "user", text, seq });
    }
  });
  return turns;
}

export class SetupAgent {
  readonly api: SetupRunApi | null;
  /** Plain flag the derived fields read (class fields initialise in order). */
  private readonly hasApi: boolean;
  private hooks: SetupAgentHooks;
  private unsubscribe: (() => void) | null = null;
  private finished = false;

  mode = $state<SetupAgentMode>("idle");
  sessionId = $state<string | null>(null);
  snapshot = $state<SetupRunSnapshot | null>(null);
  resumeStep = $state(0);
  busy = $state(false);
  error = $state<string | null>(null);
  /** Which agents this Mac can run setup with; null until the host answers. */
  providers = $state<SetupProviderStatus | null>(null);
  /** Answers given through requests (chips, typed replies to choices, permissions), by request id. */
  answers = $state<Map<string, string>>(new Map());
  /** What the channel showed last time, when the engine no longer has the session. */
  private cachedTurns = $state<SetupAgentTurn[]>([]);

  readonly state: SetupRunState | null;
  /** A run exists (live, remembered, or finished): the hero shows the stepper, the channel the agent. */
  readonly active: boolean;
  /** The composer talks to the agent instead of the channel. */
  readonly listening: boolean;
  readonly transcript: SetupAgentTurn[];
  /** A signed-in agent is available, or the host cannot tell (then preflight decides). */
  readonly providersReady: boolean;

  constructor(api: SetupRunApi | null, hooks: SetupAgentHooks = {}) {
    this.api = api;
    this.hasApi = api !== null;
    this.hooks = hooks;
    // Derived after `api` is set: class field initialisers run before the
    // constructor body, so they cannot read it.
    this.state = $derived(
      this.snapshot
        ? interpretSetupRun(this.snapshot.events, this.snapshot.phase, this.snapshot.resolvedRequestIds ?? [])
        : null,
    );
    this.active = $derived(this.hasApi && this.mode !== "idle");
    this.listening = $derived(
      this.mode === "live" && this.state !== null && !this.state.done && !this.state.ended,
    );
    this.transcript = $derived.by(() => {
      const live = this.snapshot ? setupAgentTranscript(this.snapshot.sessionId, this.snapshot.events, this.answers) : [];
      return live.length > 0 ? live : this.cachedTurns;
    });
    this.providersReady = $derived(this.providers === null ? true : setupProvidersReady(this.providers));
    if (!api) return;
    void this.refreshProviders();
    // Coming back to #welcome (or relaunching) lands here with the run
    // remembered: finished stays finished, an early exit stays paused, and a
    // run still going re-attaches on its own. The conversation comes back
    // with it — from the engine when it still has the session, else from
    // what the channel showed last time.
    const record = loadSetupRunRecord();
    if (record) {
      this.sessionId = record.sessionId;
      this.resumeStep = record.step;
      this.mode = record.status === "done" ? "done" : record.status === "ended" ? "stopped" : "resume";
      this.cachedTurns = loadTranscriptCache(record.sessionId);
      if (record.status === "done") this.finished = true;
      if (record.status === "running") void this.continueRun();
      else void this.restoreTranscript();
    }
  }

  /** Ask the host which agents are ready; harmless when it cannot say. */
  async refreshProviders(refresh = false): Promise<void> {
    if (!this.api?.providers) return;
    try {
      this.providers = await this.api.providers(refresh);
    } catch {
      this.providers = null;
    }
  }

  /** A finished / paused run: re-attach quietly so its transcript renders from the engine. */
  private async restoreTranscript(): Promise<void> {
    const api = this.api;
    const sessionId = this.sessionId;
    if (!api || !sessionId) return;
    try {
      if (await api.attach(sessionId)) this.watch(sessionId);
    } catch {
      // The cache already covers it.
    }
  }

  private watch(sessionId: string): void {
    if (!this.api) return;
    this.unsubscribe?.();
    this.unsubscribe = this.api.subscribe(sessionId, (snapshot) => {
      if (snapshot.sessionId !== this.sessionId) return;
      this.snapshot = snapshot;
      this.keepRecord();
      const turns = setupAgentTranscript(snapshot.sessionId, snapshot.events, this.answers);
      if (turns.length > 0) saveTranscriptCache(snapshot.sessionId, turns);
    });
  }

  /** Resume record follows the run; finishing fires the host hook once. */
  private keepRecord(): void {
    const state = this.state;
    const sessionId = this.sessionId;
    if (!state || !sessionId || this.mode !== "live") return;
    if (state.done) {
      if (!this.finished) {
        this.finished = true;
        saveSetupRunRecord({ sessionId, step: SETUP_RUN_STEPS.length - 1, status: "done" });
        this.hooks.onfinished?.();
      }
      return;
    }
    if (state.ended) {
      saveSetupRunRecord({ sessionId, step: state.step, status: "ended" });
      return;
    }
    saveSetupRunRecord({ sessionId, step: state.step, status: "running" });
  }

  /**
   * Start a fresh guided run. Resolves `needs-sessions-page` when the host's
   * preflight says the Sessions page (Connect / self-heal) must go first —
   * the caller opens it; nothing is duplicated here.
   */
  async start(): Promise<"started" | "needs-sessions-page" | "busy"> {
    const api = this.api;
    if (!api) return "needs-sessions-page";
    if (this.busy) return "busy";
    this.busy = true;
    this.error = null;
    try {
      const readiness = await api.preflight();
      if (readiness !== "ready") return "needs-sessions-page";
      this.mode = "starting";
      const sessionId = await api.start(SETUP_GUIDED_PROMPT);
      this.finished = false;
      this.sessionId = sessionId;
      this.answers = new Map();
      this.cachedTurns = [];
      this.snapshot = { sessionId, events: [], phase: "starting" };
      saveSetupRunRecord({ sessionId, step: 0, status: "running" });
      this.watch(sessionId);
      this.mode = "live";
      this.hooks.onstarted?.();
      return "started";
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      if (this.mode === "starting") this.mode = "idle";
      return "needs-sessions-page";
    } finally {
      this.busy = false;
    }
  }

  async continueRun(): Promise<void> {
    const api = this.api;
    const sessionId = this.sessionId;
    if (!api || this.busy || !sessionId) return;
    this.busy = true;
    this.error = null;
    try {
      const attached = await api.attach(sessionId);
      if (!attached) {
        saveSetupRunRecord({ sessionId, step: this.resumeStep, status: "ended" });
        this.mode = "stopped";
        return;
      }
      this.finished = false;
      this.watch(sessionId);
      this.mode = "live";
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  async runAgain(): Promise<"started" | "needs-sessions-page" | "busy"> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.snapshot = null;
    this.sessionId = null;
    this.mode = "idle";
    return this.start();
  }

  private async withRun(action: (api: SetupRunApi, sessionId: string) => Promise<void>): Promise<void> {
    const api = this.api;
    const sessionId = this.sessionId;
    if (!api || !sessionId || this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      await action(api, sessionId);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  private recordAnswer(requestId: string, text: string): void {
    const next = new Map(this.answers);
    next.set(requestId, text);
    this.answers = next;
    const snapshot = this.snapshot;
    if (snapshot) saveTranscriptCache(snapshot.sessionId, setupAgentTranscript(snapshot.sessionId, snapshot.events, next));
  }

  answerChoice(requestId: string, questionId: string, values: string[]): Promise<void> {
    this.recordAnswer(requestId, values.join(", "));
    return this.withRun((api, sessionId) => api.answerQuestion(sessionId, requestId, [{ questionId, values }]));
  }

  answerPermission(requestId: string, decision: SetupRunPermissionDecision): Promise<void> {
    this.recordAnswer(
      requestId,
      decision === "deny" ? "Not now" : decision === "allowSession" ? "Allowed for the rest of setup" : "Allowed",
    );
    return this.withRun((api, sessionId) => api.respondPermission(sessionId, requestId, decision));
  }

  send(text: string): Promise<void> {
    return this.withRun((api, sessionId) => api.send(sessionId, text));
  }

  /**
   * What the channel composer does while the agent is listening: a typed
   * reply answers an open structured question (the CLI's "Other"), otherwise
   * it is the next user turn.
   */
  reply(text: string): Promise<void> {
    const question = this.state?.question;
    if (question && question.kind === "choice") {
      return this.answerChoice(question.requestId, question.questionId, [text]);
    }
    return this.send(text);
  }

  /** Secret card → vault, never the session. Errors surface in the card. */
  async storeSecret(card: SetupSecretCard, value: string): Promise<void> {
    if (!this.api?.storeSecret) throw new Error("This host cannot store secrets.");
    await this.api.storeSecret(card, value);
  }

  get canStoreSecrets(): boolean {
    return typeof this.api?.storeSecret === "function";
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
