/**
 * hq-desktop-windows-reliability / US-008 source-contract acceptance tests.
 * The legacy US-008.test.ts belongs to a different PRD and is intentionally
 * preserved.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(repo, path), 'utf8');
const state = read('apps/sync/src-tauri/src/commands/hq_core_state.rs');
const update = read('apps/sync/src-tauri/src/commands/hq_core_update.rs');
const staging = read('apps/sync/src-tauri/src/commands/hq_core_staging.rs');
const scope = read('crates/hq-desktop-core/src/drift_scope.rs');
const detail = read('apps/sync/src/components/DriftDetail.svelte');

describe('US-008: fail-closed Core Drift baselines', () => {
  it('persists normalized path-to-blob baselines after both successful update paths', () => {
    expect(scope).toContain('normalized_blobs: BTreeMap<String, String>');
    expect(scope).toContain('source_repo: source_repo.to_string()');
    expect(scope).toContain('commit: commit.to_string()');
    expect(update).toContain('persist_remote_baseline(');
    expect(staging).toContain('persist_remote_baseline(');
    expect(update).toContain('if exit_code == 0');
    expect(staging).toContain('if exit_code == 0');
  });

  it('uses the stamped source baseline across channel switches without querying that former repo', () => {
    expect(state).toContain('load_core_drift_baseline(');
    expect(state).toContain('else if source == &target_repo');
    expect(state).toContain('source switched from {source} to {target_repo}');
  });

  it('returns BaselineUnavailable with update required and empty lists instead of head comparison', () => {
    expect(state).toContain('no trustworthy installed baseline, failing closed');
    expect(state).toContain('baseline_status: BaselineStatus::BaselineUnavailable');
    expect(state).toContain('update_required: true');
    expect(detail).toContain("report.baselineStatus === 'BaselineUnavailable'");
    expect(detail).toContain('No modified, missing, or added counts were inferred');
  });

  it('normalizes text EOLs but preserves binary and genuine changes', () => {
    expect(scope).toContain('normalize_newlines_for_drift');
    expect(scope).toContain('!sample.contains(&0)');
    expect(scope).toContain('drift_blob_sha_does_not_rewrite_binary_with_crlf_bytes');
  });

  it('excludes pack and matching Personal landings without masking locked-core edits', () => {
    expect(scope).toContain('pack_materialization_scopes(hq_folder)');
    expect(scope).toContain('personal_materialization_paths(hq_folder)');
    expect(scope).toContain('drift_blob_sha(&source_bytes) == drift_blob_sha(&destination_bytes)');
    expect(scope).toContain('personal_materialization_is_excluded_only_while_content_matches');
  });
});
