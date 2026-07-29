import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('desktop-alt Messages agent handoff', () => {
  const shell = readRepoFile('src/components/messaging/MessagesShell.svelte');

  it('routes the Your agent conversation to Claude Code instead of a fake DM', () => {
    expect(shell).toContain("import { buildClaudeCodeUrl } from '../../lib/claude-code-link'");
    expect(shell).toContain("import { hqSkillMarkdownLink } from '../../lib/hq-skill-link'");
    expect(shell).toContain('async function sendAgentPrompt(');
    expect(shell).toContain('peer: Contact');
    expect(shell).toContain('generation: number');
    expect(shell).toContain("hqSkillMarkdownLink('startwork', hqFolderPath)");
    // Capture the selected peer, send generation, and workspace before the
    // async handoff so a late completion cannot mutate a newer conversation.
    expect(shell).toContain('const peer = selected');
    expect(shell).toContain('const generation = ++dmSendGeneration');
    expect(shell).toContain('const folder = hqFolderPath');
    expect(shell).toContain('buildClaudeCodeUrl({ folder, prompt })');
    expect(shell).toContain('await sendAgentPrompt(text, peer, generation)');
    expect(shell).toContain('if (!dmSendIsCurrent(peer, generation)) return');
    expect(shell).toContain("invoke('open_claude_code_link', { url })");
    expect(shell).toContain("personUid: 'agent:self'");
    const oldAbsoluteSkillPath = [
      '',
      'Users',
      'corey',
      'Documents',
      'HQ',
      '.claude',
      'skills',
      'startwork',
      'SKILL.md',
    ].join('/');
    expect(shell).not.toContain(oldAbsoluteSkillPath);
    expect(shell).not.toContain("personUid: selfPersonUid ?? 'agent:self'");
  });

  it('keeps agent handoff out of DM-only features', () => {
    expect(shell).toContain("peer.source === 'agent'");
    expect(shell).toContain("selected.source === 'agent'");
    // Share reactions merged into the DM thread map — agent conversations
    // still get NO reactions surface (empty map, no toggle handler).
    expect(shell).toContain("reactions={selected.source === 'agent'");
    expect(shell).toContain("{ ...(dmReactions?.map ?? {}), ...shareReactions.map }");
    expect(shell).toContain(
      "ontogglereaction={selected.source === 'agent' ? undefined : toggleThreadReaction}",
    );
  });
});
