import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelFileItemModel } from '@hq/ui';
import {
  createNativeHqProFetch,
  createNativeWorkShellCapabilities,
  type NativeInvokeFn,
} from './work-shell-capabilities';

const projectFile: ChannelFileItemModel = {
  key: 'projects/launch/brief.md',
  vaultPath: 'projects/launch/brief.md',
  companyUid: 'cmp_indigo',
  name: 'brief.md',
  caption: 'PROJECT',
  iconKind: 'markdown',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('native WorkShell capabilities', () => {
  it('routes hq-pro requests through the native command without browser fetch', async () => {
    const invoke = vi.fn(async () => ({ status: 200, body: '{"ok":true}' }));
    const browserFetch = vi.fn(async () =>
      new Response('{"ok":true}', { status: 200 }),
    );
    vi.stubGlobal('fetch', browserFetch);
    const fetch = createNativeHqProFetch(invoke as NativeInvokeFn);

    await expect(
      fetch('/v1/work-mesh/work', {
        method: 'POST',
        body: JSON.stringify({ company: 'cmp_indigo' }),
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(browserFetch).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('hq_pro_fetch', {
      url: '/v1/work-mesh/work',
      method: 'POST',
      body: JSON.stringify({ company: 'cmp_indigo' }),
    });
  });

  it('uses the native Vault get hop for previews and supplies native identity', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'get_auth_session') return { status: 'active' };
      if (command === 'whoami') {
        return {
          personUid: 'prs_ada',
          email: 'ada@example.test',
          displayName: 'Ada Lovelace',
        };
      }
      if (command === 'hq_pro_fetch') {
        return {
          status: 200,
          body: JSON.stringify({ results: [{ url: 'https://vault.test/brief.md' }] }),
        };
      }
      return undefined;
    });
    const browserFetch = vi.fn();
    const getVaultObject = vi.fn(async () =>
      new Response('# Native brief', {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      }),
    );
    vi.stubGlobal('fetch', browserFetch);

    const capabilities = await createNativeWorkShellCapabilities({
      invoke: invoke as NativeInvokeFn,
      getVaultObject,
    });

    await expect(
      capabilities.loadFilePreview(projectFile, 'cmp_indigo'),
    ).resolves.toEqual({ kind: 'text', text: '# Native brief' });
    expect(invoke).toHaveBeenCalledWith('hq_pro_fetch', {
      url: '/v1/files/presign',
      method: 'POST',
      body: JSON.stringify({
        company: 'cmp_indigo',
        op: 'get',
        key: 'projects/launch/brief.md',
      }),
    });
    expect(getVaultObject).toHaveBeenCalledWith(
      'https://vault.test/brief.md',
      2 * 1024 * 1024,
    );
    expect(browserFetch).not.toHaveBeenCalled();
    expect(capabilities.hostIdentity).toEqual({
      sub: 'prs_ada',
      email: 'ada@example.test',
      name: 'Ada Lovelace',
    });
    capabilities.onUnauthorized();
    expect(invoke).toHaveBeenCalledWith('sign_out');
  });
});
