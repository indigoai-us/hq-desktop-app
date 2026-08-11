import { describe, it, expect } from 'vitest';

import { HQ_CONSOLE_BASE, companySettingsUrl } from './hq-console';
import { consoleDeepLinks } from './console-links';

describe('consoleDeepLinks', () => {
  it('returns 5 entries for a company slug', () => {
    const links = consoleDeepLinks('indigo');
    expect(links).toHaveLength(5);
  });

  it('puts company-scoped URLs under /companies/<encoded slug>', () => {
    const slug = 'my co';
    const links = consoleDeepLinks(slug);
    const companyBase = `${HQ_CONSOLE_BASE}/companies/${encodeURIComponent(slug)}`;

    const byId = Object.fromEntries(links.map((link) => [link.id, link]));

    expect(byId['command-go-console-deployments'].url).toBe(
      `${HQ_CONSOLE_BASE}/deployments`,
    );
    expect(byId['command-go-console-secrets'].url).toBe(`${companyBase}/secrets`);
    expect(byId['command-go-console-activity'].url).toBe(`${companyBase}/activity`);
    expect(byId['command-go-console-telescope'].url).toBe(`${companyBase}/telescope`);
    expect(byId['command-go-console-settings'].url).toBe(companySettingsUrl(slug));
    expect(byId['command-go-console-settings'].url).toBe(`${companyBase}/settings`);
  });

  it('returns only Deployments when slug is null', () => {
    const links = consoleDeepLinks(null);
    expect(links).toHaveLength(1);
    expect(links[0].id).toBe('command-go-console-deployments');
    expect(links[0].url).toBe(`${HQ_CONSOLE_BASE}/deployments`);
  });

  it('prefixes every id with command-go-console-', () => {
    for (const link of consoleDeepLinks('indigo')) {
      expect(link.id.startsWith('command-go-console-')).toBe(true);
    }
    for (const link of consoleDeepLinks(null)) {
      expect(link.id.startsWith('command-go-console-')).toBe(true);
    }
  });
});
