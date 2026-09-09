import { describe, expect, it } from "vitest";

import {
  FIRST_MOVES_ORDER,
  firstMovesFor,
  markFirstMoveDone,
  readFirstMovesDone,
} from "./first-moves";

function memory() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

describe("firstMovesFor", () => {
  it("shows nothing before the account has a company", () => {
    expect(firstMovesFor({ hasCompany: false, hasProjectChannel: false, done: new Set() })).toEqual([]);
  });

  it("expands exactly one move — the first not done — in a fixed order", () => {
    const moves = firstMovesFor({ hasCompany: true, hasProjectChannel: false, done: new Set() });
    expect(moves.map((m) => m.id)).toEqual([...FIRST_MOVES_ORDER]);
    expect(moves.filter((m) => m.state === "current").map((m) => m.id)).toEqual(["project-channel"]);
    expect(moves.slice(1).every((m) => m.state === "todo")).toBe(true);
  });

  it("ticks the project-channel move from live app state, not the honour system", () => {
    const moves = firstMovesFor({ hasCompany: true, hasProjectChannel: true, done: new Set() });
    expect(moves[0]).toMatchObject({ id: "project-channel", state: "done" });
    expect(moves[1]).toMatchObject({ id: "invite", state: "current" });
  });

  it("disappears once every move is done", () => {
    expect(
      firstMovesFor({
        hasCompany: true,
        hasProjectChannel: true,
        done: new Set(["invite", "agent", "coding-tools"]),
      }),
    ).toEqual([]);
  });

  it("never shows a terminal command as copy", () => {
    for (const move of firstMovesFor({ hasCompany: true, hasProjectChannel: false, done: new Set() })) {
      expect(move.body).not.toMatch(/hq rescue|claude login|npx |--paths/);
    }
  });
});

describe("first-moves persistence", () => {
  it("round-trips done moves and ignores junk", () => {
    const storage = memory();
    expect(readFirstMovesDone(storage).size).toBe(0);
    markFirstMoveDone("invite", storage);
    markFirstMoveDone("coding-tools", storage);
    expect([...readFirstMovesDone(storage)].sort()).toEqual(["coding-tools", "invite"]);
    storage.setItem("hq.welcome.first-moves.v1", '["nope", 3, "agent"]');
    expect([...readFirstMovesDone(storage)]).toEqual(["agent"]);
    storage.setItem("hq.welcome.first-moves.v1", "{not json");
    expect(readFirstMovesDone(storage).size).toBe(0);
  });
});
