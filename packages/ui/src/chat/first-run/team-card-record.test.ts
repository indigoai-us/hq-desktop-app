// The team card's settled line must survive a switch to another company's
// channel and an app restart: it is kept in global storage when a pick
// succeeds, and can be read back from the person's reply to the bot.

import { afterEach, describe, expect, it, vi } from "vitest";

import { teamCardReplyText } from "./team-card-pick";
import {
  TEAM_CARD_RECORDS_KEY,
  loadTeamCardRecords,
  loadTeamCardUnsentCreate,
  saveTeamCardRecord,
  saveTeamCardUnsentCreate,
  teamCardRecordKey,
  teamCardSettledFromReply,
  teamCardSettledFromReplyText,
} from "./team-card-record";
import { teamCardSettledLine, type FirstRunTeamChoice } from "./team-step";

const BOT = "agt_setup";
const ME = "prs_me";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => void data.set(key, value)),
    data,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("team card records", () => {
  it("keys a record by account and setup bot", () => {
    expect(teamCardRecordKey(" prs_me ", " agt_setup ")).toBe("prs_me:agt_setup");
    expect(teamCardRecordKey(null, BOT)).toBe(":agt_setup");
  });

  it("a saved pick is read back by a fresh load, as after a restart", () => {
    const storage = memoryStorage();
    const key = teamCardRecordKey(ME, BOT);
    expect(saveTeamCardRecord(storage, {}, key, "Created Acme")).toEqual({ [key]: "Created Acme" });
    expect(loadTeamCardRecords(storage)).toEqual({ [key]: "Created Acme" });
  });

  it("saving keeps records already in storage for other accounts", () => {
    const storage = memoryStorage({ [TEAM_CARD_RECORDS_KEY]: JSON.stringify({ "prs_other:agt_setup": "Working solo" }) });
    saveTeamCardRecord(storage, {}, teamCardRecordKey(ME, BOT), "Joined Acme");
    expect(loadTeamCardRecords(storage)).toEqual({ "prs_other:agt_setup": "Working solo", "prs_me:agt_setup": "Joined Acme" });
  });

  it("drops anything in storage that is not a settled line", () => {
    const storage = memoryStorage({ [TEAM_CARD_RECORDS_KEY]: JSON.stringify({ a: "Working solo", b: "", c: 3, d: null }) });
    expect(loadTeamCardRecords(storage)).toEqual({ a: "Working solo" });
    expect(loadTeamCardRecords(memoryStorage({ [TEAM_CARD_RECORDS_KEY]: "[1]" }))).toEqual({});
    expect(loadTeamCardRecords(null)).toEqual({});
  });

  it("broken storage reads as empty and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(loadTeamCardRecords(memoryStorage({ [TEAM_CARD_RECORDS_KEY]: "{not json" }))).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
  });

  it("a storage write that fails keeps the pick in memory and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = memoryStorage();
    storage.setItem.mockImplementation(() => {
      throw new Error("quota");
    });
    expect(saveTeamCardRecord(storage, {}, "k", "Working solo")).toEqual({ k: "Working solo" });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("settled line from the person's reply", () => {
  const company = { companyUid: "cmp_1", slug: "acme", name: "Acme Robotics" };
  const choices: FirstRunTeamChoice[] = [
    { kind: "personal" },
    { kind: "company", how: "created", company },
    { kind: "company", how: "joined", company },
    { kind: "company", how: "existing", company },
  ];

  it.each(choices.map((choice) => [teamCardReplyText(choice), choice] as const))(
    "reads %s back as the line the card showed",
    (text, choice) => {
      expect(teamCardSettledFromReplyText(text)).toBe(teamCardSettledLine(choice));
    },
  );

  it("any other text is not a card reply", () => {
    expect(teamCardSettledFromReplyText("Hello there.")).toBeNull();
    expect(teamCardSettledFromReplyText("I created .")).toBeNull();
    expect(teamCardSettledFromReplyText(null)).toBeNull();
  });

  it("only the person's first message after the bot's opening counts", () => {
    expect(
      teamCardSettledFromReply(
        [
          { fromPersonUid: BOT, body: "Hi." },
          { fromPersonUid: BOT, body: "Signed out." },
          { fromPersonUid: ME, body: "I joined Acme Robotics." },
        ],
        BOT,
      ),
    ).toBe("Joined Acme Robotics");
    expect(
      teamCardSettledFromReply(
        [
          { fromPersonUid: BOT, body: "Hi." },
          { fromPersonUid: ME, body: "Hello there." },
          { fromPersonUid: ME, body: "Just me for now." },
        ],
        BOT,
      ),
    ).toBeNull();
    expect(teamCardSettledFromReply([{ fromPersonUid: BOT, body: "Hi." }], BOT)).toBeNull();
    expect(teamCardSettledFromReply([{ fromPersonUid: ME, body: "Just me for now." }], " ")).toBeNull();
  });
});

describe("a created company whose reply has not gone through", () => {
  const key = teamCardRecordKey(ME, BOT);
  const unsent = { created: { companyUid: "cmp_new", slug: "pickle", name: "Pickle" }, name: "Pickle" };

  it("is read back by a fresh load, as after a restart, and is not a settled line", () => {
    const storage = memoryStorage();
    saveTeamCardUnsentCreate(storage, key, unsent);
    expect(loadTeamCardUnsentCreate(storage, key)).toEqual(unsent);
    expect(loadTeamCardRecords(storage)).toEqual({});
    expect(loadTeamCardUnsentCreate(storage, teamCardRecordKey("prs_other", BOT))).toBeNull();
  });

  it("is replaced by the settled line once the reply goes through, and other records are kept", () => {
    const other = teamCardRecordKey("prs_other", BOT);
    const storage = memoryStorage({ [TEAM_CARD_RECORDS_KEY]: JSON.stringify({ [other]: "Working solo" }) });
    saveTeamCardUnsentCreate(storage, key, unsent);
    const records = saveTeamCardRecord(storage, loadTeamCardRecords(storage), key, "Created Pickle");
    expect(records).toEqual({ [other]: "Working solo", [key]: "Created Pickle" });
    expect(loadTeamCardUnsentCreate(storage, key)).toBeNull();
    expect(JSON.parse(storage.data.get(TEAM_CARD_RECORDS_KEY)!)).toEqual({ [other]: "Working solo", [key]: "Created Pickle" });
  });

  it("never replaces a settled line", () => {
    const storage = memoryStorage({ [TEAM_CARD_RECORDS_KEY]: JSON.stringify({ [key]: "Joined Acme" }) });
    saveTeamCardUnsentCreate(storage, key, unsent);
    expect(loadTeamCardRecords(storage)).toEqual({ [key]: "Joined Acme" });
    expect(loadTeamCardUnsentCreate(storage, key)).toBeNull();
  });

  it("anything malformed under the key reads as none", () => {
    for (const value of [{ created: { slug: "pickle" }, name: "Pickle" }, { created: unsent.created, name: " " }, 7, null]) {
      const storage = memoryStorage({ [TEAM_CARD_RECORDS_KEY]: JSON.stringify({ [key]: value }) });
      expect(loadTeamCardUnsentCreate(storage, key)).toBeNull();
    }
  });
});
