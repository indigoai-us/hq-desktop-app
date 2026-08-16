export interface AiTools {
  claude_cli: boolean;
  claude_desktop: boolean;
  codex_cli: boolean;
  codex_desktop: boolean;
  grok_cli: boolean;
  claude_last_used_ms: number | null;
  codex_last_used_ms: number | null;
  grok_last_used_ms: number | null;
  any: boolean;
}

export const NO_AI_TOOLS: AiTools = {
  claude_cli: false,
  claude_desktop: false,
  codex_cli: false,
  codex_desktop: false,
  grok_cli: false,
  claude_last_used_ms: null,
  codex_last_used_ms: null,
  grok_last_used_ms: null,
  any: false,
};

export type CliTool = 'claude' | 'codex' | 'grok';
export type LaunchKind = 'claude' | 'codex' | 'grok';
export type PrimaryLaunchKind = LaunchKind | 'download';
export interface PrimaryLaunch { kind: PrimaryLaunchKind; label: string }
export interface AvailableLaunch { kind: LaunchKind; label: string }

const LAUNCH_CANDIDATES: Array<{
  kind: LaunchKind;
  label: string;
  isAvailable: (tools: AiTools) => boolean;
  lastUsed: (tools: AiTools) => number | null;
}> = [
  {
    kind: 'claude',
    label: 'Open in Claude Code',
    isAvailable: (tools) => tools.claude_cli || tools.claude_desktop,
    lastUsed: (tools) => tools.claude_last_used_ms,
  },
  {
    kind: 'codex',
    label: 'Open in Codex',
    isAvailable: (tools) => tools.codex_cli || tools.codex_desktop,
    lastUsed: (tools) => tools.codex_last_used_ms,
  },
  {
    kind: 'grok',
    label: 'Open in Grok',
    isAvailable: (tools) => tools.grok_cli,
    lastUsed: (tools) => tools.grok_last_used_ms,
  },
];

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

export function availableLaunches(tools: AiTools | null): AvailableLaunch[] {
  if (!tools) return [];
  return LAUNCH_CANDIDATES.filter((candidate) => candidate.isAvailable(tools)).map(
    ({ kind, label }) => ({ kind, label }),
  );
}

export function selectPrimaryLaunch(tools: AiTools | null): PrimaryLaunch {
  // Highlight the most recently used available tool. Download is only the
  // fallback when nothing is installed — it is not a stand-in for hiding peers.
  if (!tools) return { kind: 'download', label: 'Download Claude' };
  const ranked = LAUNCH_CANDIDATES.filter((candidate) => candidate.isAvailable(tools));
  if (!ranked.length) return { kind: 'download', label: 'Download Claude' };
  const winner = ranked.reduce((current, tool) => {
    const used = tool.lastUsed(tools);
    const currentUsed = current.lastUsed(tools);
    return used !== null && (currentUsed === null || used > currentUsed) ? tool : current;
  });
  return { kind: winner.kind, label: winner.label };
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
