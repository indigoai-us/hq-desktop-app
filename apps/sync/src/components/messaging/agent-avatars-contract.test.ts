// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { mount, unmount } from 'svelte';
import { agentAvatarAssets } from '@hq/ui';
import IdentityMark from './IdentityMark.svelte';

const dir = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(dir, '../../../../../packages/ui/src');

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
});

describe('sync messaging agent-avatar contract', () => {

  it('renders a generated avatar for an agent IdentityMark', () => {
    component = mount(IdentityMark, {
      target: host,
      props: { kind: 'agent', agentUid: 'agt_x', label: 'X' },
    });

    const img = host.querySelector('img.avatar-img');
    expect(img).not.toBeNull();
    expect(agentAvatarAssets).toContain(img?.getAttribute('src'));
  });
});
