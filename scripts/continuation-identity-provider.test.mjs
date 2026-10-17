import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const oauth = readFileSync(new URL('../apps/sync/src-tauri/src/commands/oauth.rs', import.meta.url), 'utf8');
const desktopAuth = readFileSync(new URL('../apps/sync/src-tauri/src/commands/desktop_auth.rs', import.meta.url), 'utf8');

describe('desktop continuation provider contract', () => {
  it('rejects a blank provider before listener mutation', () => {
    const arm = oauth.split('pub(crate) fn arm_oauth_flow(')[1].split('pub(crate) fn set_pending_referral_nonce')[0];
    assert.match(arm, /identity_provider: Option<&str>/);
    const rejectBlank = arm.indexOf('if identity_provider.is_some_and(|provider| provider.trim().is_empty())');
    assert.ok(rejectBlank >= 0);
    assert.ok(rejectBlank < arm.indexOf('cancel_pending_listener(None)'));
    assert.match(arm.slice(rejectBlank, arm.indexOf('let state =')), /return Err\(/);
  });

  it('leaves provider selection to signin-start and guards browser launch', () => {
    const start = desktopAuth.split('pub async fn desktop_continuation_start(')[1].split('pub async fn ')[0];
    assert.ok(start.includes('arm_oauth_flow(&app, None, Some(&nonce))'));
    assert.ok(start.includes('prepare_desktop_referral_start_url(&armed.authorize_url)'));
    assert.ok(start.includes('set_pending_referral_nonce(&armed.state, &referral_nonce)'));
    const guard = start.indexOf('validate_browser_signin_url(&browser_url)');
    assert.ok(guard >= 0 && guard < start.indexOf('app.shell().open'));
  });
});

it('manual sign-in returns only the validated signin-start wrapper', () => {
  const start = oauth.split('pub async fn start_oauth_login(')[1].split('async fn resolve_identity_provider')[0];
  assert.ok(start.includes('prepare_desktop_referral_start_url('));
  assert.ok(start.includes('arm_oauth_flow(&app, Some(&identity_provider), None)'));
  const prepare = desktopAuth.split('pub(crate) async fn prepare_desktop_referral_start_url(')[1].split('pub(crate) async fn')[0];
  assert.ok(prepare.includes('desktop_signin_link::signin_start_url('));
  assert.ok(prepare.indexOf('validate_browser_signin_url(&browser_url)') >= 0);
  assert.ok(prepare.indexOf('validate_browser_signin_url(&browser_url)') < prepare.indexOf('Ok((browser_url, link))'));
});
