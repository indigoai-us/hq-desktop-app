import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Messages rail filter — DESKTOP-002 removes the All / People / Requests tab
 * row entirely. The unified rail (channels + DMs + requests + shares, recency
 * sorted) is the only scope. Locks the purple-free, no-People/Requests shape.
 */
describe('Messages filter — unified rail (no People/Requests tabs)', () => {
  const shell = readRepoFile('src/components/messaging/MessagesShell.svelte');

  it('has no segment tab chrome (All / People / Requests removed)', () => {
    expect(shell).not.toContain('class="seg"');
    expect(shell).not.toContain('class="segment"');
    expect(shell).not.toContain('class="segments"');
    expect(shell).not.toContain("segment = 'people'");
    expect(shell).not.toContain("segment = 'requests'");
    expect(shell).not.toContain("segment = 'channels'");
    expect(shell).not.toContain("segment = 'all'");
    expect(shell).not.toMatch(/>\s*People\s*</);
    expect(shell).not.toMatch(/>\s*Requests\s*</);
  });

  it('uses no purple active-dot filter cue', () => {
    expect(shell).not.toContain('.segment.active::before');
    expect(shell).not.toContain('box-shadow: inset 0 -1.5px 0 currentColor');
  });

  it('merges channels alongside people and request/share rows in the unified rail', () => {
    expect(shell).toContain('mergeConversations(contacts, channels)');
    expect(shell).toContain('{#snippet channelRow(');
    expect(shell).toContain('{#snippet dmRow(');
    expect(shell).toContain('{#snippet requestRow(');
    expect(shell).toContain('{#snippet shareRow(');
    expect(shell).toContain('railItems');
    expect(shell).not.toContain("import ChannelList from './ChannelList.svelte'");
    expect(shell).toContain('companyNameFor(ch, companyLabels)');
  });

  it('uses no purple/indigo --accent anywhere on the Messages surface', () => {
    expect(shell).not.toContain('var(--accent)');
    expect(shell).not.toContain('var(--accent-soft)');
  });

  it('keeps the staged v4 agent-native messaging components purple-free', () => {
    for (const name of ['AgentThread', 'CatchUp', 'SystemEventCard', 'UnfurlCard']) {
      const component = readRepoFile(`src/components/messaging/v4/${name}.svelte`);
      expect(component, `${name} must not use --accent`).not.toContain('var(--accent)');
      expect(component, `${name} must not use --accent-soft`).not.toContain(
        'var(--accent-soft)',
      );
    }
  });
});
