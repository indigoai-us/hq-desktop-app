/**
 * Setup text for connecting outside AI apps to the hosted Indigo HQ MCP
 * connector, shown in Settings → AI tools.
 *
 * Mirrors the console's Connect → A person dialog
 * (hq-console `_connect-agent-modal.tsx` + `src/lib/claude-code-link.ts`).
 * The two repos do not share a package, so keep the wording in step when
 * either side changes.
 *
 * Every app here talks to the HOSTED connector over HTTP with a browser
 * OAuth sign-in. One sign-in is the person's HQ identity, so it reaches every
 * company they belong to; the agent names the company per call.
 */

export const INDIGO_MCP_URL = "https://hq-mcp.getindigo.ai/mcp";

export interface ConnectorApp {
  id: "grok-bot" | "claude" | "chatgpt" | "claude-code" | "codex" | "grok";
  name: string;
  /** One line telling the person where to paste and what to click. */
  help: string;
  /** What the Copy button puts on the clipboard. */
  copyText: string;
  /** Copy button label. Defaults to "Copy". */
  copyLabel?: string;
  /** Step-by-step setup, for apps added through their own settings screens. */
  steps?: readonly string[];
}

/**
 * Grok Bot runs its bots on xAI's cloud and adds custom MCP servers from
 * chat. Saying "custom" keeps it from installing a catalog plugin instead.
 * Grok Bot keeps per-server custom instructions, so the copied text also
 * saves how to use HQ across companies on the indigo server.
 */
export const GROK_BOT_CONNECT_PROMPT = [
  `Add a custom MCP server called "indigo" at ${INDIGO_MCP_URL}. It uses OAuth, so show me the connect card and let me sign in to HQ.`,
  "",
  "Once it is connected, save the following as the custom instructions for the indigo server:",
  "- HQ holds my companies' files, knowledge, secrets and connected apps. Before any HQ work, call hq_companies_list and work in the company I name. If I belong to more than one company and did not name one, ask me which.",
  "- Pass that company on every HQ call. Never copy one company's files or data into another company.",
  "- Use search, hq_files_list and hq_files_read to find and read files. Use hq_files_write to save work back to HQ.",
  "- Never ask me to paste a secret. Use hq_secrets_list to see which secrets exist and hq_secrets_sandbox to run a command that needs one.",
  "- Use hq_integrations_list and hq_integrations_call for the company's connected apps.",
  "",
  "Then tell me which companies I can work in.",
].join("\n");

export const CLAUDE_CODE_CONNECT_PROMPT = [
  "Connect me to the Indigo HQ MCP server by running this command in the terminal, then follow the browser prompt to sign in:",
  "",
  `claude mcp add --transport http indigo ${INDIGO_MCP_URL}`,
].join("\n");

export const CODEX_CONNECT_PROMPT = [
  'Connect me to the Indigo HQ MCP server. Add a remote MCP server named "indigo" to my ~/.codex/config.toml:',
  "",
  `[mcp_servers.indigo]\nurl = "${INDIGO_MCP_URL}"`,
  "",
  "Then run `codex mcp login indigo` and tell me when to finish the sign-in in the browser.",
].join("\n");

export const GROK_CLI_CONNECT_PROMPT = [
  'Connect me to the Indigo HQ MCP server. Add it as a remote MCP server named "indigo":',
  "",
  `grok mcp add --transport http indigo ${INDIGO_MCP_URL}`,
  "",
  "Then open /mcps, press i to authorize in the browser, and tell me when it is connected.",
].join("\n");

export const CONNECTOR_APPS: readonly ConnectorApp[] = [
  {
    id: "grok-bot",
    name: "Grok Bot",
    help: "Copy these instructions and paste them into a Grok Bot chat. They add HQ, ask you to sign in, and teach Grok Bot how to work across your companies.",
    copyLabel: "Copy instructions",
    copyText: GROK_BOT_CONNECT_PROMPT,
  },
  {
    id: "claude",
    name: "Claude",
    help: "Works in the Claude desktop app and on claude.ai. Copy gives you the connector URL.",
    copyText: INDIGO_MCP_URL,
    steps: [
      "Open Settings → Connectors.",
      "Choose Add custom connector.",
      "Name it Indigo HQ and paste the connector URL. Leave the advanced OAuth fields empty.",
      "Click Add, then sign in to HQ when the browser opens.",
    ],
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    help: "Turn on Developer mode, create a connector with OAuth, and paste the URL.",
    copyText: INDIGO_MCP_URL,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    help: "Paste into a Claude Code session. It adds the connector and opens sign-in.",
    copyText: CLAUDE_CODE_CONNECT_PROMPT,
  },
  {
    id: "codex",
    name: "Codex",
    help: "Paste into Codex. It updates its config and opens sign-in.",
    copyText: CODEX_CONNECT_PROMPT,
  },
  {
    id: "grok",
    name: "Grok CLI",
    help: "Paste into the Grok CLI. It adds the connector and opens sign-in.",
    copyText: GROK_CLI_CONNECT_PROMPT,
  },
];

/**
 * Puts an app's setup text on the clipboard. Settings → AI tools and the
 * welcome report's "Connect your AI apps" card both copy through this, so the
 * two never drift. Resolves false when the clipboard is unavailable or
 * denied; the caller then shows the text for copying by hand.
 */
export async function copyConnectorSetup(copyText: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API is unavailable");
    await navigator.clipboard.writeText(copyText);
    return true;
  } catch (err) {
    console.warn("[hq-connector] copy connector setup failed", err);
    return false;
  }
}

/**
 * The desktop apps the launch scan reports, by macOS bundle id, matched to a
 * connector. ChatGPT ships Codex inside it under `com.openai.codex`, so that
 * bundle counts as both. Grok's id is matched by its `ai.x.` prefix or the
 * app name, because the Grok app's exact id has changed between builds.
 */
const CONNECTOR_BUNDLE_IDS: Readonly<Record<string, readonly ConnectorApp["id"][]>> = {
  "com.anthropic.claudefordesktop": ["claude"],
  "com.openai.chat": ["chatgpt"],
  "com.openai.codex": ["chatgpt", "codex"],
};

/**
 * The connector apps found on this computer: desktop apps from the launch
 * scan's `apps`, plus Claude Code and the Codex CLI when the launch detection
 * found them. In CONNECTOR_APPS order; empty when nothing matches.
 */
export function foundConnectorApps(
  scanApps: readonly { bundleId: string | null; name: string }[],
  cli: { claudeCode: boolean; codex: boolean },
): ConnectorApp[] {
  const found = new Set<ConnectorApp["id"]>();
  for (const app of scanApps) {
    const id = app.bundleId?.toLowerCase() ?? "";
    for (const hit of CONNECTOR_BUNDLE_IDS[id] ?? []) found.add(hit);
    if (id.startsWith("ai.x.") || app.name.trim().toLowerCase() === "grok") found.add("grok-bot");
  }
  if (cli.claudeCode) found.add("claude-code");
  if (cli.codex) found.add("codex");
  return CONNECTOR_APPS.filter((app) => found.has(app.id));
}
