<script lang="ts">
  /**
   * The one way to show a company name in the UI: its favicon (or an initials
   * badge when it has none) followed by the name.
   *
   * The icon comes from `iconUrl` when the caller has it, otherwise from the
   * shared registry by `companyUid` (uid or slug). The guard test
   * `company-label.guard.test.ts` keeps visible company names routed through
   * this component.
   */
  import CompanyIcon from "./CompanyIcon.svelte";
  import { companyIconSrc } from "../avatars/csp-image-src.js";
  import { companyIconFor } from "./company-icon-registry.svelte.js";
  import { railInitials } from "../shell/app-rail.js";

  interface Props {
    name: string;
    iconUrl?: string | null;
    /** Company uid or slug, used to look the icon up in the shared registry. */
    companyUid?: string | null;
    /** Icon edge in px. */
    size?: number;
    class?: string;
    /** Hide the name and render only the mark (the name still sets the alt). */
    iconOnly?: boolean;
  }

  let {
    name,
    iconUrl = null,
    companyUid = null,
    size = 14,
    class: className = "",
    iconOnly = false,
  }: Props = $props();

  // Explicit url first, then the roster by uid or slug, then by display name
  // for surfaces that only carry the name.
  const resolved = $derived(
    iconUrl?.trim() || companyIconFor(companyUid) || companyIconFor(name),
  );
  const hasIcon = $derived(Boolean(companyIconSrc(resolved)));
</script>

<!-- No whitespace between the parts: the flex gap spaces them, and a text
     space would leak into the row's text content. -->
<span class={`company-label ${className}`.trim()} data-testid="company-label"
  >{#if hasIcon}<CompanyIcon iconUrl={resolved} {size} label={name} decorative={!iconOnly} />{:else}<span
      class="company-label-initials"
      style={`--company-label-size:${size}px`}
      data-testid="company-label-initials"
      aria-hidden={iconOnly ? undefined : "true"}
      role={iconOnly ? "img" : undefined}
      aria-label={iconOnly ? name : undefined}>{railInitials(name)}</span
    >{/if}{#if !iconOnly}<span class="company-label-name">{name}</span>{/if}</span
>

<style>
  .company-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    vertical-align: middle;
  }
  .company-label-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .company-label-initials {
    display: inline-grid;
    place-items: center;
    width: var(--company-label-size, 14px);
    height: var(--company-label-size, 14px);
    flex: 0 0 var(--company-label-size, 14px);
    border-radius: 4px;
    background: var(--v4-control-faint, rgba(127, 127, 127, 0.12));
    color: var(--t2, currentColor);
    font-size: calc(var(--company-label-size, 14px) * 0.5);
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0;
  }
</style>
