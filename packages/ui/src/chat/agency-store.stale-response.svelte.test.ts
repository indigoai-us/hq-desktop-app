// @vitest-environment happy-dom

/**
 * Regression: `refresh()` had no in-flight guard, so a slow `listChat` for the
 * previously selected team could resolve AFTER the operator switched teams and
 * overwrite the new team's conversation with the old team's messages. The poll
 * interval went 4s → 15s on the perf branch, widening that window ~4×.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agencyStore,
  configureAgencyApi,
  selectAgencyTeam,
  startAgencyStore,
  stopAgencyStore,
  type AgencyApi,
} from "./agency-store.svelte";
import type { AgencyMessage, AgencyTeam } from "./agency";

const TEAMS: AgencyTeam[] = [
  { company: "acme", team: "alpha" } as AgencyTeam,
  { company: "acme", team: "beta" } as AgencyTeam,
];

function msg(team: string): AgencyMessage[] {
  return [
    {
      ts: "2026-08-28T00:01:00.000Z",
      inbox: `${team}-inbox`,
      from: "manager",
      kind: "fyi",
      text: `${team} conversation`,
    } as AgencyMessage,
  ];
}

beforeEach(() => {
  stopAgencyStore();
});

afterEach(() => {
  stopAgencyStore();
  configureAgencyApi(null);
});

describe("agency store stale-response guard", () => {
  it("discards a slow listChat from a superseded team selection", async () => {
    let releaseAlpha = (): void => undefined;
    const alphaPending = new Promise<void>((resolve) => {
      releaseAlpha = () => resolve();
    });

    const api: AgencyApi = {
      listTeams: async () => TEAMS,
      listQuestions: async () => [],
      listChat: async (_company, team) => {
        if (team === "alpha") {
          await alphaPending;
          return msg("alpha");
        }
        return msg("beta");
      },
      answerQuestion: async () => "delivered",
      sendMessage: async () => "delivered",
    };
    configureAgencyApi(api);

    // Initial refresh selects alpha and hangs on its chat response.
    startAgencyStore();
    await vi.waitFor(() => expect(agencyStore.selected?.team).toBe("alpha"));
    expect(agencyStore.messages).toHaveLength(0);

    // Operator switches to beta; that refresh completes first.
    selectAgencyTeam("acme", "beta");
    await vi.waitFor(() =>
      expect(agencyStore.messages[0]?.text).toBe("beta conversation"),
    );

    // The superseded alpha response finally lands — it must be dropped.
    releaseAlpha();
    await alphaPending;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(agencyStore.selected?.team).toBe("beta");
    expect(agencyStore.messages[0]?.text).toBe("beta conversation");
  });
});
