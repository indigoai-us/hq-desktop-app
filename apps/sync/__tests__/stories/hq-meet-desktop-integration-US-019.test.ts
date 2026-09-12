// @vitest-environment happy-dom
//
// US-019 story acceptance tests (Desktop host side) — "Deliver subtle knocks
// and explicit open-door actions".
//
// The shared surface is pinned in `packages/ui/src/meet/US-019.story.test.ts`.
// This file pins what only the Desktop host can get wrong, through the panel
// the shell actually mounts and an injected `invoke`:
//
//  * the SENDER path — knocking on a person opens (or reuses) OUR OWN
//    company-visible room first and binds it into the knock, because the
//    backend issues the admission capability to the knocker, not the target;
//    a stale binding is worth exactly one retry with a fresh room; and an
//    acceptance opens exactly ONE call window, carrying the knock binding and
//    no credential of any kind;
//  * the RECEIVER path — accepting goes through the authorized accept route
//    and, on success, joins the knocker's room on our OWN membership with NO
//    capability attached and nothing captured; a server refusal is surfaced and
//    no window opens at all;
//  * and the quiet answers — defer, dismiss and a text reply never open a
//    window, and are always followed by a fresh authoritative `GET /knocks`.
//
// Everything is driven through an injected `invoke`; no Tauri, no network, no
// real clock, no capture.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async () => null as unknown),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { flushSync, mount, tick, unmount } from 'svelte';

import OfficePanel from '../../src/desktop-alt/panels/OfficePanel.svelte';
import serviceEvidence from '../../src/call/service-evidence.json';

const RUN_AT = Date.parse((serviceEvidence as { runAt: string }).runAt);
const COMPANY = 'cmp_indigo';
const SELF = 'prs_self';
const MATE = 'prs_mate';
/** The panel's default knock poll, and therefore this file's heartbeat. */
const POLL_MS = 10_000;

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;
let getUserMedia: ReturnType<typeof vi.fn>;

interface Fetched {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(RUN_AT + 60_000);
  tauri.invoke.mockReset();
  // Watched for the whole file: a knock, an acceptance and a window must never
  // reach for a microphone or a camera from here.
  getUserMedia = vi.fn(async () => {
    throw new Error('capture must not start from a knock');
  });
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices: async () => [] },
  });
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
    await tick();
    flushSync();
  }
}

async function poll(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settle();
  }
}

function person(personUid: string, willingness: string) {
  return { personUid, connectivity: 'online', willingness };
}

const OFFICE_BODY = JSON.stringify({
  companyUid: COMPANY,
  observedAt: RUN_AT,
  people: [person(SELF, 'knock'), person(MATE, 'knock')],
});

interface KnockSeed {
  [key: string]: unknown;
}

function knockRow(overrides: KnockSeed = {}): Record<string, unknown> {
  const at = RUN_AT + 60_000;
  return {
    knockId: 'knk_in',
    companyUid: COMPANY,
    roomId: 'room_mate',
    callId: 'call_mate',
    epoch: 7,
    from: MATE,
    target: SELF,
    note: 'two minutes?',
    state: 'pending',
    createdAt: at - 1_000,
    updatedAt: at - 1_000,
    expiresAt: at + 45_000,
    ...overrides,
  };
}

interface HostOptions {
  /** Answers for `GET /v1/meet-native/knocks`, consumed in order (last repeats). */
  listings?: Array<Record<string, unknown>[]>;
  /** Answer for `GET /v1/meet-native/knocks/{id}`. */
  getKnock?: (knockId: string) => { status: number; body: string };
  /** Answer for `POST /v1/meet-native/knocks/{id}/{action}`. */
  respond?: (
    knockId: string,
    action: string,
  ) => { status: number; body: string };
  /** Answer for `POST /v1/meet-native/knocks`. */
  createKnock?: (
    body: Record<string, unknown>,
    attempt: number,
  ) => { status: number; body: string };
}

interface Harness {
  root: HTMLElement;
  fetched: Fetched[];
  windows: Array<Record<string, unknown>>;
  dms: Array<Record<string, unknown>>;
  urls: (match: string) => Fetched[];
}

/** Mount the desktop panel over an invoke seam that speaks the knock routes. */
async function render(options: HostOptions = {}): Promise<Harness> {
  const fetched: Fetched[] = [];
  const windows: Array<Record<string, unknown>> = [];
  const dms: Array<Record<string, unknown>> = [];
  const listings = options.listings ?? [[]];
  let listIndex = 0;
  let roomSeq = 0;
  let knockAttempt = 0;

  const invokeFn = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'get_auth_state') {
      return { authenticated: true, accountId: SELF, email: 'a@b.c' };
    }
    if (cmd === 'whoami') return { personUid: SELF, email: 'a@b.c' };
    if (cmd === 'device_fingerprint') return 'dev_self';
    if (cmd === 'calls_open_window') {
      windows.push((args?.target ?? {}) as Record<string, unknown>);
      return null;
    }
    if (cmd === 'send_dm') {
      dms.push((args ?? {}) as Record<string, unknown>);
      return { ok: true };
    }
    if (cmd !== 'hq_pro_fetch') return null;

    const url = String(args?.url ?? '');
    const method = String(args?.method ?? '');
    const raw = typeof args?.body === 'string' ? args.body : '';
    let parsed: Record<string, unknown> = {};
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    fetched.push({ url, method, body: parsed });

    if (url.startsWith('/v1/meet-native/office')) {
      return { status: 200, body: OFFICE_BODY };
    }
    if (url === '/v1/meet-native/rooms' && method === 'POST') {
      roomSeq += 1;
      return {
        status: 200,
        body: JSON.stringify({
          room: { roomId: `room_self_${roomSeq}` },
          call: { callId: `call_self_${roomSeq}`, epoch: roomSeq },
        }),
      };
    }
    if (url === '/v1/meet-native/knocks' && method === 'POST') {
      knockAttempt += 1;
      return options.createKnock
        ? options.createKnock(parsed, knockAttempt)
        : {
            status: 200,
            body: JSON.stringify({ created: true, waked: true }),
          };
    }
    if (url.startsWith('/v1/meet-native/knocks?') && method === 'GET') {
      const rows = listings[Math.min(listIndex, listings.length - 1)] ?? [];
      if (listIndex < listings.length - 1) listIndex += 1;
      return { status: 200, body: JSON.stringify({ knocks: rows }) };
    }
    const action = /\/v1\/meet-native\/knocks\/([^/?]+)\/([a-z]+)$/.exec(url);
    if (action && method === 'POST') {
      return options.respond
        ? options.respond(action[1], action[2])
        : { status: 200, body: JSON.stringify(knockRow()) };
    }
    const one = /\/v1\/meet-native\/knocks\/([^/?]+)/.exec(url);
    if (one && method === 'GET') {
      return options.getKnock
        ? options.getKnock(one[1])
        : { status: 200, body: JSON.stringify(knockRow()) };
    }
    return { status: 404, body: JSON.stringify({ code: 'NOT_FOUND' }) };
  });

  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(OfficePanel, {
    target: host,
    props: { companyUid: COMPANY, companyLabel: 'Indigo', invokeFn } as never,
  });
  flushSync();
  await settle();
  return {
    root: host!,
    fetched,
    windows,
    dms,
    urls: (match: string) => fetched.filter((call) => call.url.includes(match)),
  };
}

/** Open the composer on a member row and send the knock. */
async function knockOn(root: HTMLElement, personUid: string): Promise<void> {
  testid(root, `office-knock-${personUid}`)!.click();
  flushSync();
  testid(root, `office-knock-send-${personUid}`)!.click();
  await settle();
}

/** Ids only: a call-window target carries no token, key, secret or password. */
function assertNoCredentials(target: Record<string, unknown>): void {
  const serialized = JSON.stringify(target);
  expect(serialized).not.toMatch(/token|secret|password|jwt|bearer/i);
  for (const key of Object.keys(target)) {
    expect(key).not.toMatch(/token|secret|credential|password|key$/i);
  }
}

// ── sender path ──────────────────────────────────────────────────────────────

describe('US-019 desktop: knocking binds our own room and opens one door', () => {
  it('creates (or reuses) our own room and binds it into the knock', async () => {
    const harness = await render();
    await knockOn(harness.root, MATE);

    const rooms = harness.urls('/v1/meet-native/rooms');
    const knocks = harness.fetched.filter(
      (call) => call.url === '/v1/meet-native/knocks' && call.method === 'POST',
    );
    expect(rooms).toHaveLength(1);
    expect(knocks).toHaveLength(1);
    // The room is created BEFORE the knock — a knock bound to nothing is never
    // sent — and it is company-visible, because a PRIVATE room would only
    // accept a knock aimed at someone already inside it.
    expect(harness.fetched.indexOf(rooms[0])).toBeLessThan(
      harness.fetched.indexOf(knocks[0]),
    );
    expect(rooms[0].body.visibility).toBe('company');
    expect(knocks[0].body).toMatchObject({
      companyUid: COMPANY,
      roomId: 'room_self_1',
      callId: 'call_self_1',
      epoch: 1,
      target: MATE,
    });
    expect(typeof knocks[0].body.idempotencyKey).toBe('string');
    // Sending a knock is not a call: nothing opened, nothing captured.
    expect(harness.windows).toEqual([]);
    expect(getUserMedia).not.toHaveBeenCalled();

    // A second knock in the same session reuses the room rather than leaving
    // an abandoned one behind.
    await knockOn(harness.root, MATE);
    expect(harness.urls('/v1/meet-native/rooms')).toHaveLength(1);
  });

  it('retries a stale binding exactly once, with a freshly opened room', async () => {
    const harness = await render({
      createKnock: (_body, attempt) =>
        attempt === 1
          ? { status: 409, body: JSON.stringify({ code: 'STALE_EPOCH' }) }
          : { status: 200, body: JSON.stringify({ created: true, waked: true }) },
    });
    await knockOn(harness.root, MATE);

    const knocks = harness.fetched.filter(
      (call) => call.url === '/v1/meet-native/knocks' && call.method === 'POST',
    );
    expect(knocks).toHaveLength(2);
    expect(harness.urls('/v1/meet-native/rooms')).toHaveLength(2);
    // The retry used the NEW room, not the one the server just rejected.
    expect(knocks[0].body.roomId).toBe('room_self_1');
    expect(knocks[1].body.roomId).toBe('room_self_2');
    expect(knocks[1].body.callId).toBe('call_self_2');
    expect(harness.windows).toEqual([]);
  });

  it('opens exactly ONE window on acceptance, carrying the knock binding and no credential', async () => {
    const sent = {
      knockId: 'knk_out',
      companyUid: COMPANY,
      roomId: 'room_self_1',
      callId: 'call_self_1',
      epoch: 1,
      from: SELF,
      target: MATE,
      note: '',
      state: 'pending',
      createdAt: RUN_AT,
      updatedAt: RUN_AT,
      expiresAt: RUN_AT + 120_000,
    };
    let accepted = false;
    const harness = await render({
      createKnock: () => ({
        status: 200,
        body: JSON.stringify({ created: true, waked: true, knock: sent }),
      }),
      getKnock: () => {
        accepted = true;
        return {
          status: 200,
          body: JSON.stringify({
            ...sent,
            state: 'accepted',
            updatedAt: RUN_AT + 1_000,
            admissionCapability: {
              grantId: 'grant_1',
              expiresAt: RUN_AT + 90_000,
            },
          }),
        };
      },
    });
    await knockOn(harness.root, MATE);
    expect(harness.windows).toEqual([]);

    // The acceptance is observed through the authoritative re-read, not a wake.
    await poll(1);
    expect(accepted).toBe(true);
    expect(harness.windows).toHaveLength(1);
    const target = harness.windows[0];
    expect(target).toMatchObject({
      companyUid: COMPANY,
      roomId: 'room_self_1',
      callId: 'call_self_1',
      epoch: 1,
      knock: { knockId: 'knk_out', capabilityId: 'grant_1' },
    });
    expect(target.self).toEqual({ personUid: SELF, deviceId: 'dev_self' });
    assertNoCredentials(target);
    expect(getUserMedia).not.toHaveBeenCalled();

    // Re-reads keep arriving; the window is opened once per knock, not per poll.
    await poll(3);
    expect(harness.windows).toHaveLength(1);
  });
});

// ── receiver path ────────────────────────────────────────────────────────────

describe('US-019 desktop: opening the door goes through the server', () => {
  it('accepts through the authorized route and joins the knocker room with no capability', async () => {
    const harness = await render({
      listings: [[], [knockRow()]],
      respond: (knockId, action) => ({
        status: 200,
        body: JSON.stringify(
          knockRow({
            knockId,
            state: action === 'accept' ? 'accepted' : 'declined',
            updatedAt: RUN_AT + 61_000,
          }),
        ),
      }),
    });
    await poll(1);
    expect(testid(harness.root, 'knock-card-knk_in')).not.toBeNull();

    testid(harness.root, 'knock-accept-knk_in')!.click();
    await settle();

    const accept = harness.urls('/knocks/knk_in/accept');
    expect(accept).toHaveLength(1);
    expect(accept[0].method).toBe('POST');
    expect(accept[0].body.companyUid).toBe(COMPANY);
    expect(testid(harness.root, 'office-action-error')).toBeNull();

    expect(harness.windows).toHaveLength(1);
    const target = harness.windows[0];
    // We go to THEIR room, on our own membership. The capability the acceptance
    // minted belongs to the knocker and must not travel with us.
    expect(target).toMatchObject({
      companyUid: COMPANY,
      roomId: 'room_mate',
      callId: 'call_mate',
      epoch: 7,
    });
    expect(target).not.toHaveProperty('knock');
    assertNoCredentials(target);
    // Opening the door is not joining with media.
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it.each([
    ['CAPACITY_EXCEEDED', 'That room is full'],
    ['GRANT_EXPIRED', 'expired before you opened the door'],
    ['CALL_SEALED', 'Room ended'],
  ])('surfaces a %s refusal without entering the room', async (code, copy) => {
    const harness = await render({
      listings: [[], [knockRow()]],
      respond: () => ({ status: 409, body: JSON.stringify({ code }) }),
      getKnock: () => ({ status: 200, body: JSON.stringify(knockRow()) }),
    });
    await poll(1);
    testid(harness.root, 'knock-accept-knk_in')!.click();
    await settle();

    const error = testid(harness.root, 'office-action-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain(copy);
    expect(harness.windows).toEqual([]);
    expect(getUserMedia).not.toHaveBeenCalled();
    // The refusal is reported, not terminal: the surface stays usable.
    expect(testid(harness.root, 'office-list')).not.toBeNull();
  });

  it('says so and opens nothing when the knock is gone from the server entirely', async () => {
    const harness = await render({
      listings: [[], [knockRow()]],
      respond: () => ({ status: 404, body: JSON.stringify({ code: 'NOT_FOUND' }) }),
      getKnock: () => ({ status: 404, body: JSON.stringify({ code: 'NOT_FOUND' }) }),
    });
    await poll(1);
    testid(harness.root, 'knock-accept-knk_in')!.click();
    await settle();

    expect(testid(harness.root, 'office-action-error')?.textContent).toContain(
      'no longer exists',
    );
    expect(harness.windows).toEqual([]);
    expect(testid(harness.root, 'knock-card-knk_in')).toBeNull();
  });
});

// ── the quiet answers ────────────────────────────────────────────────────────

describe('US-019 desktop: defer, dismiss and reply never start a call', () => {
  async function answered(
    testId: string,
    expectedAction: string,
    expectedState: string,
  ): Promise<Harness> {
    let state = 'pending';
    const harness = await render({
      listings: [[], [knockRow()]],
      respond: (knockId, action) => {
        state = action === 'defer' ? 'deferred' : 'declined';
        return {
          status: 200,
          body: JSON.stringify(
            knockRow({ knockId, state, updatedAt: RUN_AT + 61_000 }),
          ),
        };
      },
      getKnock: () => ({
        status: 200,
        body: JSON.stringify(
          knockRow({ state, updatedAt: RUN_AT + 61_000 }),
        ),
      }),
    });
    await poll(1);
    const listsBefore = harness.urls('/v1/meet-native/knocks?').length;

    testid(harness.root, testId)!.click();
    await settle();

    const responded = harness.urls(`/knocks/knk_in/${expectedAction}`);
    expect(responded).toHaveLength(1);
    expect(responded[0].method).toBe('POST');
    expect(harness.windows).toEqual([]);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(testid(harness.root, 'knock-card-knk_in')?.dataset.state).toBe(
      expectedState,
    );

    // Reconciliation is not optional: the authoritative listing is read again,
    // so another window or device converges on the same answer.
    await poll(1);
    expect(harness.urls('/v1/meet-native/knocks?').length).toBeGreaterThan(
      listsBefore,
    );
    return harness;
  }

  it('defers without opening a window, then re-reads the authoritative list', async () => {
    await answered('knock-defer-knk_in', 'defer', 'deferred');
  });

  it('dismisses as a decline without opening a window', async () => {
    await answered('knock-dismiss-knk_in', 'decline', 'declined');
  });

  it('sends a text reply as a DM and then closes the door', async () => {
    let state = 'pending';
    const harness = await render({
      listings: [[], [knockRow()]],
      respond: (knockId, action) => {
        state = action === 'decline' ? 'declined' : state;
        return {
          status: 200,
          body: JSON.stringify(
            knockRow({ knockId, state, updatedAt: RUN_AT + 61_000 }),
          ),
        };
      },
      getKnock: () => ({
        status: 200,
        body: JSON.stringify(knockRow({ state, updatedAt: RUN_AT + 61_000 })),
      }),
    });
    await poll(1);
    const listsBefore = harness.urls('/v1/meet-native/knocks?').length;

    testid(harness.root, 'knock-reply-knk_in')!.click();
    flushSync();
    const box = testid(harness.root, 'knock-reply-text-knk_in') as
      | HTMLTextAreaElement
      | null;
    expect(box).not.toBeNull();
    box!.value = 'in a meeting — ten minutes?';
    box!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    testid(harness.root, 'knock-reply-send-knk_in')!.click();
    await settle();

    expect(harness.dms).toHaveLength(1);
    expect(harness.dms[0].toPersonUid).toBe(MATE);
    expect(harness.dms[0].body).toBe('in a meeting — ten minutes?');
    // Words instead of a room: the door is closed, and nothing was opened.
    expect(harness.urls('/knocks/knk_in/decline')).toHaveLength(1);
    expect(harness.windows).toEqual([]);
    expect(getUserMedia).not.toHaveBeenCalled();

    await poll(1);
    expect(harness.urls('/v1/meet-native/knocks?').length).toBeGreaterThan(
      listsBefore,
    );
  });
});
