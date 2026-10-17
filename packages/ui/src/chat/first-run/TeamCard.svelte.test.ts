// @vitest-environment happy-dom

// TeamCard: "Who do you work with?" under the setup bot's first message.
// Contract (COMPANY-CARD-DESIGN-2026-10-15): only the rows that apply, in the
// order invite, existing, create, "Just me for now"; the primary row follows
// the options; a pick goes to the host; pending, failure with Retry, and the
// one-line settled state.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import TeamCard from "./TeamCard.svelte";
import { TEAM_CARD_COPY, teamCardSettledLine, type FirstRunTeamOptions } from "./team-step";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const acme = { companyUid: "cmp_acme", slug: "acme", name: "Acme" };
const pickle = { companyUid: "cmp_pickle", slug: "pickle-works", name: "Pickle Works" };

function render(options: FirstRunTeamOptions, props: Record<string, unknown> = {}) {
  const onpick = vi.fn();
  const onretry = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(TeamCard, { target: host, props: { options, onpick, onretry, ...props } as never });
  flushSync();
  return { onpick, onretry, root: host };
}

const q = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (root: HTMLElement, id: string) => [...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

describe("TeamCard option sets", () => {
  it("invite: Join row with the inviter, primary, plus create and Just me", () => {
    const { root, onpick } = render({ invites: [acme], companies: [] }, { inviters: { acme: "Corey" } });
    expect(q(root, "team-card")?.querySelector("h3")?.textContent).toBe(TEAM_CARD_COPY.heading);
    expect(root.textContent).toContain(TEAM_CARD_COPY.line);
    expect(q(root, "team-card-join")?.textContent?.trim()).toBe("Join Acme");
    expect(q(root, "team-card-join")?.dataset.variant).toBe("primary");
    expect(q(root, "team-card-inviter")?.textContent).toBe("Corey invited you");
    expect(qa(root, "team-card-open")).toHaveLength(0);
    expect(q(root, "team-card-create")?.dataset.variant).not.toBe("primary");
    q(root, "team-card-join")?.click();
    expect(onpick).toHaveBeenCalledWith({ kind: "invite", company: acme });
  });

  it("existing: Open row is primary when there is no invite", () => {
    const { root, onpick } = render({ invites: [], companies: [acme] });
    expect(qa(root, "team-card-join")).toHaveLength(0);
    expect(q(root, "team-card-open")?.textContent?.trim()).toBe("Open Acme");
    expect(q(root, "team-card-open")?.dataset.variant).toBe("primary");
    q(root, "team-card-open")?.click();
    expect(onpick).toHaveBeenCalledWith({ kind: "existing", company: acme });
  });

  it("none: Create a company is primary and opens a name field inline", () => {
    const { root, onpick } = render({ invites: [], companies: [] });
    expect(qa(root, "team-card-join")).toHaveLength(0);
    expect(qa(root, "team-card-open")).toHaveLength(0);
    const create = q(root, "team-card-create")!;
    expect(create.textContent?.trim()).toBe(TEAM_CARD_COPY.create);
    expect(create.dataset.variant).toBe("primary");
    create.click();
    flushSync();
    const input = q(root, "team-card-name") as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = "Pickle Works";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    q(root, "team-card-create-submit")?.click();
    flushSync();
    expect(onpick).toHaveBeenCalledWith({ kind: "create", name: "Pickle Works" });
  });

  it("all three: rows in order invite, existing, create, then Just me", () => {
    const { root, onpick } = render({ invites: [acme], companies: [pickle] });
    const order = qa(root, "team-card").flatMap((card) =>
      [...card.querySelectorAll<HTMLElement>("[data-testid]")]
        .map((el) => el.dataset.testid!)
        .filter((id) => ["team-card-join", "team-card-open", "team-card-create", "team-card-personal"].includes(id)),
    );
    expect(order).toEqual(["team-card-join", "team-card-open", "team-card-create", "team-card-personal"]);
    expect(q(root, "team-card-open")?.dataset.variant).not.toBe("primary");
    expect(q(root, "team-card-personal")?.textContent?.trim()).toBe(TEAM_CARD_COPY.personal);
    q(root, "team-card-personal")?.click();
    expect(onpick).toHaveBeenCalledWith({ kind: "personal" });
  });
});

describe("TeamCard states", () => {
  it("pending: the pressed row spins and every row waits", () => {
    const { root } = render({ invites: [acme], companies: [pickle] }, { pendingKey: "invite:acme" });
    expect(q(root, "team-card-join")?.querySelector('[data-testid="team-card-spinner"]')).not.toBeNull();
    for (const id of ["team-card-join", "team-card-open", "team-card-create", "team-card-personal"]) {
      expect((q(root, id) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("pending: the card and the pressed row say they are busy", () => {
    const { root } = render({ invites: [acme], companies: [pickle] }, { pendingKey: "invite:acme" });
    expect(q(root, "team-card")?.getAttribute("aria-busy")).toBe("true");
    expect(q(root, "team-card-join")?.getAttribute("aria-busy")).toBe("true");
    expect(q(root, "team-card-open")?.hasAttribute("aria-busy")).toBe(false);
  });

  it("pending Create: the name field and every row wait while the Create button spins", () => {
    const props = $state<Record<string, unknown>>({
      options: { invites: [acme], companies: [] },
      onpick: vi.fn(),
      onretry: vi.fn(),
      pendingKey: null,
      error: null,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(TeamCard, { target: host, props: props as never });
    flushSync();
    q(host, "team-card-create")!.click();
    flushSync();
    const input = q(host, "team-card-name") as HTMLInputElement;
    input.value = "Pickle Works";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    q(host, "team-card-create-submit")!.click();
    flushSync();
    expect(props.onpick).toHaveBeenCalledWith({ kind: "create", name: "Pickle Works" });
    props.pendingKey = "create";
    flushSync();
    const submit = q(host, "team-card-create-submit") as HTMLButtonElement;
    expect(submit.querySelector('[data-testid="team-card-spinner"]')).not.toBeNull();
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect(submit.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    expect((q(host, "team-card-join") as HTMLButtonElement).disabled).toBe(true);
    expect((q(host, "team-card-personal") as HTMLButtonElement).disabled).toBe(true);
    expect(q(host, "team-card")?.getAttribute("aria-busy")).toBe("true");
    // The create fails: the error line and Retry show, and the field is usable again.
    props.pendingKey = null;
    props.error = "Something went wrong. Try again.";
    flushSync();
    expect(q(host, "team-card-error")?.textContent).toContain("Something went wrong. Try again.");
    expect(q(host, "team-card-retry")).not.toBeNull();
    expect(q(host, "team-card")?.getAttribute("aria-busy")).toBe("false");
    expect(input.disabled).toBe(false);
  });

  it("failure: a plain sentence with Retry", () => {
    const { root, onretry } = render({ invites: [acme], companies: [] }, { error: "Couldn't join the company. Try again." });
    expect(q(root, "team-card-error")?.textContent).toContain("Couldn't join the company. Try again.");
    q(root, "team-card-retry")?.click();
    expect(onretry).toHaveBeenCalledOnce();
  });

  it("settled: one line with a tick, no rows", () => {
    const line = teamCardSettledLine({ kind: "company", how: "joined", company: acme });
    const { root } = render({ invites: [acme], companies: [] }, { settled: line });
    expect(q(root, "team-card")).toBeNull();
    expect(q(root, "team-card-settled")?.textContent).toContain("Joined Acme");
    expect(q(root, "team-card-settled")?.textContent).toContain("✓");
  });

  it("settled lines follow the design copy", () => {
    expect(teamCardSettledLine({ kind: "personal" })).toBe("Working solo");
    expect(teamCardSettledLine({ kind: "company", how: "created", company: acme })).toBe("Created Acme");
    expect(teamCardSettledLine({ kind: "company", how: "joined", company: acme })).toBe("Joined Acme");
  });
});

describe("TeamCard after a create made a company", () => {
  it("shows that name locked, disables the other rows, and Create resends it", () => {
    const { root, onpick } = render(
      { invites: [acme], companies: [pickle] },
      { createdName: "Brine Labs", error: "Something went wrong. Try again." },
    );
    const input = q(root, "team-card-name") as HTMLInputElement;
    expect(input.value).toBe("Brine Labs");
    expect(input.readOnly).toBe(true);
    input.value = "Other Name";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect((q(root, "team-card-join") as HTMLButtonElement).disabled).toBe(true);
    expect((q(root, "team-card-open") as HTMLButtonElement).disabled).toBe(true);
    expect((q(root, "team-card-personal") as HTMLButtonElement).disabled).toBe(true);
    q(root, "team-card-create-submit")!.click();
    expect(onpick).toHaveBeenCalledWith({ kind: "create", name: "Brine Labs" });
  });
});
