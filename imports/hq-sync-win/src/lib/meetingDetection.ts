//! Detected-meeting notification trigger (US-003).
//!
//! The Recall Desktop SDK detects a live meeting and the Rust side emits a
//! global Tauri `meeting:detected` event. The *always-present* popover window
//! (App.svelte) listens for it and calls this handler, which fires the HQ
//! liquid-glass "Meeting detected" banner via the `meetings_notify_detected`
//! Tauri command.
//!
//! Ownership note (the double-notification guard): Tauri fans `meeting:detected`
//! out to EVERY webview, so both the popover (App.svelte) and the on-demand
//! MeetingsWindow see it. Only the popover invokes `meetings_notify_detected`
//! (the popover is always alive; MeetingsWindow is opened on demand and only
//! maintains its in-app "Live now" row). The Rust-side `claim_notify` ledger
//! lock is the authoritative dedup guard; scoping the notify to one window here
//! is defence-in-depth that removes the race at its source. This mirrors the
//! upstream macOS split between `lib/meetingDetection.ts` (notify owner) and
//! `lib/activeMeetings.ts` (row-only).

import { invoke } from "@tauri-apps/api/core";

/** The shape the bridge forwards on a `meeting:detected` event. */
export interface MeetingDetectedPayload {
  meetingUrl?: string;
  windowId?: string;
  platform?: string;
  summary?: string;
  sourceEventId?: string;
}

/** Payload accepted by the `meetings_notify_detected` Tauri command. */
export interface NotifyDetectedArgs {
  meetingUrl: string | null;
  windowId: string | null;
  platform: string | null;
  summary: string | null;
  sourceEventId: string | null;
}

/** True for the `recall-window:<id>` placeholder the bridge emits when the SDK
 *  saw a meeting window but couldn't scrape a real join URL. */
export function isSyntheticUrl(url: string | undefined | null): boolean {
  return typeof url === "string" && url.startsWith("recall-window:");
}

/** Map a raw `meeting:detected` payload onto the `meetings_notify_detected`
 *  argument shape. Empty strings normalise to `null` so the Rust stable-key
 *  derivation (URL-or-event-id) doesn't treat `""` as a real key. Pure +
 *  exported for unit testing. */
export function notifyArgsFor(p: MeetingDetectedPayload): NotifyDetectedArgs {
  const clean = (s: string | undefined): string | null => {
    const t = (s ?? "").trim();
    return t.length > 0 ? t : null;
  };
  return {
    meetingUrl: clean(p.meetingUrl),
    windowId: clean(p.windowId),
    platform: clean(p.platform),
    summary: clean(p.summary),
    sourceEventId: clean(p.sourceEventId),
  };
}

/** Handle one `meeting:detected` event from the always-present popover window.
 *
 *  1. If the meeting has a real (non-synthetic) URL, skip the banner when a
 *     Recall bot is already scheduled/in the room for it — the user already
 *     has coverage and a "record?" prompt would be noise.
 *  2. Otherwise fire `meetings_notify_detected`, which applies the notify-pref
 *     gate + the atomic dedup ledger claim and shows the banner.
 *
 *  All failures are swallowed (logged) — a detection that can't notify must
 *  never throw into the event listener. The MeetingsWindow "Live now" row is
 *  the always-available fallback surface. */
export async function handleMeetingDetected(p: MeetingDetectedPayload): Promise<void> {
  const args = notifyArgsFor(p);
  try {
    if (args.meetingUrl && !isSyntheticUrl(args.meetingUrl)) {
      try {
        const bot = await invoke<{ botId: string } | null>("meetings_check_bot_for_url", {
          meetingUrl: args.meetingUrl,
          eventId: args.sourceEventId,
        });
        if (bot) return;
      } catch (botErr) {
        console.warn("meetings_check_bot_for_url failed, continuing to notify:", botErr);
      }
    }
    await invoke("meetings_notify_detected", { payload: args });
  } catch (err) {
    console.error("meeting:detected notify failed:", err);
  }
}
