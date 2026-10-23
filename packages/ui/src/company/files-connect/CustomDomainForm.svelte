<script lang="ts">
  import ReadLoader from "../../common/ReadLoader.svelte";
  import RailButton from "../../common/button/RailButton.svelte";
  import RailIcon from "../../common/button/RailIcon.svelte";
  /**
   * Custom domain for one deployment (hq-deploy-custom-domain-tiers US-007).
   * Owners and admins add a domain, see the DNS records to publish, check
   * status and remove it after a confirmation. Everyone else sees status only.
   * The price comes from `GET /v1/pricing`. A card-required refusal opens the
   * Stripe page the server offers (or a fresh card-entry Checkout).
   * Styling follows the Deploy access sheet (DeployAccessForm.svelte).
   */
  import {
    DOMAIN_PRICE_FALLBACK,
    appHostFrom,
    deployDomainClient,
    dnsRecordsFor,
    domainErrorCopy,
    domainInputProblem,
    domainStatusCopy,
    formatUsd,
    inputProblemCopy,
    isApexDomain,
    listWithRetry,
    LIST_RETRY_DELAYS_MS,
    normalizeDomainInput,
    type DeployDomainRequest,
    type DnsRecord,
    type DomainError,
    type DomainPrices,
    type DomainRecord,
  } from "./custom-domain.js";

  interface Props {
    appId: string;
    appName: string;
    /** The app's own URL; its host is the CNAME target. */
    appUrl: string;
    scope: string;
    request: DeployDomainRequest | null;
    /** Owner or admin of the company. False shows status only. */
    canManage: boolean;
    /** `usage.domains` from the pricing feed; null falls back to the contract copy. */
    loadPrices?: (() => Promise<DomainPrices | null>) | null;
    /** Mints a Stripe card-entry page for the company; null when it can't. */
    cardEntryUrl?: (() => Promise<string | null>) | null;
    openExternal?: (url: string) => void;
    onclose: () => void;
    /** Waits before each automatic retry of the domain list; tests pass zeros. */
    retryDelays?: readonly number[];
    ondone?: (message: string) => void;
  }

  let { appId, appName, appUrl, scope, request, canManage, loadPrices = null, cardEntryUrl = null, openExternal, onclose, ondone, retryDelays = LIST_RETRY_DELAYS_MS }: Props = $props();

  const client = $derived(request ? deployDomainClient(request, scope) : null);
  const appHost = $derived(appHostFrom(appUrl));

  let domains = $state<DomainRecord[] | null>(null);
  let records = $state<Record<string, DnsRecord[]>>({});
  let serving = $state<Record<string, boolean>>({});
  let certStatus = $state<Record<string, string>>({});
  let loadError = $state<string | null>(null);
  let actionError = $state<DomainError | null>(null);
  let prices = $state<DomainPrices>(DOMAIN_PRICE_FALLBACK);
  let entry = $state("");
  let busy = $state<"add" | "refresh" | "remove" | "card" | null>(null);
  let confirmRemove = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let copied = $state<string | null>(null);
  let attempt = $state(0);

  const price = $derived(`${formatUsd(prices.standardUsd)}/month`);
  const typed = $derived(normalizeDomainInput(entry));
  const problem = $derived(entry.trim() ? domainInputProblem(typed) : null);

  $effect(() => {
    void attempt;
    const c = client;
    const id = appId;
    domains = null;
    loadError = null;
    actionError = null;
    confirmRemove = null;
    if (!c) {
      loadError = "Custom domains need the desktop app.";
      return;
    }
    let live = true;
    void listWithRetry(c, id, retryDelays, () => live)
      .then((list) => {
        if (!live) return;
        domains = list;
        const next: Record<string, DnsRecord[]> = {};
        for (const d of list) next[d.domain] = dnsRecordsFor(d.domain, appHost, records[d.domain] ?? []);
        records = next;
      })
      .catch((err: unknown) => {
        if (live) loadError = domainErrorCopy(err, prices).message;
      });
    return () => {
      live = false;
    };
  });

  $effect(() => {
    const load = loadPrices;
    if (!load) return;
    let live = true;
    void load()
      .then((next) => {
        if (live && next) prices = next;
      })
      .catch((err: unknown) => console.warn("[custom-domain] pricing read failed", err));
    return () => {
      live = false;
    };
  });

  async function add(): Promise<void> {
    if (!client || busy || !typed || problem) return;
    busy = "add";
    actionError = null;
    notice = null;
    try {
      const result = await client.add(appId, typed);
      const d = result.domain;
      records = { ...records, [d.domain]: dnsRecordsFor(d.domain, appHost, result.instructions) };
      domains = [...(domains ?? []).filter((x) => x.domain !== d.domain), d];
      entry = "";
      ondone?.(`${d.domain} added to ${appName}. Publish the DNS records to finish.`);
    } catch (err) {
      actionError = domainErrorCopy(err, prices);
    } finally {
      busy = null;
    }
  }

  async function refresh(domain: string): Promise<void> {
    if (!client || busy) return;
    busy = "refresh";
    actionError = null;
    notice = null;
    try {
      const result = await client.refresh(appId, domain);
      serving = { ...serving, [domain]: result.serving };
      certStatus = { ...certStatus, [domain]: result.certStatus };
      domains = (domains ?? []).map((d) => (d.domain === domain ? { ...d, state: result.serving ? "validated" : result.state } : d));
      const known = records[domain] ?? [];
      records = { ...records, [domain]: dnsRecordsFor(domain, appHost, [...known, ...(Array.isArray(result.instructions) ? result.instructions : [])]) };
      notice = result.serving
        ? `${domain} is live.`
        : "Not live yet. DNS changes can take a few minutes to an hour. Check again later.";
    } catch (err) {
      actionError = domainErrorCopy(err, prices);
    } finally {
      busy = null;
    }
  }

  async function remove(domain: string): Promise<void> {
    if (!client || busy) return;
    busy = "remove";
    actionError = null;
    notice = null;
    try {
      const result = await client.remove(appId, domain);
      domains = (domains ?? []).filter((d) => d.domain !== domain);
      const { [domain]: _gone, ...rest } = records;
      records = rest;
      confirmRemove = null;
      ondone?.(result.warning ? `${domain} removed. Billing cleanup needs a follow-up from HQ support.` : `${domain} removed from ${appName}.`);
    } catch (err) {
      actionError = domainErrorCopy(err, prices);
    } finally {
      busy = null;
    }
  }

  async function addCard(): Promise<void> {
    if (busy) return;
    const offered = actionError?.billingUrl ?? null;
    busy = "card";
    try {
      const url = offered ?? (cardEntryUrl ? await cardEntryUrl() : null);
      if (url) {
        openExternal?.(url);
        notice = "Finish adding the card in your browser, then add the domain again.";
      } else {
        notice = "Only the company owner can add a card. Ask them to add one in Settings › Billing.";
      }
    } catch (err) {
      console.warn("[custom-domain] card entry failed", err);
      notice = "Couldn't open the card page. Ask the company owner to add a card in Settings › Billing.";
    } finally {
      busy = null;
    }
  }

  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(value);
      copied = value;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = null), 2000);
    } catch (err) {
      console.warn("[custom-domain] copy failed", err);
    }
  }

  function status(d: DomainRecord): string {
    return domainStatusCopy(d, serving[d.domain] === true, certStatus[d.domain] ?? "");
  }
  const isLive = (d: DomainRecord) => serving[d.domain] === true || d.state === "validated";
</script>

<div class="sb" data-testid="custom-domain-form">
  <div class="fr"><span class="lb">Deployment</span><span>{appName}</span></div>
  {#if loadError}
    <p class="hint note" role="status" data-testid="custom-domain-error">{loadError}</p>
    {#if client}<div class="retry"><RailButton icon="refresh" data-testid="custom-domain-retry" onclick={() => (attempt += 1)}>Try again</RailButton></div>{/if}
  {:else if domains === null}
    <div class="loading" aria-busy="true" data-testid="custom-domain-loading">
      <ReadLoader testid="custom-domain-loader" onretry={client ? () => (attempt += 1) : null} />
    </div>
  {:else}
    {#each domains as d (d.domain)}
      <div class="domain" data-testid="custom-domain-row" data-domain={d.domain}>
        <div class="fr">
          <span class="lb">Domain</span>
          <span class="dline">
            <span class="mono">{d.domain}</span>
            <span class="st" class:live={isLive(d)} data-testid="custom-domain-status">{status(d)}</span>
          </span>
        </div>
        {#if canManage && confirmRemove === d.domain}
          <div class="confirm" data-testid="custom-domain-confirm">
            <p class="sec">Remove {d.domain}?</p>
            <p class="hint flat">Visitors to {d.domain} will stop reaching {appName}, and the {price} charge stops. {appHost ? `${appHost} keeps working.` : ""}</p>
            <div class="row-actions">
              <RailButton icon="arrow-left" disabled={busy === "remove"} onclick={() => (confirmRemove = null)}>Back</RailButton>
              <RailButton icon="trash" variant="danger" data-testid="custom-domain-remove-confirm" disabled={busy === "remove"} aria-busy={busy === "remove"} onclick={() => void remove(d.domain)}>{busy === "remove" ? "Removing…" : "Remove domain"}</RailButton>
            </div>
          </div>
        {:else if canManage}
          {#if !isLive(d)}
            <div class="dns" data-testid="custom-domain-dns">
              <p class="hint flat">Add {(records[d.domain] ?? []).length === 1 ? "this record" : "these records"} at the company that hosts DNS for {d.domain}:</p>
              <div class="grid" role="table" aria-label={`DNS records for ${d.domain}`}>
                <div class="gh" role="row"><span role="columnheader">Type</span><span role="columnheader">Name</span><span role="columnheader">Value</span><span></span></div>
                {#each records[d.domain] ?? [] as r (r.name)}
                  <div class="gr" role="row" data-testid={`custom-domain-record-${r.purpose}`}>
                    <span role="cell">{r.type}</span>
                    <span role="cell" class="mono">{r.name}</span>
                    <span role="cell" class="mono">{r.value}</span>
                    <button data-icon-only class="copy" type="button" data-testid="custom-domain-copy" aria-label={copied === r.value ? "Copied" : `Copy ${r.purpose === "routing" ? "target" : "value"}`} title={copied === r.value ? "Copied" : "Copy"} onclick={() => void copy(r.value)}><RailIcon name={copied === r.value ? "check" : "copy"} /></button>
                  </div>
                  <p class="why">{r.purpose === "ownership" ? "Proves you own the domain so HQ can issue its certificate." : "Sends visitors to this deployment."}</p>
                {/each}
              </div>
              {#if isApexDomain(d.domain)}
                <p class="hint flat apex" data-testid="custom-domain-apex">
                  {d.domain} is a root domain. Most DNS hosts don't allow a CNAME there. If yours offers an ALIAS, ANAME or CNAME-flattening record (Cloudflare, Route 53, DNSimple and others do), use it to point {d.domain} at {appHost}. Otherwise use a subdomain such as www.{d.domain}.
                </p>
              {/if}
            </div>
          {/if}
          <div class="row-actions">
            {#if !isLive(d)}<RailButton icon="refresh" data-testid="custom-domain-refresh" disabled={busy !== null} aria-busy={busy === "refresh"} onclick={() => void refresh(d.domain)}>{busy === "refresh" ? "Checking…" : "Check again"}</RailButton>{/if}
            {#if isLive(d)}<RailButton icon="external" onclick={() => openExternal?.(`https://${d.domain}`)}>Open</RailButton>{/if}
            <RailButton icon="trash" data-testid="custom-domain-remove" disabled={busy !== null} onclick={() => { confirmRemove = d.domain; actionError = null; notice = null; }}>Remove</RailButton>
          </div>
        {/if}
      </div>
    {/each}

    {#if canManage && domains.length === 0}
      <label class="fr">
        <span class="lb">Your domain</span>
        <input
          class="field mono"
          type="text"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="app.example.com"
          data-testid="custom-domain-input"
          bind:value={entry}
          onkeydown={(e) => e.key === "Enter" && void add()}
        />
      </label>
      {#if problem && problem !== "empty"}<p class="hint" data-testid="custom-domain-input-problem">{inputProblemCopy(problem)}</p>{/if}
      <p class="hint" data-testid="custom-domain-price">{price} for this deployment, billed to the company. Remove it any time to stop the charge. A subdomain such as app.example.com is easiest to set up.</p>
    {:else if !canManage && domains.length === 0}
      <p class="hint" data-testid="custom-domain-member-empty">No custom domain yet. A company owner or admin can add one for {price}.</p>
    {:else if !canManage}
      <p class="hint" data-testid="custom-domain-member-note">Only a company owner or admin can change custom domains.</p>
    {/if}
  {/if}

  {#if actionError}
    <div class="hint note" role="status" data-testid={`custom-domain-refusal-${actionError.kind}`}>
      <p class="flat">{actionError.message}</p>
      {#if actionError.kind === "card"}
        <div class="row-actions"><RailButton icon="credit-card" data-testid="custom-domain-add-card" disabled={busy === "card"} aria-busy={busy === "card"} onclick={() => void addCard()}>{busy === "card" ? "Opening…" : "Set up billing"}</RailButton></div>
      {/if}
    </div>
  {/if}
  {#if notice}<p class="hint" role="status" data-testid="custom-domain-notice">{notice}</p>{/if}
</div>
<footer class="sf">
  <span class="hint grow"></span>
  <RailButton icon="x" onclick={onclose}>Close</RailButton>
  {#if canManage && domains !== null && domains.length === 0}
    <RailButton icon="plus" variant="primary" data-testid="custom-domain-add" disabled={!typed || problem !== null || busy !== null} aria-busy={busy === "add"} onclick={() => void add()}>{busy === "add" ? "Adding…" : "Add domain"}</RailButton>
  {/if}
</footer>

<style>
  /* Deploy access sheet metrics (DeployAccessForm.svelte); 13px only. */
  .sb { overflow: auto; }
  .fr { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; align-items: center; min-height: 28px; padding: 10px 20px; border-bottom: 1px solid var(--panel-border, var(--v4-rowline)); }
  .lb { color: var(--t3, var(--v4-text-3)); }
  .hint { margin: 0; padding: 10px 20px; color: var(--t3, var(--v4-text-3)); }
  .hint.flat, .flat { margin: 0; padding: 0; }
  /* Recoverable states (a refusal, a read that can be retried) are neutral, not red. */
  .hint.note { color: var(--t2, var(--v4-text-2)); display: flex; flex-direction: column; gap: 8px; }
  .retry { display: flex; padding: 0 20px 10px; }
  .sf { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--panel-border, var(--v4-hairline)); }
  .sf .hint { padding: 0; }
  .grow { flex: 1; }
  .field { height: 28px; border-radius: 6px; border: 1px solid var(--line2, var(--v4-control-border)); background: transparent; color: inherit; padding: 0 8px; min-width: 0; }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
  .loading { padding: 6px 12px; }
  .domain { border-bottom: 1px solid var(--panel-border, var(--v4-rowline)); }
  .domain .fr { border-bottom: 0; }
  .dline { display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; }
  .st { color: var(--t3, var(--v4-text-3)); }
  .st.live { color: var(--ok-ink, var(--t1)); }
  .dns { display: flex; flex-direction: column; gap: 8px; padding: 0 20px 10px; }
  .grid { display: grid; grid-template-columns: 56px minmax(0, 1fr) minmax(0, 1.4fr) auto; gap: 4px 10px; align-items: start; }
  .gh, .gr { display: contents; }
  .gh span { color: var(--t3, var(--v4-text-3)); }
  .why { grid-column: 2 / -1; margin: -2px 0 6px; color: var(--t3, var(--v4-text-3)); }
  .copy { display: inline-grid; place-items: center; width: 24px; height: 24px; border: 0; border-radius: 6px; padding: 0; background: transparent; color: var(--t2, var(--v4-text-2)); cursor: pointer; }
  .copy:hover { background: var(--hover, var(--v4-hover)); color: var(--t1, var(--v4-text-1)); }
  .copy:focus-visible { outline: 2px solid var(--v4-focus, currentColor); outline-offset: 2px; border-radius: 3px; }
  .apex { color: var(--t2, var(--v4-text-2)); }
  .row-actions { display: flex; gap: 8px; padding: 0 20px 10px; }
  .hint.note .row-actions, .confirm .row-actions { padding: 0; }
  .confirm { display: flex; flex-direction: column; gap: 8px; padding: 0 20px 10px; }
  .confirm .sec { margin: 0; font-weight: 500; }
</style>
