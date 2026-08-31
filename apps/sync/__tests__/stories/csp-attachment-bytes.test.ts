/**
 * Regression: chat-attachment bytes in the desktop-alt Work window.
 *
 * The attachment viewer resolves bytes through the Rust vault_s3_get hop and
 * hands the webview a blob: object URL, and inline message thumbs use the
 * presigned https: vault URL directly. A CSP img-src without blob:/https:
 * blocks both — the viewer showed "Could not load the file" and received
 * images degraded to filename chips even though presign + download succeeded.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');

describe('desktop-alt CSP allows attachment bytes', () => {
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

  it('img-src allows blob object URLs (attachment viewer bytes)', () => {
    expect(directive('img-src')).toContain('blob:');
  });

  it('img-src allows presigned https vault URLs (inline message thumbs)', () => {
    expect(directive('img-src')).toContain('https:');
  });

  it('keeps the existing local sources', () => {
    expect(directive('img-src')).toEqual(
      expect.arrayContaining(["'self'", 'data:', 'asset:']),
    );
  });
});
