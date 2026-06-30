import { describe, expect, it } from 'vitest';
import {
  allSettled,
  buildInitialStages,
  setStageStatus,
  STAGE_LABELS,
  STAGE_ORDER,
  type StageState,
} from './onboarding-setup';

describe('onboarding setup stages', () => {
  it('builds the initial stage list in order with all stages pending', () => {
    const stages = buildInitialStages();

    expect(stages).toHaveLength(STAGE_ORDER.length);
    expect(stages.map((stage) => stage.id)).toEqual(STAGE_ORDER);
    expect(stages.map((stage) => stage.label)).toEqual(
      STAGE_ORDER.map((id) => STAGE_LABELS[id]),
    );
    expect(stages.every((stage) => stage.status === 'pending')).toBe(true);
  });

  it('settles only when every stage is ok or failed', () => {
    const pending = buildInitialStages();
    const running = setStageStatus(pending, 'deps', 'running');
    const settled: StageState[] = STAGE_ORDER.map((id, index) => ({
      id,
      label: STAGE_LABELS[id],
      status: index % 2 === 0 ? 'ok' : 'failed',
      error: index % 2 === 0 ? null : 'non-fatal failure',
    }));

    expect(allSettled(pending)).toBe(false);
    expect(allSettled(running)).toBe(false);
    expect(allSettled(settled)).toBe(true);
  });

  it('applies status transitions without mutating other stages', () => {
    const stages = buildInitialStages();
    const running = setStageStatus(stages, 'git-init', 'running');
    const failed = setStageStatus(running, 'git-init', 'failed', 'missing command');

    expect(stages.find((stage) => stage.id === 'git-init')?.status).toBe(
      'pending',
    );
    expect(running.find((stage) => stage.id === 'git-init')).toMatchObject({
      status: 'running',
      error: null,
    });
    expect(failed.find((stage) => stage.id === 'git-init')).toMatchObject({
      status: 'failed',
      error: 'missing command',
    });
    expect(failed.find((stage) => stage.id === 'deps')?.status).toBe('pending');
  });
});
