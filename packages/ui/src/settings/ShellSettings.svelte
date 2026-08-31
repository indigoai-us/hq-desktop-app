<script lang="ts">
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
  import { HQ_CONSOLE_BASE } from "../common/hq-console.js";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import CompaniesSettingsPane from "./CompaniesSettingsPane.svelte";
  import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
  import SettingsNavIcon from "./SettingsNavIcon.svelte";
  import { avatarBase64FromFile } from "./avatar-image.js";
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
    | "companies"
    | "general"
    | "appearance"
    | "notifications"
    | "sync"
    | "meetings"
    | "updates";

  const ALL_SECTIONS: ReadonlyArray<{ id: ShellSettingsSection | "sep"; label: string }> =
    [
      { id: "profile", label: "Profile" },
      { id: "companies", label: "Companies" },
      { id: "sep", label: "" },
      { id: "general", label: "General" },
      { id: "appearance", label: "Appearance" },
      { id: "notifications", label: "Notifications" },
      { id: "sync", label: "Sync" },
      { id: "meetings", label: "Meetings" },
      { id: "updates", label: "Updates" },
    ];

  interface Props {
    profile?: ShellSettingsProfile | null;
    /** Signed-in memberships (GET /membership/me via the host). */
    companies?: Workspace[] | null;
    adapter?: PlatformAdapter | null;
    version?: string;
    /** Host-routed subsection; null preserves Profile-first normal entry. */
    initialSection?: ShellSettingsSection | null;
    onback?: () => void;
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
  }

  let {
    profile = null,
    companies = [],
    adapter = null,
    version = "0.0.0",
    initialSection = null,
    onback,
    onsignout,
    onopenconsole,
    onchangephoto,
    consoleBase = HQ_CONSOLE_BASE,
    updateWakeSeq = 0,
    refreshAppVersion,
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
      externalError = `Couldn’t open HQ Console: ${String(error)}`;
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
      externalError = `Couldn’t sign out: ${String(error)}`;
    }
  }

  let active = $state<ShellSettingsSection>("profile");
  $effect(() => {
    // A bare Settings destination is an explicit Profile-first request too.
    // Without this reset a warm `settings` route could leave a previously
    // selected subsection visible when the settings shell stays mounted.
    active = initialSection ?? "profile";
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
  let savingProfile = $state(false);
  let profileError = $state<string | null>(null);
  let profileSavedAt = $state<number | null>(null);
  let avatarBusy = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  const DESCRIPTION_MAX = 140;
  // Baselines that "dirty" is measured against — reset on load and after a save
  // so the prop (derived from the session, never re-pushed) can't strand them.
  let initialName = $state("");
  let initialDescription = $state("");

  const profileDirty = $derived(
    profileLoaded &&
      (pendingAvatarBase64 !== null ||
        editName.trim() !== initialName.trim() ||
        editDescription.trim() !== initialDescription.trim()),
  );

  function seedFromProfile(): void {
    editName = profile?.displayName ?? profile?.fullName ?? "";
    initialName = editName;
  }

  onMount(() => {
    seedFromProfile();
    if (typeof adapter?.identity?.getProfile !== "function") {
      profileLoaded = true;
      return;
    }
    void adapter.identity.getProfile().then((res) => {
      if (res.ok && res.value) {
        const block = res.value.profile;
        if (block?.displayName) editName = block.displayName;
        else if (res.value.entityName) editName ||= res.value.entityName;
        initialName = editName;
        if (block?.description) {
          editDescription = block.description;
          initialDescription = block.description;
        }
        if (block?.avatarUrl) avatarPreview = block.avatarUrl;
      }
      profileLoaded = true;
    });
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
        err instanceof Error ? err.message : "Couldn't read that image.";
    } finally {
      avatarBusy = false;
    }
  }

  async function saveProfile(): Promise<void> {
    if (!adapter || savingProfile) return;
    const name = editName.trim();
    const description = editDescription.trim();
    if (description.length > DESCRIPTION_MAX) {
      profileError = `About must be ${DESCRIPTION_MAX} characters or fewer.`;
      return;
    }
    savingProfile = true;
    profileError = null;
    try {
      const res = await adapter.identity.updateProfile({
        displayName: name || undefined,
        description,
        ...(pendingAvatarBase64 ? { avatarBase64: pendingAvatarBase64 } : {}),
      });
      if (res.ok) {
        pendingAvatarBase64 = null;
        initialName = name;
        initialDescription = description;
        if (res.value?.profile?.avatarUrl) {
          avatarPreview = res.value.profile.avatarUrl;
        }
        profileSavedAt = Date.now();
      } else {
        profileError = res.message || "Couldn't save your profile.";
      }
    } catch (err) {
      profileError =
        err instanceof Error ? err.message : "Couldn't save your profile.";
    } finally {
      savingProfile = false;
    }
  }

  const sections = $derived(
    ALL_SECTIONS.filter((section) => {
      if (section.id === "sync")
        return adapter?.isAvailable("canSync") ?? false;
      if (section.id === "updates") {
        return adapter?.isAvailable("canSelfUpdate") ?? false;
      }
      return true;
    }),
  );
</script>

<section class="shell-settings" data-testid="settings-two-column">
  <header class="ss-header">
    <button
      type="button"
      class="ss-back"
      data-testid="settings-back"
      onclick={() => onback?.()}
    >
      <span aria-hidden="true">←</span> Back
    </button>
    <h1 class="ss-title">Settings</h1>
    <span class="ss-subtitle" data-testid="settings-subtitle"
      >yours — moved here from the Core menu</span
    >
  </header>

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
              if (section.id !== "sep") active = section.id;
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
        {#if !profile}
          <EmptyState
            testid="settings-profile-empty"
            title="No data"
            copy="No profile data yet."
          />
        {:else}
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
                  {profile.initial}
                </div>
              {/if}
              <div class="ss-identity-meta">
                <span class="ss-name">{editName || profile.fullName}</span>
                <span class="ss-email">{profile.email}</span>
              </div>
              <button
                type="button"
                class="chip"
                data-testid="settings-change-photo"
                disabled={avatarBusy || !adapter}
                onclick={pickPhoto}
              >
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
                </div>
              </div>
              <input
                class="ss-input"
                type="text"
                maxlength={DESCRIPTION_MAX}
                data-testid="settings-description-input"
                placeholder="e.g. Founder · building HQ"
                bind:value={editDescription}
                disabled={!adapter}
              />
            </div>
            <div class="set-row">
              <div>
                <div class="sn">Email</div>
                <div class="sd">Signed-in account</div>
              </div>
              <span class="ss-field-inline">
                <span class="mono">{profile.email}</span>
                {#if profile.verified}
                  <span class="ss-badge" data-testid="settings-email-verified"
                    >Verified</span
                  >
                {/if}
              </span>
            </div>
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
              >
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
              >
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
              >
                Sign out
              </button>
            </div>
          </div>
        {/if}
      {:else if active === "companies"}
        <CompaniesSettingsPane
          {companies}
          personalLabel={profile?.displayName ?? ""}
          {consoleBase}
          onopenconsole={openConsole}
        />
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
          {companies}
          personalLabel={profile?.displayName ?? ""}
          {consoleBase}
          onopenconsole={openConsole}
          {updateWakeSeq}
          {refreshAppVersion}
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
    background: var(--v4-ground, #161618);
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui);
  }

  .ss-header {
    display: flex;
    align-items: baseline;
    gap: 14px;
    flex: 0 0 auto;
    padding: 14px 24px;
    border-bottom: 1px solid var(--line);
  }

  .ss-back {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--btn-bg);
    color: var(--t2);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .ss-back:hover {
    border-color: var(--line2);
    color: var(--t1);
  }

  .ss-title {
    margin: 0;
    color: var(--t1);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.2;
  }

  .ss-subtitle {
    color: var(--t3);
    font-size: 12px;
    font-weight: 400;
  }

  .ss-body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  .ss-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 0 0 200px;
    padding: 14px 12px;
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
    transition:
      color 0.12s,
      background 0.12s;
  }

  .ss-nav-item:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .ss-nav-item.active {
    background: var(--sel);
    color: var(--t1);
  }

  .ss-nav-item:focus-visible,
  .ss-back:focus-visible {
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
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
  }

  .sn {
    font-weight: 500;
    font-size: 13px;
    color: var(--t1);
  }

  .sd {
    margin-top: 2px;
    color: var(--t3);
    font-size: 11px;
  }

  .mono {
    margin-left: auto;
    color: var(--ice-ink, #c9d6e4);
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 11px;
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
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
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
</style>
