<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  /**
   * First run with no company (console-rail US-016, scene home-first-run).
   * Static checklist; actions are callbacks the host already owns.
   */
  interface Props {
    name?: string;
    installCommand?: string;
    oncreate?: () => void;
    oninvite?: () => void;
    onlibrary?: () => void;
  }
  let {
    name = "there",
    installCommand = "curl -fsSL https://get.hq.sh | sh",
    oncreate,
    oninvite,
    onlibrary,
  }: Props = $props();

  let inviteOpen = $state(false);
  let inviteCode = $state("");
  let copied = $state(false);

  async function copyInstall(): Promise<void> {
    try {
      await navigator.clipboard.writeText(installCommand);
      copied = true;
    } catch {
      copied = false;
    }
  }

  function submitInvite(): void {
    const code = inviteCode.trim();
    if (!code) return;
    oninvite?.();
  }
</script>

<section class="welcome" id="welcome" data-testid="home-first-run">
  <header class="toolbar">
    <span class="hash" aria-hidden="true">#</span>
    <div class="crumb">
      <b>welcome</b>
      <span class="sub">Just you, for now</span>
    </div>
  </header>
  <div class="fr">
    <h2>Welcome to HQ, {name}</h2>
    <p class="lede">Three steps and your team is working in one place. Each one takes about a minute.</p>
    <ol class="steps">
      <li class="now">
        <span class="n">1</span>
        <div>
          <b>Create a company</b>
          <span class="d">A company is the boundary for people, files, bots, and secrets. You can join one you were invited to instead.</span>
          <div class="act">
            <button type="button" class="primary" data-testid="welcome-create" onclick={() => oncreate?.()}><RailIcon name="plus" />Create a company</button>
            <button type="button" data-testid="welcome-invite-code" title="Pastes an invite code; joins the company" onclick={() => (inviteOpen = !inviteOpen)}><RailIcon name="key" />I have an invite</button>
          </div>
          {#if inviteOpen}
            <form class="act" onsubmit={(e) => { e.preventDefault(); submitInvite(); }}>
              <input data-testid="welcome-invite-input" bind:value={inviteCode} placeholder="Invite code" aria-label="Invite code" />
              <button type="submit"><RailIcon name="arrow-right" />Join</button>
            </form>
          {/if}
        </div>
      </li>
      <li>
        <span class="n">2</span>
        <div>
          <b>Install the HQ CLI</b>
          <span class="d">Sync, secrets, and agent runs come from the CLI. Paste one line in Terminal; the app detects it when it is done.</span>
          <div class="act">
            <code>{installCommand}</code>
            <button type="button" data-testid="welcome-copy-cli" onclick={() => void copyInstall()}><RailIcon name="copy" />{copied ? "Copied" : "Copy"}</button>
          </div>
        </div>
      </li>
      <li>
        <span class="n">3</span>
        <div>
          <b>Invite a teammate</b>
          <span class="d">Invites are magic links that expire in 7 days. Members see only the folders you grant.</span>
          <div class="act">
            <button type="button" data-testid="welcome-invite-teammate" onclick={() => oninvite?.()}><RailIcon name="user-plus" />Invite a teammate</button>
          </div>
        </div>
      </li>
    </ol>
    <p class="foot">
      Prefer to look around first?
      <button type="button" class="text" data-testid="welcome-library" onclick={() => onlibrary?.()}>The Library tile on the left holds your personal files and vault.</button>
    </p>
  </div>
</section>

<style>
  .welcome {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    color: var(--v4-text-1);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 52px;
    padding: 0 16px;
    border-bottom: 1px solid var(--v4-rowline);
  }
  .hash { font-family: var(--font-mono); color: var(--v4-text-3); font-size: 15px; }
  .crumb b { font-size: 15px; font-weight: 600; }
  .sub { margin-left: 6px; font-size: 12px; color: var(--v4-text-3); }
  .fr { max-width: 640px; padding: 40px 28px 32px; }
  h2 { margin: 0; font-size: 20px; font-weight: 600; }
  .lede { margin: 8px 0 0; font-size: 13px; color: var(--v4-text-3); line-height: 1.5; }
  .steps { list-style: none; margin: 20px 0 0; padding: 0; display: flex; flex-direction: column; }
  .steps li {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    gap: 14px;
    padding: 16px 0;
    border-top: 1px solid var(--v4-rowline);
    color: var(--v4-text-3);
  }
  .steps li:last-child { border-bottom: 1px solid var(--v4-rowline); }
  .n {
    width: 24px; height: 24px; border-radius: 50%;
    display: grid; place-items: center;
    font-family: var(--font-mono); font-size: 11px;
    border: 1px solid var(--v4-control-border); color: var(--v4-text-3);
  }
  li.now .n { background: var(--ice); color: var(--ice-fg); border-color: transparent; }
  b { display: block; font-size: 14px; font-weight: 600; color: var(--v4-text-1); }
  .d { display: block; font-size: 13px; color: var(--v4-text-3); line-height: 1.5; margin-top: 2px; max-width: 52ch; }
  .act { display: flex; gap: 6px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  button, input {
    font: inherit;
    font-size: 13px;
    border-radius: 6px;
    border: 1px solid var(--v4-control-border);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    padding: 4px 10px;
  }
  button.primary { background: var(--ice); color: var(--ice-fg); border-color: transparent; }
  button.text { background: none; border: 0; padding: 0; color: var(--v4-text-3); text-align: left; cursor: pointer; }
  code {
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 4px 9px;
    border-radius: 6px;
    background: var(--v4-control-faint);
    border: 1px solid var(--v4-rowline);
    color: var(--v4-text-2);
  }
  .foot { font-size: 12px; color: var(--v4-text-3); margin-top: 20px; }
</style>
