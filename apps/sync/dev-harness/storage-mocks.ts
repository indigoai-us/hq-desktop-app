// Settings › Storage for the browser preview harness.
//
// Serves the real `hq storage ... --json` output captured from hq-cli (the
// same files the Storage tests use) so the pane renders what the CLI sends.
//
//   ?storage=data         (default) 6 old copies to move, cloud history
//   ?storage=unavailable  big-file moves can't run ("update HQ sync")
//   ?storage=partial      the move uploads but frees nothing (real CLI result)
import { NOT_HANDLED } from './company-flow-mocks';
import status from '../../../packages/ui/src/settings/__fixtures__/storage/status.json';
import offloadDry from '../../../packages/ui/src/settings/__fixtures__/storage/offload-dry.json';
import offloadReal from '../../../packages/ui/src/settings/__fixtures__/storage/offload-real.json';

const CURRENT_BLOCKED = {
  available: false,
  reason: 'Offloading current files is not available yet: HQ sync would treat the replaced file as deleted.',
};

const DAY = 24 * 60 * 60 * 1000;

/** Real local status plus one cloud company, so the whole page renders. */
function statusFor(variant: string): unknown {
  const offload =
    variant === 'unavailable'
      ? { ...status.offload, available: false, reason: 'update HQ sync' }
      : { ...status.offload, placeholders: { count: 2, bytes: 1_048_576_000 } };
  return {
    ...status,
    local: { ...status.local, root: '/Users/corey/Documents/HQ' },
    offload,
    cloud: [
      {
        company: 'indigo',
        available: true,
        can_delete: true,
        current_bytes: 12_884_901_888,
        noncurrent_bytes: 4_294_967_296,
        noncurrent_count: 18_240,
        delete_markers: 420,
        tranches: [
          { id: '7d', label: 'Last 7 days', count: 1_200, bytes: 214_748_364 },
          { id: '30d', label: '7–30 days', count: 3_100, bytes: 644_245_094 },
          { id: '90d', label: '30–90 days', count: 5_400, bytes: 1_073_741_824 },
          { id: '365d', label: '90 days–1 year', count: 6_040, bytes: 1_610_612_736 },
          { id: 'older', label: 'Older than 1 year', count: 2_500, bytes: 751_619_276 },
        ],
      },
    ],
    generated_at: new Date(Date.now() - DAY / 24).toISOString(),
  };
}

function variant(): string {
  if (typeof window === 'undefined') return 'data';
  return new URLSearchParams(window.location.search).get('storage') ?? 'data';
}

export function storageAnswer(cmd: string): unknown {
  switch (cmd) {
    case 'get_storage_status':
      return statusFor(variant());
    case 'preview_storage_offload':
      return { ...offloadDry, current: { ...offloadDry.current, ...CURRENT_BLOCKED } };
    case 'run_storage_offload':
      if (variant() === 'partial') return { ...offloadReal, current: { ...offloadReal.current, ...CURRENT_BLOCKED } };
      return {
        ...offloadReal,
        history: { ...offloadReal.history, freed_bytes: 365_105_152 },
        current: { ...offloadReal.current, ...CURRENT_BLOCKED },
        errors: [],
      };
    case 'preview_storage_prune':
    case 'run_storage_prune':
      return { local: null, cloud: [], dry_run: cmd === 'preview_storage_prune' };
    case 'cloud_file_ui_ready':
      return [];
    default:
      return NOT_HANDLED;
  }
}
