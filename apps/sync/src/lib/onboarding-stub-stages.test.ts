import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  STAGE_COMMAND,
  STAGE_ORDER,
  buildInitialStages,
  setStageStatus,
  setupCompletionResult,
  setupProgressPercent,
  stageTimeoutMs,
} from './onboarding-setup';
import { setupFailureEscape } from './onboarding-escape';

describe('honest onboarding stage reporting', () => {
  it('runs only the stages that perform verified onboarding work', () => {
    expect(STAGE_ORDER).toEqual([
      'content',
      'deps',
      'initial-sync',
      'git-init',
      'personalize',
      'indexing',
    ]);
    expect(STAGE_COMMAND).toEqual({
      content: 'fetch_and_extract_template',
      deps: 'install_deps',
      'initial-sync': 'start_initial_cloud_sync',
      'git-init': 'git_init',
      personalize: 'personalize_hq',
      indexing: 'register_search_index',
    });
  });

  it('keeps a failed required stage out of a clean completion result', () => {
    const stages = setStageStatus(
      buildInitialStages().map((stage) => ({ ...stage, status: 'ok' })),
      'deps',
      'failed',
      'dependency install failed',
    );

    expect(setupCompletionResult(stages)).toMatchObject({
      needsAttention: true,
      failedStages: [
        {
          id: 'deps',
          label: 'Installing dependencies',
          message: 'dependency install failed',
        },
      ],
    });
    expect(
      setupProgressPercent({
        settledCount: STAGE_ORDER.length,
        totalStages: STAGE_ORDER.length,
        hasRunningStage: false,
        stageCreep: 0,
        allDone: false,
      }),
    ).toBe(99);
  });

  it('names every failed stage, uses an accurate count, and offers retry in the Ready panel', () => {
    const caution = setupFailureEscape([
      { label: 'Installing dependencies' },
      { label: 'Registering for search' },
    ]);
    const wizard = readFileSync(
      'apps/sync/src/components/onboarding/OnboardingWizard.svelte',
      'utf8',
    );

    expect(caution.title).toBe('2 installer steps need attention');
    expect(caution.body).toContain('Installing dependencies, Registering for search');
    expect(caution.body).not.toContain('One installer step');
    expect(wizard).toContain("'HQ setup needs attention'");
    expect(wizard).toContain('setupDone && !setupHasFailedStage');
    expect(wizard).toContain('{#each stages as stage}');
    expect(wizard).toContain('Needs attention');
    expect(wizard).toContain('Retry failed steps');
    expect(wizard).toContain('Existing HQ setup import was not run');
  });

  it('awaits a bounded initial cloud sync rather than completing a detached task', () => {
    const stages = readFileSync(
      'apps/sync/src-tauri/src/commands/install_stages.rs',
      'utf8',
    );
    const personalization = stages.slice(
      stages.indexOf('fn personalize_hq_at'),
      stages.indexOf('/// Placeholder for importing an existing setup'),
    );

    expect(stageTimeoutMs('initial-sync')).toBeGreaterThan(0);
    expect(personalization).toContain(
      'fs::create_dir_all(&settings)\n        .map_err(|_| "Could not prepare personal settings.".to_string())?',
    );
    expect(personalization).not.toContain('return Ok(())');
    expect(stages).toContain(
      'ensure_personal_bucket_and_first_push(&app, &vault, &hq_root)',
    );
    expect(stages).not.toContain('tauri::async_runtime::spawn');
  });
});
