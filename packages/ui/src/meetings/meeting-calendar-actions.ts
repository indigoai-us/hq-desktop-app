/**
 * Calendar connect and paste-a-link actions for the Meetings toolbar and the
 * no-calendar state (console-rail US-042). Thin wrappers over the existing
 * store paths the legacy Meetings page uses: in-app Google OAuth through
 * beginCalendarConnect, per-account disconnectCalendar, and inviteBotByUrl.
 */

import { pushToast } from "../shell/toast-stack.svelte.js";
import { meetingsStore, type ToastDescriptor } from "./meetings-store.svelte";

export type OpenExternal = (url: string) => void | Promise<void>;

function toast(t: ToastDescriptor | null): void {
  if (!t) return;
  pushToast({ title: t.text, detail: "", tone: t.kind === "warn" ? "err" : "neutral" });
}

let connecting = false;

/** Start Google calendar OAuth and open the consent page in the browser. */
export async function connectGoogleCalendar(openExternal?: OpenExternal): Promise<void> {
  if (connecting || meetingsStore.connectPending) return;
  connecting = true;
  try {
    const result = await meetingsStore.beginCalendarConnect();
    toast(result.toast);
    if (!result.url) return;
    try {
      if (!openExternal) throw new Error("no browser opener");
      await openExternal(result.url);
    } catch (err) {
      console.warn("[meetings] open calendar consent failed", err);
      meetingsStore.stopCalendarConnectWatch();
      toast({ kind: "warn", text: "Couldn't open the browser to connect your calendar." });
    }
  } finally {
    connecting = false;
  }
}

/** Confirm, then revoke one connected account. Recaps stay. */
export async function disconnectCalendarAccount(accountId: string, email: string): Promise<void> {
  if (!accountId || meetingsStore.disconnectPendingByAccountId.has(accountId)) return;
  const ok = window.confirm(
    `Disconnect ${email || "this calendar"} from HQ? Upcoming events leave this list; recaps stay.`,
  );
  if (!ok) return;
  toast(await meetingsStore.disconnectCalendar(accountId));
}

/** Open the pasted room in the browser, then send the notetaker to it. */
export async function joinPastedLink(url: string, openExternal?: OpenExternal): Promise<void> {
  try {
    if (!openExternal) throw new Error("no browser opener");
    await openExternal(url);
  } catch (err) {
    console.warn("[meetings] open pasted link failed", err);
    toast({ kind: "warn", text: "Couldn't open the meeting link." });
    return;
  }
  toast(await meetingsStore.inviteBotByUrl(url, null));
}
