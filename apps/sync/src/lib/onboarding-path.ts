function trimTrailingSeparators(path: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return path.replace(/[\\/]$/, '\\');
  if (path === '/' || path === '\\') return path;
  return path.replace(/[\\/]+$/, '');
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
