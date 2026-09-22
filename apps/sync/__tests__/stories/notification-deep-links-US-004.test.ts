import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseHqUrl } from '../../src/desktop-alt/lib/deepLink';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

const deepLinkRs = read('src-tauri/src/deep_link.rs');
const mainRs = read('src-tauri/src/main.rs');
const tauriConf = read('src-tauri/tauri.conf.json');
const infoPlist = read('src-tauri/Info.plist');
const routeTs = read('src/desktop-alt/lib/route.ts');
const deepLinkTs = read('src/desktop-alt/lib/deepLink.ts');
const hostTs = read('src/desktop-alt/hq-work-host.ts');

describe('US-004: hq:// URL scheme maps onto the route grammar', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  afterEach(() => {
    warn.mockClear();
  });

  it('registers hq as an additional scheme next to hq-desktop', () => {
    expect(tauriConf).toContain('"hq-desktop"');
    expect(tauriConf).toContain('"hq"');
    const schemesBlock = tauriConf.slice(
      tauriConf.indexOf('"schemes"'),
      tauriConf.indexOf('"updater"'),
    );
    expect(schemesBlock).toContain('hq-desktop');
    expect(schemesBlock).toContain('"hq"');
    expect(infoPlist).toContain('CFBundleURLSchemes');
    expect(infoPlist).toContain('hq-desktop');
    expect(infoPlist).toContain('<string>hq</string>');
    expect(mainRs).toContain('register(scheme)');
    expect(mainRs).toContain('"hq-desktop", "hq"');
  });

  it('running app + hq://inbox/dm/<uid> fronts the DM thread', () => {
    expect(parseHqUrl('hq://inbox/dm/prs_ada')).toBe('inbox:dm:prs_ada');
    expect(deepLinkRs).toContain('spawn_open_hq_url');
    expect(deepLinkRs).toContain('open_desktop_alt_window_inner');
    expect(deepLinkRs).toContain('inbox:dm:');
    expect(mainRs).toContain('spawn_open_delivered_url');
    expect(mainRs).toContain('spawn_open_hq_url');
    expect(hostTs).toContain("parseHqUrl");
    expect(routeTs).toContain('inbox:dm:<personUid>');
  });

  it('quit app + hq://inbox/channel/<id> launches on that channel (pending-route path)', () => {
    expect(parseHqUrl('hq://inbox/channel/chn_eng')).toBe(
      'inbox:channel:chn_eng',
    );
    expect(mainRs).toContain('hq_url_from_argv(&startup_args)');
    expect(mainRs).toContain('spawn_open_hq_url(app.handle(), url)');
    expect(deepLinkRs).toContain('hq_url_from_argv');
    expect(deepLinkRs).toContain('parse_hq_url');
    expect(deepLinkRs).toContain('open_desktop_alt_window_inner');
    expect(deepLinkRs).toContain('inbox:channel:');
  });

  it('malformed hq:// fronts the landing route and logs a warning', () => {
    expect(parseHqUrl('hq://not-a-real-target')).toBeNull();
    expect(warn).toHaveBeenCalled();
    const message = String(warn.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('HQ_URL_IGNORE');
    expect(message).not.toContain('not-a-real-target');
    expect(deepLinkRs).toContain('HQ_URL_IGNORE len=');
    expect(deepLinkRs).toContain('open_desktop_alt_window_inner(handle, mapped)');
    expect(deepLinkRs).toContain('if route.is_none()');
    expect(deepLinkTs).toContain('HQ_URL_IGNORE len=');
    expect(deepLinkTs).toContain('segs=');
    expect(deepLinkTs).not.toContain('console.warn(raw');
    expect(deepLinkTs).not.toContain('console.warn(trimmed');
  });
});
