/**
 * OWNER-R3: plain words for inviting the notetaker (the recording bot hq-pro
 * sends to a meeting link) from the console-rail Meetings destination. Pure;
 * the components call the existing meetings-store actions.
 */

import { isPlausibleMeetingUrl, type ScheduledBot } from "./meetings-model";
import { notetakerToggleState } from "./meetings-view-model";

/** Validation line for the pasted link, or null when there is nothing to say. */
export function notetakerLinkProblem(raw: string): string | null {
  const link = raw.trim();
  if (!link) return null;
  if (!/^https:\/\//i.test(link)) return "Paste the full link, starting with https://.";
  if (!isPlausibleMeetingUrl(link)) return "That isn't a Zoom, Google Meet, Teams, or Webex meeting link.";
  return null;
}

export function canInviteNotetaker(raw: string): boolean {
  const link = raw.trim();
  return Boolean(link) && notetakerLinkProblem(link) === null;
}

/**
 * Companies the notetaker can save to, by name. Personal is not offered:
 * hq-pro refuses every Personal recording with the HQ Workforce prompt.
 */
export function notetakerCompanyOptions(
  companyNamesByUid: ReadonlyMap<string, string>,
): Array<{ value: string; label: string }> {
  return [...companyNamesByUid.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The sole company, preselected; "" when the user must choose (or has none). */
export function defaultNotetakerCompany(companyNamesByUid: ReadonlyMap<string, string>): string {
  return companyNamesByUid.size === 1 ? [...companyNamesByUid.keys()][0]! : "";
}

/** Why a pasted-link invite was not sent: it had no company to save to. */
export function notetakerNeedsCompanyText(companyCount: number): string {
  return companyCount === 0
    ? "The notetaker saves its notes to a company. Join or create a company in HQ to invite it."
    : "Choose a company for the notes first. Use Invite notetaker to pick one.";
}

export interface NotetakerStatus {
  /** What the notetaker is doing, in plain words; empty when none is invited. */
  label: string;
  action: "invite" | "remove" | "none";
  /** Plain-language failure detail, rendered below a failed status. */
  detail?: string;
}

export function notetakerStatus(bot: ScheduledBot | undefined): NotetakerStatus {
  const model = notetakerToggleState(bot);
  if (model.kind === "failed") {
    return { label: "Notetaker couldn't join", action: "invite", detail: model.detail };
  }
  if (model.action === "invite") return { label: "", action: "invite" };
  const label =
    model.kind === "invited"
      ? "Notetaker invited"
      : model.kind === "joining"
        ? "Notetaker joining"
        : model.kind === "in-call"
          ? "Notetaker is in the meeting"
          : model.kind === "done"
            ? "Notetaker finished"
            : "Notetaker is saving the notes";
  return { label, action: model.action === "cancel" ? "remove" : "none" };
}
