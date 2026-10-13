/**
 * Shared state for one rendered brief: the peek card, the chosen engine,
 * locally cleared items, and the launch seam. Widgets read it from context.
 */

import { getContext, setContext } from "svelte";
import { placePeek } from "./brief-layout.js";
import type { BriefLine } from "./brief-types.js";
import { loadSenderDms, type BriefDmApi, type BriefDmLoad } from "./brief-dms.js";

export type BriefEngine = "claude" | "codex" | "grok";
export const ENGINES: { id: BriefEngine; label: string; short: string }[] = [
  { id: "claude", label: "Claude", short: "CL" },
  { id: "codex", label: "Codex", short: "CX" },
  { id: "grok", label: "Grok", short: "GR" },
];

/** Opens a session in the engine with the prompt pre-filled; resolves to an error message or null. */
export type BriefLaunch = (engine: BriefEngine, prompt: string) => Promise<string | null>;

export interface PeekContent {
  title: string;
  status?: string;
  sections: { label: string; tone?: string; text?: string; lines?: BriefLine[] }[];
  /** Illustrative content with no real source yet. */
  sample?: boolean;
  /** Actionable items show their full prompt and the launch controls. */
  prompt?: { id: string; text: string; /** Button verb in compact cards: "Resume in Claude". */ verb?: string };
  /**
   * Compact card (session dots): eyebrow and origin chip on one line, the
   * title, the status line, then two pill buttons (<verb> in <engine>, Copy
   * prompt). No prompt text, no engine switcher.
   */
  compact?: boolean;
  /** Small mono line above the title, e.g. "Session · Oct 8". */
  eyebrow?: string;
  /** Company logo chip beside the eyebrow, e.g. "Indigo · sessions". */
  origin?: { companyUid: string | null; label: string };
  /** Buttons under the peek (e.g. Open in Meetings). */
  actions?: { label: string; run: () => void; testid?: string }[];
  /** A person or agent: the peek lists their recent DMs, read live. */
  dms?: { uid: string; name: string; isAgent: boolean };
}

export interface BriefCompanyLogo {
  uid: string;
  /** Company slug, when the host has it ("indigo"). */
  slug?: string | null;
  label: string;
  iconUrl?: string | null;
}

const ENGINE_KEY = "hq.brief.engine";
const KEY = Symbol("daily-brief");

/** Copy text to the clipboard. Resolves false when the host refuses. */
export async function copyBriefPrompt(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.warn("[daily-brief] copy prompt failed", err);
    return false;
  }
}

/**
 * Launch stub for hosts with no session launcher (web, harness): the prompt
 * goes to the clipboard and the person pastes it into the engine.
 */
export async function launchBriefPromptViaClipboard(engine: BriefEngine, prompt: string): Promise<string | null> {
  const label = ENGINES.find((e) => e.id === engine)?.label ?? engine;
  return (await copyBriefPrompt(prompt))
    ? `Prompt copied. Paste it into ${label}.`
    : "Could not copy the prompt.";
}

export class BriefState {
  /** `anchorTop` is the hovered thing's top; the peek measures itself and keeps on screen (peekTop). */
  peek = $state<{ content: PeekContent; x: number; anchorTop: number; side: "r" | "l" } | null>(null);
  engine = $state<BriefEngine>("claude");
  cleared = $state<Record<string, boolean>>({});
  notes = $state<Record<string, string>>({});
  ripple = $state(0);
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;

  /** Each sender's recent DMs, loaded on demand and kept for this brief. */
  dms = $state<Record<string, BriefDmLoad>>({});

  constructor(
    readonly launch: BriefLaunch,
    readonly companies: () => readonly BriefCompanyLogo[],
    readonly links: {
      dmApi?: () => BriefDmApi | null | undefined;
      openThread?: () => ((uid: string) => void) | undefined;
    } = {},
  ) {
    try {
      const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(ENGINE_KEY);
      if (saved === "claude" || saved === "codex" || saved === "grok") this.engine = saved;
    } catch {
      // Storage refused: keep the default engine.
    }
  }

  /** Load a sender's DMs once; again after an error or when forced. */
  async loadDms(uid: string, force = false): Promise<void> {
    const cur = this.dms[uid];
    if (cur && !force && cur.state !== "error") return;
    this.dms = { ...this.dms, [uid]: { state: "loading" } };
    const next = await loadSenderDms(this.links.dmApi?.(), uid);
    this.dms = { ...this.dms, [uid]: next };
  }

  /** The host can open a DM in Messages. */
  get canOpenThread(): boolean {
    return !!this.links.openThread?.();
  }

  openThread(uid: string): void {
    this.links.openThread?.()?.(uid);
  }

  setEngine(engine: BriefEngine): void {
    this.engine = engine;
    try {
      localStorage.setItem(ENGINE_KEY, engine);
    } catch {
      // Not persisted; the choice still holds for this brief.
    }
  }

  /** A company by uid, slug or name (brief files name companies by slug). */
  company(uid: string | null): BriefCompanyLogo | null {
    if (!uid) return null;
    const key = uid.trim().toLowerCase();
    const all = this.companies();
    return (
      all.find((c) => c.uid === uid) ??
      all.find((c) => c.slug?.toLowerCase() === key || c.label.trim().toLowerCase() === key) ??
      null
    );
  }

  /** Mark an item done in this brief only. Nothing is sent anywhere. */
  clear(id: string): void {
    if (this.cleared[id]) return;
    this.cleared = { ...this.cleared, [id]: true };
    this.ripple += 1;
  }

  async start(id: string, prompt: string): Promise<void> {
    const error = await this.launch(this.engine, prompt);
    this.notes = { ...this.notes, [id]: error ?? `Started in ${ENGINES.find((e) => e.id === this.engine)!.label}.` };
    if (!error || error.startsWith("Prompt copied")) this.clear(id);
  }

  showPeek(anchor: HTMLElement, content: PeekContent): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.showTimer) clearTimeout(this.showTimer);
    this.showTimer = setTimeout(() => {
      const r = anchor.getBoundingClientRect();
      // The card or top-section panel the hovered thing sits in: its peeks share one column.
      const zone = anchor.closest<HTMLElement>(".slot, .b-top > *")?.getBoundingClientRect() ?? null;
      const at = placePeek(r, zone, { w: window.innerWidth, h: window.innerHeight });
      this.peek = { content, ...at };
    }, 220);
  }

  hidePeekSoon(): void {
    if (this.showTimer) clearTimeout(this.showTimer);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => (this.peek = null), 160);
  }

  keepPeek(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
  }
}

export function provideBrief(state: BriefState): void {
  setContext(KEY, state);
}

export function useBrief(): BriefState {
  return getContext<BriefState>(KEY);
}

/** `use:peek` for anything with more behind it. */
export function peek(node: HTMLElement, args: { state: BriefState; content: () => PeekContent }) {
  let current = args;
  const enter = () => current.state.showPeek(node, current.content());
  const leave = () => current.state.hidePeekSoon();
  node.addEventListener("mouseenter", enter);
  node.addEventListener("mouseleave", leave);
  node.addEventListener("focusin", enter);
  node.addEventListener("focusout", leave);
  return {
    update(next: typeof args) {
      current = next;
    },
    destroy() {
      node.removeEventListener("mouseenter", enter);
      node.removeEventListener("mouseleave", leave);
      node.removeEventListener("focusin", enter);
      node.removeEventListener("focusout", leave);
    },
  };
}
