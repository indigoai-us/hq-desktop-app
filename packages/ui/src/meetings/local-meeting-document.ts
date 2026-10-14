/**
 * The recorded meeting's markdown document as synced to this computer.
 *
 * A recorded meeting's id is its Recall bot id, and HQ Sync writes the
 * meeting to `companies/<slug>/sources/meetings/{id}.md` (or
 * `personal/sources/meetings/{id}.md` for a meeting with no company). Reading
 * it is a local file read, so the meeting opens without waiting for hq-pro's
 * detail call, which presigns every signal and takes seconds.
 *
 * The native read gate only allows `companies/<slug>/` while that company is
 * bound to the window. This binds the meeting's company for the one read and
 * then puts back the company that was bound before, so the Files, Brain and
 * Agency surfaces keep the scope they set. Reads run one at a time for the
 * same reason.
 */
import type { AdapterPromise, AppShellApi, VaultApi } from "@hq/platform";
import type { LocalMeetingDocument } from "./meetings-store.svelte";

export interface LocalMeetingDocumentDeps {
  vault: Pick<VaultApi, "readNote"> | null | undefined;
  appShell: (Pick<AppShellApi, "setActiveCompany"> & { getActiveCompany?: () => AdapterPromise<string | null> }) | null | undefined;
  /** The synced folder slug for a company uid, or null when the company is not on this computer. */
  companySlugForUid: (companyUid: string) => string | null;
}

/** Recall bot ids and hq-pro meeting ids: no path separators, no dots. */
const SAFE_MEETING_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_SLUG = /^[a-z0-9_-]{1,128}$/;

/** The HQ-relative path of a meeting's synced document, or null when it cannot be named safely. */
export function localMeetingDocumentPath(meetingId: string, companySlug: string | null): string | null {
  if (!SAFE_MEETING_ID.test(meetingId)) return null;
  if (companySlug === null) return `personal/sources/meetings/${meetingId}.md`;
  if (!SAFE_SLUG.test(companySlug)) return null;
  return `companies/${companySlug}/sources/meetings/${meetingId}.md`;
}

export function createLocalMeetingDocumentReader(
  deps: LocalMeetingDocumentDeps,
): (meetingId: string, companyUid: string | null) => Promise<LocalMeetingDocument | null> {
  let queue: Promise<unknown> = Promise.resolve();

  async function readOnce(meetingId: string, companyUid: string | null): Promise<LocalMeetingDocument | null> {
    const vault = deps.vault;
    if (!vault) return null;
    const slug = companyUid ? deps.companySlugForUid(companyUid) : null;
    // A company meeting whose company folder is not on this computer.
    if (companyUid && !slug) return null;
    const path = localMeetingDocumentPath(meetingId, slug);
    if (!path) return null;
    if (!slug) return asDocument(await vault.readNote(path));

    const shell = deps.appShell;
    if (!shell?.getActiveCompany) return null;
    const before = await shell.getActiveCompany();
    // Without knowing the bound company it cannot be put back; skip the local read.
    if (!before.ok) return null;
    const previous = before.value?.trim() || null;
    if (previous === slug) return asDocument(await vault.readNote(path));
    const bound = await shell.setActiveCompany(slug);
    if (!bound.ok) return null;
    try {
      return asDocument(await vault.readNote(path));
    } finally {
      const restored = await shell.setActiveCompany(previous ?? "");
      if (!restored.ok) console.warn("[meetings] could not restore the company scope after reading a meeting file");
    }
  }

  return (meetingId, companyUid) => {
    const run = queue.then(() => readOnce(meetingId, companyUid));
    queue = run.catch(() => undefined);
    return run;
  };
}

function asDocument(
  res: Awaited<ReturnType<VaultApi["readNote"]>>,
): LocalMeetingDocument | null {
  if (!res.ok || typeof res.value?.text !== "string") return null;
  return { text: res.value.text, truncated: res.value.truncated === true };
}
