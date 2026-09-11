# Creating a company and creating an agent

Status: proposed · Owner: design · Last updated: 2026-09-11

This specifies what happens when someone asks the desktop app for a new
company or a new agent — from the moment they click, through the questions
they answer, to the moment the thing exists. It covers the four entry points
that exist today plus the states that are currently unhandled.

## The decision this settles

There are two plausible shapes for "create a company":

1. **A modal.** The "+" menu opens a dialog, the dialog collects a name and a
   slug, the dialog calls an API, the dialog closes, the sidebar grows a row.
2. **A lifecycle card.** The "+" menu asks the server to post a card into the
   `#welcome` channel, the app navigates there and focuses it, and the person
   fills it in where they can see it.

This spec chooses **(2), the lifecycle card**, for both company and agent
creation, and treats every entry point as a *router* to a card rather than as
a form of its own.

The reasons, in order of weight:

- **The server already owns the flow.** Company creation is not one call. It
  is name → slug availability → cloud bucket provisioning → plan choice →
  (on paid plans) a Stripe checkout round-trip. The backend drives that
  sequence by posting successive cards (`create_company` → `activate_cloud` →
  `upgrade_plan`). A modal would have to re-implement the same state machine
  on the client and keep it in step with the server's, forever.
- **Two implementations drift.** The `#welcome` cards are the path a brand-new
  user takes on their first launch, and they cannot be removed. Adding a modal
  means "create a company" exists twice — and the modal is the copy that will
  fall behind when the server adds a step.
- **Progress stays where the team can see it.** Provisioning is slow and
  partly asynchronous. In a channel, a half-finished company is a visible card
  with a status; in a modal, it is a spinner that vanishes when the window is
  dismissed, with nothing to return to.
- **Agents are a spend decision.** An agent costs $100–$500/month and is gated
  on the company's plan. That belongs in the company's channel, next to the
  Team tab's spend row, not behind a dialog that only the person who opened it
  ever sees.

Modals remain correct for their existing jobs: picking recipients for a new
message, naming a project, confirming something destructive. What separates
them from this case is that those complete in one step, client-side, with no
server-driven sequel.

---

## Concepts and names

| Term | Meaning |
| --- | --- |
| Lifecycle card | A server-posted, form-shaped system event rendered by `LifecycleCard.svelte`. Carries `cardKind`, `state`, fields and actions. |
| `#welcome` | The synthetic personal channel, wire id `setup`, where account-level lifecycle cards land. Display name "welcome". |
| Company channel | Each company's own channel. Agent cards land here. |
| Entry point | A control that *starts* a flow. It never renders the form; it asks the server where the form is and navigates there. |
| Scope | The sidebar's company filter: `"all"`, `"personal"`, or a `companyUid`. |

Card kinds in play: `create_company`, `activate_cloud`, `upgrade_plan`,
`companies_summary`, `create_agent`, `status`.

---

## Flow A — New company

### A1. Entry points

Four controls start this flow. All four do the same thing.

| # | Where | Control | Visible when |
| --- | --- | --- | --- |
| 1 | Sidebar "+" menu | "New company" | Always (when the build can run card actions) |
| 2 | Company switcher popover | "New company", below the company list | Always |
| 3 | `#welcome` → "Your companies" card | "Create another company" | The summary card is present |
| 4 | Empty state, no companies yet | The seeded `create_company` card itself | First launch |

Entry points 1 and 2 are *routers*. They call:

```
runCardAction({
  channelId: "setup",
  cardId:    "companies_summary",
  actionId:  "create_company",
  values:    {},
})
```

and then navigate to the card the server names in its reply. Entry point 3
*is* that action, clicked directly on the card.

### A2. What the entry point does, step by step

1. **Mark the control busy.** Disable it and set `aria-busy="true"`. Do not
   open a spinner overlay — the click is answered in under a second or it
   fails.
2. **Call the action** with an idempotency key derived from
   `(channelId, cardId, actionId)`, so a double-click cannot post two cards.
3. **Interpret the reply:**
   - `state: "blocked"` → stay put, show the server's `reason` inline beneath
     the menu item. Do not navigate. Do not toast.
   - `404` → treat as success. This is the brand-new-account case: there is no
     summary card to act on because the seeded `create_company` card is
     already sitting in `#welcome`. Navigate to `#welcome` and focus the newest
     live `create_company` card.
   - otherwise → navigate to `channelId` from the reply (`"setup"`) and focus
     `cardId`.
4. **Navigate and focus.** Open the channel, scroll the card into view, move
   focus to it (`tabindex="-1"` on the card element), then move focus to its
   first empty required field. Focus is what makes this feel like a form
   opening rather than a page jumping.
5. **Close the menu** only after the navigation is committed, so a blocked
   result still has somewhere to render.

If the card does not appear within ~6 seconds of polling, stop polling, land
the user in `#welcome` anyway, and leave the channel scrolled to the bottom.
Never show a dead spinner.

### A3. The card sequence

**Step 1 of 3 — `create_company`, "Name your company"**

- Summary: "This creates the company channel, vault, and team roster."
- Fields: `name` (text, required) · `slug` (text, required, hint shows
  availability, e.g. "ramen-bae is available") · `website` (text, optional,
  "we'll use its icon for your company").
- Action: **Create company** (primary).
- Client validates only "required is non-empty". Slug shape, uniqueness and
  reserved words are the server's answer, returned as the field's `error`.

**Step 2 of 3 — `activate_cloud`, "Turning on cloud sync"**

- Readonly fields: bucket, region.
- **No actions.** The server flips `pending` → `done` on its own. The card
  shows a spinner and the status `PENDING`.
- This step can fail. On failure the card goes `blocked` with a reason and a
  **Retry** action. It must not strand the user with a spinner.

**Step 3 of 3 — `upgrade_plan`, "Choose a plan"**

- Radio field `plan`: Starter (Free) · Workforce ($500/mo flat · agents
  unlocked) · Enterprise (Talk to us).
- Actions: **Continue to checkout** (primary) · **Stay on Starter**
  (secondary).
- Checkout opens the returned URL externally and the card goes `pending` with
  **Retry checkout** / **Cancel checkout**.

**After the last step**

- The server posts or upserts the `companies_summary` card (same event id, so
  it updates in place rather than stacking).
- The new company appears in the sidebar scope list and gets its own channel.
- The app switches scope to the new company and opens its channel. This is the
  one automatic scope change in the product, and it is right: the user just
  said "make me this company", so showing it to them is the answer, not a
  surprise.

### A4. Permissions

Anyone signed in can create a company; they become its owner. There is no
blocked state for entry points 1, 2 and 4. Entry point 3 can be blocked if the
account is over a company limit — the server says so and the card renders the
reason.

---

## Flow B — New agent

An agent always belongs to a company, needs the Workforce plan, and needs the
acting person to be an owner or admin. Those three preconditions are what make
this flow different from company creation.

### B1. Entry points

| # | Where | Control | Visible when |
| --- | --- | --- | --- |
| 1 | Sidebar "+" menu | "New agent" | At least one company is available |
| 2 | Company channel header | "Add agent" | The viewer can act on that company's Team tab |
| 3 | Company → Team tab → spend row | "Add agent" | The viewer can act |

All three call:

```
runCompanyTabAction({
  companyUid,
  tab:      "team",
  cardId:   "team:spend",
  actionId: "add_agent",
  values:   {},
})
```

and navigate to the `channelId` the reply names — the company's channel, where
a `create_agent` card has been posted or resurfaced.

### B2. Choosing the company — the one question worth asking

Entry points 2 and 3 already know the company. Entry point 1 does not, and
this is the single place in either flow where a dialog is justified.

Behaviour for the sidebar "New agent" item:

- **Scope is a single company** → use it. No question.
- **Scope is "All" or "Personal", and exactly one company is eligible** → use
  it. No question. (Eligible = the viewer can add agents there.)
- **Scope is "All" or "Personal", and two or more companies are eligible** →
  open a small picker.

The picker is a **menu, not a modal**: it replaces the "+" menu's contents in
place, titled "Add an agent to…", listing each eligible company with its icon
and plan. Escape returns to the "+" menu. It asks one question and then gets
out of the way.

Do not silently default to "the first company in the list". Picking the wrong
company here costs $100–$500/month, and the mistake is discovered later, in a
bill.

Companies the viewer *cannot* add agents to are listed but disabled, with the
reason as the row's secondary text ("Owners and admins only", "Needs
Workforce"). Hiding them makes the app look broken to someone who knows the
company exists.

### B3. Not on Workforce

If the company is on Starter, the server answers the `add_agent` action by
posting the `upgrade_plan` card into the company channel instead of
`create_agent`. The client does not special-case this: it navigates to
whatever card the reply names.

The one thing the client must get right is the copy at the entry point. The
sidebar item stays enabled — clicking it takes you to a card that explains the
plan gate, which is more useful than a disabled item that explains nothing.

### B4. The card sequence

**Agent · 1 of 3 — name and handle**

- Fields: `name` (text, required) · `handle` (text, required, hint shows
  availability, e.g. "@polar is available").
- Action: **Next** (primary).

**Agent · 2 of 3 — runtime**

- Radio `runtime`: Claude Code (Anthropic · long-context sessions) · Codex
  (OpenAI · fast background runs) · Grok Build (xAI · headless
  implementation).
- Action: **Next** (primary).

**Agent · 3 of 3 — size**

- Radio `size`: Basic ($100/mo) · Power ($250/mo) · Dev ($500/mo).
- Action: **Create agent** (primary).

Each step is a fresh card, so the channel keeps a readable record of the
choices rather than mutating one card in place.

**After the last step**

- The server mints the agent, returns `agentChannelId` and `agentUid`, and the
  app opens the agent's channel.
- While provisioning runs, the agent channel shows a `status` card in
  `pending` and the composer stays locked — you cannot message an agent that
  does not exist yet.
- When the status card reaches `done`, the composer unlocks and focus moves
  into it.

### B5. Permissions

A member who is not an owner or admin sees the entry points, clicks, and gets
a `blocked` result with the server's reason ("You don't have permission to add
agents here"). The reason renders inline at the entry point; the app does not
navigate.

---

## Shared rules

These apply to both flows and are the parts most likely to be got wrong.

1. **An entry point never renders a form.** It runs one action, reads one
   reply, and navigates. Any UI it owns is a busy state and an error line.
2. **Errors render where the click happened.** A blocked action shows its
   reason beneath the control that was clicked. A failure *after* navigation
   patches the card to `blocked` with the reason on the card. Neither uses a
   toast — a toast is gone before the user has finished reading it, and this
   is exactly the information they need to act on.
3. **Idempotency keys on every action**, keyed by
   `(channelId, cardId, actionId)` and held for the life of the in-flight
   request. Double-clicking "New company" must not create two companies.
4. **Focus is part of the navigation.** Landing on the channel is not enough;
   the card takes focus and then hands it to its first empty required field.
   A keyboard user should be typing the company name without touching the
   mouse.
5. **Client validation stops at "required".** Shape, uniqueness, availability
   and entitlement are all server answers. A client-side slug regex will
   disagree with the server eventually, and the user will trust the wrong one.
6. **Scope changes only on success**, and only for company creation. Creating
   an agent does not change scope — you are already in the company.
7. **Every entry point is optional.** Builds where the adapter has no
   `runCardAction` hide the "+" menu's create items entirely rather than
   showing controls that fail on click.

---

## States that need copy

These are the states with no designed copy today. Each needs a line before
this ships.

| State | Where it shows | Needs |
| --- | --- | --- |
| Cloud provisioning failed | `activate_cloud` card, `blocked` | Reason + Retry label |
| Checkout abandoned | `upgrade_plan` card, `pending` | What "Cancel checkout" leaves behind |
| Slug taken | `create_company`, field error | Suggestion, or just "taken"? |
| No eligible company for an agent | Sidebar "+" menu | One line explaining the plan gate |
| Agent provisioning failed | Agent channel `status` card | Reason + whether the handle is released |
| Company limit reached | `companies_summary` action, `blocked` | Reason + upgrade path |

---

## Open questions

1. **Does creating a company switch scope?** This spec says yes. The
   alternative — stay where you are and let the user switch — is defensible if
   company creation is often done on someone else's behalf.
2. **Should the agent company picker remember its last choice?** A team with
   one active company would rather not answer the same question twice, but a
   sticky default is how you accidentally bill the wrong company.
3. **Is `#welcome` the right home for account-level cards long term?** It is
   pinned, personal, and never archived, which is right. But it is also where
   the first-run hero lives, and those two jobs may separate later.
