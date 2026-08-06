import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { renderMessageBodyMarkdown } from '../../src/lib/messageMarkdown';

// Source-contract regression guard for Sentry HQ-DESKTOP-4F:
//
//   UnhandledRejection: Non-Error promise rejection captured with value:
//   Command plugin:shell|open not allowed by ACL
//
// The dm-detail window (DM notification -> "Open details") and the share-detail
// window both mount the shared <Conversation/> pane through <DmThreadPane/>, and
// Conversation renders DM bodies through renderMessageBodyMarkdown(), whose
// markdown link / autolink / mailto branches emit
// `<a … target="_blank" rel="noopener noreferrer">`.
//
// tauri-plugin-shell (2.3.5, Cargo.lock-pinned) injects a document-level click
// listener that intercepts any such anchor, preventDefaults the click and calls
// invoke('plugin:shell|open', …) with no .catch(). Neither window's capability
// granted `shell:allow-open`, so tauri core rejected the command with
// "Command plugin:shell|open not allowed by ACL" — an uncatchable unhandled
// rejection to Sentry, and an inert link for the user. The messages and
// desktop-alt windows render the identical UI and already had the grant.
//
// The Sentry grouping signature carries no window label (metadata.value is the
// bare ACL message), so a click in EITHER window groups into the same issue —
// both windows must be granted for the cluster to close.
//
// These are source-contract checks (the unit suite never boots a real Tauri
// window), in the house style of activity-log-drag-capability.test.ts. Pins on
// component sources are deliberately tolerant import/render/routing regexes plus
// one behavioral renderer call, so styling churn cannot break them.

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const capabilitiesDir = root('src-tauri/capabilities');

// A permission entry is either a bare identifier string or a scoped object
// (`{ identifier, allow: [...] }`, as default.json uses for http:/fs:).
type Permission = string | { identifier: string; [key: string]: unknown };

interface Capability {
  identifier: string;
  description: string;
  windows: string[];
  permissions: Permission[];
}

const permissionId = (permission: Permission): string =>
  typeof permission === 'string' ? permission : permission.identifier;

const capabilityFiles = readdirSync(capabilitiesDir)
  .filter((name) => name.endsWith('.json'))
  .sort();

const capabilities = new Map<string, Capability>(
  capabilityFiles.map((name) => {
    const parsed = JSON.parse(
      readFileSync(`${capabilitiesDir}/${name}`, 'utf8'),
    ) as Capability;
    return [parsed.identifier, parsed];
  }),
);

const generated = JSON.parse(
  readFileSync(root('src-tauri/gen/schemas/capabilities.json'), 'utf8'),
) as Record<string, Capability & { local?: boolean }>;

const mainTs = readFileSync(root('src/main.ts'), 'utf8');
const dmDetail = readFileSync(root('src/components/DmDetail.svelte'), 'utf8');
const shareDetail = readFileSync(root('src/components/ShareDetail.svelte'), 'utf8');
const dmThreadPane = readFileSync(root('src/components/DmThreadPane.svelte'), 'utf8');
const conversation = readFileSync(root('src/components/messaging/Conversation.svelte'), 'utf8');
const dmNotifyRs = readFileSync(root('src-tauri/src/commands/dm_notify.rs'), 'utf8');
const shareNotifyRs = readFileSync(
  fileURLToPath(new URL('../../../../crates/hq-desktop-core/src/share_notify.rs', import.meta.url)),
  'utf8',
);

// Every window that mounts <Conversation/> (or <ThreadPanel/>) renders DM
// markdown, so every one of them must resolve shell:allow-open. Changing this
// set is a deliberate act — update it here and confirm the ACL follows.
const WINDOWS_GRANTED_SHELL_OPEN = [
  'default',
  'desktop-alt-capability',
  'dm-detail',
  'drift-detail',
  'meeting-permissions',
  'meetings-window',
  'messages',
  'share-detail',
];

describe('HQ-DESKTOP-4F: dm-detail + share-detail shell:allow-open capability', () => {
  it('grants shell:allow-open to the dm-detail window (DM markdown links are inert + reject without it)', () => {
    const cap = capabilities.get('dm-detail');
    expect(cap).toBeDefined();
    expect(cap!.windows).toContain('dm-detail');
    expect(cap!.permissions.map(permissionId)).toContain('shell:allow-open');
  });

  it('grants shell:allow-open to the share-detail window (same Conversation pane, same grouping signature)', () => {
    const cap = capabilities.get('share-detail');
    expect(cap).toBeDefined();
    expect(cap!.windows).toContain('share-detail');
    expect(cap!.permissions.map(permissionId)).toContain('shell:allow-open');
  });

  it('grants shell:allow-open to exactly the expected capability set (no silent widening, no silent loss)', () => {
    const granting = [...capabilities.values()]
      .filter((cap) => cap.permissions.map(permissionId).includes('shell:allow-open'))
      .map((cap) => cap.identifier)
      .sort();
    expect(granting).toEqual(WINDOWS_GRANTED_SHELL_OPEN);
  });

  it('grants no shell permission other than shell:allow-open (the default open scope is https?/mailto/tel)', () => {
    const otherShell = [...capabilities.values()]
      .flatMap((cap) => cap.permissions)
      .map(permissionId)
      .filter((permission) => permission.startsWith('shell:') && permission !== 'shell:allow-open');
    expect(otherShell).toEqual([]);
  });

  it('keeps the generated capability manifest in exact agreement with the source capability files', () => {
    // gen/schemas/capabilities.json is committed but only regenerated by a
    // macOS tauri build; CI has no diff gate, so this leg is the standing
    // mechanical guard against the snapshot drifting from source.
    expect([...capabilities.keys()].sort()).toEqual(Object.keys(generated).sort());
    for (const [identifier, source] of capabilities) {
      const entry = generated[identifier];
      expect(entry, `missing generated entry for ${identifier}`).toBeDefined();
      expect(entry.windows, `windows drift for ${identifier}`).toEqual(source.windows);
      expect(entry.permissions, `permissions drift for ${identifier}`).toEqual(source.permissions);
      expect(entry.description, `description drift for ${identifier}`).toEqual(source.description);
    }
  });

  it('routes the dm-detail and share-detail window labels to the components that render DM markdown', () => {
    expect(mainTs).toMatch(/windowLabel === 'dm-detail'[\s\S]*?Component = DmDetail/);
    expect(mainTs).toMatch(/windowLabel === 'share-detail'[\s\S]*?Component = ShareDetail/);
  });

  it('mounts the shared Conversation pane in both windows (DmDetail/ShareDetail -> DmThreadPane -> Conversation)', () => {
    expect(dmDetail).toMatch(/import\s+DmThreadPane[\s\S]*?from\s+'\.\/DmThreadPane\.svelte'/);
    expect(dmDetail).toMatch(/<DmThreadPane\b/);
    expect(shareDetail).toMatch(/import\s+DmThreadPane[\s\S]*?from\s+'\.\/DmThreadPane\.svelte'/);
    expect(shareDetail).toMatch(/<DmThreadPane\b/);
    expect(dmThreadPane).toMatch(/import\s+Conversation[\s\S]*?from\s+'\.\/messaging\/Conversation\.svelte'/);
    expect(dmThreadPane).toMatch(/<Conversation\b/);
    expect(conversation).toMatch(/renderMessageBodyMarkdown/);
  });

  it('renders DM markdown links as target=_blank anchors (what the shell plugin listener intercepts)', () => {
    const link = renderMessageBodyMarkdown('see [docs](https://example.com/x)');
    expect(link).toMatch(/<a\s[^>]*href="https:\/\/example\.com\/x"[^>]*target="_blank"/);

    // CommonMark angle-bracket autolinks — the renderer deliberately does not
    // linkify bare URLs, so these are the other two anchor-emitting branches.
    const autolink = renderMessageBodyMarkdown('<https://example.com/y>');
    expect(autolink).toMatch(/<a\s[^>]*href="https:\/\/example\.com\/y"[^>]*target="_blank"/);

    const mail = renderMessageBodyMarkdown('<someone@example.com>');
    expect(mail).toMatch(/<a\s[^>]*href="mailto:someone@example\.com"[^>]*target="_blank"/);
  });

  it('builds both windows under the labels the capabilities grant', () => {
    expect(dmNotifyRs).toMatch(/DM_DETAIL_LABEL:\s*&str\s*=\s*"dm-detail"/);
    expect(shareNotifyRs).toMatch(/SHARE_DETAIL_LABEL:\s*&str\s*=\s*"share-detail"/);
  });
});
