import { describe, expect, it } from 'vitest';
import {
  stageCommandInvocations,
  type StageCommandInvocation,
} from '../../src/lib/onboarding-setup';

const STARTUP_READINESS_COMMAND = 'launch_startup_readiness';

function readinessInvocations(
  plan: StageCommandInvocation[],
): StageCommandInvocation[] {
  return plan.filter(
    (invocation) => invocation.command === STARTUP_READINESS_COMMAND,
  );
}

describe('US-013: Launch readiness asynchronously from unified desktop onboarding', () => {
  it('plans one argument-free readiness launch after successful dependency and git-init stages', () => {
    const dependencyPlan = stageCommandInvocations('deps', {
      installPath: '/tmp/hq',
    });
    const gitInitPlan = stageCommandInvocations('git-init', {
      installPath: '/tmp/hq',
    });

    expect(dependencyPlan[0]).toEqual({
      command: 'install_deps',
      required: true,
    });
    expect(gitInitPlan).toEqual([
      { command: 'git_init', required: true },
      { command: STARTUP_READINESS_COMMAND, required: false },
    ]);
    expect(gitInitPlan[0]?.command).toBe('git_init');
    expect(readinessInvocations(gitInitPlan)).toHaveLength(1);
    expect(readinessInvocations(gitInitPlan)[0]).not.toHaveProperty('args');
  });

  it('keeps git-init as the required boundary and the readiness bridge as a non-required follow-up', () => {
    const [gitInit, readiness] = stageCommandInvocations('git-init', {
      installPath: '/tmp/hq',
    });

    expect(gitInit).toMatchObject({ command: 'git_init', required: true });
    expect(readiness).toMatchObject({
      command: STARTUP_READINESS_COMMAND,
      required: false,
    });
  });

  it.each([
    ['initial plan with an unresolved root', null],
    ['resumed plan with a resolved root', '/tmp/hq'],
    ['a later rebuilt plan', '/tmp/hq-resumed'],
  ])('bounds %s to one optional readiness launch', (_case, installPath) => {
    const gitInitPlan = stageCommandInvocations('git-init', { installPath });
    const launches = readinessInvocations(gitInitPlan);

    expect(gitInitPlan).toHaveLength(2);
    expect(launches).toEqual([
      { command: STARTUP_READINESS_COMMAND, required: false },
    ]);
  });
});
