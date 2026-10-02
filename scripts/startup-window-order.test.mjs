import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const mainPath = fileURLToPath(
  new URL('../apps/sync/src-tauri/src/main.rs', import.meta.url),
);

test('first-run window is prepared before lifecycle probes', async () => {
  const source = await readFile(mainPath, 'utf8');
  const show = source.indexOf(
    'prepare_first_run_welcome_window(app.handle(), early_first_run);',
  );
  const lifecycle = source.indexOf(
    'commands::lifecycle::setup_lifecycle(app.handle());',
  );

  assert.notEqual(show, -1, 'early first-run window setup call exists');
  assert.notEqual(lifecycle, -1, 'lifecycle startup work remains present');
  assert.ok(show < lifecycle, 'first-run window setup precedes lifecycle probes');
});
