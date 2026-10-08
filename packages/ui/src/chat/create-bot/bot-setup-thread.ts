/**
 * The setup that follows the New bot modal, told by the bot in its own thread.
 *
 * The modal collects only what creating needs (kind, where it runs, name).
 * The rest of the old six-step sheet (access, capabilities, verify) arrives as
 * ordinary messages from the new bot in the DM or channel the person lands
 * in, using cards the timeline already renders:
 *
 *   1. a greeting that says what is left,
 *   2. an access request card (Approve read / write, Deny),
 *   3. "Pick my skills", pointing at the profile pane's Capabilities edit,
 *   4. "Verified, I'm ready" once the bot is online.
 *
 * A local bot gets none of the access or skills rows: picking the company
 * in New bot is the grant, and it runs on this computer with the person's
 * own access. Its thread is a greeting, then the kickoff conversation.
 *
 * These are local rows; nothing here posts to the server. Approving the
 * access card does not pretend to grant anything: the bot answers with the
 * exact `hq files share` command as a copyable prompt, because the desktop
 * has no vault-grant call of its own. Secret and enroll values never appear.
 */
import type { ConversationMessageWire } from "../chat-api.js";
import type { ShareGrantLevel } from "../messaging/share-request-card.js";

export const BOT_SETUP_CARD_PREFIX = "bot-setup:";
/** The folder a new bot asks for first: company context, read-only. */
export const BOT_SETUP_DEFAULT_PATH = "knowledge/";

export interface BotSetupEntry {
  agentUid: string;
  /**
   * Local bots run with the person's own access, so they never ask for a
   * grant. Cloud bots ask with the access card.
   */
  kind: "local" | "cloud";
  name: string;
  /** Bot email when known; the share command needs a real principal. */
  email: string | null;
  /** Company slug for the share command; null for a personal bot. */
  companySlug: string | null;
  companyUid: string | null;
  /** Row the setup belongs to: `dm:<uid>` for Local, the channel for Cloud. */
  rowId: string | null;
  channelId: string | null;
  createdAt: number;
  online: boolean;
  access: { state: "pending" | "approved" | "denied"; level: ShareGrantLevel };
}

export function botSetupCardId(agentUid: string): string {
  return `${BOT_SETUP_CARD_PREFIX}${agentUid}:access`;
}

/** The agent uid a setup card id belongs to, or null for any other card. */
export function botSetupUidFromCardId(cardId: string): string | null {
  if (!cardId.startsWith(BOT_SETUP_CARD_PREFIX)) return null;
  const rest = cardId.slice(BOT_SETUP_CARD_PREFIX.length);
  const end = rest.lastIndexOf(":access");
  const uid = end > 0 ? rest.slice(0, end) : "";
  return uid.trim() || null;
}

/** True when this setup thread is the one the person has open. */
export function botSetupMatchesRow(
  entry: BotSetupEntry,
  row: { id: string; channelId?: string | null } | null | undefined,
): boolean {
  if (!row) return false;
  if (entry.rowId && row.id === entry.rowId) return true;
  return Boolean(entry.channelId && row.channelId && row.channelId === entry.channelId);
}

/** The `hq files share` line the person runs to grant what the bot asked for. */
export function botSetupShareCommand(entry: BotSetupEntry): string {
  // File grants take an email or group, never an agt_ uid.
  const who = entry.email?.trim() || "<bot email>";
  const company = entry.companySlug ? ` --company ${entry.companySlug}` : "";
  return `hq files share ${BOT_SETUP_DEFAULT_PATH} --with ${who} --permission ${entry.access.level}${company}`;
}

/** True when this setup asks for folder access: cloud bots only. */
export function botSetupAsksAccess(entry: Pick<BotSetupEntry, "kind">): boolean {
  return entry.kind === "cloud";
}

export function botSetupWires(entry: BotSetupEntry): ConversationMessageWire[] {
  const at = (offset: number) => new Date(entry.createdAt + offset * 1000).toISOString();
  const from = { fromPersonUid: entry.agentUid, fromDisplayName: entry.name, direction: "in" as const, replyCount: 0 };
  if (!botSetupAsksAccess(entry)) {
    // Whatever access state an entry carries, a local bot shows no card.
    const wires: ConversationMessageWire[] = [
      {
        ...from,
        eventId: `${BOT_SETUP_CARD_PREFIX}${entry.agentUid}:hello`,
        body: `Hi, I'm ${entry.name}. I'll ask a few quick questions to finish my setup.`,
        createdAt: at(1),
      },
    ];
    if (entry.online) {
      wires.push({
        ...from,
        eventId: `${BOT_SETUP_CARD_PREFIX}${entry.agentUid}:ready`,
        body: "Verified, I'm ready. Send me a first task here.",
        createdAt: at(5),
      });
    }
    return wires;
  }
  const wires: ConversationMessageWire[] = [
    {
      ...from,
      eventId: `${BOT_SETUP_CARD_PREFIX}${entry.agentUid}:hello`,
      body: `Hi, I'm ${entry.name}. Two things before I start: grant me access to the company context, and pick my skills.`,
      createdAt: at(1),
    },
    {
      ...from,
      eventId: botSetupCardId(entry.agentUid),
      body: `Grant me access to ${BOT_SETUP_DEFAULT_PATH}`,
      messageKind: "system",
      systemEvent: {
        v: 1,
        type: "access_request",
        id: botSetupCardId(entry.agentUid),
        path: BOT_SETUP_DEFAULT_PATH,
        level: entry.access.level,
        note: "So I can read the company context. Read is enough to start; write lets me save notes there.",
        requestedBy: entry.name,
        state: entry.access.state,
        companyUid: entry.companyUid,
      },
      createdAt: at(2),
    },
  ];
  if (entry.access.state === "approved") {
    wires.push({
      ...from,
      eventId: `${BOT_SETUP_CARD_PREFIX}${entry.agentUid}:grant`,
      body: `Thanks. Run this once to apply ${entry.access.level} on ${BOT_SETUP_DEFAULT_PATH}; I pick it up on my next check-in.`,
      prompt: botSetupShareCommand(entry),
      createdAt: at(3),
    });
  } else if (entry.access.state === "denied") {
    wires.push({
      ...from,
      eventId: `${BOT_SETUP_CARD_PREFIX}${entry.agentUid}:grant`,
      body: `No folder access for now. You can grant it later from my profile, under Vault access.`,
      createdAt: at(3),
    });
  }
  wires.push({
    ...from,
    eventId: `${BOT_SETUP_CARD_PREFIX}${entry.agentUid}:skills`,
    body: "Pick my skills: open my profile and use Edit next to Capabilities.",
    createdAt: at(4),
  });
  if (entry.online) {
    wires.push({
      ...from,
      eventId: `${BOT_SETUP_CARD_PREFIX}${entry.agentUid}:ready`,
      body: "Verified, I'm ready. Send me a first task here.",
      createdAt: at(5),
    });
  }
  return wires;
}
