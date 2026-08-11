/**
 * Command-palette console deep links (US-003).
 *
 * Surfaces dropped from the desktop shell (Deployments, Secrets, Activity,
 * Telescope, Company settings) still live in the HQ web console. These entries
 * back the palette's "Open … in HQ Console" rows so keyboard users can jump
 * straight into the browser.
 */

import {
  HQ_CONSOLE_BASE,
  companyConsoleUrl,
  companySettingsUrl,
} from './hq-console';

export interface ConsoleDeepLink {
  id: string;
  label: string;
  detail: string;
  url: string;
}

/**
 * Palette rows that open HQ Console surfaces in the system browser.
 * `slug` is the active workspace company; when null, only the non-company
 * Deployments entry is returned.
 */
export function consoleDeepLinks(slug: string | null): ConsoleDeepLink[] {
  const deployments: ConsoleDeepLink = {
    id: 'command-go-console-deployments',
    label: 'Open Deployments in HQ Console',
    detail: 'Opens the HQ web console Deployments page in the browser',
    url: `${HQ_CONSOLE_BASE}/deployments`,
  };

  if (slug === null) {
    return [deployments];
  }

  const companyHome = companyConsoleUrl(slug);

  return [
    deployments,
    {
      id: 'command-go-console-secrets',
      label: 'Open Secrets in HQ Console',
      detail: `Opens Secrets for ${slug} in the HQ web console (browser)`,
      url: `${companyHome}/secrets`,
    },
    {
      id: 'command-go-console-activity',
      label: 'Open Activity in HQ Console',
      detail: `Opens Activity for ${slug} in the HQ web console (browser)`,
      url: `${companyHome}/activity`,
    },
    {
      id: 'command-go-console-telescope',
      label: 'Open Telescope in HQ Console',
      detail: `Opens Telescope for ${slug} in the HQ web console (browser)`,
      url: `${companyHome}/telescope`,
    },
    {
      id: 'command-go-console-settings',
      label: 'Open Company settings in HQ Console',
      detail: `Opens Company settings for ${slug} in the HQ web console (browser)`,
      url: companySettingsUrl(slug),
    },
  ];
}
