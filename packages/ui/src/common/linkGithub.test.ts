import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GITHUB_SUMMARY_CACHE_LIMIT,
  GITHUB_SUMMARY_TTL_MS,
  cachedGithubSummary,
  githubSummaryCacheSizeForTest,
  onGithubSummary,
  requestGithubSummary,
  resetGithubSummariesForTest,
  setGithubSummaryFetcher,
  type GithubLinkSummary,
} from './linkGithub';

const summary = (title: string): GithubLinkSummary => ({ kind: 'pull', title, state: 'open' });
const pr = (n: number) => `https://github.com/acme/app/pull/${n}`;

async function settle(): Promise<void> {
  // The fetcher promise, then .then/.catch, then .finally.
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

describe('GitHub summary cache', () => {
  beforeEach(() => {
    resetGithubSummariesForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetGithubSummariesForTest();
  });

  it('asks the host once per link within the TTL and again after it', async () => {
    const fetcher = vi.fn(async (url: string) => summary(url));
    setGithubSummaryFetcher(fetcher);

    requestGithubSummary(pr(1));
    requestGithubSummary(pr(1)); // in flight: no second call
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cachedGithubSummary(pr(1))?.title).toBe(pr(1));

    vi.advanceTimersByTime(GITHUB_SUMMARY_TTL_MS - 1);
    requestGithubSummary(pr(1));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    requestGithubSummary(pr(1));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('caches a miss or a failure as null and notifies listeners', async () => {
    const listener = vi.fn();
    onGithubSummary(listener);
    setGithubSummaryFetcher(async (url) => {
      if (url === pr(1)) return null;
      throw new Error('offline');
    });

    requestGithubSummary(pr(1));
    requestGithubSummary(pr(2));
    expect(cachedGithubSummary(pr(1))).toBeUndefined();
    await settle();
    expect(cachedGithubSummary(pr(1))).toBeNull();
    expect(cachedGithubSummary(pr(2))).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it(`keeps at most ${GITHUB_SUMMARY_CACHE_LIMIT} links, dropping the oldest`, async () => {
    setGithubSummaryFetcher(async (url) => summary(url));
    const total = GITHUB_SUMMARY_CACHE_LIMIT + 25;
    for (let n = 1; n <= total; n += 1) {
      requestGithubSummary(pr(n));
      await settle();
    }
    expect(githubSummaryCacheSizeForTest()).toBe(GITHUB_SUMMARY_CACHE_LIMIT);
    expect(cachedGithubSummary(pr(1))).toBeUndefined();
    expect(cachedGithubSummary(pr(25))).toBeUndefined();
    expect(cachedGithubSummary(pr(26))?.title).toBe(pr(26));
    expect(cachedGithubSummary(pr(total))?.title).toBe(pr(total));
  });

  it('a refreshed link counts as newest when trimming', async () => {
    setGithubSummaryFetcher(async (url) => summary(url));
    for (let n = 1; n <= GITHUB_SUMMARY_CACHE_LIMIT; n += 1) {
      requestGithubSummary(pr(n));
      await settle();
    }
    vi.advanceTimersByTime(GITHUB_SUMMARY_TTL_MS);
    requestGithubSummary(pr(1)); // refetch moves link 1 to the newest slot
    await settle();
    requestGithubSummary(pr(GITHUB_SUMMARY_CACHE_LIMIT + 1));
    await settle();
    expect(githubSummaryCacheSizeForTest()).toBe(GITHUB_SUMMARY_CACHE_LIMIT);
    expect(cachedGithubSummary(pr(1))?.title).toBe(pr(1));
    expect(cachedGithubSummary(pr(2))).toBeUndefined();
  });
});
