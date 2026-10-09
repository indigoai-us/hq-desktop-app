<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import BillingSettingsPane from "./BillingSettingsPane.svelte";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  /**
   * ShellSettings — the FULL-WINDOW, Profile-first Settings destination for the
   * V2 shell (design source: hq-desktop-preview-v2 ?view=v2).
   *
   * Two columns: left section nav + right pane. Display language is the
   * preview-v2 / Daybook prototype (set-row cards, toggles, company chips).
   */
  import { onMount } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";
  import EmptyState from "../common/EmptyState.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import { HQ_CONSOLE_BASE } from "../common/hq-console.js";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import PageHeader from "../shell/PageHeader.svelte";
  import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
  import StorageSettingsPane from "./StorageSettingsPane.svelte";
  import AgentsSettingsPane from "./AgentsSettingsPane.svelte";
  import BotsSettingsPane from "./BotsSettingsPane.svelte";
  import SettingsNavIcon from "./SettingsNavIcon.svelte";
  import { avatarBase64FromFile } from "./avatar-image.js";
  import {
    PROFILE_SKELETON_DELAY_MS,
    profileFromMemberProfile,
    profilePanePhase,
  } from "./shell-settings-model.js";
  import "../chat/tokens.css";
  import "../chat/chat-tokens.css";
  import "./settings-chrome.css";

  export interface ShellSettingsProfile {
    /** Avatar monogram (single letter). */
    initial: string;
    /** Full display name shown by the avatar. */
    fullName: string;
    /** Short display name used on messages/runs. */
    displayName: string;
    email: string;
    verified: boolean;
  }

  export type ShellSettingsSection =
    | "profile"
    | "public-profile"
    | "billing"
    | "general"
    | "agents"
    | "bots"
    | "appearance"
    | "notifications"
    | "sync"
    | "meetings"
    | "updates"
    | "storage";

  const ALL_SECTIONS: ReadonlyArray<{ id: ShellSettingsSection | "sep"; label: string }> =
    [
      // OWNER-R21: one Settings list. Account first (Profile, Billing), then HQ.
      { id: "profile", label: "Profile" },
      // OWNER-R23: the marketplace creator profile, moved here from Library.
      { id: "public-profile", label: "Public profile" },
      { id: "billing", label: "Billing" },
      { id: "sep", label: "" },
      { id: "general", label: "General" },
      { id: "appearance", label: "Appearance" },
      { id: "notifications", label: "Notifications" },
      { id: "sync", label: "Sync" },
      { id: "meetings", label: "Meetings" },
      { id: "updates", label: "Updates" },
      { id: "storage", label: "Storage" },
      { id: "agents", label: "AI tools" },
      { id: "bots", label: "Bots" },
    ];

  interface Props {
    profile?: ShellSettingsProfile | null;
    /** Signed-in memberships (GET /membership/me via the host). */
    companies?: Workspace[] | null;
    adapter?: PlatformAdapter | null;
    version?: string;
    /**
     * Host-routed subsection; null preserves Profile-first normal entry.
     * "companies" is a retired section kept for old deep links: companies
     * are reached from the rail, so it lands on Profile.
     */
    initialSection?: ShellSettingsSection | "companies" | null;
    /** Monotonic native auth generation; stale profile loads/saves are rejected. */
    sessionGeneration?: number;
    /** Account/company-scoped renderer persistence supplied by the host. */
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
    onback?: () => void;
    /** Host-owned section navigation so settings subsections share history. */
    onsectionchange?: (section: ShellSettingsSection) => void;
    /** OWNER-R21: opens Stripe pages from Billing in the system browser. */
    openExternal?: (url: string) => void;
    /** OWNER-R20: companies with the caller's real role (null when unknown), owners first. */
    profileCompanies?: ReadonlyArray<{ uid: string; label: string; role: string | null }>;
    /** OWNER-R20/R24: a company row opens that company's General pane. */
    oncompany?: (uid: string) => void;
    onsignout?: () => Promise<void> | void;
    /** Open HQ Console (optional URL for a company or integrations). */
    onopenconsole?: (url?: string) => Promise<void> | void;
    /** Change-photo affordance (host seam; display-only default). */
    onchangephoto?: () => void;
    consoleBase?: string;
    /** Native update event edge; wakes the authoritative Updates pane. */
    updateWakeSeq?: number;
    /** Reads the running native app version when Updates refreshes. */
    refreshAppVersion?: () => Promise<string>;
    /** Live interface version when a UI hot update is serving. */
    uiVersion?: string | null;
    /** Settings › Bots "New bot": opens the Messages New bot modal. */
    onnewbot?: (() => void) | null;
  }

  let {
    profile = null,
    companies = [],
    adapter = null,
    version = "0.0.0",
    initialSection = null,
    sessionGeneration = 0,
    storage = typeof window !== "undefined" ? window.localStorage : null,
    onback,
    onsectionchange,
    openExternal,
    profileCompanies = [],
    oncompany,
    onsignout,
    onopenconsole,
    onchangephoto,
    consoleBase = HQ_CONSOLE_BASE,
    updateWakeSeq = 0,
    refreshAppVersion,
    uiVersion = null,
    onnewbot = null,
  }: Props = $props();

  let externalError = $state<string | null>(null);

  async function openConsole(url: string = consoleBase): Promise<void> {
    externalError = null;
    if (!onopenconsole) {
      externalError = "HQ Console is unavailable in this host.";
      return;
    }
    try {
      await onopenconsole(url);
    } catch (error) {
      console.warn("[settings] open HQ Console failed", error);
      externalError = "Couldn’t open HQ Console. Try again.";
    }
  }

  async function confirmSignOut(): Promise<void> {
    signOutConfirmOpen = false;
    externalError = null;
    if (!onsignout) {
      externalError = "Sign out is unavailable in this host.";
      return;
    }
    try {
      await onsignout();
    } catch (error) {
      console.warn("[settings] sign out failed", error);
      externalError = "Couldn’t sign out. Try again.";
    }
  }

  let active = $state<ShellSettingsSection>("profile");
  $effect(() => {
    // A bare Settings destination is an explicit Profile-first request too.
    // Without this reset a warm `settings` route could leave a previously
    // selected subsection visible when the settings shell stays mounted.
    active =
      initialSection && initialSection !== "companies" ? initialSection : "profile";
  });
  let signOutConfirmOpen = $state(false);

  // ── Editable profile state (US: make profile editable in-app) ───────────────
  let editName = $state("");
  let editDescription = $state("");
  /** Raw base64 (no data: prefix) of a freshly picked avatar, else null. */
  let pendingAvatarBase64 = $state<string | null>(null);
  /** Data-URL preview for the avatar (picked file or persisted avatarUrl). */
  let avatarPreview = $state<string | null>(null);
  let profileLoaded = $state(false);
  let descriptionLoaded = $state(false);
  let savingProfile = $state(false);
  let profileError = $state<string | null>(null);
  let profileSavedAt = $state<number | null>(null);
  let profileLoading = $state(false);
  let profileRequest = 0;
  let observedSessionGeneration = $state<number | null>(null);
  let avatarBusy = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);
  let profileFetchPending = $state(
    typeof adapter?.identity?.getProfile === "function",
  );
  let profileFetchError = $state<string | null>(null);
  let fetchedDisplayName = $state<string | null>(null);
  let fetchedEntityName = $state<string | null>(null);
  let fetchedEmail = $state<string | null>(null);
  let skeletonVisible = $state(false);
  let skeletonTimer: ReturnType<typeof setTimeout> | null = null;

  const DESCRIPTION_MAX = 140;
  // Baselines that "dirty" is measured against — reset on load and after a save
  // so the prop (derived from the session, never re-pushed) can't strand them.
  let initialName = $state("");
  let initialDescription = $state("");

  const nameDirty = $derived(editName.trim() !== initialName.trim());
  const descriptionDirty = $derived(
    descriptionLoaded && editDescription.trim() !== initialDescription.trim(),
  );
  const profileDirty = $derived(
    profileLoaded && (pendingAvatarBase64 !== null || nameDirty || descriptionDirty),
  );

  function seedFromProfile(): void {
    editName = profile?.displayName ?? profile?.fullName ?? "";
    initialName = editName;
  }

  const fallbackProfile = $derived(
    profile
      ? null
      : profileFromMemberProfile({
          displayName: fetchedDisplayName || fetchedEntityName,
          email: fetchedEmail || null,
        }),
  );
  const resolvedProfile = $derived(profile ?? fallbackProfile);
  const phase = $derived(
    profilePanePhase({
      hasProfile: Boolean(resolvedProfile),
      fetching: profileFetchPending,
      error: profileFetchError,
    }),
  );

  function clearSkeletonTimer(): void {
    if (skeletonTimer === null) return;
    clearTimeout(skeletonTimer);
    skeletonTimer = null;
  }

  function startSkeletonDelay(): void {
    clearSkeletonTimer();
    skeletonVisible = false;
    skeletonTimer = setTimeout(() => {
      skeletonTimer = null;
      skeletonVisible = true;
    }, PROFILE_SKELETON_DELAY_MS);
  }

  /** GetProfileResult carries no typed email; read it loosely off the wire. */
  function memberEmailFromValue(value: unknown): string | null {
    const email = (value as { email?: unknown } | null)?.email;
    return typeof email === "string" && email.trim() ? email.trim() : null;
  }

  async function loadProfile(): Promise<void> {
    const request = ++profileRequest;
    const generation = sessionGeneration;
    profileLoading = true;
    profileError = null;
    seedFromProfile();
    if (typeof adapter?.identity?.getProfile !== "function") {
      profileFetchPending = false;
      profileLoaded = true;
      profileLoading = false;
      return;
    }
    profileFetchPending = true;
    profileFetchError = null;
    startSkeletonDelay();
    try {
      const res = await adapter.identity.getProfile();
      if (request !== profileRequest || generation !== sessionGeneration) return;
      if (res.ok && res.value) {
        const block = res.value.profile;
        if (block?.displayName) editName = block.displayName;
        else if (res.value.entityName) editName ||= res.value.entityName;
        initialName = editName;
        // A successful profile response is authoritative even when this is a
        // first-time profile (`profile: null`) or its optional description is
        // absent. Keep failures distinct so only a confirmed empty value is
        // editable and eligible to save.
        editDescription = typeof block?.description === "string" ? block.description : "";
        initialDescription = editDescription;
        descriptionLoaded = true;
        if (block?.avatarUrl) avatarPreview = block.avatarUrl;
        fetchedDisplayName = block?.displayName ?? null;
        fetchedEntityName = res.value.entityName ?? null;
        fetchedEmail = memberEmailFromValue(res.value);
        profileFetchError = null;
      } else {
        // A failed profile result is not an empty profile. Keep only the
        // session-backed name editable and do not manufacture a blank About
        // value that a later Save could send back to the server.
        descriptionLoaded = false;
        // AUDIT-3: the service's own text goes to the log, never onto the screen.
        console.warn("[settings] profile read failed", res.ok ? "empty" : res.message);
        const message = "Couldn\u2019t load all profile fields. Try again.";
        profileError = message;
        profileFetchError = message;
      }
      profileLoaded = true;
    } catch (error) {
      if (request !== profileRequest || generation !== sessionGeneration) return;
      descriptionLoaded = false;
      profileLoaded = true;
      console.warn("[settings] profile read failed", error);
      const message = "Couldn\u2019t load all profile fields. Try again.";
      profileError = message;
      profileFetchError = message;
    } finally {
      if (request === profileRequest && generation === sessionGeneration) {
        profileLoading = false;
        profileFetchPending = false;
        clearSkeletonTimer();
        skeletonVisible = false;
      }
    }
  }


  onMount(() => {
    void loadProfile();
    return () => {
      clearSkeletonTimer();
    };
  });

  // DesktopApp re-keys on every native session generation, but keep this
  // component correct when a host updates the prop in place as well. A save
  // started for A must neither settle B's UI nor leave its controls wedged.
  $effect(() => {
    if (observedSessionGeneration === null) {
      observedSessionGeneration = sessionGeneration;
      return;
    }
    if (sessionGeneration === observedSessionGeneration) return;
    observedSessionGeneration = sessionGeneration;
    profileRequest += 1;
    savingProfile = false;
    profileSavedAt = null;
    profileError = null;
    profileLoaded = false;
    descriptionLoaded = false;
    pendingAvatarBase64 = null;
    editName = "";
    initialName = "";
    editDescription = "";
    initialDescription = "";
    avatarPreview = null;
    profileFetchError = null;
    fetchedDisplayName = null;
    fetchedEntityName = null;
    fetchedEmail = null;
    void loadProfile();
  });

  function pickPhoto(): void {
    profileError = null;
    fileInput?.click();
  }

  async function onPhotoChosen(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    avatarBusy = true;
    profileError = null;
    try {
      const { base64, previewDataUrl } = await avatarBase64FromFile(file);
      pendingAvatarBase64 = base64;
      avatarPreview = previewDataUrl;
    } catch (err) {
      profileError =
        // raw-error-ok: avatar-image errors are app-written copy
        err instanceof Error ? err.message : "Couldn't read that image.";
    } finally {
      avatarBusy = false;
    }
  }

  async function saveProfile(): Promise<void> {
    if (!adapter || savingProfile) return;
    const name = editName.trim();
    const description = editDescription.trim();
    if (descriptionLoaded && description.length > DESCRIPTION_MAX) {
      profileError = `About must be ${DESCRIPTION_MAX} characters or fewer.`;
      return;
    }
    savingProfile = true;
    profileError = null;
    const generation = sessionGeneration;
    const update: {
      displayName?: string;
      description?: string;
      avatarBase64?: string;
    } = {};
    if (nameDirty && name) update.displayName = name;
    if (descriptionDirty) update.description = description;
    if (pendingAvatarBase64) update.avatarBase64 = pendingAvatarBase64;
    if (Object.keys(update).length === 0) {
      savingProfile = false;
      return;
    }
    try {
      const res = await adapter.identity.updateProfile(update);
      if (generation !== sessionGeneration) return;
      if (res.ok) {
        pendingAvatarBase64 = null;
        if (nameDirty) initialName = name;
        if (descriptionDirty) initialDescription = description;
        if (res.value?.profile?.avatarUrl) {
          avatarPreview = res.value.profile.avatarUrl;
        }
        profileSavedAt = Date.now();
      } else {
        console.warn("[settings] profile save failed", res.message);
        profileError = "Couldn't save your profile. Try again.";
      }
    } catch (err) {
      if (generation !== sessionGeneration) return;
      console.warn("[settings] profile save failed", err);
      profileError = "Couldn't save your profile. Try again.";
    } finally {
      if (generation === sessionGeneration) savingProfile = false;
    }
  }

  const sections = $derived(
    ALL_SECTIONS.filter((section) => {
      if (section.id === "sync")
        return adapter?.isAvailable("canSync") ?? false;
      if (section.id === "updates") {
        return adapter?.isAvailable("canSelfUpdate") ?? false;
      }
      // Storage shells to the local hq CLI; desktop host only.
      if (section.id === "storage") return Boolean(adapter?.storage);
      if (section.id === "agents")
        return Boolean(adapter?.sessions?.preflight);
      // Bots: the Cloud group reads adapter.agents (every host); the Local
      // group needs the desktop-only `bots` group and hides itself otherwise.
      if (section.id === "bots") return Boolean(adapter?.bots || adapter?.agents);
      return true;
    }),
  );
</script>

<section class="shell-settings" data-testid="settings-two-column">
  <PageHeader
    title="Settings"
    subtitle="yours — moved here from the Core menu"
    subtitleTestId="settings-subtitle"
    backTestId="settings-back"
    onback={() => onback?.()}
  />

  <div class="ss-body">
    <nav
      class="ss-nav"
      aria-label="Settings sections"
      data-testid="settings-nav"
    >
      {#each sections as section (section.id)}
        {#if section.id === "sep"}
          <div class="ss-nav-sep" role="separator"></div>
        {:else}
          <button
            type="button"
            class="ss-nav-item"
            class:active={active === section.id}
            aria-current={active === section.id ? "page" : undefined}
            data-testid={`settings-nav-${section.id}`}
            onclick={() => {
              if (section.id === "sep") return;
              if (onsectionchange) onsectionchange(section.id);
              else active = section.id;
            }}
          >
            <span class="ss-nav-icon">
              <SettingsNavIcon name={section.id} />
            </span>
            {section.label}
          </button>
        {/if}
      {/each}
    </nav>

    <div class="ss-pane" data-testid="settings-pane">
      {#if externalError}
        <p class="ss-external-error" data-testid="settings-external-error" role="alert">
          {externalError}
        </p>
      {/if}
      {#if active === "profile"}
        {#if phase === "ready" && resolvedProfile}
          <div
            class="ss-profile proto-stack"
            data-testid="settings-profile-pane"
          >
            <input
              bind:this={fileInput}
              type="file"
              accept="image/*"
              class="ss-file-input"
              data-testid="settings-photo-input"
              onchange={(e) => void onPhotoChosen(e)}
            />
            <div class="set-row ss-identity-row">
              {#if avatarPreview}
                <img
                  class="ss-avatar ss-avatar-img"
                  src={avatarPreview}
                  alt="Your avatar"
                  data-testid="settings-avatar-img"
                />
              {:else}
                <div class="ss-avatar" aria-hidden="true">
                  {resolvedProfile.initial}
                </div>
              {/if}
              <div class="ss-identity-meta">
                <span class="ss-name">{editName || resolvedProfile.fullName}</span>
                <span class="ss-email">{resolvedProfile.email}</span>
              </div>
              <button
                type="button"
                class="chip"
                data-testid="settings-change-photo"
                disabled={avatarBusy || !adapter}
                onclick={pickPhoto}
              ><RailIcon name="upload" />
                {avatarBusy ? "Reading…" : "Change photo"}
              </button>
            </div>
            <div class="set-row ss-input-row">
              <div>
                <div class="sn">Display name</div>
                <div class="sd">Shown on your messages and runs</div>
              </div>
              <input
                class="ss-input"
                type="text"
                data-testid="settings-display-name-input"
                placeholder="Your name"
                bind:value={editName}
                disabled={!adapter}
              />
            </div>
            <div class="set-row ss-input-row">
              <div>
                <div class="sn">About</div>
                <div class="sd">
                  A short line teammates see ({editDescription.trim()
                    .length}/{DESCRIPTION_MAX})
                  {#if !descriptionLoaded} — unavailable until the profile service recovers{/if}
                </div>
              </div>
              <input
                class="ss-input"
                type="text"
                maxlength={DESCRIPTION_MAX}
                data-testid="settings-description-input"
                placeholder="e.g. Founder · building HQ"
                bind:value={editDescription}
                disabled={!adapter || !descriptionLoaded}
              />
              {#if !descriptionLoaded}
                <button
                  type="button"
                  class="chip"
                  data-testid="settings-profile-retry"
                  disabled={profileLoading}
                  onclick={() => void loadProfile()}
                ><RailIcon name="refresh" />
                  {profileLoading ? "Loading…" : "Retry About"}
                </button>
              {/if}
            </div>
            <div class="set-row">
              <div>
                <div class="sn">Email</div>
                <div class="sd">Signed-in account</div>
              </div>
              <span class="ss-field-inline">
                <span class="val">{resolvedProfile.email}</span>
                {#if resolvedProfile.verified}
                  <span class="ss-badge" data-testid="settings-email-verified"
                    >Verified</span
                  >
                {/if}
              </span>
            </div>
            {#if profileCompanies.length > 0}
              <div class="ss-companies" data-testid="settings-profile-companies">
                <div class="sn ss-companies-head">Companies and roles</div>
                {#each profileCompanies as company (company.uid)}
                  <button
                    type="button"
                    class="ss-company-row"
                    data-testid="settings-profile-company"
                    data-company-uid={company.uid}
                    onclick={() => oncompany?.(company.uid)}
                  >
                    <span class="ss-company-name"><CompanyLabel name={company.label} companyUid={company.uid} /></span>
                    <span class="ss-company-role" data-testid="settings-profile-company-role">{company.role ?? ""}</span>
                    <svg class="ss-company-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </button>
                {/each}
              </div>
            {/if}
            <div class="set-row ss-save-row">
              <div>
                {#if profileError}
                  <div
                    class="sd ss-save-error"
                    role="alert"
                    data-testid="settings-profile-error"
                  >
                    {profileError}
                  </div>
                {:else if profileSavedAt && !profileDirty}
                  <div
                    class="sd ss-save-ok"
                    data-testid="settings-profile-saved"
                  >
                    Saved
                  </div>
                {:else}
                  <div class="sd">Changes apply across HQ Work</div>
                {/if}
              </div>
              <button
                type="button"
                class="chip primary"
                data-testid="settings-profile-save"
                disabled={!adapter || savingProfile || !profileDirty}
                onclick={() => void saveProfile()}
              ><RailIcon name="check" />
                {savingProfile ? "Saving…" : "Save changes"}
              </button>
            </div>
            <div class="set-row">
              <div>
                <div class="sn">Manage account</div>
                <div class="sd">
                  Billing, teammates, and company settings live in HQ Console
                </div>
              </div>
              <button
                type="button"
                class="chip"
                data-testid="settings-open-console"
                onclick={() => void openConsole()}
              ><RailIcon name="external" />
                Open console
              </button>
            </div>
            <div class="set-row">
              <div>
                <div class="sn">Sign out</div>
                <div class="sd">Ends this session on this machine</div>
              </div>
              <button
                type="button"
                class="chip danger"
                data-testid="settings-sign-out"
                onclick={() => (signOutConfirmOpen = true)}
              ><RailIcon name="logout" />
                Sign out
              </button>
            </div>
          </div>
        {:else if phase === "loading"}
          {#if skeletonVisible}
            <ReadLoader testid="settings-profile-loading" onretry={() => void loadProfile()} />
          {/if}
        {:else if phase === "error"}
          <div
            class="ss-profile-retry"
            data-testid="settings-profile-retry-state"
          >
            <span>Couldn't load your profile.</span>
            <button
              type="button"
              class="chip"
              data-testid="settings-profile-retry"
              onclick={() => void loadProfile()}
            ><RailIcon name="refresh" />
              Retry
            </button>
          </div>
        {:else}
          <EmptyState
            testid="settings-profile-empty"
            title="No data"
            copy="No profile data yet."
          />
        {/if}
      {:else if active === "public-profile"}
        {#if adapter}
          {#await import("../marketplace/ProfilePanel.svelte") then m}
            <m.default {adapter} />
          {/await}
        {/if}
      {:else if active === "billing"}
        <BillingSettingsPane {openExternal} />
      {:else if active === "agents"}
        <AgentsSettingsPane {adapter} />
      {:else if active === "storage"}
        <StorageSettingsPane {adapter} />
      {:else if active === "bots"}
        <BotsSettingsPane {adapter} {companies} {onnewbot} />
      {:else}
        <PrototypeSettingsPanes
          section={active as
            | "general"
            | "appearance"
            | "notifications"
            | "sync"
            | "meetings"
            | "updates"}
          {version}
          {adapter}
          {storage}
          {sessionGeneration}
          {companies}
          personalLabel={profile?.displayName ?? ""}
          {consoleBase}
          onopenconsole={openConsole}
          {updateWakeSeq}
          {refreshAppVersion}
          {uiVersion}
        />
      {/if}
    </div>
  </div>
</section>

<ConfirmDialog
  open={signOutConfirmOpen}
  title="Sign out"
  message="Sign out of HQ Work on this machine?"
  confirmLabel="Sign out"
  danger
  oncancel={() => (signOutConfirmOpen = false)}
  onconfirm={() => void confirmSignOut()}
/>

<style>
  .shell-settings {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    /* Transparent: Settings renders inside .desktop-shell, which already
       paints --v4-ground. Repainting it here doubled the window backing and
       kept the opacity slider from showing any change. */
    background: transparent;
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui);
  }

  .ss-body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  .ss-companies { display: flex; flex-direction: column; gap: 1px; padding: 6px 0; }
  .ss-companies-head { padding: 0 0 4px; }
  .ss-company-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 80px 14px;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t1, inherit);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .ss-company-row:hover { background: var(--hover, var(--overlay-hover)); }
  .ss-company-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ss-company-role, .ss-company-chev { color: var(--t3, currentColor); }
  .ss-company-chev { width: 14px; height: 14px; }
  .ss-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 0 0 200px;
    /* Row content lands on --page-edge-inset, under the page title. */
    padding: 14px calc(var(--page-edge-inset, 20px) - 10px);
    border-right: 1px solid var(--line);
    overflow-y: auto;
  }

  .ss-nav-sep {
    height: 1px;
    margin: 8px 6px;
    background: var(--line);
  }

  .ss-nav-icon {
    display: inline-flex;
    width: 16px;
    color: var(--t3);
    align-items: center;
    justify-content: center;
  }

  .ss-nav-item.active .ss-nav-icon {
    color: var(--t1);
  }

  .ss-nav-item {
    appearance: none;
    -webkit-appearance: none;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    /* Background only. A color transition on a var()-driven color leaves
       WebKit painting the old theme's text after the theme attribute flips
       while Settings is mounted (QA-103), so text color switches instantly. */
    transition: background 0.12s;
  }

  .ss-nav-item:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .ss-nav-item.active {
    background: var(--sel);
    color: var(--t1);
  }

  .ss-nav-item:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
  }

  .ss-pane {
    flex: 1 1 auto;
    min-width: 0;
    padding: 24px 28px;
    overflow-y: auto;
  }

  .ss-profile {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 640px;
  }

  .set-row {
    display: flex;
    align-items: center;
    gap: 12px;
    background: transparent;
    border: 1px solid transparent;
    border-top-color: var(--line);
    border-radius: 0;
    padding: 14px 16px;
  }

  .sn {
    font-weight: 500;
    font-size: 13px;
    color: var(--t1);
  }

  .sd {
    margin-top: 2px;
    color: var(--t2);
    font-size: 12px;
    line-height: 1.45;
  }

  .val {
    margin-left: auto;
    color: var(--ice-ink, #c9d6e4);
    font-size: 13px;
  }

  .chip {
    margin-left: auto;
    padding: 5px 10px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: none;
    color: var(--t2);
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .chip.danger {
    color: var(--warn-ink, #d9584a);
  }

  .ss-field-inline {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .ss-identity {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .ss-avatar {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--ice-ink);
    color: var(--badge-fg);
    font-size: 20px;
    font-weight: 600;
  }

  .ss-avatar-img {
    object-fit: cover;
  }

  .ss-file-input {
    display: none;
  }

  .ss-input-row .ss-input {
    margin-left: auto;
    flex: 0 1 280px;
    min-width: 0;
    padding: 7px 10px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--v4-ground, #161618);
    color: var(--t1);
    font: inherit;
    font-size: 13px;
  }

  .ss-input:focus-visible {
    outline: none;
    border-color: var(--ice-ink, #c9d6e4);
  }

  .ss-input:disabled {
    opacity: 0.6;
  }

  .chip.primary {
    border-color: var(--ice-ink, #2a3644);
    color: var(--ice-ink, #c9d6e4);
  }

  .chip:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .ss-save-error {
    color: var(--warn-ink, #d9584a);
  }

  .ss-save-ok {
    color: var(--ok, #34c759);
  }

  .ss-identity-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 auto;
    min-width: 0;
  }

  .ss-name {
    color: var(--t1);
    font-size: 15px;
    font-weight: 600;
  }

  .ss-email {
    color: var(--t3);
    font-size: 12px;
  }

  .ss-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ss-section-label {
    margin: 0 0 6px;
    color: var(--t3);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .ss-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 0;
    border-top: 1px solid var(--line);
  }

  .ss-field-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .ss-field-label {
    color: var(--t1);
    font-size: 13px;
    font-weight: 500;
  }

  .ss-field-help {
    color: var(--t3);
    font-size: 12px;
  }

  .ss-field-value {
    flex: 0 0 auto;
    color: var(--t2);
    font-size: 13px;
  }

  .ss-field-inline {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .ss-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--ok, #34c759) 18%, transparent);
    color: var(--ok-ink, var(--ok, #34c759));
    /* Status pill, not a path or id: sans at the OWNER-008 info-pill size. */
    font-size: 11px;
    font-weight: 400;
  }

  .ss-btn {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: 0 0 auto;
    padding: 6px 12px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--btn-bg);
    color: var(--t1);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .ss-btn:hover {
    border-color: var(--t3);
  }

  .ss-btn.ghost {
    background: transparent;
    color: var(--t2);
  }

  .ss-btn.danger {
    color: var(--warn-ink, #d9584a);
  }

  .ss-profile-retry {
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 640px;
    color: var(--t2);
    font-size: 13px;
  }

  .ss-profile-retry .chip {
    margin-left: 0;
  }
</style>
