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
}

/**
 * Grok Bot runs its bots on xAI's cloud and adds custom MCP servers from
 * chat. Saying "custom" keeps it from installing a catalog plugin instead.
 */
export const GROK_BOT_CONNECT_PROMPT = [
  `Add a custom MCP server called "indigo" at ${INDIGO_MCP_URL}.`,
  "It uses OAuth, so show me the connect card and let me sign in.",
  "Once it is connected, call hq_companies_list and tell me which companies I can work in.",
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
    help: "Paste into a Grok Bot chat, click Add it, then Authorize on the connect card.",
    copyText: GROK_BOT_CONNECT_PROMPT,
  },
  {
    id: "claude",
    name: "Claude",
    help: "In Settings → Connectors, choose Add custom connector and paste the URL.",
    copyText: INDIGO_MCP_URL,
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
