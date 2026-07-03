export interface AiTools {
  claude_cli: boolean;
  claude_desktop: boolean;
  codex_cli: boolean;
  codex_desktop: boolean;
  grok_cli: boolean;
  any: boolean;
}

export const NO_AI_TOOLS: AiTools = {
  claude_cli: false,
  claude_desktop: false,
  codex_cli: false,
  codex_desktop: false,
  grok_cli: false,
  any: false,
};

export type CliTool = 'claude' | 'codex' | 'grok';

export type SummaryLaunchState =
  | { kind: 'checking'; label: string }
  | { kind: 'claude-desktop'; label: string }
  | { kind: 'cli'; label: string; tool: CliTool }
  | { kind: 'copy-command'; label: string }
  | { kind: 'download'; label: string };

const FALLBACK_HQ_PATH = '~/hq';

export function primaryCli(tools: AiTools | null): CliTool | null {
  if (!tools) return null;
  if (tools.claude_cli) return 'claude';
  if (tools.codex_cli) return 'codex';
  if (tools.grok_cli) return 'grok';
  return null;
}

export function toolDisplayName(tool: CliTool): string {
  if (tool === 'claude') return 'Claude';
  if (tool === 'codex') return 'Codex';
  return 'Grok';
}

export function cliTerminalLabel(tool: CliTool): string {
  if (tool === 'claude') return 'Claude Code';
  if (tool === 'codex') return 'Codex CLI';
  return 'Grok CLI';
}

function quoteForShell(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function shellPath(path: string | null): string {
  const trimmed = path?.trim();
  if (!trimmed) return FALLBACK_HQ_PATH;
  return quoteForShell(trimmed);
}

export function readyCommandFor(path: string | null, tools: AiTools | null): string {
  const cli = primaryCli(tools);
  const target = shellPath(path);
  if (cli) return `cd ${target} && ${cli}`;
  return `open ${target}`;
}

export function summaryLaunchState(tools: AiTools | null): SummaryLaunchState {
  if (!tools) {
    return { kind: 'checking', label: 'Copy command' };
  }

  if (tools.claude_desktop) {
    return { kind: 'claude-desktop', label: 'Launch Claude Desktop' };
  }

  const cli = primaryCli(tools);
  if (cli) {
    return {
      kind: 'cli',
      label: `Open ${cliTerminalLabel(cli)} in Terminal`,
      tool: cli,
    };
  }

  if (tools.any) {
    return { kind: 'copy-command', label: 'Copy command' };
  }

  return { kind: 'download', label: 'Download Claude' };
}

export function markToolUnavailable(
  tools: AiTools | null,
  key: keyof Omit<AiTools, 'any'>,
): AiTools {
  const next = { ...(tools ?? NO_AI_TOOLS), [key]: false };
  return {
    ...next,
    any:
      next.claude_cli ||
      next.claude_desktop ||
      next.codex_cli ||
      next.codex_desktop ||
      next.grok_cli,
  };
}
