import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import PackInstallSheet from './PackInstallSheet.svelte';
import {
  appendInstallLine,
  beginInstall,
  createPackInstallState,
  failInstall,
  finishInstall,
  withDisplayName,
  type PackInstallSheetState,
} from './pack-install';

const renderSheet = (state: PackInstallSheetState, onopenmessages?: () => void) =>
  render(PackInstallSheet, {
    props: { state, onadd: vi.fn(), oncancel: vi.fn(), onopenmessages },
  }).body;

const named = withDisplayName(createPackInstallState('agency-kit', true), 'Agency Kit');

describe('PackInstallSheet states (US-005)', () => {
  it('confirms with the catalog name, the slug, Add and Cancel', () => {
    const html = renderSheet(named);
    expect(html).toContain('data-phase="confirm"');
    expect(html).toContain('Add Agency Kit to HQ?');
    expect(html).toContain('>agency-kit<');
    expect(html).toContain('data-testid="pack-sheet-add"');
    expect(html).toContain('>Cancel<');
    expect(html).toContain('role="dialog"');
  });

  it('falls back to the slug when the catalog is unreachable', () => {
    const html = renderSheet(createPackInstallState('agency-kit', true));
    expect(html).toContain('Add agency-kit to HQ?');
  });

  it('asks the person to sign in first and offers no Add', () => {
    const html = renderSheet(createPackInstallState('agency-kit', false));
    expect(html).toContain('data-phase="signed-out"');
    expect(html).toContain('Sign in to add agency-kit');
    expect(html).toContain('data-testid="pack-sheet-signed-out"');
    expect(html).not.toContain('data-testid="pack-sheet-add"');
  });

  it('shows progress lines while installing', () => {
    let state = beginInstall(named);
    state = appendInstallLine(state, 'Downloading hq-pack-agency-kit 0.3.0');
    state = appendInstallLine(state, 'bot: agency-guide');
    const html = renderSheet(state);
    expect(html).toContain('data-phase="installing"');
    expect(html).toContain('Adding Agency Kit');
    expect(html).toContain('Downloading hq-pack-agency-kit 0.3.0');
    expect(html).toContain('bot: agency-guide');
    expect(html).not.toContain('data-testid="pack-sheet-add"');
  });

  it('names the bot when done and offers Messages when there is no DM to open', () => {
    const withBot = renderSheet(finishInstall(beginInstall(named), 'agency-guide'));
    expect(withBot).toContain('Agency Kit added');
    expect(withBot).toContain('agency-guide');
    const withoutBot = renderSheet(finishInstall(beginInstall(named), null), vi.fn());
    expect(withoutBot).toContain('Its bot will appear in Messages');
    expect(withoutBot).toContain('Open Messages');
  });

  it('reports a failure with Try again and Close', () => {
    const html = renderSheet(failInstall(beginInstall(named), new Error('`hq packages install agency-kit --start-bot` exited 1')));
    expect(html).toContain('data-phase="failed"');
    expect(html).toContain('Couldn’t add Agency Kit');
    expect(html).toContain('exited 1');
    expect(html).toContain('data-testid="pack-sheet-retry"');
    expect(html).toContain('>Close<');
  });
});
