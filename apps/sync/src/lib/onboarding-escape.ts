export type EscapeKind =
  | 'folder_not_ready'
  | 'tool_missing'
  | 'open_failed'
  | 'reveal_failed'
  | 'download_failed';

export type EscapeTool = 'claude' | 'codex' | 'grok' | 'download' | 'folder';

export interface OnboardingEscape {
  kind: EscapeKind;
  title: string;
  body: string;
}

const FOLDER_NOT_READY =
  /not ready|core\/core\.yaml|manifest\.yaml|does not exist|finish onboarding|re-tether|hq folder/i;

const TOOL_MISSING =
  /not detected|not installed|not found|unable to find application|missing/i;

function toolLabel(tool: EscapeTool): string {
  if (tool === 'codex') return 'Codex';
  if (tool === 'grok') return 'Grok';
  return 'Claude Code';
}

/**
 * Map a launcher / reveal failure to a next step. Never echo the raw
 * backend string — those read as errors and dump internals (paths, schema
 * names) onto a first-run screen.
 */
export function escapeForLaunch(
  tool: EscapeTool,
  message: string | null | undefined,
): OnboardingEscape {
  const text = message?.trim() ?? '';

  if (tool === 'folder' || /reveal|finder|explorer/i.test(text)) {
    return {
      kind: 'reveal_failed',
      title: 'Copy the path and open it from Finder',
      body: 'HQ couldn’t show the folder automatically. Paste the path into Finder or your AI tool.',
    };
  }

  if (tool === 'download') {
    return {
      kind: 'download_failed',
      title: 'Open claude.ai/download in your browser',
      body: 'The download page didn’t open from here. Visit it yourself, then come back and open this HQ folder.',
    };
  }

  if (FOLDER_NOT_READY.test(text)) {
    return {
      kind: 'folder_not_ready',
      title: 'Open the folder and run /setup',
      body: 'The HQ folder is there, but setup still needs a pass inside your AI tool. Reveal it or copy the command below.',
    };
  }

  if (TOOL_MISSING.test(text)) {
    const name = toolLabel(tool);
    return {
      kind: 'tool_missing',
      title: `Install ${name}, or open the folder yourself`,
      body: `HQ couldn’t find ${name}. Download it, or copy the path and open this folder from another tool.`,
    };
  }

  return {
    kind: 'open_failed',
    title: 'Open the folder yourself',
    body: `${toolLabel(tool)} didn’t launch from here. Reveal the folder, then run /setup.`,
  };
}

export const COMPLETE_SETUP: OnboardingEscape = {
  kind: 'folder_not_ready',
  title: 'Complete setup in your AI tool',
  body: 'Open the HQ folder and run /setup.',
};

export const SETUP_NEEDS_PASS: OnboardingEscape = {
  kind: 'folder_not_ready',
  title: 'Finish setup in your AI tool',
  body: 'One installer step still needs a pass. Open the HQ folder and run /setup — that’s the rest of the work.',
};
