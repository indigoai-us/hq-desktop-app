import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source-contract: Beta/Alpha are opt-in for every signed-in user. The former
// @getindigo.ai coerce-to-Stable gate must not return.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const updaterRs = read('../../src-tauri/src/updater.rs');
const releaseChannelRs = read('../../../../crates/hq-desktop-core/src/release_channel.rs');
const settingsPage = read('../../src/desktop-alt/pages/SettingsPage.svelte');
const uiSettingsPage = read('../../../../packages/ui/src/settings/SettingsPage.svelte');

describe('release channel opt-in for every signed-in user', () => {
  it('available_channels always offers stable, beta, and alpha', () => {
    const start = updaterRs.indexOf('pub async fn available_channels()');
    const end = updaterRs.indexOf('\n}', start);
    const fnBody = updaterRs.slice(start, end === -1 ? undefined : end + 2);
    expect(fnBody).toContain('ReleaseChannel::Beta');
    expect(fnBody).toContain('ReleaseChannel::Alpha');
    expect(fnBody).not.toContain('is_indigo_user');
  });

  it('effective_channel is preference-only (no indigo coerce argument)', () => {
    expect(releaseChannelRs).toMatch(
      /pub fn effective_channel\(stored_pref: Option<&str>\) -> ReleaseChannel/,
    );
    expect(releaseChannelRs).not.toMatch(/is_indigo: bool/);
    expect(updaterRs).toMatch(/effective_channel\(stored\.as_deref\(\)\)/);
    expect(updaterRs).not.toMatch(/effective_channel\(stored\.as_deref\(\),\s*is_indigo\)/);
  });

  it('Settings copy no longer tells non-Indigo users Stable is enforced', () => {
    expect(settingsPage).not.toContain('Stable is enforced for everyone else');
    expect(uiSettingsPage).not.toContain('Stable is enforced for everyone else');
    expect(settingsPage).toContain('Opt into Beta for pre-release builds');
    expect(uiSettingsPage).toContain('Opt into Beta for pre-release builds');
  });
});
