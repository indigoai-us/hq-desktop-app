// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  AGENCY_REFRESH_MS,
  acquireAgencyStore,
  agencyPollerRunning,
  agencyStore,
  startAgencyStore,
  stopAgencyStore,
} from './agency-store.svelte';

function refreshCallCount(): number {
  // One refresh = one `list_agency_teams` invoke.
  return invoke.mock.calls.filter(([cmd]) => cmd === 'list_agency_teams').length;
}

let hidden = false;

describe('agency-store polling (perf: 30s interval, visibility + mount gated)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockResolvedValue([]);
    hidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
  });

  afterEach(() => {
    stopAgencyStore();
    vi.useRealTimers();
    invoke.mockReset();
  });

  it('polls every 30 seconds, not 4', () => {
    expect(AGENCY_REFRESH_MS).toBe(30_000);
  });

  it('does not poll at all until an agency surface acquires the store', () => {
    vi.advanceTimersByTime(10 * AGENCY_REFRESH_MS);
    expect(refreshCallCount()).toBe(0);
    expect(agencyPollerRunning()).toBe(false);
  });

  it('acquire starts polling on the 30s interval; release stops it entirely', () => {
    const release = acquireAgencyStore();
    expect(refreshCallCount()).toBe(1); // immediate refresh on mount
    expect(agencyPollerRunning()).toBe(true);

    vi.advanceTimersByTime(AGENCY_REFRESH_MS - 1);
    expect(refreshCallCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(refreshCallCount()).toBe(2);
    vi.advanceTimersByTime(2 * AGENCY_REFRESH_MS);
    expect(refreshCallCount()).toBe(4);

    release();
    expect(agencyPollerRunning()).toBe(false);
    vi.advanceTimersByTime(10 * AGENCY_REFRESH_MS);
    expect(refreshCallCount()).toBe(4);
  });

  it('skips ticks while document.hidden and resumes when visible again', () => {
    const release = acquireAgencyStore();
    expect(refreshCallCount()).toBe(1);

    hidden = true;
    vi.advanceTimersByTime(5 * AGENCY_REFRESH_MS);
    expect(refreshCallCount()).toBe(1);

    hidden = false;
    vi.advanceTimersByTime(AGENCY_REFRESH_MS);
    expect(refreshCallCount()).toBe(2);
    release();
  });

  it('poller keeps running until the last of several mounted surfaces releases', () => {
    const releaseTeams = acquireAgencyStore();
    const releaseChat = acquireAgencyStore();
    expect(refreshCallCount()).toBe(1); // shared poller, no duplicate intervals
    releaseTeams();
    expect(agencyPollerRunning()).toBe(true);
    releaseChat();
    expect(agencyPollerRunning()).toBe(false);
  });

  it('startAgencyStore/stopAgencyStore legacy lease is idempotent', () => {
    startAgencyStore();
    startAgencyStore();
    expect(agencyPollerRunning()).toBe(true);
    expect(refreshCallCount()).toBe(1);
    stopAgencyStore();
    stopAgencyStore();
    expect(agencyPollerRunning()).toBe(false);
  });

  it('exposes reactive getters that stay readable with no poller running', () => {
    expect(Array.isArray(agencyStore.teams)).toBe(true);
    expect(Array.isArray(agencyStore.questions)).toBe(true);
  });
});
