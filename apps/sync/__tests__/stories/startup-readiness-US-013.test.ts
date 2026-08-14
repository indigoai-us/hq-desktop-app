import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  stageCommandInvocations,
  type StageCommandInvocation,
} from '../../src/lib/onboarding-setup';

const STARTUP_READINESS_COMMAND = 'launch_startup_readiness';
const installStagesRs = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/commands/install_stages.rs'),
  'utf8',
);
const mainRs = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/main.rs'),
  'utf8',
);

function readinessInvocations(
  plan: StageCommandInvocation[],
): StageCommandInvocation[] {
  return plan.filter(
    (invocation) => invocation.command === STARTUP_READINESS_COMMAND,
  );
}

describe('US-013: Launch readiness asynchronously from unified desktop onboarding', () => {
  it('registers the adapter in the Tauri invoke handler', () => {
    expect(mainRs).toContain(
      'commands::install_stages::launch_startup_readiness,',
    );
  });

  it('uses only the installed CLI and makes failed detached launches retryable', () => {
    const launchBody = installStagesRs.slice(
      installStagesRs.indexOf('pub fn launch_startup_readiness()'),
      installStagesRs.indexOf('pub async fn register_search_index()'),
    );

    expect(launchBody).toContain('paths::resolve_bin_with_kind("hq")');
    expect(launchBody).not.toContain('hq_resolver::resolve_hq()');
    expect(installStagesRs).toContain('StartupReadinessLaunchLease');
    expect(installStagesRs).toContain('.stdin(Stdio::null())');
    expect(installStagesRs).toContain('.stdout(Stdio::null())');
    expect(installStagesRs).toContain('.stderr(Stdio::null())');
  });

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
