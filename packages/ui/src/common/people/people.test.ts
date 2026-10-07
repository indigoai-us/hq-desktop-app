// @vitest-environment happy-dom
// OWNER-R5: one resolver for people and bots; never a raw id.
import { describe, expect, it, vi } from "vitest";
import { buildPeopleIndex, isRawPersonId, resolvePerson, rosterEntriesFromRows, uniquePeople } from "./people.js";

const ROSTER = rosterEntriesFromRows([
  { personUid: "prs_01KQ2TZQMA8078CHPDWBAFPN0Z", displayName: "Corey Epstein", email: "corey@getindigo.ai" },
  { personUid: "prs_01KQ695MZHZBYFMVMPRTGFW34B", displayName: "Jacob Posel", email: "jacob@getindigo.ai" },
  { personUid: "prs_01KQ695MZHZBYFMVMPRTGFW99X", displayName: "Caitlin Park", email: "caitlin@getindigo.ai" },
  { personUid: "prs_01KQ695MZHZBYFMVMPRTGFW99X", email: "caitlin@vyg.ai" },
  { agentUid: "agt_686EVXD1DGG4B9XFB7WRAJYGD4", displayName: "Izzy", kind: "agent" },
]);

describe("people resolver", () => {
  const index = buildPeopleIndex(ROSTER);

  it("collapses id, email, handle, slug and name for one person into one identity", () => {
    const keys = ["prs_01KQ2TZQMA8078CHPDWBAFPN0Z", "corey@getindigo.ai", "corey", "Corey Epstein", "corey-epstein"];
    const ids = new Set(keys.map((k) => resolvePerson(index, k).key));
    expect(ids.size).toBe(1);
    expect(resolvePerson(index, "corey")).toMatchObject({ name: "Corey Epstein", detail: "corey@getindigo.ai", resolved: true });
    expect(resolvePerson(index, "jacob-posel").name).toBe("Jacob Posel");
  });

  it("merges two emails under one roster id", () => {
    expect(resolvePerson(index, "caitlin@vyg.ai").key).toBe(resolvePerson(index, "caitlin@getindigo.ai").key);
  });

  it("shows a bot by name with Bot muted", () => {
    expect(resolvePerson(index, "agt_686EVXD1DGG4B9XFB7WRAJYGD4")).toMatchObject({ name: "Izzy", detail: "Bot", kind: "agent" });
  });

  it("never returns a raw id: unresolved shows email or Unknown person/bot, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolvePerson(index, "poseljacob@gmail.com").name).toBe("poseljacob@gmail.com");
    expect(resolvePerson(index, "prs_01ZZZZZZZZZZZZZZZZZZZZZZZZ").name).toBe("Unknown person");
    expect(resolvePerson(index, "agt_01ZZZZZZZZZZZZZZZZZZZZZZZZ").name).toBe("Unknown bot");
    expect(warn).toHaveBeenCalledWith("[people] unresolved person key", "prs_01ZZZZZZZZZZZZZZZZZZZZZZZZ");
    warn.mockRestore();
  });

  it("shows a neutral placeholder while the roster loads, never the id", () => {
    const empty = buildPeopleIndex([]);
    expect(resolvePerson(empty, "prs_01KQ2TZQMA8078CHPDWBAFPN0Z", { loading: true }).name).toBe("…");
    expect(resolvePerson(empty, "corey@getindigo.ai", { loading: true }).name).toBe("corey@getindigo.ai");
  });

  it("uniquePeople: one entry per person, people by name then bots", () => {
    const values = ["agt_686EVXD1DGG4B9XFB7WRAJYGD4", "corey", "Corey Epstein", "corey@getindigo.ai", "jacob-posel", "jacob@getindigo.ai", "prs_01KQ695MZHZBYFMVMPRTGFW34B"];
    const out = uniquePeople(index, values);
    expect(out.map((p) => p.name)).toEqual(["Corey Epstein", "Jacob Posel", "Izzy"]);
    for (const p of out) expect(isRawPersonId(p.name)).toBe(false);
  });

  it("an ambiguous first name does not resolve to either person", () => {
    const two = buildPeopleIndex([
      { id: "prs_aaaaaaaa", displayName: "Sam Lee", email: "sam.lee@x.io" },
      { id: "prs_bbbbbbbb", displayName: "Sam Ortiz", email: "ortiz@x.io" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolvePerson(two, "sam").resolved).toBe(false);
    warn.mockRestore();
  });
});

describe("people roster loader (OWNER-R5)", () => {
  it("resolves names from a cached Team read when loaded from a page effect", async () => {
    const { flushSync, mount, unmount } = await import("svelte");
    const { writeTeamCache } = await import("../../company/team-cache.js");
    const Probe = (await import("./PeopleLoadProbe.test-fixture.svelte")).default;
    writeTeamCache("loop-probe", {
      view: { members: [{ id: "prs_a", displayName: "Ada", kind: "human", topSkills: [], activeProjects: [] }], humans: [], agents: [], error: null, empty: false },
      invites: [],
    });
    const target = document.createElement("div");
    const app = mount(Probe, { target, props: { slug: "loop-probe" } });
    flushSync();
    expect(target.textContent).toBe("Ada");
    await unmount(app);
  });
});
