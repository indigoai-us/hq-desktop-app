// Open / Share / Deploy on the files a session produced.
//
// The transcript components stay presentation-pure: `ToolGroupRow` renders an
// artifact row and calls back into an `ArtifactActions` port it was GIVEN, so a
// mount test can hand it a fake and the page can hand it the Tauri-backed one
// built here. Nothing in this module reads or writes session state.
//
// Share is the sensitive one. The backend mints a single-use share-session URL
// through the `hq` CLI and returns it exactly once; the row shows it in that
// same turn with a Copy button and forgets it on dismiss. It is never logged,
// never persisted, and never re-rendered from history.

import { invoke } from '@tauri-apps/api/core';
import { contentToText } from './session-events';

/** Rust `ArtifactStat` — what one produced path is right now. */
export interface ArtifactStat {
  exists: boolean;
  kind: 'file' | 'dir' | 'missing';
  /** Only a vault path (`companies/<slug>/…`) can be shared. */
  shareable: boolean;
  company: string | null;
  /** Something `/deploy` serves: a page, document, image, or folder with `index.html`. */
  deployable: boolean;
}

/** Rust `ArtifactShare` — the minted link, shown once. */
export interface ArtifactShare {
  url: string;
  expiresInMinutes: number;
}

/** The port an artifact row acts through. */
export interface ArtifactActions {
  stat(path: string): Promise<ArtifactStat>;
  open(path: string): Promise<void>;
  share(path: string): Promise<ArtifactShare>;
  /** Hand the path to the session as a `/deploy` turn — the skill does the rest. */
  deploy(path: string): void;
}

/** The tooltip on a Share button that cannot mint anything. */
export const SHARE_VAULT_ONLY_HINT = 'Only company vault files can be shared';

/**
 * The user turn that asks the session to deploy `path`. Quoted only when the
 * path needs it, so the common case reads exactly like what an operator types.
 */
export function deployCommandFor(path: unknown): string {
  // The path comes off a folded tool call; a non-string is a `/deploy` with
  // nothing after it, not a crash in the click handler.
  const text = contentToText(path);
  const needsQuotes = /[\s"']/.test(text);
  const arg = needsQuotes ? `"${text.replace(/(["\\])/g, '\\$1')}"` : text;
  return `/deploy ${arg}`;
}

/** The Tauri-backed port; `deploy` is supplied by the page since it is a send. */
export function tauriArtifactActions(deploy: (path: string) => void): ArtifactActions {
  return {
    stat: (path) => invoke<ArtifactStat>('session_artifact_stat', { path }),
    open: (path) => invoke<void>('session_artifact_open', { path }),
    share: (path) => invoke<ArtifactShare>('session_artifact_share', { path }),
    deploy,
  };
}
