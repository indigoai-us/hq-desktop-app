<script lang="ts">
  /**
   * New company sheet (US-037). Step 1 is name, slug, and plan. Step 2 pins
   * the rail tile, queues invites, and names an optional first project.
   * The frame is on screen before any network call returns.
   */
  import {
    NEW_COMPANY_PLANS,
    PROJECT_TEMPLATES,
    companyInitials,
    companySlugFromName,
    parseInviteEmails,
    pinnedIdsAfterFinish,
    projectSlugFromName,
    railPreview,
    stepOneEffects,
    type NewCompanyPlan,
    type ProjectTemplate,
  } from "./new-company.js";

  interface Created {
    companyUid: string | null;
  }

  interface Props {
    pinnedInitials?: readonly string[];
    pinnedIds?: readonly string[];
    onclose?: () => void;
    oncheckout?: (url: string) => void;
    oncreate?: (input: {
      name: string;
      slug: string;
      plan: NewCompanyPlan;
      invites: string[];
    }) => Promise<{ ok: true; companyUid: string | null } | { ok: false; reason: string }>;
    onfinish?: (result: {
      companyUid: string | null;
      name: string;
      slug: string;
      pin: boolean;
      pinnedIds: string[];
      invites: string[];
      projectSlug: string | null;
      template: ProjectTemplate;
    }) => void;
  }

  let {
    pinnedInitials = [],
    pinnedIds = [],
    onclose,
    oncheckout,
    oncreate,
    onfinish,
  }: Props = $props();

  let step = $state<1 | 2>(1);
  let name = $state("");
  let plan = $state<NewCompanyPlan>("free");
  let inviteRaw = $state("");
  let invites = $state<string[]>([]);
  let pin = $state(true);
  let projectName = $state("");
  let template = $state<ProjectTemplate>("blank");
  let error = $state<string | null>(null);
  let busy = $state(false);
  let created = $state<Created | null>(null);
  let checkoutOpened = $state(false);

  const slug = $derived(companySlugFromName(name));
  const initials = $derived(companyInitials(name || "New"));
  const preview = $derived(railPreview(pinnedInitials, initials, pin));
  const projectSlug = $derived(projectSlugFromName(projectName));
  const pinIndex = $derived(
    pin ? Math.min(pinnedInitials.length, 5) + 1 : pinnedInitials.length,
  );

  function addInvites(): void {
    const next = parseInviteEmails(inviteRaw);
    if (next.length === 0) return;
    const seen = new Set(invites);
    invites = [...invites, ...next.filter((email) => !seen.has(email))];
    inviteRaw = "";
  }

  function removeInvite(email: string): void {
    invites = invites.filter((row) => row !== email);
  }

  async function continueStep(): Promise<void> {
    if (!slug || busy) return;
    error = null;
    const effects = stepOneEffects(plan);
    // Destination frame first: step 2 is on screen this turn.
    step = 2;
    if (effects.checkoutUrl) {
      checkoutOpened = true;
      oncheckout?.(effects.checkoutUrl);
      return;
    }
    if (!effects.createNow || !oncreate) return;
    busy = true;
    const result = await oncreate({ name: name.trim(), slug, plan, invites: [] });
    busy = false;
    if (!result.ok) {
      step = 1;
      error = result.reason;
      return;
    }
    created = { companyUid: result.companyUid };
  }

  async function finish(skip: boolean): Promise<void> {
    if (busy) return;
    error = null;
    let companyUid = created?.companyUid ?? null;
    if (!skip && !created && oncreate) {
      busy = true;
      const result = await oncreate({
        name: name.trim(),
        slug,
        plan,
        invites: [],
      });
      busy = false;
      if (!result.ok) {
        error = result.reason;
        return;
      }
      companyUid = result.companyUid;
      created = { companyUid };
    }
    const nextPins = pinnedIdsAfterFinish(pinnedIds, companyUid, !skip && pin);
    onfinish?.({
      companyUid,
      name: name.trim(),
      slug,
      pin: !skip && pin && nextPins.includes(companyUid ?? ""),
      pinnedIds: nextPins,
      invites: skip ? [] : invites,
      projectSlug: skip ? null : projectSlug,
      template,
    });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose?.();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<button type="button" class="scrim" aria-label="Close" data-testid="new-company-scrim" onclick={() => onclose?.()}></button>
<div class="sheet" role="dialog" aria-label={step === 1 ? "New company" : `Set up ${name || "company"}`} data-testid="new-company-sheet">
  <header class="sh">
    {#if step === 1}
      New company
      <span class="sub">from More companies</span>
    {:else}
      Set up {name || "company"}
      <span class="sub">{checkoutOpened ? "step 2 of 2 · checkout opened" : "step 2 of 2"}</span>
    {/if}
    <span class="grow"></span>
    <button type="button" class="icon" aria-label="Close" onclick={() => onclose?.()}>✕</button>
  </header>

  <div class="sb" data-testid="new-company-body">
    {#if step === 1}
      <div class="fr">
        <div class="lb">Name</div>
        <input class="search" data-testid="new-company-name" bind:value={name} placeholder="Company name" />
      </div>
      <div class="fr">
        <div class="lb">Slug</div>
        <div>
          <div class="search mono" data-testid="new-company-slug">{slug || "—"}</div>
          <p class="hint">Vault path <span class="mono">companies/{slug || "…"}</span></p>
        </div>
      </div>
      <div class="fr">
        <div class="lb">Plan</div>
        <div>
          {#each NEW_COMPANY_PLANS as option (option.id)}
            <button
              type="button"
              class="opt"
              role="radio"
              aria-checked={plan === option.id}
              data-testid="new-company-plan-{option.id}"
              onclick={() => (plan = option.id)}
            >
              <i></i>
              <span>
                <b>{option.title}</b>
                <span class="m">{option.detail}</span>
              </span>
            </button>
          {/each}
          <p class="hint">Workforce continues to Stripe checkout in your browser after this step.</p>
        </div>
      </div>
      <div class="fr">
        <div class="lb">Invite teammates</div>
        <div>
          <div class="chips">
            {#each invites as email (email)}
              <span class="chip">{email}<button type="button" class="x" aria-label="Remove {email}" onclick={() => removeInvite(email)}>✕</button></span>
            {/each}
          </div>
          <input
            class="search"
            data-testid="new-company-invites"
            placeholder="Add emails, comma separated…"
            bind:value={inviteRaw}
            onkeydown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addInvites();
              }
            }}
            onblur={addInvites}
          />
          <p class="hint">Invited as Members. Sent when you finish.</p>
        </div>
      </div>
    {:else}
      <div class="fr">
        <div class="lb">Created</div>
        <div class="ncs-done" data-testid="new-company-created">
          <span class="mark">{initials}</span>
          <div>
            <b>{name}</b>
            <p class="hint">{plan === "workforce" ? "HQ Workforce" : "Free"} · {slug}</p>
          </div>
          {#if busy}
            <span class="shimmer" data-testid="new-company-shimmer"></span>
          {:else}
            <span class="chip">Owner · you</span>
          {/if}
        </div>
      </div>
      <div class="fr">
        <div class="lb">Pin to rail</div>
        <div>
          <div class="inl">
            <button
              type="button"
              class="tog"
              class:on={pin}
              role="switch"
              aria-checked={pin}
              aria-label="Pin to rail"
              data-testid="new-company-pin"
              onclick={() => (pin = !pin)}
            ></button>
            <span>Show a tile in the rail</span>
          </div>
          <div class="ncs-rail" data-testid="new-company-rail">
            {#each preview as slot, index (index)}
              <span class="ncs-tile {slot.kind}">{slot.initials}</span>
            {/each}
          </div>
          <p class="hint">Tile {pinIndex} of 6 · this device only. Unpin any time from More companies.</p>
        </div>
      </div>
      <div class="fr">
        <div class="lb">Invite teammates</div>
        <div>
          <div class="chips">
            {#each invites as email (email)}
              <span class="chip">{email}<button type="button" class="x" aria-label="Remove {email}" onclick={() => removeInvite(email)}>✕</button></span>
            {/each}
          </div>
          <input
            class="search"
            placeholder="Add emails, comma separated…"
            bind:value={inviteRaw}
            onkeydown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addInvites();
              }
            }}
            onblur={addInvites}
          />
          <p class="hint">{invites.length} invite{invites.length === 1 ? "" : "s"} queued as Members. Sent when you finish.</p>
        </div>
      </div>
      <div class="fr">
        <div class="lb">First project</div>
        <div>
          <input class="search mono" data-testid="new-company-project" bind:value={projectName} placeholder="project-slug" />
          <p class="hint">Creates <span class="mono">companies/{slug}/projects/{projectSlug ?? "…"}</span></p>
          <div class="tabs">
            {#each PROJECT_TEMPLATES as item (item)}
              <button type="button" class="tab" role="tab" aria-selected={template === item} onclick={() => (template = item)}>
                {item === "blank" ? "Blank" : item === "brainstorm" ? "Brainstorm" : "PRD"}
              </button>
            {/each}
          </div>
          <p class="hint">Optional. Skip to land on an empty Atlas.</p>
        </div>
      </div>
    {/if}
  </div>

  <footer class="sf">
    <span class="hint" data-testid="new-company-status">
      {#if error}
        {error}
      {:else if step === 1}
        Step 1 of 2{plan === "workforce" ? " · checkout opens next" : ""}
      {:else}
        Finish pins the tile{invites.length ? `, sends ${invites.length} invite${invites.length === 1 ? "" : "s"}` : ""}{projectSlug ? `, and creates ${projectSlug}` : ""}
      {/if}
    </span>
    {#if step === 1}
      <button type="button" class="btn" onclick={() => onclose?.()}>Cancel</button>
      <button
        type="button"
        class="btn primary"
        data-testid="new-company-continue"
        disabled={!slug}
        onclick={() => void continueStep()}
      >Create and continue</button>
    {:else}
      <button type="button" class="btn" data-testid="new-company-skip" onclick={() => void finish(true)}>Skip for now</button>
      <button type="button" class="btn primary" data-testid="new-company-finish" onclick={() => void finish(false)}>Finish</button>
    {/if}
  </footer>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); border: 0; z-index: 70; }
  .sheet {
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(480px, calc(100vw - 32px)); max-height: calc(100% - 40px);
    display: flex; flex-direction: column; overflow: hidden; z-index: 71;
    background: var(--overlay-bg); border: 1px solid var(--overlay-border);
    border-radius: 8px; color: var(--v4-text-1);
    box-shadow: var(--v4-shadow-popover, none);
  }
  .sh {
    height: 52px; flex: none; display: flex; align-items: center; gap: 8px;
    padding: 0 10px 0 20px; border-bottom: 1px solid var(--v4-hairline);
    font-size: 15px; font-weight: 600;
  }
  .sub { font-size: 12px; font-weight: 400; color: var(--v4-text-3); margin: 0; }
  .grow { flex: 1; }
  .icon { border: 0; background: transparent; color: var(--v4-text-3); cursor: pointer; }
  .sb { overflow: auto; min-height: 0; }
  .fr {
    display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px;
    align-items: start; padding: 10px 20px; border-bottom: 1px solid var(--v4-rowline);
  }
  .fr:last-child { border-bottom: 0; }
  .lb { font-size: 12px; color: var(--v4-text-3); padding-top: 6px; }
  .search {
    width: 100%; height: 28px; box-sizing: border-box; color: var(--v4-text-1);
    font-size: 13px; background: transparent;
    border: 1px solid var(--v4-control-border); border-radius: 6px; padding: 0 10px;
  }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
  .hint { font-size: 12px; color: var(--v4-text-3); margin: 5px 0 0; line-height: 1.4; }
  .opt {
    display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 8px;
    align-items: start; padding: 8px 10px; width: 100%; text-align: left;
    border: 1px solid var(--v4-control-border); border-radius: 6px;
    background: var(--v4-control-faint, transparent); color: var(--v4-text-2);
    font-size: 13px; cursor: pointer;
  }
  .opt + .opt { margin-top: 6px; }
  .opt i {
    width: 12px; height: 12px; border-radius: 50%; border: 1px solid var(--v4-text-3); margin-top: 3px;
  }
  .opt[aria-checked="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .opt[aria-checked="true"] i { border: 4px solid var(--v4-text-1); }
  .opt b { font-weight: 500; color: var(--v4-text-1); }
  .m { display: block; font-size: 12px; color: var(--v4-text-3); margin-top: 2px; }
  .chips { display: flex; gap: 4px; flex-wrap: wrap; }
  .chip {
    height: 22px; display: inline-flex; align-items: center; gap: 4px;
    font-size: 12px; color: var(--v4-text-1); background: var(--v4-control-bg, transparent);
    border: 1px solid var(--v4-control-border); border-radius: 6px; padding: 0 6px;
  }
  .x { border: 0; background: transparent; color: var(--v4-text-3); cursor: pointer; }
  .inl { display: flex; align-items: center; gap: 6px; min-height: 28px; font-size: 13px; }
  .tog {
    width: 30px; height: 18px; border-radius: 9px; border: 1px solid var(--v4-control-border);
    background: var(--v4-control-bg, transparent); position: relative; padding: 0; flex: none; cursor: pointer;
  }
  .tog::after {
    content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
    border-radius: 50%; background: var(--v4-text-3);
  }
  .tog.on { background: var(--v4-text-1); border-color: transparent; }
  .tog.on::after { left: 14px; background: var(--overlay-bg); }
  .ncs-done {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center;
    padding: 8px 10px; border: 1px solid var(--v4-control-border); border-radius: 6px;
    background: var(--v4-control-faint, transparent); font-size: 13px;
  }
  .mark {
    width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
    font-size: 10px; font-weight: 600; background: var(--v4-control-border); color: var(--v4-text-1);
  }
  .ncs-rail {
    display: flex; gap: 6px; margin-top: 8px; padding: 6px; border-radius: 8px;
    background: var(--v4-sidebar, transparent); border: 1px solid var(--v4-rowline); width: max-content;
  }
  .ncs-tile {
    width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
    font-size: 10px; font-weight: 600; background: var(--v4-control-border); color: var(--v4-text-2);
  }
  .ncs-tile.new { background: var(--v4-active-row); color: var(--v4-text-1); }
  .ncs-tile.empty { background: transparent; border: 1px dashed var(--v4-control-border); }
  .tabs {
    display: flex; gap: 0; width: max-content; margin-top: 6px; padding: 2px; border-radius: 6px;
    background: var(--v4-control-faint, transparent); border: 1px solid var(--v4-control-border);
  }
  .tab {
    border: 0; background: transparent; color: var(--v4-text-2); font: inherit; font-size: 12px;
    padding: 4px 8px; border-radius: 4px; cursor: pointer;
  }
  .tab[aria-selected="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .shimmer {
    width: 72px; height: 14px; border-radius: 4px;
    background: linear-gradient(90deg, var(--v4-control-faint, transparent), var(--v4-active-row), var(--v4-control-faint, transparent));
  }
  .sf {
    flex: none; display: flex; align-items: center; gap: 8px;
    padding: 12px 20px; border-top: 1px solid var(--v4-hairline);
  }
  .sf .hint { flex: 1; margin: 0; }
  .btn {
    border: 1px solid var(--v4-control-border); background: transparent; color: var(--v4-text-1);
    border-radius: 6px; padding: 6px 10px; font: inherit; font-size: 13px; cursor: pointer;
  }
  .btn.primary { background: var(--v4-text-1); color: var(--overlay-bg); }
  .btn:disabled { opacity: 0.45; }
</style>
