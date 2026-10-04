export type BrainProvider = "grok" | "codex" | "claude";

export interface BrainApproval {
  provider: BrainProvider;
  url: string;
  /** Sensitive for its lifetime. Keep it in component state only. */
  code: string;
  capturedAt: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function provider(value: unknown): BrainProvider | null {
  return value === "grok" || value === "codex" || value === "claude"
    ? value
    : null;
}

function providerFromUrl(value: unknown): BrainProvider | null {
  if (typeof value !== "string") return null;
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host === "accounts.x.ai") return "grok";
    if (host === "claude.ai" || host.endsWith(".claude.ai") || host === "claude.com" || host.endsWith(".claude.com") || host === "anthropic.com" || host.endsWith(".anthropic.com")) return "claude";
    if (host === "auth.openai.com" || host.endsWith(".openai.com") || host === "chatgpt.com" || host.endsWith(".chatgpt.com")) return "codex";
  } catch {
    return null;
  }
  return null;
}

function trustedUrl(value: unknown, brain: BrainProvider): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    const allowed = brain === "grok"
      ? host === "accounts.x.ai"
      : brain === "claude"
        ? host === "claude.ai" || host.endsWith(".claude.ai") || host === "claude.com" || host.endsWith(".claude.com") || host === "anthropic.com" || host.endsWith(".anthropic.com")
        : host === "auth.openai.com" || host.endsWith(".openai.com") || host === "chatgpt.com" || host.endsWith(".chatgpt.com");
    return allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Pull only the pairing contract the new-bot waking screen needs. */
export function brainApprovalFromStatus(payload: unknown): BrainApproval | null {
  const root = record(payload);
  const agent = record(root?.agent);
  const pairing = record(root?.pairing);
  const brain = provider(agent?.provider) ?? providerFromUrl(pairing?.url);
  if (!pairing || !brain) return null;
  const url = trustedUrl(pairing.url, brain);
  const code = typeof pairing.code === "string" ? pairing.code : "";
  if (!url || (brain !== "claude" && !code)) return null;
  return {
    provider: brain,
    url,
    code,
    capturedAt: typeof pairing.capturedAt === "string" ? pairing.capturedAt : null,
  };
}

export function brainApprovalLabel(brain: BrainProvider): string {
  return brain === "grok" ? "Grok" : brain === "claude" ? "Claude" : "Codex";
}

/** Grok accepts its device code in the authorization URL. */
export function approvalOpenUrl(approval: BrainApproval): string {
  if (approval.provider !== "grok" || !approval.code) return approval.url;
  const url = new URL(approval.url);
  // The current pairing code is authoritative. Do not preserve a stale code
  // from a previously issued pairing URL.
  url.searchParams.set("user_code", approval.code);
  return url.toString();
}

export function approvalExpired(approval: BrainApproval, now = Date.now()): boolean {
  if (!approval.capturedAt) return false;
  const capturedAt = Date.parse(approval.capturedAt);
  return Number.isFinite(capturedAt) && now - capturedAt >= 10 * 60_000;
}
