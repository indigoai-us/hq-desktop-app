import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import type { WizardStepId } from './onboarding-wizard';

/**
 * Anonymous POST to POST /v1/installer/step. Ported from
 * imports/hq-installer-react/src/lib/telemetry.ts `pingStep`.
 *
 * The server is already live (hq-pro installer-telemetry). Trust model: the
 * spine is the caller-supplied `installSessionId`. No authentication. Failures
 * are swallowed — a telemetry miss must never block the onboarding wizard.
 *
 * Body shape:
 * {
 *   installSessionId: string,  // required, same value as desktop_onboarding_step sessionId
 *   step: string,              // required, mapped installer funnel name
 *   version: string,
 *   ts: number,
 *   deviceId?: string,         // hashed machine id; omitted when unavailable
 *   personUid?: string         // prs_* only; omitted until sign-in + person entity
 * }
 */

const DEFAULT_STEP_ENDPOINT = 'https://telemetry.hq.computer/v1/installer/step';
const PERSON_UID_RE = /^prs_[A-Za-z0-9_-]{1,64}$/;

export type InvokeCommand = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export type InstallerFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status'>>;

/**
 * Historical installer funnel (880 rows, versions 0.12.0–0.14.4):
 *   welcome → install → signin → setup → done
 *
 * apps/sync wizard steps map onto that vocabulary wherever a step genuinely
 * corresponds. New names are introduced only when there is no equivalent.
 * Post-ready extras are omitted so they do not fork the install funnel.
 *
 *   welcome-signin     → signin
 *                        + welcome on first-run `entered`
 *                          (this panel is both the first screen and the
 *                          auth surface; historical welcome and signin
 *                          were sequential screens, now combined)
 *   directory          → install   (HQ folder selection)
 *   setup              → setup
 *   consent            → consent   (new; asked after person provision)
 *   connector-import   → connector-import (new)
 *   ready              → done      (first-run completion / launch)
 *   trust, settings, run-setup, handoff, build → omitted
 */
export const INSTALLER_STEP_BY_WIZARD_STEP = {
  'welcome-signin': 'signin',
  directory: 'install',
  setup: 'setup',
  consent: 'consent',
  'connector-import': 'connector-import',
  ready: 'done',
  trust: null,
  settings: null,
  'run-setup': null,
  handoff: null,
  build: null,
} as const satisfies Record<WizardStepId, string | null>;

export function installerStepsForOnboarding(input: {
  step: WizardStepId;
  action: string;
  flow?: string;
}): string[] {
  const mapped = INSTALLER_STEP_BY_WIZARD_STEP[input.step];
  const steps: string[] = [];
  if (input.step === 'welcome-signin' && input.action === 'entered' && input.flow !== 'resume') {
    steps.push('welcome');
  }
  if (mapped) steps.push(mapped);
  return steps;
}

export function getInstallerStepEndpoint(): string | null {
  const override = import.meta.env.VITE_INSTALLER_STEP_URL as string | undefined;
  // Explicit empty string disables (local/dev). Undefined uses production.
  if (override === '') return null;
  return override ?? DEFAULT_STEP_ENDPOINT;
}

export function isInstallerPersonUid(value: string | null | undefined): value is string {
  return typeof value === 'string' && PERSON_UID_RE.test(value);
}

let deviceIdCache: string | undefined;

async function getDeviceId(invokeCommand: InvokeCommand): Promise<string | undefined> {
  if (deviceIdCache) return deviceIdCache;
  try {
    const id = await invokeCommand('device_fingerprint');
    if (typeof id === 'string' && id) {
      deviceIdCache = id;
      return id;
    }
  } catch {
    // Best-effort: a missing fingerprint must not block or log the raw value.
  }
  return undefined;
}

/** Test-only: clear the memoized device id between cases. */
export function __resetInstallerStepTelemetryForTests(): void {
  deviceIdCache = undefined;
}

export interface PingInstallerStepOptions {
  installSessionId: string;
  step: string;
  personUid?: string;
  version?: string;
  fetch?: InstallerFetch;
  invokeCommand?: InvokeCommand;
  now?: () => number;
  endpoint?: string | null;
}

/**
 * Fire-and-forget ping for one installer funnel step. Anonymous by
 * `installSessionId`; attaches `personUid` once a real `prs_*` is known and a
 * best-effort hashed device id. Never throws.
 */
export async function pingInstallerStep(opts: PingInstallerStepOptions): Promise<void> {
  try {
    const endpoint = opts.endpoint === undefined ? getInstallerStepEndpoint() : opts.endpoint;
    if (!endpoint) return;
    const invokeCommand = opts.invokeCommand ?? (invoke as InvokeCommand);
    const deviceId = await getDeviceId(invokeCommand);
    const personUid = isInstallerPersonUid(opts.personUid) ? opts.personUid : undefined;
    const body: Record<string, string | number> = {
      installSessionId: opts.installSessionId,
      step: opts.step,
      version: opts.version ?? appVersion(),
      ts: (opts.now ?? Date.now)(),
    };
    if (personUid) body.personUid = personUid;
    if (deviceId) body.deviceId = deviceId;
    const fetchFn = opts.fetch ?? tauriFetch;
    await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // Telemetry failure must never block, delay, or error the wizard.
  }
}

function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'unknown';
}
