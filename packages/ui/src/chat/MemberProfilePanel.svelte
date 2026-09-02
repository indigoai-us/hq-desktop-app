<script lang="ts">
  /**
   * MemberProfilePanel — Slack-style right-side profile panel for a channel
   * member. Opened by clicking a name in the conversation, a row in the members
   * popover, or a mention. Renders the member's avatar monogram, display name,
   * email, and role. Zero-network: it renders the StatusPersonRow the shell
   * already holds; an optional avatarUrl (self, from GET /v1/profile) upgrades
   * the monogram to a photo when available.
   */
  import type { StatusPersonRow } from "./channel-status-model.js";
  import { paintableAvatarSrc } from "../avatars/csp-image-src.js";
  import { isSelf, type SelfIdentity } from "../identity/self.js";
  import AvatarPackPicker from "../avatars/AvatarPackPicker.svelte";
  import type { AvatarPack, AvatarSelection } from "../avatars/types.js";
  import "./tokens.css";
  import "./chat-tokens.css";

  interface Props {
    member: StatusPersonRow;
    self?: SelfIdentity | null;
    /** Optional real avatar (currently only known for self). */
    avatarUrl?: string | null;
    /** Owner/admin of this agent: show the pack picker. */
    editable?: boolean;
    packs?: AvatarPack[] | null;
    saving?: boolean;
    saveError?: string | null;
    onsaveavatar?: (selection: AvatarSelection) => void | Promise<void>;
    onclose?: () => void;
  }

  let {
    member,
    self = null,
    avatarUrl = null,
    editable = false,
    packs = null,
    saving = false,
    saveError = null,
    onsaveavatar,
    onclose,
  }: Props = $props();

  const you = $derived(isSelf(member.personUid, self));
  // Prefer an explicitly-passed photo, else the member row's own avatar.
  const photo = $derived(
    paintableAvatarSrc(avatarUrl || member.avatarUrl || null),
  );
  let photoBroken = $state(false);
  const initial = $derived(
    (member.displayName ?? "").trim()
      ? member.displayName.trim()[0].toUpperCase()
      : "?",
  );
  const roleLabel = $derived((member.role ?? "").trim());
  const about = $derived((member.description ?? "").trim());
</script>

<aside
  class="profile-panel"
  aria-label={`${member.displayName} profile`}
  data-testid="member-profile-panel"
>
  <header class="pp-head">
    <span class="pp-title">Profile</span>
    <button
      type="button"
      class="pp-close"
      data-testid="member-profile-close"
      aria-label="Close profile"
      onclick={() => onclose?.()}
    >
      ×
    </button>
  </header>

  <div class="pp-body">
    <div class="pp-avatar-wrap">
      {#if photo && !photoBroken}
        <img
          class="pp-avatar-img"
          src={photo}
          alt={`${member.displayName} avatar`}
          data-testid="member-profile-avatar-img"
          onerror={() => (photoBroken = true)}
        />
      {:else}
        <span class="pp-avatar" aria-hidden="true">{initial}</span>
      {/if}
    </div>

    <div class="pp-name-row">
      <h2 class="pp-name" data-testid="member-profile-name">
        {member.displayName}
      </h2>
      {#if you}
        <span class="pp-you" data-testid="member-profile-you">you</span>
      {/if}
    </div>

    {#if roleLabel}
      <div class="pp-role" data-testid="member-profile-role">{roleLabel}</div>
    {/if}

    <dl class="pp-fields">
      {#if about}
        <div class="pp-field">
          <dt>About</dt>
          <dd data-testid="member-profile-about">{about}</dd>
        </div>
      {/if}
      {#if editable}
        <div class="pp-picker" data-testid="member-profile-avatar-picker">
          <AvatarPackPicker
            agentUid={member.personUid}
            currentSrc={photo}
            {packs}
            {saving}
            error={saveError}
            onsave={onsaveavatar}
          />
        </div>
      {/if}
      {#if member.email}
        <div class="pp-field">
          <dt>Email</dt>
          <dd>
            <a
              class="pp-email"
              href={`mailto:${member.email}`}
              data-testid="member-profile-email">{member.email}</a
            >
          </dd>
        </div>
      {/if}
    </dl>
  </div>
</aside>

<style>
  .profile-panel {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    background: var(--v4-ground, #161618);
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui);
  }

  .pp-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 0 auto;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line);
  }

  .pp-title {
    color: var(--t1);
    font-size: 13px;
    font-weight: 600;
  }

  .pp-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .pp-close:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .pp-body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 24px 20px;
    text-align: center;
  }

  .pp-avatar-wrap {
    width: 108px;
    height: 108px;
  }

  .pp-avatar,
  .pp-avatar-img {
    display: grid;
    place-items: center;
    width: 108px;
    height: 108px;
    border-radius: 16px;
    object-fit: cover;
  }

  .pp-avatar {
    background: var(--ice-ink, #c9d6e4);
    color: var(--badge-fg, #10151b);
    font-size: 44px;
    font-weight: 600;
  }

  .pp-name-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .pp-name {
    margin: 0;
    color: var(--t1);
    font-size: 18px;
    font-weight: 700;
  }

  .pp-you {
    color: var(--t3);
    font: 500 10px/1 var(--font-mono);
  }

  .pp-role {
    color: var(--t3);
    font-size: 12px;
    text-transform: capitalize;
  }

  .pp-picker {
    width: 100%;
    margin-top: 8px;
    text-align: left;
  }

  .pp-fields {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
    margin: 12px 0 0;
    text-align: left;
  }

  .pp-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--raised);
  }

  .pp-field dt {
    color: var(--t3);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .pp-field dd {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    color: var(--t1);
    font-size: 13px;
    text-overflow: ellipsis;
  }

  .pp-email {
    color: var(--ice-ink, #c9d6e4);
    text-decoration: none;
  }

  .pp-email:hover {
    text-decoration: underline;
  }

  .pp-close:focus-visible,
  .pp-email:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
  }
</style>
