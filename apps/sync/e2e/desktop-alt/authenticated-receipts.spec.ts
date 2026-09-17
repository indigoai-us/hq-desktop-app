import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

function between(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  expect(startAt, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(endAt, `missing ${end}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe('authenticated desktop receipts — account and I/O boundary contracts', () => {
  const auth = readRepoFile('src-tauri/src/commands/auth.rs');
  const receipts = readRepoFile('src-tauri/src/commands/desktop_auth.rs');
  const workspaces = readRepoFile('src-tauri/src/commands/workspaces.rs');

  it('binds delivery to the identity in the exact bearer token sent', () => {
    expect(auth).toContain('pub(crate) fn notification_identity_from_bearer_token');
    const post = between(
      receipts,
      'async fn post_authenticated_desktop_receipt',
      'async fn flush_authenticated_desktop_receipts',
    );
    const resolveToken = post.indexOf('let jwt = super::sync::resolve_jwt().await?;');
    const bindIdentity = post.indexOf('receipt_matches_bearer_account(receipt, &jwt)');
    const postRequest = post.indexOf('.post(url)');
    expect(resolveToken).toBeGreaterThanOrEqual(0);
    expect(bindIdentity).toBeGreaterThan(resolveToken);
    expect(postRequest).toBeGreaterThan(bindIdentity);
    expect(receipts).toContain('auth::notification_identity_from_bearer_token(jwt)');
  });

  it('keeps the receipt in memory before scheduling durable persistence', () => {
    const schedule = between(
      receipts,
      'fn schedule_authenticated_desktop_receipt',
      'fn without_terminal_receipts',
    );
    expect(schedule.indexOf('custody.push(receipt);')).toBeGreaterThanOrEqual(0);
    expect(schedule.indexOf('tauri::async_runtime::spawn')).toBeGreaterThan(
      schedule.indexOf('custody.push(receipt);'),
    );
    expect(receipts).toContain('tauri::async_runtime::spawn_blocking(move || {');
    expect(receipts).toContain('enqueue_authenticated_desktop_receipts(pending)');
  });

  it('moves token and install-id filesystem work behind the command background boundary', () => {
    const login = between(
      receipts,
      'pub(crate) fn record_desktop_login_completed',
      '/// Record the company',
    );
    const loginBeforeBackground = login.slice(0, login.indexOf('tauri::async_runtime::spawn'));
    expect(loginBeforeBackground).not.toContain('desktop_receipt_base');

    const workspace = between(
      receipts,
      'pub(crate) fn record_desktop_workspace_selected',
      '// ── Anonymous HTTP',
    );
    const workspaceBeforeBackground = workspace.slice(
      0,
      workspace.indexOf('tauri::async_runtime::spawn'),
    );
    expect(workspaceBeforeBackground).not.toContain('cognito::get_tokens');
    expect(workspaceBeforeBackground).not.toContain('desktop_receipt_base');
    expect(workspaces).toContain('workspace_receipt_authorization()');
    expect(workspaces).toMatch(
      /record_desktop_workspace_selected\(\s*&app,\s*company_uid,\s*workspace_receipt_authorizer\.clone\(\),/,
    );
    expect(workspaces).not.toContain('record_desktop_workspace_selected(&app, company_uid).await');
  });
});
