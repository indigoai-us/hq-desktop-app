import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import PersonalRootReview from './PersonalRootReview.svelte';
import type { PersonalRootView } from '../lib/personal-root';

const base: PersonalRootView = {
  phase: 'adoption_review',
  rootPath: '/Users/test/hq',
  reason: null,
  retryable: false,
  nextPhase: null,
  plan: null,
  holdUnenforced: false,
};

const plan = {
  transactionId: 'tx-123',
  stateDirectory: '/Users/test/.hq',
  authorityDigest: 'sha256:auth',
  inventoryDigest: 'sha256:inv',
  maxUploadRows: 500,
  maxUploadBytes: 1048576,
  maxDurationMs: 60000,
  uploadEntries: [
    {
      key: 'notes/a.md',
      kind: 'file' as const,
      size: 10,
      wireSize: 10,
      localHash: 'sha256:aaa',
      wireHash: 'sha256:aaa',
    },
  ],
  approvedPlanDigest: 'sha256:abc',
  fileCount: 12,
  byteCount: 4096,
  uploadCount: 10,
  uploadBytes: 2048,
  preservedOnly: [{ key: '.env', reason: 'secret' }],
  preservedOnlyTotal: 3,
  destinationUid: 'psn_1',
  destinationBucket: 'hq-personal-psn-1',
  destinationRegion: 'us-east-1',
  destinationEndpoint: 'https://s3',
  historicalUids: ['psn_old'],
};

const renderReview = (view: PersonalRootView) =>
  render(PersonalRootReview, {
    props: { view, onreview: vi.fn(), onapprove: vi.fn(), onretry: vi.fn() },
  }).body;

describe('PersonalRootReview (H8, gated)', () => {
  it('asks for a review before showing any approval', () => {
    const html = renderReview(base);
    expect(html).toContain('Review this folder before HQ syncs it');
    expect(html).toContain('data-testid="personal-root-review-plan"');
    expect(html).not.toContain('data-testid="personal-root-approve"');
  });

  it('shows the exact plan and one approval for the next phase only', () => {
    const html = renderReview({ ...base, nextPhase: 'preserve', plan });
    expect(html).toContain('data-testid="personal-root-plan"');
    expect(html).toContain('hq-personal-psn-1');
    expect(html).toContain('psn_old');
    expect(html).toContain('.env');
    expect(html).toContain('and 2 more');
    expect(html).toContain('Step 1 of 4: Keep a copy of these files');
    expect(html.match(/data-testid="personal-root-approve"/g)).toHaveLength(1);
    expect(html).toContain('data-next-phase="preserve"');
  });

  it('shows the upload list, address, records folder, and fingerprints being approved', () => {
    const html = renderReview({ ...base, nextPhase: 'preserve', plan });
    expect(html).toContain('data-testid="personal-root-uploads"');
    expect(html).toContain('notes/a.md');
    expect(html).toContain('sha256:aaa');
    expect(html).toContain('and 9 more');
    expect(html).toContain('https://s3');
    expect(html).toContain('/Users/test/.hq');
    expect(html).toContain('tx-123');
    expect(html).toContain('sha256:abc');
    expect(html).toContain('sha256:auth');
    expect(html).toContain('sha256:inv');
    expect(html).toContain('500 files');
  });

  it('after a stop that is not retryable shows no step, only a fresh check', () => {
    const html = renderReview({
      ...base,
      phase: 'preserved',
      reason: 'authority_changed',
      nextPhase: null,
      plan,
    });
    expect(html).not.toContain('data-testid="personal-root-approve"');
    expect(html).not.toContain('data-testid="personal-root-retry"');
    expect(html).toContain('data-testid="personal-root-recheck"');
    expect(html).toContain('Check this folder again');
  });

  it('warns when the hold cannot reach a sync service this app did not start', () => {
    expect(renderReview({ ...base, holdUnenforced: true })).toContain(
      'data-testid="personal-root-hold-unenforced"',
    );
    expect(renderReview(base)).not.toContain('data-testid="personal-root-hold-unenforced"');
  });

  it('labels each later phase', () => {
    expect(renderReview({ ...base, phase: 'preserved', nextPhase: 'adopt', plan })).toContain(
      'Step 2 of 4: Make this folder yours',
    );
    expect(renderReview({ ...base, phase: 'adopted', nextPhase: 'baseline', plan })).toContain(
      'Step 3 of 4: Upload the reviewed files',
    );
    expect(renderReview({ ...base, phase: 'baseline_ready', nextPhase: 'resume', plan })).toContain(
      'Step 4 of 4: Turn on personal sync',
    );
  });

  it('offers no adoption for a folder owned by another account', () => {
    const html = renderReview({ ...base, phase: 'paused', reason: 'owner_mismatch' });
    expect(html).toContain('This folder belongs to another account');
    expect(html).toContain('export them from that account');
    expect(html).not.toContain('data-testid="personal-root-approve"');
    expect(html).not.toContain('data-testid="personal-root-review-plan"');
    expect(html).not.toContain('data-testid="personal-root-retry"');
  });

  it('offers a retry only for retryable pauses', () => {
    expect(
      renderReview({ ...base, phase: 'paused', reason: 'authority_unavailable', retryable: true }),
    ).toContain('data-testid="personal-root-retry"');
    expect(renderReview({ ...base, phase: 'paused', reason: 'unsupported_cli' })).not.toContain(
      'data-testid="personal-root-retry"',
    );
    expect(renderReview({ ...base, phase: 'paused', reason: 'unsupported_cli' })).toContain(
      'Update HQ',
    );
  });
});
