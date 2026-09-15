import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const banner = readFileSync(
  resolve(process.cwd(), 'src/components/BannerNotification.svelte'),
  'utf8',
);

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('US-016: V4 connective tissue stays complete', () => {

  it('keeps banner notifications source-agnostic with click, action, and dismiss affordances', () => {
    expect(banner).toContain('kind: string;');
    expect(banner).toContain('actionLabel?: string | null;');
    expect(banner).toContain('actionId?: string | null;');
    expect(banner).toContain('clickActionId: string;');
    expect(banner).toContain("listen<BannerPayload>('banner:event'");
    expect(banner).toContain("invoke('banner_window_ready')");
    expect(banner).toContain("requestId: createActionRequestId()");
    expect(banner).toContain("action: actionId");
    expect(banner).toContain("payload,");
    expect(banner).toContain("invoke('dismiss_banner')");
    expect(banner).toContain('data-kind={payload.kind}');
    expect(banner).toContain('{payload.actionLabel}');
  });
});
