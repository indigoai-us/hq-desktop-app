import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const installDeps = read('src-tauri/src/commands/install_deps.rs');

describe('Windows dependency installation regressions', () => {
  it('writes qmd.cmd to the package-declared qmd entry point', () => {
    const start = installDeps.indexOf('fn write_qmd_bash_shim_in(');
    const end = installDeps.indexOf('\n#[cfg(windows)]', start + 1);
    const writer = installDeps.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(writer.includes('node_modules\\@tobilu\\qmd\\bin\\qmd')).toBe(true);
    expect(writer.includes('node_modules\\qmd\\bin\\qmd')).toBe(true);
    expect(writer.includes('if qmd_resolves_in_prefix(prefix)')).toBe(false);
  });

  it('keeps npm qmd.cmd when Git Bash is unavailable instead of invoking bare bash', () => {
    const start = installDeps.indexOf('fn write_qmd_bash_shim_in(');
    const end = installDeps.indexOf('\n#[cfg(windows)]', start + 1);
    const writer = installDeps.slice(start, end);

    expect(writer).toContain('bash_path: Option<&Path>');
    expect(writer).toContain('qmd_npm_shim_references_entry');
    expect(writer).toContain('let Some(bash) = bash_path else');
    expect(writer).not.toContain('bash "%~dp0');
    expect(writer).toContain('qmd.cmd does not reference the installed package entry point');
  });

  it('classifies qmd post-install failures and records only a sanitized resolved version', () => {
    expect(installDeps).toContain('qmd_not_resolved');
    expect(installDeps).toContain('qmd_version_mismatch');
    expect(installDeps).toContain('qmd_native_addon_mismatch');
    expect(installDeps).toContain('QMD_POST_INSTALL_PROBE_COMMAND');
    expect(installDeps).toContain('qmd_resolved_version_token');
    expect(installDeps).toContain('setup_resolved_version');
  });

  it('pins Git installs to the Winget community source', () => {
    const start = installDeps.indexOf('fn winget_install_args(');
    const end = installDeps.indexOf('\n#[cfg(windows)]', start + 1);
    const installer = installDeps.slice(start, end);

    expect(installer.includes('"--source"')).toBe(true);
    expect(installer.includes('"winget"')).toBe(true);
  });

  it('classifies Winget certificate pin failures with a stable error kind', () => {
    expect(installDeps.includes('0x8A15_005E_u32 as i32')).toBe(true);
    expect(installDeps.includes('winget_pinned_certificate_mismatch')).toBe(true);
    expect(installDeps.includes('"setup_error_kind"')).toBe(true);
  });
});
