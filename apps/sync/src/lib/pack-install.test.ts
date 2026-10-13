import { describe, expect, it } from 'vitest';
import {
  appendInstallLine,
  beginInstall,
  createPackInstallState,
  failInstall,
  finishInstall,
  isPackInstallProgress,
  isValidPackSlug,
  localBotAgentUid,
  PACK_INSTALL_LINE_CAP,
  packDisplayLabel,
  withDisplayName,
  withSignedIn,
} from './pack-install';

describe('pack deep-link sheet state', () => {
  it('accepts only the native slug grammar', () => {
    expect(isValidPackSlug('agency-kit')).toBe(true);
    expect(isValidPackSlug('a1')).toBe(true);
    expect(isValidPackSlug('a'.repeat(64))).toBe(true);
    expect(isValidPackSlug('a')).toBe(false);
    expect(isValidPackSlug('a'.repeat(65))).toBe(false);
    expect(isValidPackSlug('Agency')).toBe(false);
    expect(isValidPackSlug('agency_kit')).toBe(false);
    expect(isValidPackSlug('agency kit')).toBe(false);
    expect(isValidPackSlug(undefined)).toBe(false);
  });

  it('starts signed-out or at the confirmation depending on the session', () => {
    expect(createPackInstallState('agency-kit', false).phase).toBe('signed-out');
    expect(createPackInstallState('agency-kit', true).phase).toBe('confirm');
  });

  it('moves a signed-out sheet to confirm after sign-in and never interrupts an install', () => {
    const waiting = createPackInstallState('agency-kit', false);
    expect(withSignedIn(waiting, true).phase).toBe('confirm');
    const installing = beginInstall(createPackInstallState('agency-kit', true));
    expect(withSignedIn(installing, false).phase).toBe('installing');
    expect(withSignedIn(createPackInstallState('agency-kit', true), false).phase).toBe('signed-out');
  });

  it('shows the catalog name when known and the slug otherwise', () => {
    const state = createPackInstallState('agency-kit', true);
    expect(packDisplayLabel(state)).toBe('agency-kit');
    expect(packDisplayLabel(withDisplayName(state, 'Agency Kit'))).toBe('Agency Kit');
    expect(packDisplayLabel(withDisplayName(state, '   '))).toBe('agency-kit');
    expect(packDisplayLabel(withDisplayName(state, 42))).toBe('agency-kit');
  });

  it('keeps a bounded, ANSI-free progress tail', () => {
    let state = beginInstall(createPackInstallState('agency-kit', true));
    state = appendInstallLine(state, '\u001b[32mInstalling\u001b[0m hq-pack-agency-kit  ');
    state = appendInstallLine(state, '   ');
    state = appendInstallLine(state, 12);
    expect(state.lines).toEqual(['Installing hq-pack-agency-kit']);
    for (let i = 0; i < PACK_INSTALL_LINE_CAP + 5; i += 1) state = appendInstallLine(state, `line ${i}`);
    expect(state.lines).toHaveLength(PACK_INSTALL_LINE_CAP);
    expect(state.lines.at(-1)).toBe(`line ${PACK_INSTALL_LINE_CAP + 4}`);
  });

  it('records the bot on success and a readable error on failure', () => {
    const installing = beginInstall(createPackInstallState('agency-kit', true));
    const done = finishInstall(installing, 'agency-guide');
    expect(done.phase).toBe('done');
    expect(done.botName).toBe('agency-guide');
    expect(finishInstall(installing, null).botName).toBeNull();
    expect(failInstall(installing, new Error('exit 1')).error).toBe('exit 1');
    expect(failInstall(installing, '  spawn failed ')).toMatchObject({ phase: 'failed', error: 'spawn failed' });
    expect(failInstall(installing, { odd: true }).error).toBe('The pack could not be installed.');
  });

  it('only takes progress lines streamed for this install', () => {
    expect(isPackInstallProgress({ op: 'pack-deep-link', name: 'agency-kit', line: 'x' }, 'agency-kit')).toBe(true);
    expect(isPackInstallProgress({ op: 'install', name: 'agency-kit', line: 'x' }, 'agency-kit')).toBe(false);
    expect(isPackInstallProgress({ op: 'pack-deep-link', name: 'other', line: 'x' }, 'agency-kit')).toBe(false);
    expect(isPackInstallProgress(null, 'agency-kit')).toBe(false);
  });

  it('finds the started bot in a local bot listing', () => {
    const listing = { bots: [{ name: 'setup', agentUid: 'agt_1' }, { name: 'agency-guide', agentUid: ' agt_2 ' }] };
    expect(localBotAgentUid(listing, 'agency-guide')).toBe('agt_2');
    expect(localBotAgentUid(listing.bots, 'setup')).toBe('agt_1');
    expect(localBotAgentUid(listing, 'missing')).toBeNull();
    expect(localBotAgentUid(listing, null)).toBeNull();
    expect(localBotAgentUid({ bots: [{ name: 'agency-guide', agentUid: '' }] }, 'agency-guide')).toBeNull();
  });
});
