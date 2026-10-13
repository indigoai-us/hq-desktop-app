import { describe, expect, it } from "vitest";

import {
  botConnectionAccessState,
  botConnectionIsInteractive,
  botConnectionIsOn,
  readConnectionAccess,
  type BotConnectionAccessInput,
  type ConnectionAccess,
} from "./bot-integration-access-model.js";

const EMPTY_ACCESS: ConnectionAccess = {
  mode: "",
  canManage: true,
  entries: [],
};

function input(overrides: Partial<BotConnectionAccessInput> = {}): BotConnectionAccessInput {
  return {
    botUid: "agt_nova",
    botRole: "",
    mode: "",
    access: EMPTY_ACCESS,
    ...overrides,
  };
}

describe("readConnectionAccess", () => {
  it("returns null for anything that is not a record", () => {
    expect(readConnectionAccess(null)).toBeNull();
    expect(readConnectionAccess(undefined)).toBeNull();
    expect(readConnectionAccess("x")).toBeNull();
    expect(readConnectionAccess(42)).toBeNull();
    expect(readConnectionAccess([])).toBeNull();
  });

  it("returns an empty access envelope for an empty record", () => {
    expect(readConnectionAccess({})).toEqual({
      mode: "",
      canManage: false,
      entries: [],
    });
  });

  it("reads mode off the nested access record and only treats canManage=true as true", () => {
    expect(
      readConnectionAccess({
        access: { mode: "shared" },
        canManage: true,
      }),
    ).toEqual({ mode: "shared", canManage: true, entries: [] });

    expect(
      readConnectionAccess({
        access: { mode: 123 },
        canManage: "true",
      }),
    ).toEqual({ mode: "", canManage: false, entries: [] });
  });

  it("coerces entries to an array at the parse boundary and skips non-record items", () => {
    const parsed = readConnectionAccess({
      entries: [
        null,
        "not an entry",
        42,
        { granteeType: "person", granteeId: "agt_nova", permission: "read" },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.entries).toEqual([
      { granteeType: "person", granteeId: "agt_nova", permission: "read" },
    ]);
  });

  it("coerces entries to an array when the field is not an array", () => {
    const parsed = readConnectionAccess({ entries: "nope" });
    expect(parsed).not.toBeNull();
    expect(parsed!.entries).toEqual([]);
  });

  it("skips entries with an empty granteeType", () => {
    const parsed = readConnectionAccess({
      entries: [
        { granteeType: "", granteeId: "agt_nova" },
        { granteeType: "person", granteeId: "agt_nova" },
      ],
    });
    expect(parsed!.entries).toEqual([
      { granteeType: "person", granteeId: "agt_nova", permission: "" },
    ]);
  });

  it("coerces entry field types to strings", () => {
    const parsed = readConnectionAccess({
      entries: [
        {
          granteeType: "person",
          granteeId: 42,
          permission: null,
        },
      ],
    });
    expect(parsed!.entries).toEqual([
      { granteeType: "person", granteeId: "", permission: "" },
    ]);
  });
});

describe("botConnectionAccessState", () => {
  it("returns read-only when the caller cannot manage, even if role or ACL would say on", () => {
    expect(
      botConnectionAccessState(
        input({
          botRole: "owner",
          mode: "everyone",
          access: {
            mode: "everyone",
            canManage: false,
            entries: [
              { granteeType: "person", granteeId: "agt_nova", permission: "read" },
            ],
          },
        }),
      ),
    ).toBe("read-only");
  });

  it("returns on-admin when the bot is a company owner", () => {
    expect(
      botConnectionAccessState(
        input({ botRole: "Owner", access: { ...EMPTY_ACCESS, canManage: true } }),
      ),
    ).toBe("on-admin");
  });

  it("returns on-admin when the bot is a company admin", () => {
    expect(
      botConnectionAccessState(
        input({ botRole: "ADMIN", access: { ...EMPTY_ACCESS, canManage: true } }),
      ),
    ).toBe("on-admin");
  });

  it("returns on-everyone when the connection is open to everyone", () => {
    expect(
      botConnectionAccessState(
        input({
          mode: "everyone",
          access: { ...EMPTY_ACCESS, canManage: true },
        }),
      ),
    ).toBe("on-everyone");
  });

  it("returns on-everyone for the legacy-open mode", () => {
    expect(
      botConnectionAccessState(
        input({
          mode: "legacy-open",
          access: { ...EMPTY_ACCESS, canManage: true },
        }),
      ),
    ).toBe("on-everyone");
  });

  it("returns on when the ACL has an explicit person entry for the bot", () => {
    expect(
      botConnectionAccessState(
        input({
          mode: "shared",
          access: {
            mode: "shared",
            canManage: true,
            entries: [
              { granteeType: "person", granteeId: "agt_nova", permission: "read" },
            ],
          },
        }),
      ),
    ).toBe("on");
  });

  it("returns off when there is no explicit entry, no everyone, no role bypass", () => {
    expect(
      botConnectionAccessState(
        input({
          mode: "shared",
          access: {
            mode: "shared",
            canManage: true,
            entries: [
              { granteeType: "person", granteeId: "someone_else", permission: "read" },
            ],
          },
        }),
      ),
    ).toBe("off");
  });

  it("does not count a company-wide or role entry as an explicit person entry", () => {
    expect(
      botConnectionAccessState(
        input({
          mode: "shared",
          access: {
            mode: "shared",
            canManage: true,
            entries: [
              { granteeType: "company-wide", granteeId: "", permission: "read" },
              { granteeType: "role", granteeId: "admin", permission: "read" },
            ],
          },
        }),
      ),
    ).toBe("off");
  });
});

describe("botConnectionIsInteractive", () => {
  it("is true only for on and off", () => {
    expect(botConnectionIsInteractive("on")).toBe(true);
    expect(botConnectionIsInteractive("off")).toBe(true);
    expect(botConnectionIsInteractive("on-admin")).toBe(false);
    expect(botConnectionIsInteractive("on-everyone")).toBe(false);
    expect(botConnectionIsInteractive("read-only")).toBe(false);
  });
});

describe("botConnectionIsOn", () => {
  it("is true for on, on-everyone, on-admin and false for off, read-only", () => {
    expect(botConnectionIsOn("on")).toBe(true);
    expect(botConnectionIsOn("on-everyone")).toBe(true);
    expect(botConnectionIsOn("on-admin")).toBe(true);
    expect(botConnectionIsOn("off")).toBe(false);
    expect(botConnectionIsOn("read-only")).toBe(false);
  });
});
