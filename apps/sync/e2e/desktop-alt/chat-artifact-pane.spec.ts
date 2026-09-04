import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Chat artifacts — long structured DM blocks (`hq dm --details` / `--prompt`,
 * delegation + handoff cards) used to render as a bordered monospace block
 * hard-clipped at 180 characters, ending in a bare "…" with no affordance: the
 * rest of the content was simply unreachable.
 *
 * Source contracts for the replacement: a designed artifact card (title / kind
 * / size / faded preview / Open) that opens the FULL content in ARTIFACT mode
 * of the existing right side pane — one pane mode at a time, no second overlay
 * system.
 */

const ui = (rel: string) => readRepoFile(join('../../packages/ui', rel));

const card = ui('src/chat/messaging/ArtifactCard.svelte');
const panel = ui('src/chat/messaging/ArtifactPanel.svelte');
const model = ui('src/chat/messaging/artifact-model.ts');
const copy = ui('src/chat/messaging/conversation-copy.ts');
const shell = ui('src/shell/DesktopApp.svelte');
const conversation = ui('src/chat/messaging/ChannelConversation.svelte');
const reply = ui('src/chat/messaging/ReplyPanel.svelte');

describe('artifact card replaces the dead-end clamp', () => {
  it('drops the 180-char ellipsis preview helper entirely', () => {
    expect(copy).not.toContain('promptPreview');
    // The preview helper keeps whole lines and adds no truncation marker.
    const preview = /export function artifactPreviewLines[\s\S]*?\n\}/.exec(model)?.[0] ?? '';
    expect(preview).not.toBe('');
    expect(preview).not.toContain('…');
  });

  it('previews whole lines and fades instead of hard-cutting', () => {
    expect(model).toContain('export const ARTIFACT_PREVIEW_LINES');
    expect(card).toContain('artifact-card-fade');
    expect(card).toMatch(/\.artifact-card-fade\s*\{[\s\S]*?linear-gradient\(/);
    expect(card).toMatch(/\.artifact-card-body\s*\{[\s\S]*?overflow:\s*hidden/);
  });

  it('renders title, kind label and size hint in the card header', () => {
    expect(card).toContain("data-testid=\"artifact-card-title\"");
    expect(card).toContain("data-testid=\"artifact-card-kind\"");
    expect(card).toContain("data-testid=\"artifact-card-size\"");
    expect(model).toContain('export function artifactTitle');
    expect(model).toContain('export function artifactSizeLabel');
  });

  it('makes the whole card an accessible button plus an explicit Open control', () => {
    expect(card).toContain('role="button"');
    expect(card).toContain('tabindex="0"');
    expect(card).toContain('aria-label={`Open ');
    expect(card).toMatch(/onkeydown=\{onKeydown\}/);
    expect(card).toMatch(/e\.key !== "Enter" && e\.key !== " "/);
    expect(card).toContain("data-testid=\"artifact-card-open\"");
  });

  it('keeps desktop-alt chrome: 13px ghost card, hairline border, mono preview only', () => {
    expect(card).toMatch(/\.artifact-card\s*\{[\s\S]*?border:\s*1px solid var\(--line2/);
    expect(card).toMatch(/\.artifact-card\s*\{[\s\S]*?background:\s*transparent/);
    expect(card).toMatch(/\.artifact-card\s*\{[\s\S]*?font-size:\s*13px/);
    expect(card).toMatch(/\.artifact-card-open\s*\{[\s\S]*?color:\s*var\(--vio-ink/);
    expect(card).toMatch(/\.artifact-card-preview\s*\{[\s\S]*?font-family:\s*var\(--font-mono/);
    expect(card).not.toMatch(/\.artifact-card-title\s*\{[^}]*font-mono/);
  });
});

describe('artifact mode of the existing right side pane', () => {
  it('reuses the .reply-column pane slot rather than a second overlay system', () => {
    expect(shell).toContain("data-testid=\"artifact-column\"");
    expect(shell).toMatch(
      /\{#if openArtifactView\}[\s\S]*?class="reply-column"[\s\S]*?data-pane-mode="artifact"[\s\S]*?<ArtifactPanel/,
    );
    expect(shell).toMatch(/\{#if openArtifactView\}[\s\S]*?\{:else if openAgentMember\}/);
  });

  it('keeps exactly one pane mode active: artifact clears on thread/profile/tab/row change', () => {
    expect(shell).toMatch(/function openReply\([\s\S]*?openArtifactView = null;/);
    expect(shell).toMatch(/function openMemberProfile\([\s\S]*?openArtifactView = null;/);
    expect(shell).toMatch(/if \(activeTab !== "chat"\) \{[\s\S]*?openArtifactView = null;/);
    expect(shell).toMatch(/lastReplyRowId = rowId;[\s\S]*?openArtifactView = null;/);
  });

  it('does not clear the open thread when an artifact opens (close returns to it)', () => {
    expect(shell).toMatch(
      /function openArtifact\(artifact: ChatArtifact\): void \{\s*openArtifactView = artifact;/,
    );
    const openArtifactBody =
      /function openArtifact\(artifact: ChatArtifact\): void \{[\s\S]*?\n  \}/.exec(shell)?.[0] ??
      '';
    expect(openArtifactBody).not.toBe('');
    expect(openArtifactBody).not.toContain('openReplyRootId');
    expect(shell).toMatch(/function closeArtifact\(\): void \{\s*openArtifactView = null;\s*\}/);
  });

  it('wires both the channel timeline and the thread panel to the host opener', () => {
    expect(conversation).toContain('onopenartifact?: (artifact: ChatArtifact) => void;');
    expect(reply).toContain('onopenartifact?: (artifact: ChatArtifact) => void;');
    expect(conversation).toContain('onopen={onopenartifact}');
    expect(reply).toContain('onopen={onopenartifact}');
    expect(shell).toContain('onopenartifact={openArtifact}');
  });

  it('gives the pane a header with copy + close and full scrollable wrapped content', () => {
    expect(panel).toContain("data-testid=\"artifact-panel-title\"");
    expect(panel).toContain("data-testid=\"artifact-panel-kind\"");
    expect(panel).toContain("data-testid=\"artifact-panel-copy\"");
    expect(panel).toContain("data-testid=\"artifact-panel-close\"");
    expect(panel).toContain('{artifact.text}');
    expect(panel).toMatch(/\.artifact-panel-body\s*\{[\s\S]*?overflow-y:\s*auto/);
    // Long single lines wrap; the pane never scrolls horizontally.
    expect(panel).toMatch(/\.artifact-panel-body\s*\{[\s\S]*?overflow-x:\s*hidden/);
    expect(panel).toMatch(/\.artifact-panel-content\s*\{[\s\S]*?white-space:\s*pre-wrap/);
    expect(panel).toMatch(/\.artifact-panel-content\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
    expect(panel).toMatch(/\.artifact-panel-content\s*\{[\s\S]*?max-width:\s*100%/);
  });

  it('closes on Escape and respects prefers-reduced-motion', () => {
    expect(panel).toMatch(/e\.key !== "Escape"[\s\S]*?onclose\(\)/);
    expect(panel).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.artifact-panel\s*\{\s*animation:\s*none/,
    );
  });
});
