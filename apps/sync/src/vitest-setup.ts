import { vi } from 'vitest';

// Tests must never POST into the live hq-install-events table.
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
  })),
}));
