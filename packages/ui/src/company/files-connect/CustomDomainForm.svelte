<script lang="ts">
  import ReadLoader from "../../common/ReadLoader.svelte";
  import RailButton from "../../common/button/RailButton.svelte";
  import RailIcon from "../../common/button/RailIcon.svelte";
  /**
   * Custom domain for one deployment (hq-deploy-custom-domain-tiers US-007).
   * Owners and admins add a domain, see the DNS records to publish, check
   * status and remove it after a confirmation. Everyone else sees status only.
   * The price is the company's own (hq-pro #5202), else `GET /v1/pricing`. A card-required refusal opens the
   * Stripe page the server offers (or a fresh card-entry Checkout).
   * Styling follows the Deploy access sheet (DeployAccessForm.svelte).
   */
  import {
    DOMAIN_PRICE_FALLBACK,
    appHostFrom,
    awaitOwnershipRecord,
    companyDomainPriceFrom,
    deployDomainClient,
    dnsRecordsFor,
    domainErrorCopy,
    domainMonthlyUsd,
    domainPriceLine,
    domainInputProblem,
    domainStatus,
    formatUsd,
    hostSegments,
    inputProblemCopy,
    listWithRetry,
    LIST_RETRY_DELAYS_MS,
    normalizeDomainInput,
    RECORD_RETRY_DELAYS_MS,
    type DeployDomainRequest,
    type CompanyDomainPrice,
    type DnsRecord,
    type DomainError,
    type DomainPrices,
    type DomainRecord,
    type RefreshResult,
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
    /**
     * This company's own price (hq-pro #5202's body). Null, a missing route or a
     * failed read falls back to the catalog price; it never reads as "included".
     */
    loadCompanyPrice?: (() => Promise<unknown>) | null;
    /** The company's name for the price line; empty reads "the company". */
    companyName?: string;
    /** Mints a Stripe card-entry page for the company; null when it can't. */
    cardEntryUrl?: (() => Promise<string | null>) | null;
    openExternal?: (url: string) => void;
    onclose: () => void;
    /** Waits before each automatic retry of the domain list; tests pass zeros. */
    retryDelays?: readonly number[];
    /** Waits between the reads that fetch a certificate record ACM has not made yet; tests pass zeros. */
    recordDelays?: readonly number[];
    ondone?: (message: string) => void;
    /** A domain went live or was removed, so the deployment's address changed. */
    onchange?: () => void;
  }

  let { appId, appName, appUrl, scope, request, canManage, loadPrices = null, loadCompanyPrice = null, companyName = "", cardEntryUrl = null, openExternal, onclose, ondone, onchange, retryDelays = LIST_RETRY_DELAYS_MS, recordDelays = RECORD_RETRY_DELAYS_MS }: Props = $props();

  const client = $derived(request ? deployDomainClient(request, scope) : null);
  const appHost = $derived(appHostFrom(appUrl));

  let domains = $state<DomainRecord[] | null>(null);
  let records = $state<Record<string, DnsRecord[]>>({});
  let serving = $state<Record<string, boolean>>({});
  let certStatus = $state<Record<string, string>>({});
  let loadError = $state<string | null>(null);
  let actionError = $state<DomainError | null>(null);
  let prices = $state<DomainPrices>(DOMAIN_PRICE_FALLBACK);
  let companyPrice = $state<CompanyDomainPrice | null>(null);
  /** The price an add reply reported for this company (hq-deploy #260); it wins over the reads. */
  let addedPriceUsd = $state<number | null>(null);
  let entry = $state("");
  let busy = $state<"add" | "refresh" | "remove" | "card" | null>(null);
  let confirmRemove = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let copied = $state<string | null>(null);
  let attempt = $state(0);
  /** Domains whose certificate record is still being fetched; their DNS records show together once it arrives. */
  let preparing = $state<Record<string, boolean>>({});
  /** Bumped on every load and on close, so a fetch for an earlier load stops writing. */
  let loadToken = 0;

  const monthlyUsd = $derived(addedPriceUsd ?? domainMonthlyUsd(companyPrice, prices));
  const price = $derived(`${formatUsd(monthlyUsd)}/month`);
  /** Prices for refusal copy: the catalog's, with this company's own monthly amount. */
  const effectivePrices = $derived<DomainPrices>({ ...prices, standardUsd: monthlyUsd });
  const priceLine = $derived(domainPriceLine(companyPrice, prices, companyName));
  const addDisabledByPlan = $derived(companyPrice?.basis === "not_enabled");
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
    const token = ++loadToken;
    const live = () => token === loadToken;
    void listWithRetry(c, id, retryDelays, live)
      .then((list) => {
        if (!live()) return;
        domains = list;
        const next: Record<string, DnsRecord[]> = {};
        for (const d of list) next[d.domain] = dnsRecordsFor(d.domain, appHost, records[d.domain] ?? []);
        records = next;
        // The list carries no DNS records, so fetch both before showing them.
        if (canManage) for (const d of list) if (d.state !== "validated") void prepareRecords(d.domain, [], live);
      })
      .catch((err: unknown) => {
        if (live()) loadError = domainErrorCopy(err, effectivePrices).message;
      });
    return () => {
      loadToken += 1;
    };
  });

  function applyRefresh(domain: string, result: RefreshResult): void {
    serving = { ...serving, [domain]: result.serving };
    certStatus = { ...certStatus, [domain]: result.certStatus };
    domains = (domains ?? []).map((d) => (d.domain === domain ? { ...d, state: result.serving ? "validated" : result.state } : d));
    if (result.serving) onchange?.();
  }

  /** Show a pending domain's DNS records only once the certificate record is among them. */
  async function prepareRecords(domain: string, known: unknown, stillWanted: () => boolean): Promise<void> {
    const c = client;
    if (!c) return;
    preparing = { ...preparing, [domain]: true };
    try {
      const { instructions, last } = await awaitOwnershipRecord(c, appId, domain, known, recordDelays, stillWanted);
      if (!stillWanted()) return;
      records = { ...records, [domain]: dnsRecordsFor(domain, appHost, instructions) };
      if (last) applyRefresh(domain, last);
    } finally {
      const { [domain]: _done, ...rest } = preparing;
      preparing = rest;
    }
  }

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

  $effect(() => {
    const load = loadCompanyPrice;
    if (!load) return;
    let live = true;
    void load()
      .then((body) => {
        if (live) companyPrice = companyDomainPriceFrom(body);
      })
      .catch((err: unknown) => console.warn("[custom-domain] company price read failed", err));
    return () => {
      live = false;
    };
  });

  async function add(): Promise<void> {
    if (!client || busy || !typed || problem || addDisabledByPlan) return;
    busy = "add";
    actionError = null;
    notice = null;
    try {
      const result = await client.add(appId, typed);
      const d = result.domain;
      if (result.monthlyPriceUsd !== undefined) addedPriceUsd = result.monthlyPriceUsd;
      records = { ...records, [d.domain]: dnsRecordsFor(d.domain, appHost, result.instructions) };
      domains = [...(domains ?? []).filter((x) => x.domain !== d.domain), d];
      entry = "";
      ondone?.(`${d.domain} added to ${appName}. Publish the DNS records to finish.`);
      const token = loadToken;
      if (d.state !== "validated") void prepareRecords(d.domain, result.instructions, () => token === loadToken);
    } catch (err) {
      actionError = domainErrorCopy(err, effectivePrices);
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
      applyRefresh(domain, result);
      const known = records[domain] ?? [];
      records = { ...records, [domain]: dnsRecordsFor(domain, appHost, [...known, ...(Array.isArray(result.instructions) ? result.instructions : [])]) };
      notice = result.serving
        ? `${domain} is live.`
        : "Not live yet. DNS changes can take a few minutes to an hour. Check again later.";
    } catch (err) {
      actionError = domainErrorCopy(err, effectivePrices);
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
      onchange?.();
      ondone?.(result.warning ? `${domain} removed. Billing cleanup needs a follow-up from HQ support.` : `${domain} removed from ${appName}.`);
    } catch (err) {
      actionError = domainErrorCopy(err, effectivePrices);
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

  function status(d: DomainRecord) {
    return domainStatus(d, serving[d.domain] === true, certStatus[d.domain] ?? "", busy === "refresh");
  }
  const recordTitle = (r: DnsRecord) => (r.purpose === "ownership" ? "Certificate record" : "Website record");
  const recordWhy = (r: DnsRecord, domain: string) =>
    r.purpose === "ownership"
      ? `Lets HQ confirm you own ${domain} and set up its secure (https) certificate.`
      : `Sends people who visit ${domain} to ${appName}.`;
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
        <div class="head">
          <span class="mono name">{d.domain}</span>
          <span class="chip" data-tone={status(d).tone} data-testid="custom-domain-status"><i class="dot" aria-hidden="true"></i>{status(d).label}</span>
        </div>
        {#if canManage && confirmRemove === d.domain}
          <div class="confirm" data-testid="custom-domain-confirm">
            <p class="sec">Remove {d.domain}?</p>
            <p class="flat body">Visitors to {d.domain} will stop reaching {appName}, {monthlyUsd > 0 ? `and the ${price} charge stops.` : "and nothing is charged for it now."} {appHost ? `${appHost} keeps working.` : ""}</p>
            <div class="row-actions">
              <RailButton icon="arrow-left" disabled={busy === "remove"} onclick={() => (confirmRemove = null)}>Back</RailButton>
              <RailButton icon="trash" variant="danger" data-testid="custom-domain-remove-confirm" disabled={busy === "remove"} aria-busy={busy === "remove"} onclick={() => void remove(d.domain)}>{busy === "remove" ? "Removing…" : "Remove domain"}</RailButton>
            </div>
          </div>
        {:else if canManage}
          {#if !isLive(d)}
            <div class="dns" data-testid="custom-domain-dns">
              {#if preparing[d.domain]}
                <p class="hint flat" role="status" data-testid="custom-domain-records-loading">Getting the DNS records for {d.domain}…</p>
              {:else}
                {#if status(d).tone === "verifying" && busy !== "refresh"}
                  <p class="lead" data-testid="custom-domain-verifying">HQ found your records and is finishing setup. This usually takes a few minutes. Keep the records in place.</p>
                {:else}
                  <p class="lead">Add {(records[d.domain] ?? []).length === 1 ? "this record" : `these ${(records[d.domain] ?? []).length} records`} where you manage DNS for {d.domain}, usually the site where you bought it. Then choose Check again.</p>
                {/if}
                {#each records[d.domain] ?? [] as r, i (r.name)}
                  <section class="rec" aria-label={recordTitle(r)} data-testid={`custom-domain-record-${r.purpose}`}>
                    <header class="rh">
                      <span class="num" aria-hidden="true">{i + 1}</span>
                      <span class="rt">{recordTitle(r)}</span>
                      <span class="type" title="Record type">{r.type}</span>
                    </header>
                    <p class="why">{recordWhy(r, d.domain)}</p>
                    <dl class="kv">
                      {#each [["Name", r.name], ["Value", r.value]] as [label, text] (label)}
                        <dt>{label}</dt>
                        <dd class="mono" title={text}>{#each hostSegments(text) as part, j (j)}<span class="seg">{part}</span><wbr />{/each}</dd>
                        <button
                          data-icon-only
                          class="copy"
                          type="button"
                          data-testid={label === "Name" ? "custom-domain-copy-name" : "custom-domain-copy"}
                          aria-label={copied === text ? "Copied" : `Copy ${label.toLowerCase()}`}
                          title={copied === text ? "Copied" : `Copy ${label.toLowerCase()}`}
                          onclick={() => void copy(text)}
                        ><RailIcon name={copied === text ? "check" : "copy"} /></button>
                      {/each}
                    </dl>
                  </section>
                {/each}
                {#if !(records[d.domain] ?? []).some((r) => r.purpose === "ownership")}
                  <p class="hint flat" data-testid="custom-domain-records-partial">The certificate record isn't ready yet. Check again in a minute to see it.</p>
                {/if}
                {#if status(d).tone !== "verifying"}<p class="tip" data-testid="custom-domain-name-tip">If your DNS site adds {d.domain} to names by itself, enter only the part before it, or @ for {d.domain} itself.</p>{/if}
              {/if}
            </div>
          {/if}
          <div class="row-actions">
            {#if !isLive(d)}<RailButton icon="refresh" data-testid="custom-domain-refresh" disabled={busy !== null || preparing[d.domain] === true} aria-busy={busy === "refresh"} onclick={() => void refresh(d.domain)}>{busy === "refresh" ? "Checking…" : "Check again"}</RailButton>{/if}
            {#if isLive(d)}<RailButton icon="external" onclick={() => openExternal?.(`https://${d.domain}`)}>Open</RailButton>{/if}
            <span class="grow"></span>
            <RailButton icon="trash" variant="ghost" data-testid="custom-domain-remove" disabled={busy !== null} onclick={() => { confirmRemove = d.domain; actionError = null; notice = null; }}>Remove</RailButton>
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
          placeholder="mysite.com"
          data-testid="custom-domain-input"
          bind:value={entry}
          onkeydown={(e) => e.key === "Enter" && void add()}
        />
      </label>
      {#if problem && problem !== "empty"}<p class="hint" data-testid="custom-domain-input-problem">{inputProblemCopy(problem)}</p>{/if}
      <p class="hint" data-testid="custom-domain-price" data-basis={companyPrice?.basis ?? "catalog"}>{priceLine}</p>
    {:else if !canManage && domains.length === 0}
      <p class="hint" data-testid="custom-domain-member-empty">No custom domain yet. {addDisabledByPlan ? priceLine : monthlyUsd > 0 ? `A company owner or admin can add one for ${price}.` : "A company owner or admin can add one."}</p>
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
    <RailButton icon="plus" variant="primary" data-testid="custom-domain-add" disabled={!typed || problem !== null || busy !== null || addDisabledByPlan} aria-busy={busy === "add"} onclick={() => void add()}>{busy === "add" ? "Adding…" : "Add domain"}</RailButton>
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
  /* Domain status: the name, then a chip. Weight and tone carry the hierarchy; 13px throughout. */
  .head { display: flex; align-items: center; gap: 12px; min-height: 28px; padding: 14px 20px 10px; }
  .head .name { flex: 1; min-width: 0; font-weight: 500; color: var(--t1, var(--v4-text-1)); }
  .chip { display: inline-flex; align-items: center; gap: 6px; flex: none; height: 22px; padding: 0 9px; border-radius: 11px; border: 1px solid var(--line2, var(--v4-control-border)); color: var(--t2, var(--v4-text-2)); white-space: nowrap; }
  .chip[data-tone="failed"] { white-space: normal; height: auto; padding: 3px 9px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--t2, var(--v4-text-2)); }
  .chip[data-tone="verifying"] .dot, .chip[data-tone="failed"] .dot { background: var(--warn, var(--v4-warn)); }
  .chip[data-tone="live"] { color: var(--ok-ink, var(--t1)); }
  .chip[data-tone="live"] .dot { background: var(--ok, var(--v4-ok)); }
  .dns { display: flex; flex-direction: column; gap: 12px; padding: 0 20px 14px; }
  .lead { margin: 0; color: var(--t2, var(--v4-text-2)); }
  /* One card per record: number, plain title, type; a purpose line; Name and Value with copy. */
  .rec { border: 1px solid var(--line2, var(--v4-control-border)); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  .rh { display: flex; align-items: center; gap: 8px; }
  .num { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--line2, var(--v4-control-border)); color: var(--t2, var(--v4-text-2)); flex: none; }
  .rt { flex: 1; font-weight: 500; }
  .type { color: var(--t3, var(--v4-text-3)); font-family: var(--font-mono, ui-monospace, monospace); }
  .why { margin: 0; color: var(--t2, var(--v4-text-2)); }
  .kv { display: grid; grid-template-columns: 44px minmax(0, 1fr) 24px; gap: 8px; align-items: start; margin: 0; padding-top: 10px; border-top: 1px solid var(--panel-border, var(--v4-rowline)); }
  /* Label, first line of the value and the copy icon share one 24px line. */
  .kv dt { color: var(--t2, var(--v4-text-2)); line-height: 24px; }
  .kv dd { margin: 0; padding: 3px 0; line-height: 18px; color: var(--t1, var(--v4-text-1)); }
  .kv .seg { display: inline-block; max-width: 100%; overflow-wrap: anywhere; }
  .kv .copy { align-self: start; }
  .tip { margin: 2px 0 0; color: var(--t2, var(--v4-text-2)); }
  .copy { display: inline-grid; place-items: center; width: 24px; height: 24px; border: 0; border-radius: 6px; padding: 0; background: transparent; color: var(--t2, var(--v4-text-2)); cursor: pointer; }
  .copy:hover { background: var(--hover, var(--v4-hover)); color: var(--t1, var(--v4-text-1)); }
  .copy:focus-visible { outline: 2px solid var(--v4-focus, currentColor); outline-offset: 2px; border-radius: 3px; }
  .row-actions { display: flex; align-items: center; gap: 8px; padding: 0 20px 12px; }
  .hint.note .row-actions, .confirm .row-actions { padding: 0; }
  .confirm { display: flex; flex-direction: column; gap: 8px; padding: 0 20px 14px; }
  .confirm .sec { margin: 0; font-weight: 500; }
  .confirm .body { color: var(--t2, var(--v4-text-2)); }
  .confirm .row-actions { padding-top: 4px; }
</style>
