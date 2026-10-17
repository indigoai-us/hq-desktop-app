import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const oauth = readFileSync(new URL('../apps/sync/src-tauri/src/commands/oauth.rs', import.meta.url), 'utf8');
const desktopAuth = readFileSync(new URL('../apps/sync/src-tauri/src/commands/desktop_auth.rs', import.meta.url), 'utf8');

describe('desktop continuation provider contract', () => {
  it('requires a provider at the shared arming boundary', () => {
    const arm = oauth.split('pub(crate) fn arm_oauth_flow(')[1].split('pub(crate) fn set_pending_referral_nonce')[0];
    assert.match(arm, /identity_provider: &str/);
    assert.ok(arm.includes('identity_provider: Some(identity_provider)'));
    assert.ok(arm.includes('Some(identity_provider.to_owned())'));
    const rejectBlank = arm.indexOf('if identity_provider.trim().is_empty()');
    assert.ok(rejectBlank >= 0);
    assert.ok(rejectBlank < arm.indexOf('cancel_pending_listener(None)'));
    assert.match(arm.slice(rejectBlank, arm.indexOf('let state =')), /return Err\(/);
  });

  it('uses the Google fallback with the continuation nonce and existing callback flow', () => {
    const start = desktopAuth.split('pub async fn desktop_continuation_start(')[1].split('pub async fn ')[0];
    assert.ok(start.includes('arm_oauth_flow(&app, "Google", Some(&nonce))'));
    assert.ok(start.includes('prepare_desktop_referral_start_url(&armed.authorize_url)'));
    assert.ok(start.includes('set_pending_referral_nonce(&armed.state, &referral_nonce)'));
  });
});
