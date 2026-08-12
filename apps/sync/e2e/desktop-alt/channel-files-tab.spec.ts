import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-008 — Desktop: Files tab (source contracts).
 *
 * Grep-the-source specs: lock the Rust files endpoint client, ChannelFilesTab
 * wiring into ChannelView, list/empty/denied testids, FilePreviewPane reuse,
 * deep-link from in-chat file cards, and model absent-safety markers.
 */

describe('desktop channel files tab (US-008)', () => {
  const messagesRs = readRepoFile('src-tauri/src/commands/messages.rs');
  const mainRs = readRepoFile('src-tauri/src/main.rs');
  const channelView = readRepoFile('src/components/messaging/ChannelView.svelte');
  const filesTab = readRepoFile('src/components/messaging/ChannelFilesTab.svelte');
  const model = readRepoFile('src/components/messaging/channelFilesModel.ts');
  const conversation = readRepoFile('src/components/messaging/Conversation.svelte');
  const fileCard = readRepoFile('src/components/messaging/FileAttachmentCard.svelte');

  it('Rust fetch_channel_files hits GET /v1/notify/channels/{}/files and is registered', () => {
    expect(messagesRs).toContain('pub async fn fetch_channel_files');
    expect(messagesRs).toContain('/v1/notify/channels/{}/files');
    expect(messagesRs).toContain('ChannelFilesResponse');
    expect(messagesRs).toContain('fetch_channel_files');
    expect(messagesRs).toMatch(/`fetch_channel_files`\s+—\s+GET/);
    expect(mainRs).toContain('commands::messages::fetch_channel_files');
  });

  it('ChannelView renders ChannelFilesTab (placeholder gone)', () => {
    expect(channelView).toContain("import ChannelFilesTab from './ChannelFilesTab.svelte'");
    expect(channelView).toContain('<ChannelFilesTab');
    expect(channelView).toContain('highlightVaultPath');
    expect(channelView).toContain("projectTab === 'files'");
    expect(channelView).not.toContain('Project files land in a later story.');
    expect(channelView).not.toMatch(
      /project-placeholder[\s\S]*project-tab-files|project-tab-files[\s\S]*Project files land/,
    );
  });

  it('exposes list / empty / denied / loading testids', () => {
    expect(filesTab).toContain('data-testid="channel-files-list"');
    expect(filesTab).toContain('data-testid="channel-file-row"');
    expect(filesTab).toContain('data-testid="channel-files-empty"');
    expect(filesTab).toContain('data-testid="channel-files-denied"');
    expect(filesTab).toContain('data-testid="channel-files-loading"');
    expect(filesTab).toContain('data-testid="project-tab-files"');
  });

  it('reuses FilePreviewPane for the authorized preview path', () => {
    expect(filesTab).toContain(
      "import FilePreviewPane from '../../desktop-alt/components/FilePreviewPane.svelte'",
    );
    expect(filesTab).toContain('<FilePreviewPane');
    expect(filesTab).toContain('path={selectedPath}');
    expect(filesTab).toMatch(/invoke(?:<[^>]+>)?\(\s*['"]fetch_channel_files['"]/);
    expect(filesTab).toContain('limit: 100');
  });

  it('deep-links from in-chat file cards into the Files tab', () => {
    // Explicit callback chain: Conversation → ChannelView → projectTab + highlight.
    expect(conversation).toContain('onopenfile');
    expect(conversation).toContain('onopen={onopenfile}');
    expect(channelView).toContain('onopenfile={handleOpenFile}');
    expect(channelView).toContain("projectTab = 'files'");
    expect(channelView).toContain('highlightVaultPath = path');
    expect(filesTab).toContain('highlightVaultPath');
    expect(filesTab).toContain('findFileIndexByVaultPath');
    // Window event contract stays intact for contract tests / other listeners.
    expect(fileCard).toContain('hq:open-file-attachment');
  });

  it('model is absent-safe for missing endpoint, malformed rows, and ACL denial', () => {
    expect(model).toContain('export function parseChannelFilesResponse');
    expect(model).toContain('export function classifyAccessError');
    expect(model).toContain('export function classifyPreviewError');
    expect(model).toContain('export function findFileIndexByVaultPath');
    expect(model).toContain('export function isAgentUploader');
    expect(model).toContain("'unsupported'");
    expect(model).toContain("'denied'");
    expect(model).toContain('CHANNEL_FILES_DENIED_MESSAGE');
    expect(model).toContain('CHANNEL_FILES_EMPTY_MESSAGE');
    expect(model).toContain("You don't have access to this file.");
    expect(model).toContain('No files yet');
    // Endpoint-missing markers.
    expect(model).toMatch(/404|not found/i);
    // Agent identity convention shared with messaging.
    expect(model).toContain('agt_');
    expect(model).toContain('agent:');
  });
});
