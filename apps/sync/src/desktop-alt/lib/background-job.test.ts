import { describe, expect, it } from 'vitest';
import { backgroundJobFailure, createdStoryTitle } from './background-job';

describe('backgroundJobFailure', () => {
  it('surfaces a revoked OAuth token immediately', () => {
    expect(
      backgroundJobFailure([
        {
          kind: 'error',
          message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
          code: 'authentication_failed',
        },
      ]),
    ).toBe('Authentication failed — sign in to the provider again.');
  });

  it('surfaces a failed turn', () => {
    expect(
      backgroundJobFailure([
        { kind: 'turnDone', status: 'error', error: 'Turn failed: nope' },
      ]),
    ).toBe('Turn failed: nope');
  });

  it('is quiet while the job is still running', () => {
    expect(
      backgroundJobFailure([{ kind: 'textDelta', text: 'working', parentToolUseId: null }]),
    ).toBeNull();
  });

  it('treats a new Board story id as success', () => {
    expect(
      createdStoryTitle(new Set(['US-001']), [
        { id: 'US-001', title: 'Old' },
        { id: 'US-019', title: 'Cache provider model lists across provider switches' },
      ]),
    ).toBe('Cache provider model lists across provider switches');
  });
});
