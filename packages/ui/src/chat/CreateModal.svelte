<script lang="ts">
  /**
   * The unified create modal — one search-first dialog behind the sidebar "+".
   *
   * Three steps in one card (find → create → summary), no tabs and no lane
   * selector: what the user types infers the lane. An existing person or agent
   * opens a DM, an existing channel opens it, an unmatched name creates a
   * channel — and a channel IS the project shell, so there is no third
   * "project" concept here and no project folder is materialized.
   *
   * Every field this modal offers is persisted somewhere the user can see:
   * there is deliberately NO description input, because `POST
   * /v1/notify/channels` has no `description` and a typed one would evaporate.
   * The "What's this for?" body is posted as a real first message instead, and
   * is hidden entirely when the host cannot send one.
   */
  import type { Channel } from "./channels.js";
  import type { ChatSidebarApi } from "./chat-api.js";
  import type { SelfIdentity } from "../identity/self.js";
  import {
    initialsFor,
    type CompanyScope,
    type ConversationRow,
    type DmContactInput,
    type ScopeCompany,
  } from "./sidebar-model.js";
  import { humanCompanyLabel } from "./visible-labels.js";
  import { focusOnMount, portal } from "./portal.js";
  import {
    buildFindResults,
    buildPickerCandidates,
    channelScopeKey,
    channelSlug,
    checkSlug,
    classifyFindQuery,
    companyRelation,
    inviteRequestBody,
    isValidEmail,
    knownSlugsInScope,
    memberFailureReason,
    parseCreateChannelError,
    rosterFromMembers,
    slugInputValue,
    stripRawUids,
    suggestFreeSlug,
    type CompanyRoster,
    type FindRow,
    type KnownChannel,
    type PickerCandidate,
    type SlugTarget,
  } from "./create-flow.js";
  import {
    channelCreateValidationMessage,
    channelExistsWithName,
    companyUidsByPerson,
    defaultChannelCompanyUid,
    directoryRowsFromFeed,
    personalScopeAllowed,
    pickChannelCompanyUid,
    unavailableChannelScopes,
    unconfirmedCreateMessage,
    type ChannelCreateMember,
  } from "./channel-create-scope.js";
  import "./tokens.css";
  import "./chat-tokens.css";

  interface Props {
    api: ChatSidebarApi;
    /** Full directory (people WITHOUT a conversation included) + browse rows. */
    rows: readonly ConversationRow[];
    contacts: readonly DmContactInput[];
    scopeCompanies: ScopeCompany[];
    /**
     * Workspaces the caller can actually CREATE in. A subset of
     * `scopeCompanies`, which is a browse list and includes companies the user
     * can only look at. Defaults to `scopeCompanies` so older hosts keep
     * working, but the desktop shell passes the filtered list.
     */
    createCompanies?: ScopeCompany[] | null;
    activeScope: CompanyScope;
    self?: SelfIdentity | null;
    /** Close; pass a channel id to open it on the way out. */
    /**
     * Close; pass a channel id to open it on the way out. `hint` carries the
     * display name + workspace so the host can paint the header immediately —
     * the directory feed has not listed a just-created channel yet, and the
     * sidebar's own copy can be overwritten by a refresh mid-create.
     */
    onclose: (
      openChannelId?: string,
      hint?: { title: string; companyUid: string | null },
    ) => void;
    onpick: (row: ConversationRow) => void;
    oncreated: (channel: Channel) => void | Promise<void>;
  }

  let {
    api,
    rows,
    contacts,
    scopeCompanies,
    createCompanies = null,
    activeScope,
    self = null,
    onclose,
    onpick,
    oncreated,
  }: Props = $props();

  type Step = "find" | "create" | "summary";

  interface MemberChip {
    key: string;
    type: "person" | "agent" | "email";
    personUid: string | null;
    email: string | null;
    label: string;
    /**
     * The companyUid a cross-workspace add was CONFIRMED for (D7). Never a
     * snapshot of "is external": that is re-derived from the live workspace
     * selection, so switching "In" after picking re-opens the confirmation
     * instead of silently smuggling someone across companies.
     */
    confirmedFor: string | null;
  }

  type IssueReason =
    | "invited-requested"
    | "invited-delivered"
    | "invite-failed"
    | "member-unreachable"
    | "member-agent-scope"
    | "member-not-owner"
    | "member-other"
    | "first-message-failed";

  interface Issue {
    key: string;
    label: string;
    reason: IssueReason;
    chip: MemberChip | null;
    email: string | null;
    /** Set once a retry from the summary succeeded. */
    resolved: string | null;
    /** A retry is in flight — the button is held so it cannot be double-fired. */
    pending: boolean;
    /** Why the LAST retry failed. Never swallow a retry into console.error. */
    error: string | null;
  }

  function issueFrom(
    partial: Omit<Issue, "resolved" | "pending" | "error">,
  ): Issue {
    return { ...partial, resolved: null, pending: false, error: null };
  }

  let step = $state<Step>("find");
  let query = $state("");
  let queryDebounced = $state("");
  let activeIndex = $state(0);

  let channelName = $state("");
  /** null = derived from the name; a string = the user renamed it. */
  let slugOverride = $state<string | null>(null);
  /** "" = personal scope; otherwise the companyUid (preserved contract). */
  let companyUid = $state("");
  let members = $state<MemberChip[]>([]);
  let firstMessage = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);
  /**
   * The last create call failed AND a channel with that name is now visible
   * somewhere we can list — the create may have committed despite the error,
   * so retry is held until the name changes (a duplicate is worse than a
   * second click).
   */
  let createUnconfirmed = $state(false);
  /** `${scopeKey}#${slug}` keys learned from 409s — the only way we hear about
   *  a channel we cannot see. */
  let serverTaken = $state<ReadonlySet<string>>(new Set<string>());

  let pickerQuery = $state("");
  let pickerIndex = $state(0);
  let confirmPick = $state<PickerCandidate | null>(null);
  /** Live roster for the SELECTED workspace — the only real D7 input. */
  let roster = $state<CompanyRoster | null>(null);

  let createdChannelId = $state<string | null>(null);
  let createdSlug = $state("");
  let issues = $state<Issue[]>([]);

  let dialogEl = $state<HTMLDivElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  let suggestionsEl = $state<HTMLDivElement | null>(null);
  let confirmEl = $state<HTMLDivElement | null>(null);
  let slugInputEl = $state<HTMLInputElement | null>(null);
  let pickerInputEl = $state<HTMLInputElement | null>(null);

  const canCreate = $derived(typeof api.createChannel === "function");
  const canAddMembers = $derived(typeof api.addChannelMember === "function");
  const canSendFirstMessage = $derived(
    typeof api.sendChannelMessage === "function",
  );
  const canInviteByEmail = $derived(typeof api.sendDmToEmail === "function");
  const selfUid = $derived(self?.uid?.trim() || null);

  // 110 ms — the sidebar's convention, and the `setTimeout(150)` test wait
  // depends on it.
  $effect(() => {
    const next = query;
    const timer = setTimeout(() => {
      queryDebounced = next;
    }, 110);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    dialogEl?.focus();
  });

  /**
   * The "In" options. Never `scopeCompanies` — creating in a workspace you are
   * not an active member of always fails server-side, and offering it means
   * the user only learns that after filling the whole form in. The host builds
   * this with `companiesForChannelCreate`, the one create-scope rule set.
   */
  const targetCompanies = $derived(createCompanies ?? scopeCompanies);

  /**
   * Default workspace for a new channel: the company the user is looking at,
   * never "the first membership in the list" (often the owner's personal
   * vault). Shared with the rest of the create-scope rules.
   */
  function defaultCompanyUid(
    scope: CompanyScope,
    list: readonly ScopeCompany[],
  ): string {
    return defaultChannelCompanyUid({
      activeScope: scope,
      companies: list,
      members: [],
      selfUid,
    });
  }

  const findCompanyUid = $derived(
    defaultCompanyUid(activeScope, targetCompanies),
  );
  const findTarget = $derived<SlugTarget>(
    findCompanyUid
      ? { scope: "company", companyUid: findCompanyUid }
      : { scope: "personal", companyUid: null },
  );
  const createTarget = $derived<SlugTarget>(
    companyUid
      ? { scope: "company", companyUid }
      : { scope: "personal", companyUid: null },
  );

  /** Workspace label for a row — "Personal" for an unscoped channel. */
  function labelForCompany(uid: string | null): string {
    if (!uid) return "Personal";
    return (
      scopeCompanies.find((c) => c.companyUid === uid)?.label ??
      humanCompanyLabel({ companyUid: uid })
    );
  }

  const findResults = $derived(
    buildFindResults({
      rows,
      query: queryDebounced,
      canCreate,
      target: findTarget,
      selfPersonUid: selfUid,
      companyLabel: labelForCompany,
    }),
  );
  const findKind = $derived(classifyFindQuery(queryDebounced).kind);
  const flatCount = $derived(
    findResults.rows.length + (findResults.createSlug ? 1 : 0),
  );

  type RenderItem =
    | { kind: "heading"; label: string }
    | { kind: "row"; row: FindRow; index: number }
    | { kind: "create"; index: number };

  const renderItems = $derived.by<RenderItem[]>(() => {
    const items: RenderItem[] = [];
    let index = 0;
    let heading: string | null = null;
    if (findKind === "empty" && findResults.rows.length > 0) {
      items.push({ kind: "heading", label: "Recent" });
      heading = "Recent";
    }
    for (const row of findResults.rows) {
      if (findKind !== "empty" && !row.exact) {
        const label =
          row.kind === "channel"
            ? "Channels"
            : row.kind === "person"
              ? "People"
              : "Agents";
        if (label !== heading) {
          items.push({ kind: "heading", label });
          heading = label;
        }
      }
      items.push({ kind: "row", row, index });
      index += 1;
    }
    if (findResults.createSlug) {
      items.push({ kind: "create", index });
    }
    return items;
  });

  // Any new query invalidates the highlight.
  $effect(() => {
    void queryDebounced;
    activeIndex = 0;
  });

  /**
   * The index actually highlighted. Derived, not stored: a live roster update
   * can shrink the list under a stale `activeIndex`, and an out-of-range one
   * pointed `aria-activedescendant` at a dead node and turned Enter into
   * "create a channel" when the user meant "open this conversation".
   */
  const highlightIndex = $derived(
    flatCount === 0 ? 0 : Math.min(Math.max(activeIndex, 0), flatCount - 1),
  );

  const knownChannels = $derived<KnownChannel[]>(
    rows
      .filter((row) => row.kind !== "dm" && Boolean(row.channelId))
      .map((row) => ({
        channelId: row.channelId as string,
        title: row.title,
        companyUid: row.companyUid,
        ...(row.channelScope ? { channelScope: row.channelScope } : {}),
        projectId: row.projectId ?? null,
        // Carried so the collision copy never claims a membership the caller
        // does not have (browse-only company project channels).
        browseOnly: row.browseOnly === true,
        membership: row.membership ?? null,
      })),
  );

  const slugDisplay = $derived(slugOverride ?? channelSlug(channelName));
  const slugCanonical = $derived(channelSlug(slugDisplay));
  const scopeKey = $derived(channelScopeKey(createTarget, selfUid));
  const slugVerdict = $derived(
    checkSlug(slugCanonical, createTarget, knownChannels, serverTaken, selfUid),
  );
  const takenSlugs = $derived.by(() => {
    const taken = knownSlugsInScope(createTarget, knownChannels);
    const prefix = `${scopeKey}#`;
    for (const key of serverTaken) {
      if (key.startsWith(prefix)) taken.add(key.slice(prefix.length));
    }
    return taken;
  });
  const freeSuggestion = $derived(suggestFreeSlug(slugCanonical, takenSlugs));

  const companyLabel = $derived(
    scopeCompanies.find((c) => c.companyUid === companyUid)?.label ?? null,
  );
  const workspaceLabel = $derived(
    companyUid ? (companyLabel ?? humanCompanyLabel({ companyUid })) : "Personal",
  );

  const pickedKeys = $derived(
    members.map((chip) => chip.personUid ?? chip.email ?? chip.key),
  );

  // ── Create-scope rules (shared with the sidebar via channel-create-scope) ─
  /** Every company each person is KNOWN to be in, from DM rows + contacts. */
  const memberCompanies = $derived(companyUidsByPerson(rows, contacts));
  /** Picked people/agents as the create-scope rules see them. Email chips are
   *  invited over DM, not added, so they never constrain the scope. */
  const scopeMembers = $derived<ChannelCreateMember[]>(
    members
      .filter((chip) => chip.type !== "email" && chip.personUid)
      .map((chip) => ({
        personUid: chip.personUid as string,
        label: chip.label,
        companyUids: memberCompanies.get(chip.personUid as string) ?? [],
      })),
  );
  /** Personal is only for the owner and their own agents. */
  const personalAllowed = $derived(personalScopeAllowed(scopeMembers, selfUid));
  const scopeUnavailable = $derived(
    unavailableChannelScopes(targetCompanies, scopeMembers, selfUid),
  );
  /** Pre-submit membership check — shown inline, and it disables Create. */
  const createBlock = $derived(
    channelCreateValidationMessage({
      activeScope,
      companies: targetCompanies,
      members: scopeMembers,
      companyUid,
      selfUid,
    }),
  );

  /** Re-pick "In" after the roster changed: keep the current choice when it is
   *  still valid, otherwise move to the one company everyone shares. */
  function syncScope(): void {
    companyUid = pickChannelCompanyUid({
      activeScope,
      companies: targetCompanies,
      members: scopeMembers,
      currentUid: companyUid,
      selfUid,
    });
  }
  const pickerCandidates = $derived(
    pickerQuery.trim()
      ? buildPickerCandidates({
          rows,
          contacts,
          query: pickerQuery,
          picked: pickedKeys,
          selfPersonUid: selfUid,
          allowEmail: canInviteByEmail,
        })
      : [],
  );

  $effect(() => {
    void pickerQuery;
    pickerIndex = 0;
  });

  /** Same clamp as `highlightIndex` — a shrinking list must not eat Enter. */
  const pickerHighlight = $derived(
    pickerCandidates.length === 0
      ? 0
      : Math.min(Math.max(pickerIndex, 0), pickerCandidates.length - 1),
  );

  /**
   * D7 roster fetch. Keyed on the LIVE workspace selection so switching "In"
   * re-evaluates every chip already picked.
   */
  $effect(() => {
    const target = companyUid;
    const load = api.listCompanyMembers;
    if (!target || !load) {
      roster = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await load(target);
        if (cancelled) return;
        roster = rosterFromMembers(target, res?.contacts ?? []);
      } catch (err) {
        if (cancelled) return;
        // Degrade to the contacts heuristic (⇒ no confirmation) rather than
        // confirming on every teammate because one fetch failed.
        roster = null;
        console.error("create-modal: company roster fetch failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  /**
   * Is this chip outside the CURRENTLY selected workspace? Derived, never
   * snapshotted — the workspace select and the roster both move under it.
   *
   * Agents are excluded on purpose: the roster is a people surface, and the
   * server already rejects an out-of-scope agent with `agent-scope`. Marking
   * every agent "external" would bury D10's real signal (agent vs person).
   */
  function isExternal(chip: MemberChip): boolean {
    if (chip.type !== "person" || !chip.personUid || !companyUid) return false;
    return (
      companyRelation(chip.personUid, companyUid, contacts, roster) === "outside"
    );
  }

  const externalKeys = $derived(
    new Set(members.filter(isExternal).map((chip) => chip.key)),
  );

  /** First already-picked member who is external and NOT confirmed for this
   *  workspace — set after a workspace switch or a late roster load. */
  const pendingRecheck = $derived(
    members.find(
      (chip) => externalKeys.has(chip.key) && chip.confirmedFor !== companyUid,
    ) ?? null,
  );

  const confirmSubject = $derived<{
    label: string;
    kind: "pick" | "recheck";
  } | null>(
    confirmPick
      ? { label: confirmPick.label, kind: "pick" }
      : pendingRecheck
        ? { label: pendingRecheck.label, kind: "recheck" }
        : null,
  );

  const submitDisabled = $derived(
    creating ||
      createUnconfirmed ||
      slugCanonical === "" ||
      slugVerdict.status === "taken" ||
      confirmSubject !== null ||
      createBlock !== null ||
      channelName.trim().length > 200,
  );

  /**
   * Why the Create button is dead. A bare `disabled` with no copy is a dead
   * end — the button is not even focusable to interrogate.
   */
  const blockReason = $derived.by<string | null>(() => {
    if (creating || slugVerdict.status === "taken") return null;
    // The membership block and the unconfirmed-create notice render as their
    // own alerts right above the footer — do not say it twice.
    if (createUnconfirmed || createBlock) return null;
    if (slugCanonical === "") return "Name the channel to create it.";
    if (channelName.trim().length > 200) {
      return "That name is too long — 200 characters max.";
    }
    if (confirmSubject) return "Answer the question above to continue.";
    return null;
  });

  // ── Navigation ─────────────────────────────────────────────────────────────

  /** Scroll an option into view through EVERY scroll ancestor it sits in. */
  function scrollOptionIntoView(root: HTMLElement | null, id: string): void {
    if (typeof requestAnimationFrame === "undefined") return;
    requestAnimationFrame(() => {
      const node = root?.querySelector<HTMLElement>(`#${id}`);
      if (node && typeof node.scrollIntoView === "function") {
        node.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function scrollActiveIntoView(): void {
    scrollOptionIntoView(listEl, `create-opt-${highlightIndex}`);
  }

  /**
   * The picker list lives in a nested scroller inside `.create-body`, and at
   * the app's 600px minimum height most of it is below the fold. `nearest`
   * scrolls both ancestors, so the highlighted candidate — including the whole
   * "Agents" group — is always visible.
   */
  function scrollPickIntoView(): void {
    scrollOptionIntoView(suggestionsEl, `create-pick-${pickerHighlight}`);
  }

  // Opening the list (or its contents changing) must not leave the highlight
  // parked out of sight either.
  $effect(() => {
    if (pickerCandidates.length === 0) return;
    void pickerHighlight;
    scrollPickIntoView();
  });

  function setActive(next: number): void {
    if (flatCount === 0) return;
    activeIndex = ((next % flatCount) + flatCount) % flatCount;
    scrollActiveIntoView();
  }

  function activateIndex(index: number): void {
    const row = findResults.rows[index];
    if (row) {
      onpick(row.row);
      return;
    }
    // Only the trailing create row may fall through here — a stale index into
    // the row range must never be reinterpreted as "create a channel".
    if (index < findResults.rows.length) return;
    if (findResults.createSlug) enterCreate(query);
  }

  function onFindKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(highlightIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(highlightIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(flatCount - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (flatCount > 0) {
        activateIndex(highlightIndex);
        return;
      }
      // The debounced list is stale (fast type-then-Enter) — recompute from the
      // RAW value so the create offer is never lost.
      const raw = buildFindResults({
        rows,
        query,
        canCreate,
        target: findTarget,
        selfPersonUid: selfUid,
      });
      if (raw.createSlug) enterCreate(query);
    }
  }

  function enterCreate(raw: string): void {
    // The server stores `name` verbatim, and "Q4 board" is a better display
    // name than "q4-board" — so the NAME is not slugified here.
    channelName = raw.trim().replace(/^#+/, "").trim();
    slugOverride = null;
    companyUid = defaultCompanyUid(activeScope, targetCompanies);
    members = [];
    firstMessage = "";
    createError = null;
    createUnconfirmed = false;
    pickerQuery = "";
    confirmPick = null;
    step = "create";
  }

  /** Back preserves the NAME (the thing that round-trips) and nothing else. */
  function backToFind(): void {
    query = channelName;
    queryDebounced = channelName;
    createError = null;
    confirmPick = null;
    activeIndex = 0;
    step = "find";
  }

  /**
   * The ONE exit. While `creating` is true there is no exit at all: the
   * member/invite loop is still running and tearing the modal down mid-flight
   * loses the failure summary, fires `onclose` twice, and navigates the app
   * into a channel the user just dismissed. Escape already refused; the × and
   * the backdrop must refuse too.
   */
  function closeAll(): void {
    if (creating) return;
    if (step === "summary") {
      onclose(createdChannelId ?? undefined, createdHint());
      return;
    }
    onclose();
  }

  /** Display hint for the channel created in this session, if any. */
  function createdHint():
    | { title: string; companyUid: string | null }
    | undefined {
    if (!createdChannelId) return undefined;
    const title = channelName.trim() || createdSlug;
    return title ? { title, companyUid: companyUid || null } : undefined;
  }

  function onBackdrop(event: MouseEvent): void {
    if (creating) return;
    if (event.target === event.currentTarget) closeAll();
  }

  function openExisting(channelId: string): void {
    const row = rows.find((r) => r.channelId === channelId);
    if (row) onpick(row);
    else onclose(channelId);
  }

  // Escape lives on a window listener so it still works when focus leaves the
  // subtree. The sidebar deliberately owns no dismissal for this modal.
  $effect(() => {
    function onKey(event: KeyboardEvent): void {
      // Focus can end up on <body> (a step swap unmounts the focused node), and
      // the card-level handler never sees those keys — so the trap is closed
      // here too rather than letting Tab escape to the page behind the overlay.
      if (event.key === "Tab") {
        const active = document.activeElement as HTMLElement | null;
        if (active && trapRoot()?.contains(active)) return;
        onDialogKey(event);
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmSubject) {
        cancelConfirm();
        return;
      }
      if (creating) return;
      if (step === "create") {
        backToFind();
        return;
      }
      closeAll();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const FOCUSABLE =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

  /**
   * Tab ring owner. While the cross-company question is up it is the confirm
   * itself — otherwise Tab walked straight out of the alertdialog into the
   * live form and let the user edit the very workspace being confirmed.
   */
  function trapRoot(): HTMLElement | null {
    return confirmSubject ? confirmEl : dialogEl;
  }

  function onDialogKey(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      if (step === "create" && !submitDisabled) {
        event.preventDefault();
        void submitCreate();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const items = [
      ...(trapRoot()?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    ];
    if (items.length === 0) return;
    event.preventDefault();
    const current = document.activeElement as HTMLElement | null;
    const index = current ? items.indexOf(current) : -1;
    if (index === -1) {
      items[0]?.focus();
      return;
    }
    const next = event.shiftKey
      ? (index - 1 + items.length) % items.length
      : (index + 1) % items.length;
    items[next]?.focus();
  }

  /** Focus a text input AND drop the caret at the end of the seeded value. */
  function focusEndOnMount(node: HTMLInputElement) {
    const handle = focusOnMount(node);
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(() => {
        const end = node.value.length;
        try {
          node.setSelectionRange(end, end);
        } catch {
          /* input types without a selection range */
        }
      });
    }
    return handle;
  }

  // ── Create-step fields ─────────────────────────────────────────────────────

  function onNameInput(event: Event): void {
    channelName = (event.currentTarget as HTMLInputElement).value;
    // Typing the name re-derives the slug.
    slugOverride = null;
    createUnconfirmed = false;
  }

  function onSlugInput(event: Event): void {
    slugOverride = slugInputValue((event.currentTarget as HTMLInputElement).value);
    createUnconfirmed = false;
  }

  /**
   * The server has no separate slug field, so renaming the slug renames the
   * channel. The Name row follows visibly — never hide that coupling.
   */
  function onSlugBlur(): void {
    if (slugOverride === null) return;
    const canonical = channelSlug(slugOverride);
    slugOverride = canonical;
    channelName = canonical;
  }

  function useSuggestion(): void {
    slugOverride = freeSuggestion;
    channelName = freeSuggestion;
    slugInputEl?.focus();
  }

  function onFieldKey(event: KeyboardEvent): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!submitDisabled) void submitCreate();
  }

  function chipFor(
    candidate: PickerCandidate,
    confirmedFor: string | null,
  ): MemberChip {
    return {
      key: candidate.key,
      type: candidate.type,
      personUid: candidate.personUid,
      email: candidate.email,
      label: candidate.label,
      confirmedFor,
    };
  }

  /**
   * Chip keys are the `{#each}` key, so a duplicate is not a cosmetic bug: it
   * throws `each_key_duplicate` and tears the modal down. Typing the same
   * address twice reaches here (the picker suppresses the candidate the second
   * time, so the raw-email fallback runs) — hence the guard lives in ONE place.
   */
  function addChip(
    candidate: PickerCandidate,
    confirmedFor: string | null,
  ): void {
    if (!members.some((chip) => chip.key === candidate.key)) {
      members = [...members, chipFor(candidate, confirmedFor)];
      syncScope();
    }
    pickerQuery = "";
    pickerIndex = 0;
    pickerInputEl?.focus();
  }

  function pickCandidate(candidate: PickerCandidate): void {
    const uid = candidate.personUid;
    if (candidate.type === "person" && uid && companyUid) {
      // Contacts/DM rows positively place them elsewhere: the shared scope
      // rules take over (the "In" list narrows or the inline block explains),
      // so asking "add anyway?" first would promise something Create refuses.
      const known = memberCompanies.get(uid) ?? [];
      const restricted = known.length > 0 && !known.includes(companyUid);
      if (
        !restricted &&
        companyRelation(uid, companyUid, contacts, roster) === "outside"
      ) {
        confirmPick = candidate;
        return;
      }
    }
    addChip(candidate, null);
  }

  /** "Add anyway" — for a fresh pick AND for a chip the workspace switch made
   *  external after the fact. Confirmation is recorded against the workspace it
   *  was given for, so switching again asks again. */
  function confirmExternal(): void {
    const candidate = confirmPick;
    if (candidate) {
      confirmPick = null;
      addChip(candidate, companyUid);
      return;
    }
    const chip = pendingRecheck;
    if (!chip) return;
    members = members.map((m) =>
      m.key === chip.key ? { ...m, confirmedFor: companyUid } : m,
    );
    pickerInputEl?.focus();
  }

  /** Declining a fresh pick adds nothing; declining a re-check removes the
   *  member, because leaving them in would be an unconfirmed cross-company add. */
  function cancelConfirm(): void {
    if (confirmPick) {
      confirmPick = null;
      pickerInputEl?.focus();
      return;
    }
    const chip = pendingRecheck;
    if (chip) {
      members = members.filter((m) => m.key !== chip.key);
      syncScope();
    }
    pickerInputEl?.focus();
  }

  function removeChip(key: string): void {
    members = members.filter((chip) => chip.key !== key);
    syncScope();
  }

  function onPickerKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (pickerCandidates.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const n = pickerCandidates.length;
      pickerIndex = ((pickerHighlight + delta) % n + n) % n;
      scrollPickIntoView();
      return;
    }
    if (event.key === "Backspace" && pickerQuery === "" && members.length > 0) {
      event.preventDefault();
      members = members.slice(0, -1);
      syncScope();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const candidate = pickerCandidates[pickerHighlight];
    if (candidate) {
      pickCandidate(candidate);
      return;
    }
    const typed = pickerQuery.trim();
    if (canInviteByEmail && isValidEmail(typed)) {
      addChip(
        {
          key: `email:${typed.toLowerCase()}`,
          type: "email",
          personUid: null,
          email: typed,
          label: typed,
          sublabel: "",
          companyUid: null,
        },
        null,
      );
    }
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  function friendlyMemberFailure(reason: IssueReason, hasEmail: boolean): string {
    if (reason === "member-not-owner") {
      return "only the channel owner can add people.";
    }
    if (reason === "member-unreachable") {
      return hasEmail
        ? "couldn't add them directly."
        : "couldn't add them — they're not reachable from here.";
    }
    if (reason === "member-agent-scope") {
      return "agents can only join channels in a workspace they belong to.";
    }
    return "couldn't add them.";
  }

  function memberIssue(chip: MemberChip, err: unknown): Issue {
    const reason = memberFailureReason(err, chip.personUid ?? "");
    const mapped: IssueReason =
      reason === "unreachable"
        ? "member-unreachable"
        : reason === "agent-scope"
          ? "member-agent-scope"
          : reason === "not-owner"
            ? "member-not-owner"
            : "member-other";
    return issueFrom({
      key: chip.key,
      label: chip.label,
      reason: mapped,
      chip,
      email: chip.email,
    });
  }

  function inviteBody(slug: string): string {
    return inviteRequestBody({
      slug,
      companyLabel: companyUid ? workspaceLabel : null,
      inviterLabel: self?.displayName?.trim() || null,
    });
  }

  /**
   * After a failed create: is a channel with this name now visible anywhere we
   * can look? Best-effort — a failed lookup is not proof the create committed,
   * so it must never block a safe retry.
   */
  async function createdChannelAlreadyExists(name: string): Promise<boolean> {
    if (
      channelExistsWithName(
        name,
        rows.filter((row) => row.kind !== "dm").map((row) => ({ name: row.title })),
      )
    ) {
      return true;
    }
    const uids = companyUid
      ? [companyUid]
      : targetCompanies.map((company) => company.companyUid);
    for (const uid of uids) {
      try {
        const resp = await api.listChannels({
          companyUid: uid,
          includeCompanyProjects: false,
        });
        if (channelExistsWithName(name, resp?.channels ?? [])) return true;
      } catch {
        // Lookup is best-effort; a failed list must not block a safe retry.
      }
    }
    try {
      const feed = await api.fetchChannelDirectory(null);
      if (channelExistsWithName(name, directoryRowsFromFeed(feed))) return true;
    } catch {
      // Same: directory lookup failure is not proof the create committed.
    }
    return false;
  }

  async function submitCreate(): Promise<void> {
    const create = api.createChannel;
    if (submitDisabled || !create) return;
    creating = true;
    createError = null;

    const name = slugOverride ? channelSlug(slugOverride) : channelName.trim();
    const slug = slugCanonical;
    const scope: "personal" | "company" = companyUid ? "company" : "personal";

    let channelId = "";
    try {
      const created = await create({
        name,
        scope,
        ...(companyUid ? { companyUid } : {}),
      });
      channelId = created?.channelId ?? "";
    } catch (err) {
      const failure = parseCreateChannelError(err, name);
      if (failure.code === "slug-taken") {
        // A 409 is proof the name is owned — by someone else, or by our own
        // earlier attempt. Either way the slug UI takes over from here.
        serverTaken = new Set([...serverTaken, `${scopeKey}#${slug}`]);
        createError = failure.message;
      } else {
        // Any other rejection is ambiguous: the server may have committed the
        // channel before answering. Retry only when nothing by that name shows
        // up anywhere we can list.
        const exists = await createdChannelAlreadyExists(name);
        createUnconfirmed = exists;
        createError = unconfirmedCreateMessage({
          detail: failure.message.replace(/\.$/, ""),
          name,
          exists,
        });
      }
      creating = false;
      slugInputEl?.focus();
      return;
    }

    // `asMintedChannelId` rejects anything that is not `chn_*`; a project slug
    // leaking through here previously produced CHANNEL_NOT_FOUND on send.
    if (!channelId.startsWith("chn_")) {
      createError = "The server returned an unusable channel id.";
      creating = false;
      return;
    }

    createdChannelId = channelId;
    createdSlug = slug;

    // Paint the rail NOW, before the member loop, so the channel is visible
    // immediately. Deliberately not awaited — the reconcile behind it must not
    // delay the invites.
    void Promise.resolve(
      oncreated({
        channelId,
        name,
        scope,
        companyUid: companyUid || null,
        membership: "joined",
        unread: 0,
        lastMessageAt: null,
      }),
    ).catch((err) => {
      console.error("create-modal: optimistic rail insert failed", err);
    });

    const found: Issue[] = [];

    // Sequential (the server rejects a batch and ignores `invite`), and one
    // rejection MUST NOT abort the loop — that was the duplicate-channel bug.
    const addMember = api.addChannelMember;
    if (addMember) {
      for (const chip of members) {
        if (chip.type === "email" || !chip.personUid) continue;
        try {
          await addMember(channelId, chip.personUid);
        } catch (err) {
          found.push(memberIssue(chip, err));
        }
      }
    }

    const sendDm = api.sendDmToEmail;
    if (sendDm) {
      for (const chip of members) {
        if (chip.type !== "email" || !chip.email) continue;
        try {
          const outcome = await sendDm({
            toEmail: chip.email,
            body: inviteBody(slug),
          });
          found.push(
            issueFrom({
              key: chip.key,
              label: chip.label,
              reason:
                outcome?.state === "delivered"
                  ? "invited-delivered"
                  : "invited-requested",
              chip,
              email: chip.email,
            }),
          );
        } catch {
          found.push(
            issueFrom({
              key: chip.key,
              label: chip.label,
              reason: "invite-failed",
              chip,
              email: chip.email,
            }),
          );
        }
      }
    }

    const body = firstMessage.trim();
    const sendMessage = api.sendChannelMessage;
    if (body && sendMessage) {
      try {
        await sendMessage({ channelId, body });
      } catch {
        found.push(
          issueFrom({
            key: "first-message",
            label: "First message",
            reason: "first-message-failed",
            chip: null,
            email: null,
          }),
        );
      }
    }

    creating = false;
    if (found.length === 0) {
      onclose(channelId, { title: name, companyUid: companyUid || null });
      return;
    }
    issues = found;
    step = "summary";
  }

  function patchIssue(key: string, patch: Partial<Issue>): void {
    issues = issues.map((issue) =>
      issue.key === key ? { ...issue, ...patch } : issue,
    );
  }

  function markResolved(key: string, note: string): void {
    patchIssue(key, { resolved: note, pending: false, error: null });
  }

  /**
   * A retry that fails must SAY so. Logging to the console made a rejected
   * retry indistinguishable from a click that never registered, and with no
   * in-flight guard every impatient click fired another request.
   */
  function markRetryFailed(key: string, err: unknown): void {
    const raw = err instanceof Error ? err.message : String(err ?? "");
    const cleaned = stripRawUids(raw);
    patchIssue(key, {
      pending: false,
      error: cleaned ? `Still failing: ${cleaned}` : "That didn't work either.",
    });
  }

  async function retryIssue(issue: Issue): Promise<void> {
    const channelId = createdChannelId;
    if (!channelId || issue.pending) return;
    if (issue.reason === "invite-failed") {
      await sendInvite(issue);
      return;
    }
    patchIssue(issue.key, { pending: true, error: null });
    if (issue.reason === "first-message-failed") {
      try {
        await api.sendChannelMessage?.({
          channelId,
          body: firstMessage.trim(),
        });
        markResolved(issue.key, "Sent.");
      } catch (err) {
        markRetryFailed(issue.key, err);
      }
      return;
    }
    const uid = issue.chip?.personUid;
    if (!uid) {
      patchIssue(issue.key, { pending: false });
      return;
    }
    try {
      await api.addChannelMember?.(channelId, uid);
      markResolved(issue.key, "Added.");
    } catch (err) {
      markRetryFailed(issue.key, err);
    }
  }

  async function sendInvite(issue: Issue): Promise<void> {
    const email = issue.email;
    if (!email || !api.sendDmToEmail || issue.pending) return;
    patchIssue(issue.key, { pending: true, error: null });
    try {
      const outcome = await api.sendDmToEmail({
        toEmail: email,
        body: inviteBody(createdSlug),
      });
      markResolved(
        issue.key,
        outcome?.state === "delivered"
          ? "Messaged — add them once they're connected."
          : "Request sent — add them once they accept.",
      );
    } catch (err) {
      markRetryFailed(issue.key, err);
    }
  }

  /**
   * D8 copy, and it must not over-promise: `send_dm_to_email` parks a DM
   * connection request and nothing on either side adds the invitee to a
   * channel when it is accepted. Saying "they'll join when they accept" left
   * the creator believing a job was done that nobody had started.
   */
  function issueCopy(issue: Issue): string {
    switch (issue.reason) {
      case "invited-requested":
        return `${issue.label} — request sent. Add them to #${createdSlug} once they accept.`;
      case "invited-delivered":
        return `${issue.label} — messaged. They're not in #${createdSlug} yet; add them from its members.`;
      case "invite-failed":
        return `${issue.label} — couldn't send the invite.`;
      case "first-message-failed":
        return "Your first message didn't send. It's still in your draft below.";
      default:
        return `${issue.label} — ${friendlyMemberFailure(issue.reason, Boolean(issue.email))}`;
    }
  }

  /** "Send request instead" is offered only for a reachable-by-email person. */
  function offersEmailFallback(issue: Issue): boolean {
    return (
      issue.reason === "member-unreachable" &&
      Boolean(issue.email) &&
      canInviteByEmail &&
      issue.chip?.type !== "agent"
    );
  }

  function offersRetry(issue: Issue): boolean {
    if (issue.reason === "invite-failed") return true;
    if (issue.reason === "first-message-failed") return true;
    if (issue.reason === "member-not-owner" || issue.reason === "member-other") {
      return true;
    }
    return issue.reason === "member-unreachable" && !offersEmailFallback(issue);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="create-overlay chat-shell"
  data-testid="chat-create-modal"
  role="presentation"
  use:portal
  onclick={onBackdrop}
>
  <div
    bind:this={dialogEl}
    class="create-card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="create-modal-title"
    tabindex="-1"
    onkeydown={onDialogKey}
  >
    <!-- `inert` while the cross-company question is up: the alertdialog asks
         about the very workspace this form edits, so nothing under it may be
         tabbed to, clicked, or read out as if it were live. -->
    <div class="create-head" inert={confirmSubject !== null}>
      {#if step === "find"}
        <span class="create-search-ic" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <circle
              cx="7"
              cy="7"
              r="4.5"
              stroke="currentColor"
              stroke-width="1.25"
            />
            <path
              d="m10.5 10.5 3 3"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linecap="round"
            />
          </svg>
        </span>
        <h2 id="create-modal-title" class="create-sr">
          New message or channel
        </h2>
        <input
          class="create-query"
          type="text"
          role="combobox"
          data-testid="chat-create-query"
          use:focusOnMount
          placeholder="Search people, agents, and channels — or type a new channel name"
          aria-label="Search people, agents, and channels, or type a new channel name"
          aria-expanded={flatCount > 0}
          aria-controls="create-results"
          aria-autocomplete="list"
          aria-activedescendant={flatCount > 0
            ? `create-opt-${highlightIndex}`
            : undefined}
          bind:value={query}
          onkeydown={onFindKey}
        />
      {:else}
        {#if step === "create"}
          <button
            type="button"
            class="create-back"
            data-testid="chat-create-back"
            aria-label="Back to search"
            disabled={creating}
            onclick={backToFind}
          >
            <span aria-hidden="true">‹</span>
          </button>
        {/if}
        <h2 id="create-modal-title" class="create-title">
          {step === "create" ? "New channel" : "Channel created"}
        </h2>
        <span class="create-spacer"></span>
      {/if}
      <button
        type="button"
        class="create-close"
        aria-label="Close"
        disabled={creating}
        onclick={closeAll}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>

    {#if step === "find"}
      <div
        bind:this={listEl}
        class="create-list"
        id="create-results"
        role="listbox"
        aria-label="Results"
      >
        {#if findKind === "email"}
          <div class="create-group" role="presentation">No match</div>
          <p
            class="create-note"
            role="status"
            data-testid="chat-create-no-match"
          >
            No one on HQ matches that address. Add them from a channel's members
            instead.
          </p>
        {:else}
          {#each renderItems as item (item.kind === "heading" ? `h:${item.label}` : item.kind === "create" ? "create-row" : item.row.key)}
            {#if item.kind === "heading"}
              <div class="create-group" role="presentation">{item.label}</div>
            {:else if item.kind === "row"}
              <button
                type="button"
                class="create-row"
                id={`create-opt-${item.index}`}
                role="option"
                tabindex="-1"
                data-testid="chat-create-result"
                aria-selected={highlightIndex === item.index}
                onmouseenter={() => (activeIndex = item.index)}
                onclick={() => onpick(item.row.row)}
              >
                {#if item.row.kind === "channel"}
                  <span class="create-glyph" aria-hidden="true">#</span>
                {:else}
                  <span
                    class="create-mono"
                    class:agent={item.row.kind === "agent"}
                    aria-hidden="true">{initialsFor(item.row.label)}</span
                  >
                {/if}
                <span class="create-row-name">{item.row.label}</span>
                {#if item.row.sublabel}
                  <span
                    class="create-row-meta"
                    data-testid="chat-create-result-meta">{item.row.sublabel}</span
                  >
                {/if}
              </button>
            {:else}
              <button
                type="button"
                class="create-row create-row-action"
                id={`create-opt-${item.index}`}
                role="option"
                tabindex="-1"
                data-testid="chat-create-channel-row"
                aria-selected={highlightIndex === item.index}
                onmouseenter={() => (activeIndex = item.index)}
                onclick={() => enterCreate(query)}
              >
                <span class="create-glyph" aria-hidden="true">+</span>
                <span class="create-row-name"
                  >Create channel #{findResults.createSlug}</span
                >
              </button>
            {/if}
          {:else}
            <p class="create-note">
              {queryDebounced.trim() ? "No matches" : "No conversations"}
            </p>
          {/each}
        {/if}
      </div>
    {:else if step === "create"}
      <div class="create-body" inert={confirmSubject !== null}>
        <div class="create-field">
          <span class="create-label" id="create-name-label">Name</span>
          <input
            class="create-input"
            type="text"
            maxlength="200"
            data-testid="chat-channel-name"
            use:focusEndOnMount
            placeholder="e.g. Q4 board"
            aria-labelledby="create-name-label"
            disabled={creating}
            value={channelName}
            oninput={onNameInput}
            onkeydown={onFieldKey}
          />
        </div>

        <!-- Slug row + its helper/caveat lines share one hairline cell so the
             copy reads as belonging to the field above it, not the one below. -->
        <div class="create-cell">
          <div class="create-field create-field-flush">
            <span class="create-label" id="create-slug-label">URL name</span>
            <span class="create-hash" aria-hidden="true">#</span>
            <input
              bind:this={slugInputEl}
              class="create-input create-slug"
              type="text"
              maxlength="200"
              data-testid="chat-channel-slug"
              aria-labelledby="create-slug-label"
              aria-describedby="create-slug-help create-slug-note"
              disabled={creating}
              value={slugDisplay}
              oninput={onSlugInput}
              onblur={onSlugBlur}
              onkeydown={onFieldKey}
            />
          </div>
          <p class="create-help" id="create-slug-help">
            {slugOverride === null
              ? "Lowercase, dashes only. Editing this renames the channel."
              : `Renamed. The channel will be called “${slugDisplay}”.`}
          </p>
          <!-- Always rendered so the live region exists BEFORE the verdict
               changes — a region created at the same moment as its text is not
               announced. D4's preview and D5's verdict both land here. -->
          <div id="create-slug-note" aria-live="polite">
            {#if slugVerdict.status !== "empty"}
              <p class="create-help" data-testid="chat-channel-slug-note">
                {#if slugVerdict.status === "taken" && slugVerdict.source === "local" && slugVerdict.joined}
                  <span>You're already in #{slugCanonical} here.</span>
                  <button
                    type="button"
                    class="create-inline-btn"
                    data-testid="chat-channel-slug-open"
                    onclick={() => openExisting(slugVerdict.channelId ?? "")}
                    >Open it</button
                  >
                  <button
                    type="button"
                    class="create-inline-btn"
                    data-testid="chat-channel-slug-suggest"
                    onclick={useSuggestion}>Use {freeSuggestion}</button
                  >
                {:else if slugVerdict.status === "taken"}
                  <!-- Browse-only / server-learned: the slug is taken, but the
                       caller is NOT in that channel, so no "Open it". -->
                  <span
                    >#{slugCanonical} is already taken in this workspace.</span
                  >
                  <button
                    type="button"
                    class="create-inline-btn"
                    data-testid="chat-channel-slug-suggest"
                    onclick={useSuggestion}>Use {freeSuggestion}</button
                  >
                {:else if createTarget.scope === "company"}
                  <span
                    >#{slugCanonical} — we only see channels you're in, so this
                    name may still be taken.</span
                  >
                {:else}
                  <span class="create-slug-echo">#{slugCanonical}</span>
                {/if}
              </p>
            {/if}
          </div>
        </div>

        <div class="create-field">
          <span class="create-label" id="create-scope-label">In</span>
          <select
            class="create-select"
            data-testid="chat-channel-scope"
            aria-labelledby="create-scope-label"
            disabled={creating}
            bind:value={companyUid}
          >
            {#each targetCompanies as company (company.companyUid)}
              {@const blocked = scopeUnavailable.find(
                (row) => row.company.companyUid === company.companyUid,
              )}
              <option value={company.companyUid} disabled={Boolean(blocked)}>
                {blocked ? `${company.label} — ${blocked.reason}` : company.label}
              </option>
            {/each}
            <!-- Personal is the owner's own scope: only they and their agents
                 can be in it, so it is held (not hidden) once a teammate is
                 picked — the value stays legible instead of a blank select. -->
            <option value="" disabled={!personalAllowed}>Personal</option>
          </select>
        </div>
        {#if scopeUnavailable.length > 0}
          <p class="create-help" data-testid="chat-channel-scope-unavailable">
            {scopeUnavailable[0].reason}
          </p>
        {/if}

        {#if canAddMembers}
          <div class="create-members">
            <div class="create-cell">
              <div class="create-field create-field-wrap create-field-flush">
                <span class="create-label" id="create-with-label">With</span>
                <div class="create-chips">
                  {#each members as chip (chip.key)}
                    <span class="create-chip" data-testid="chat-channel-chip">
                      <span
                        class="create-chip-mono"
                        class:agent={chip.type === "agent"}
                        aria-hidden="true">{initialsFor(chip.label)}</span
                      >
                      <span class="create-chip-name">{chip.label}</span>
                      <!-- D10: agent-vs-person is THE distinction, so it gets
                           the legible pill; "external" stays secondary. -->
                      {#if chip.type === "agent"}
                        <span class="create-tag create-tag-strong">agent</span>
                      {:else if chip.type === "email"}
                        <span class="create-tag">not on hq</span>
                      {/if}
                      {#if externalKeys.has(chip.key)}
                        <span class="create-tag">external</span>
                      {/if}
                      <button
                        type="button"
                        class="create-chip-x"
                        aria-label={`Remove ${chip.label}`}
                        disabled={creating}
                        onclick={() => removeChip(chip.key)}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    </span>
                  {/each}
                  <input
                    bind:this={pickerInputEl}
                    class="create-input create-picker"
                    type="text"
                    role="combobox"
                    data-testid="chat-channel-participants"
                    placeholder={members.length === 0
                      ? "Add people, agents, or an email…"
                      : ""}
                    aria-labelledby="create-with-label"
                    aria-expanded={pickerCandidates.length > 0}
                    aria-controls="create-picker-results"
                    aria-autocomplete="list"
                    aria-activedescendant={pickerCandidates.length > 0
                      ? `create-pick-${pickerHighlight}`
                      : undefined}
                    disabled={creating}
                    bind:value={pickerQuery}
                    onkeydown={onPickerKey}
                  />
                </div>
              </div>
              {#if members.some((chip) => chip.type === "email")}
                <!-- Honest by construction: accepting the connection request
                     does NOT join them to the channel — nothing implements
                     that — so the creator is told they own the last step. -->
                <p class="create-help" data-testid="chat-channel-email-note">
                  Not on HQ — we'll send a request to connect. Add them to the
                  channel once they accept.
                </p>
              {/if}
            </div>

            {#if pickerCandidates.length > 0}
              <div
                bind:this={suggestionsEl}
                class="create-suggestions"
                id="create-picker-results"
                role="listbox"
                aria-label="Suggestions"
              >
                {#each pickerCandidates as candidate, i (candidate.key)}
                  {#if i === 0 && candidate.type !== "email"}
                    <div class="create-group" role="presentation">
                      {candidate.type === "agent" ? "Agents" : "People"}
                    </div>
                  {:else if candidate.type === "agent" && pickerCandidates[i - 1]?.type !== "agent"}
                    <div class="create-group" role="presentation">Agents</div>
                  {/if}
                  <button
                    type="button"
                    class="create-row"
                    id={`create-pick-${i}`}
                    role="option"
                    tabindex="-1"
                    data-testid="chat-channel-suggestion"
                    aria-selected={pickerHighlight === i}
                    onmouseenter={() => (pickerIndex = i)}
                    onclick={() => pickCandidate(candidate)}
                  >
                    {#if candidate.type === "email"}
                      <span class="create-glyph" aria-hidden="true">+</span>
                      <span class="create-row-name">Invite {candidate.label}</span>
                    {:else}
                      <span
                        class="create-mono"
                        class:agent={candidate.type === "agent"}
                        aria-hidden="true">{initialsFor(candidate.label)}</span
                      >
                      <span class="create-row-name">{candidate.label}</span>
                    {/if}
                    {#if candidate.sublabel}
                      <span class="create-row-meta">{candidate.sublabel}</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        {#if canSendFirstMessage}
          <textarea
            class="create-textarea"
            data-testid="chat-channel-first-message"
            placeholder="What's this channel for? (optional — posted as the first message)"
            aria-label="What's this channel for?"
            disabled={creating}
            bind:value={firstMessage}
          ></textarea>
        {/if}
      </div>

      {#if createError}
        <p class="create-error" role="alert" data-testid="chat-channel-error">
          {createError}
        </p>
      {:else if createBlock}
        <p class="create-error" role="alert" data-testid="chat-channel-validation">
          {createBlock}
        </p>
      {/if}

      <div class="create-footer" inert={confirmSubject !== null}>
        {#if blockReason}
          <span class="create-hint create-hint-block" id="create-submit-reason"
            >{blockReason}</span
          >
        {:else}
          <span class="create-hint" aria-hidden="true">⌘↵ TO CREATE</span>
        {/if}
        <button
          type="button"
          class="create-submit"
          data-testid="chat-channel-create"
          disabled={submitDisabled}
          aria-busy={creating}
          aria-describedby={blockReason ? "create-submit-reason" : undefined}
          onclick={() => void submitCreate()}
        >
          {creating
            ? "Creating…"
            : createUnconfirmed
              ? "Creation unconfirmed"
              : "Create channel"}
        </button>
      </div>
    {:else}
      <!-- The ONLY place the per-member outcome is reported (D7/D8), so it is
           announced, not just painted. -->
      <div
        class="create-body"
        role="status"
        aria-live="polite"
        data-testid="chat-create-summary"
      >
        <p class="create-summary-lead">#{createdSlug} is ready.</p>
        {#each issues as issue (issue.key)}
          <div class="create-summary-row" data-testid="chat-create-summary-row">
            <span class="create-summary-copy">{issueCopy(issue)}</span>
            {#if issue.resolved}
              <span class="create-row-meta">{issue.resolved}</span>
            {:else if offersEmailFallback(issue)}
              <button
                type="button"
                class="create-inline-btn"
                data-testid="chat-create-summary-action"
                disabled={issue.pending}
                onclick={() => void sendInvite(issue)}
                >{issue.pending ? "Sending…" : "Send request instead"}</button
              >
            {:else if offersRetry(issue)}
              <button
                type="button"
                class="create-inline-btn"
                data-testid="chat-create-summary-action"
                disabled={issue.pending}
                onclick={() => void retryIssue(issue)}
                >{issue.pending ? "Retrying…" : "Retry"}</button
              >
            {/if}
          </div>
          {#if issue.error}
            <p
              class="create-summary-draft"
              data-testid="chat-create-summary-error"
            >
              {issue.error}
            </p>
          {/if}
          {#if issue.reason === "first-message-failed"}
            <p class="create-summary-draft">{firstMessage.trim()}</p>
          {/if}
        {/each}
      </div>
      <div class="create-footer">
        <span class="create-hint" aria-hidden="true"></span>
        <!-- Focus MUST land here: the create-step button that had it was just
             unmounted, and focus on <body> escapes the trap on the next Tab. -->
        <button
          type="button"
          class="create-submit"
          data-testid="chat-create-summary-done"
          use:focusOnMount
          onclick={() => onclose(createdChannelId ?? undefined, createdHint())}>Done</button
        >
      </div>
    {/if}

    {#if confirmSubject}
      <div
        bind:this={confirmEl}
        class="create-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="create-confirm-title"
        data-testid="chat-create-confirm-external"
      >
        <p class="create-confirm-title" id="create-confirm-title">
          Add {confirmSubject.label} from outside {workspaceLabel}?
        </p>
        <p class="create-confirm-body">
          {confirmSubject.label} isn't listed in {workspaceLabel}. They'll be able
          to read and post in #{slugCanonical} — nothing else. This does not give
          them workspace membership or access to any files.
        </p>
        <p class="create-confirm-body">
          People often belong to several workspaces, so they may already have
          access another way.
        </p>
        <div class="create-confirm-actions">
          <button
            type="button"
            class="create-submit"
            data-testid="chat-create-confirm-external-add"
            use:focusOnMount
            onclick={confirmExternal}>Add anyway</button
          >
          <button
            type="button"
            class="create-inline-btn"
            data-testid="chat-create-confirm-external-cancel"
            onclick={cancelConfirm}
            >{confirmSubject.kind === "recheck" ? "Remove" : "Cancel"}</button
          >
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .create-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
    /* Dim, never wash: a text-1 scrim BRIGHTENS the app in dark mode. */
    background: rgba(0, 0, 0, 0.45);
  }

  /* One width for every step so the card never jumps between them. */
  .create-card {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(520px, 100%);
    max-height: min(78vh, 620px);
    overflow: hidden;
    border: 1px solid var(--v4-hairline);
    border-radius: 14px;
    /* Never --v4-ground here — that token is glass and lets timeline text
       bleed through. */
    background: var(--v4-surface-solid, #fff);
    box-shadow: var(--v4-shadow-window, var(--panel-shadow));
    outline: none;
  }

  .create-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--v4-hairline);
  }

  .create-search-ic {
    display: grid;
    place-items: center;
    color: var(--t3);
  }

  .create-search-ic svg {
    width: 16px;
    height: 16px;
  }

  .create-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .create-title {
    margin: 0;
    color: var(--t1);
    font-size: 14px;
    font-weight: 600;
  }

  .create-spacer {
    flex: 1 1 auto;
  }

  .create-query {
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 15px;
    outline: none;
  }

  .create-query::placeholder {
    color: var(--t3);
  }

  .create-back,
  .create-close {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--t2);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .create-back:hover,
  .create-close:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .create-back:focus-visible,
  .create-close:focus-visible,
  .create-row:focus-visible,
  .create-submit:focus-visible,
  .create-inline-btn:focus-visible,
  .create-chip-x:focus-visible,
  .create-select:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .create-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 320px;
    overflow-y: auto;
    padding: 6px;
  }

  .create-body {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
  }

  .create-group {
    padding: 10px 10px 4px;
    color: var(--t3);
    font: 500 10px/1 var(--font-mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .create-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font: 400 13px/1.4 var(--font-ui);
    text-align: left;
    cursor: pointer;
  }

  .create-row:hover {
    background: var(--hover);
  }

  .create-row[aria-selected="true"] {
    background: var(--sel);
  }

  /* Reads as an action, not as a match. */
  .create-row-action {
    color: var(--t2);
    font-weight: 500;
  }

  .create-glyph {
    display: inline-grid;
    place-items: center;
    width: 22px;
    color: var(--t3);
    font-size: 14px;
  }

  /* Round monogram = person. Square (6px) monogram = agent — that pairing
     plus the "Agent" sublabel is the delineation. */
  .create-mono {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    background: var(--v4-control-bg);
    color: var(--t2);
    font-size: 9px;
    font-weight: 600;
  }

  .create-mono.agent {
    border-radius: 6px;
  }

  .create-row-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Carries the "Agent" delineation and the workspace label — not decoration,
     so --t2 (5.29:1) rather than --t3 (2.75:1). */
  .create-row-meta {
    flex: 0 0 auto;
    margin-left: auto;
    color: var(--t2);
    font-size: 12px;
  }

  .create-note {
    margin: 0;
    padding: 14px 12px;
    color: var(--t2);
    font-size: 13px;
  }

  .create-field {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--v4-hairline);
  }

  .create-field-wrap {
    align-items: flex-start;
  }

  /* A field row owns its helper copy: one hairline under the whole group,
     so the caption reads as belonging to the field above it. */
  .create-cell {
    border-bottom: 1px solid var(--v4-hairline);
  }

  .create-field-flush {
    border-bottom: 0;
  }

  .create-label {
    flex: 0 0 auto;
    min-width: 72px;
    color: var(--t3);
    font-size: 13px;
    font-weight: 500;
  }

  .create-hash {
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .create-input {
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 14px;
    outline: none;
  }

  .create-input::placeholder {
    color: var(--t3);
  }

  .create-input:disabled {
    color: var(--t2);
  }

  .create-slug {
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .create-help {
    margin: 0;
    padding: 0 16px 8px 96px;
    color: var(--t2);
    font-size: 12px;
  }

  .create-slug-echo {
    color: var(--t3);
    font-family: var(--font-mono);
  }

  .create-select {
    flex: 1 1 auto;
    appearance: none;
    -webkit-appearance: none;
    padding: 6px 8px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    cursor: pointer;
  }

  .create-chips {
    flex: 1 1 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .create-picker {
    flex: 1 1 140px;
    min-width: 140px;
  }

  .create-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 4px 3px 4px;
    border-radius: 999px;
    background: var(--v4-control-bg);
    color: var(--t1);
    font-size: 12px;
  }

  .create-chip-mono {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 999px;
    background: var(--hover);
    color: var(--t2);
    font-size: 7px;
    font-weight: 600;
  }

  .create-chip-mono.agent {
    border-radius: 5px;
  }

  .create-chip-name {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .create-chip-x {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--t3);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }

  .create-chip-x:hover {
    color: var(--t1);
  }

  /* Secondary, but still legible: --t3 on the card measured 2.75:1, under even
     the 3:1 non-text floor. --t2 measures 5.29:1. */
  .create-tag {
    color: var(--t2);
    font: 500 10px/1 var(--font-mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* D10's primary signal — agent vs person — gets a pill and full contrast. */
  .create-tag-strong {
    padding: 2px 5px;
    border-radius: 999px;
    background: var(--hover);
    color: var(--t1);
  }

  .create-suggestions {
    display: flex;
    flex-direction: column;
    gap: 1px;
    /* Kept short so the list does not outrun `.create-body` at the app's
       600px minimum window height; the highlight is scrolled into view. */
    max-height: 168px;
    overflow-y: auto;
    padding: 6px;
    border-bottom: 1px solid var(--v4-hairline);
  }

  /* A sheet over the WHOLE card (the card behind it is `inert`), not a panel
     wedged into the members row — the question is about the whole form. */
  .create-confirm {
    position: absolute;
    left: 12px;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 2;
    max-height: calc(100% - 24px);
    overflow-y: auto;
    padding: 14px 16px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 12px;
    background: var(--v4-surface-solid, #fff);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  }

  .create-confirm-title {
    margin: 0 0 6px;
    color: var(--t1);
    font-size: 13px;
    font-weight: 600;
  }

  .create-confirm-body {
    margin: 0 0 6px;
    color: var(--t2);
    font-size: 12px;
    line-height: 1.5;
  }

  .create-confirm-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }

  .create-textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 88px;
    padding: 14px 16px;
    border: none;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 14px;
    line-height: 1.4;
    outline: none;
    resize: none;
  }

  .create-textarea::placeholder {
    color: var(--t3);
  }

  /* Soft status — never alarm red. */
  .create-error {
    margin: 0;
    padding: 6px 16px 0;
    color: var(--t2);
    font-size: 12px;
  }

  .create-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-top: 1px solid var(--v4-hairline);
  }

  .create-hint {
    color: var(--t3);
    font: 500 10px/1 var(--font-mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* A disabled button with no explanation is a dead end — say why. */
  .create-hint-block {
    color: var(--t2);
    font: 400 12px/1.4 var(--font-ui);
    letter-spacing: 0;
    text-transform: none;
  }

  .create-submit {
    height: 30px;
    padding: 0 12px;
    border: 0;
    border-radius: 9px;
    background: var(--v4-control-bg);
    color: var(--t1);
    font: 500 13px/1 var(--font-ui);
    cursor: pointer;
    transition:
      background 0.12s,
      color 0.12s;
  }

  .create-submit:hover:not(:disabled) {
    background: var(--hover);
  }

  .create-submit:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .create-inline-btn {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--t1);
    font: 500 12px/1.4 var(--font-ui);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .create-summary-lead {
    margin: 0;
    padding: 14px 16px 6px;
    color: var(--t1);
    font-size: 13px;
  }

  .create-summary-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px 16px;
  }

  .create-summary-copy {
    flex: 1 1 auto;
    color: var(--t2);
    font-size: 12px;
    line-height: 1.5;
  }

  .create-summary-draft {
    margin: 0;
    padding: 0 16px 10px;
    color: var(--t2);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    user-select: text;
  }

  :global(:root[data-force-theme="dark"]) .create-card,
  :global(:root[data-force-theme="dark"]) .create-confirm,
  :global(.dark) .create-card,
  :global(.dark) .create-confirm {
    background: var(--v4-surface-solid, #303030);
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-force-theme="light"])) .create-card,
    :global(:root:not([data-force-theme="light"])) .create-confirm {
      background: var(--v4-surface-solid, #303030);
    }
  }
</style>
