<script lang="ts">
  // Test harness: owns reactive props so unit tests can mutate botUid, botRole,
  // or companyUid at runtime and verify BotIntegrationsSection's $effect
  // responds. The vitest svelte plugin compiles this file on import so runes
  // work. Not shipped.
  import BotIntegrationsSection from "./BotIntegrationsSection.svelte";

  interface Props {
    initialCompanyUid: string | null;
    initialBotUid: string | null;
    initialBotRole: string | null;
    initialFlagEnabled: boolean | null;
    adapter: unknown;
  }

  const props: Props = $props();

  let companyUid = $state<string | null>(props.initialCompanyUid);
  let botUid = $state<string | null>(props.initialBotUid);
  let botRole = $state<string | null>(props.initialBotRole);
  let flagEnabled = $state<boolean | null>(props.initialFlagEnabled);

  export function setCompanyUid(value: string | null): void {
    companyUid = value;
  }
  export function setBotUid(value: string | null): void {
    botUid = value;
  }
  export function setBotRole(value: string | null): void {
    botRole = value;
  }
  export function setFlagEnabled(value: boolean | null): void {
    flagEnabled = value;
  }
</script>

<BotIntegrationsSection
  {companyUid}
  {botUid}
  {botRole}
  adapter={props.adapter as never}
  {flagEnabled}
/>
