import { describe, expect, it } from "vitest";

import {
  UNKNOWN_BOT_LABEL,
  UNKNOWN_PERSON_LABEL,
  addToPeerDirectory,
  applyPeerDirectory,
  dmPeerLabel,
  peersMissingNames,
  type PeerNameEntry,
} from "./peer-names";
import {
  collapseDuplicateDmRows,
  initialsFor,
  normalizeConversations,
  normalizeDm,
  resolveSearchHitRow,
} from "./sidebar-model";
import { channelDisplayName, type Channel } from "./channels";

const WILL = "prs_01M3T6YYR2GTRVXB19DK8N5P3F";
const SEAN = "prs_01M2413XHZEH2RY2MHH97EWB9T";
const NIMA = "prs_01M3WE3C4K6Q3NWWVF9AG20KAZ";
const BOT = "agt_01KTX6WQ6SYH3TZGF3DSDRPGGD";
const at = new Date().toISOString();

function directoryOf(
  rows: Array<{ personUid: string } & PeerNameEntry>,
): Map<string, PeerNameEntry> {
  return addToPeerDirectory(new Map(), rows);
}

describe("DM peer labels never show a raw person id", () => {
  it("a peer known only by uid shows the name another roster has", () => {
    const directory = directoryOf([
      { personUid: WILL, displayName: "Will McLeod", email: "will@example.com" },
    ]);
    const row = normalizeDm(
      { personUid: WILL, lastMessageAt: at },
      { peerDirectory: directory },
    );
    expect(row.title).toBe("Will McLeod");
    expect(row.personUid).toBe(WILL);
    expect(row.id).toBe(`dm:${WILL}`);
    expect(initialsFor(row.title)).toBe("WM");
  });

  it("a peer with no name but an email shows the email", () => {
    const row = normalizeDm({
      personUid: SEAN,
      email: "sean@example.com",
      lastMessageAt: at,
    });
    expect(row.title).toBe("sean@example.com");
  });

  it("a peer with a directory email but no name shows that email", () => {
    const directory = directoryOf([{ personUid: SEAN, email: "sean@example.com" }]);
    expect(dmPeerLabel({ personUid: SEAN }, directory)).toBe("sean@example.com");
  });

  it("a peer with nothing shows Unknown person, never the prs_ id", () => {
    const row = normalizeDm({ personUid: NIMA, lastMessageAt: at });
    expect(row.title).toBe(UNKNOWN_PERSON_LABEL);
    expect(row.title).not.toContain("prs_");
    expect(initialsFor(row.title)).toBe("UP");
    expect(row.personUid).toBe(NIMA);
  });

  it("a display name that is itself a raw id is not shown", () => {
    const row = normalizeDm({ personUid: NIMA, displayName: NIMA, lastMessageAt: at });
    expect(row.title).toBe(UNKNOWN_PERSON_LABEL);
  });

  it("an unnamed bot shows Unknown bot, never the agt_ id", () => {
    const row = normalizeDm({ personUid: BOT, lastMessageAt: at });
    expect(row.title).toBe(UNKNOWN_BOT_LABEL);
  });

  it("several unnamed peers stay separate rows instead of collapsing on the shared label", () => {
    const rows = normalizeConversations(
      [],
      [
        { personUid: WILL, lastMessageAt: at },
        { personUid: SEAN, lastMessageAt: at },
        { personUid: NIMA, lastMessageAt: at },
      ],
    );
    const dms = collapseDuplicateDmRows(rows).filter((row) => row.kind === "dm");
    expect(dms.map((row) => row.personUid).sort()).toEqual([SEAN, WILL, NIMA].sort());
    for (const row of dms) expect(row.title).toBe(UNKNOWN_PERSON_LABEL);
  });

  it("a search hit for an unknown DM peer uses the directory name, else Unknown person", () => {
    const hit = { messageId: "m1", scope: "dm", counterpartyUid: WILL, createdAt: at };
    expect(resolveSearchHitRow(hit, []).title).toBe(UNKNOWN_PERSON_LABEL);
    const directory = directoryOf([{ personUid: WILL, displayName: "Will McLeod" }]);
    const row = resolveSearchHitRow(hit, [], directory);
    expect(row.title).toBe("Will McLeod");
    expect(row.personUid).toBe(WILL);
  });

  it("group DM titles skip raw-id member names and use the directory when it knows them", () => {
    const channel: Channel = {
      channelId: "chn_group",
      scope: "group",
      name: "",
      members: [
        { personUid: WILL, displayName: WILL },
        { personUid: SEAN, displayName: "Sean Rich" },
      ],
    } as unknown as Channel;
    expect(channelDisplayName(channel)).toBe("Sean Rich");
    const directory = directoryOf([{ personUid: WILL, displayName: "Will McLeod" }]);
    const [row] = normalizeConversations([channel], [], { peerDirectory: directory });
    expect(row?.title).toBe("Will McLeod, Sean Rich");
  });
});

describe("peer directory", () => {
  it("fills only missing or raw-id names and leaves named contacts untouched", () => {
    const named = { personUid: SEAN, displayName: "Sean Rich" };
    const contacts = [{ personUid: WILL, displayName: WILL }, named];
    const directory = directoryOf([
      { personUid: WILL, displayName: "Will McLeod", email: "will@example.com" },
      { personUid: SEAN, displayName: "Someone Else" },
    ]);
    const next = applyPeerDirectory(contacts, directory);
    expect(next[0]).toMatchObject({ displayName: "Will McLeod", email: "will@example.com" });
    expect(next[1]).toBe(named);
    expect(applyPeerDirectory(next, directory)).toBe(next);
  });

  it("ignores raw ids offered as names and keeps the first readable name", () => {
    const directory = directoryOf([
      { personUid: WILL, displayName: WILL },
      { personUid: WILL, displayName: "Will McLeod" },
      { personUid: WILL, displayName: "Later Name" },
    ]);
    expect(directory.get(WILL)?.displayName).toBe("Will McLeod");
  });

  it("lists the peers that still lack a name", () => {
    expect(
      peersMissingNames([
        { personUid: WILL },
        { personUid: SEAN, email: "sean@example.com" },
        { personUid: NIMA, displayName: "Nima" },
      ]),
    ).toEqual([WILL, SEAN]);
  });
});
