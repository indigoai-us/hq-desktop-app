const WINDOWS_UNC_PREFIX = '\\\\?\\UNC\\';
const WINDOWS_VERBATIM_PREFIX = '\\\\?\\';
const WINDOWS_LEGACY_MAX_LEN = 260;
const WINDOWS_RESERVED_STEM = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const WINDOWS_DRIVE = /^[A-Za-z]:$/;

function trimTrailingSeparators(path: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return path.replace(/[\\/]$/, '\\');
  if (path === '/' || path === '\\') return path;
  return path.replace(/[\\/]+$/, '');
}

function windowsComponentStem(component: string): string {
  const trimmed = component.replace(/[. ]+$/g, '');
  const dot = trimmed.indexOf('.');
  return (dot === -1 ? trimmed : trimmed.slice(0, dot)).toUpperCase();
}

/** Same safety gate as dunce::simplified: only drop `\\?\` when legacy Win32 can name the path. */
function canSimplifyWin32(legacy: string): boolean {
  // MAX_PATH is 260 including the terminating NUL, so 259 usable code units.
  if (legacy.length >= WINDOWS_LEGACY_MAX_LEN) return false;
  for (const part of legacy.split(/[\\/]/)) {
    if (!part) continue;
    if (WINDOWS_DRIVE.test(part)) continue;
    if (part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')) return false;
    if (WINDOWS_RESERVED_STEM.test(windowsComponentStem(part))) return false;
  }
  return true;
}

/**
 * Strip Windows' internal verbatim prefix (`\\?\` / `\\?\UNC\`) so the path is
 * pasteable in Explorer, Claude Code Open Folder, and a terminal `cd`.
 * Keep the prefix when dunce would (long paths, reserved DOS names).
 */
export function toUserFacingPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.toUpperCase().startsWith(WINDOWS_UNC_PREFIX.toUpperCase())) {
    const legacy = `\\\\${trimmed.slice(WINDOWS_UNC_PREFIX.length)}`;
    return canSimplifyWin32(legacy) ? legacy : trimmed;
  }
  if (trimmed.startsWith(WINDOWS_VERBATIM_PREFIX)) {
    const legacy = trimmed.slice(WINDOWS_VERBATIM_PREFIX.length);
    return canSimplifyWin32(legacy) ? legacy : trimmed;
  }
  return trimmed;
}

function separatorFor(path: string): '/' | '\\' {
  return path.includes('\\') ? '\\' : '/';
}

export function friendlyPath(path: string, homeDir?: string | null): string {
  const trimmedPath = trimTrailingSeparators(path.trim());
  const trimmedHome = homeDir ? trimTrailingSeparators(homeDir.trim()) : '';

  if (!trimmedPath || !trimmedHome) return trimmedPath;
  if (trimmedPath === trimmedHome) return '~';

  const separator = separatorFor(trimmedPath);
  const prefix = `${trimmedHome}${separator}`;
  if (trimmedPath.startsWith(prefix)) {
    return `~${separator}${trimmedPath.slice(prefix.length)}`;
  }

  return trimmedPath;
}

export function homeDirFromDefaultHqPath(path: string): string | null {
  const trimmedPath = trimTrailingSeparators(path.trim());
  const slashIndex = Math.max(trimmedPath.lastIndexOf('/'), trimmedPath.lastIndexOf('\\'));
  if (slashIndex <= 0) return null;

  const leaf = trimmedPath.slice(slashIndex + 1);
  if (leaf.toLowerCase() !== 'hq') return null;

  return trimmedPath.slice(0, slashIndex);
}
