<!--
  OWNER-R3: Invite notetaker to a meeting that is not on the calendar. One
  link field, plain validation, and a confirm. Uses the existing
  meetings-store inviteBotByUrl action.
-->
<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import { dismissable } from "../common/dismissable.js";
  import { meetingsStore } from "./meetings-store.svelte";
  import { canInviteNotetaker, notetakerLinkProblem } from "./notetaker-invite";

  interface Props {
    onclose?: () => void;
  }

  let { onclose }: Props = $props();

  let link = $state("");
  let phase = $state<"idle" | "pending" | "failed" | "done">("idle");
  let failure = $state("");
  const problem = $derived(notetakerLinkProblem(link));
  const ready = $derived(canInviteNotetaker(link));

  async function invite(): Promise<void> {
    if (!ready || phase === "pending") return;
    phase = "pending";
    failure = "";
    const result = await meetingsStore.inviteBotByUrl(link.trim(), null);
    if (!result || result.kind === "warn") {
      failure = result?.text || "Couldn't invite the notetaker.";
      phase = "failed";
      return;
    }
    phase = "done";
  }
</script>

<div class="scrim" role="presentation" onclick={() => onclose?.()}></div>
<div class="sheet" role="dialog" aria-label="Invite notetaker" data-testid="invite-notetaker-sheet" tabindex="-1" use:dismissable={{ onclose: () => onclose?.() }}>
  <div class="hd">Invite notetaker to a meeting</div>
  {#if phase === "done"}
    <p class="line" role="status" data-testid="invite-notetaker-done">Notetaker invited. It joins the meeting at that link to record and transcribe it.</p>
    <div class="ft"><button type="button" class="btn primary" data-testid="invite-notetaker-close" onclick={() => onclose?.()}><RailIcon name="check" />Done</button></div>
  {:else}
    <input
      class="field"
      data-testid="invite-notetaker-link"
      placeholder="Paste a Zoom, Meet, or Teams link"
      aria-label="Meeting link"
      aria-invalid={problem ? "true" : "false"}
      bind:value={link}
      disabled={phase === "pending"}
      onkeydown={(e) => e.key === "Enter" && void invite()}
    />
    {#if problem}<p class="line" data-testid="invite-notetaker-problem">{problem}</p>{/if}
    {#if phase === "failed"}<p class="line" role="alert" data-testid="invite-notetaker-failed">{failure}</p>{/if}
    <div class="ft">
      <button type="button" class="btn" onclick={() => onclose?.()}><RailIcon name="x" />Cancel</button>
      <button type="button" class="btn primary" data-testid="invite-notetaker-confirm" disabled={!ready || phase === "pending"} aria-busy={phase === "pending"} onclick={() => void invite()}><RailIcon name="user-plus" />
        {phase === "pending" ? "Inviting…" : phase === "failed" ? "Try again" : "Invite notetaker"}
      </button>
    </div>
  {/if}
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 20; background: rgba(0, 0, 0, 0.45); }
  .sheet { position: fixed; left: 50%; top: 96px; transform: translateX(-50%); z-index: 21; width: 400px; max-width: calc(100vw - 32px); padding: 16px; box-sizing: border-box; background: var(--overlay-bg); border: 1px solid var(--overlay-border); box-shadow: var(--overlay-shadow); border-radius: 8px; color: var(--t1); font: 400 13px/1.45 var(--font-ui, var(--font-sans)); }
  .hd { font-weight: 500; margin: 0 0 12px; }
  .field { width: 100%; height: 28px; padding: 0 8px; box-sizing: border-box; border: 1px solid var(--overlay-field-border); border-radius: 6px; background: var(--overlay-field-bg); color: var(--t1); font: inherit; font-size: 13px; }
  .line { margin: 8px 0 0; color: var(--t2); font-size: 13px; }
  .ft { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .btn { height: 28px; padding: 0 10px; border: 1px solid var(--panel-border, var(--line)); border-radius: 6px; background: transparent; color: var(--t1); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
  .btn:hover:not(:disabled) { background: var(--overlay-hover); }
  .btn.primary { border-color: transparent; background: var(--v4-primary-bg, var(--t1)); color: var(--v4-primary-fg, var(--side-bg)); }
  .btn:disabled, .btn.primary:disabled { border-color: var(--line); background: transparent; color: var(--t3); cursor: default; }
</style>
