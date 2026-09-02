/**
 * Regression: chat-attachment bytes in the desktop-alt Work window.
 *
 * The packaged CSP deliberately blocks remote img-src (no auto-loading
 * tracking images — see e2e/desktop-alt/tauri-conf.spec.ts), so attachment
 * images can never render straight off the presigned https vault URL.
 * Instead the host pulls bytes over the Rust vault_s3_get hop and hands the
 * webview a blob: object URL — which the CSP must allow, or the viewer shows
 * "Could not load the file" and received images degrade to filename chips
 * even though presign + download succeeded.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');

describe('desktop-alt CSP allows local attachment bytes', () => {
  const conf = JSON.parse(
    readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'),
  ) as { app: { security: { csp: string } } };

  function directive(name: string): string[] {
    const part = conf.app.security.csp
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${name} `) || s === name);
    return part ? part.split(/\s+/).slice(1) : [];
  }

  it('img-src allows blob object URLs (attachment thumbs + viewer bytes)', () => {
    expect(directive('img-src')).toContain('blob:');
  });

  it('keeps the existing local sources', () => {
    expect(directive('img-src')).toEqual(
      expect.arrayContaining(["'self'", 'data:', 'asset:']),
    );
  });

  it('still blocks remote images (tracking-pixel contract)', () => {
    const csp = conf.app.security.csp;
    // Marketplace covers are the only remote img-src; wildcards stay forbidden.
    expect(csp).toContain(
      'https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com',
    );
    expect(csp).not.toMatch(/img-src[^;]*\*/i);
    expect(csp).not.toMatch(/img-src[^;]*https:\s/i);
    expect(csp).not.toMatch(/img-src[^;]*https:\/\/\*/i);
  });
});
