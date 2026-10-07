<script lang="ts">
  import { onMount } from "svelte";
  import {
    HQ_ANYWHERE_RUNTIME_FLAG,
    getHqAnywherePersonSetting,
    hqAnywhereRuntimeEnabled,
    putHqAnywherePersonSetting,
    type PlatformAdapter,
  } from "@hq/platform";

  interface Props {
    adapter?: PlatformAdapter | null;
  }

  let { adapter = null }: Props = $props();
  let available = $state(false);
  let loaded = $state(false);
  let enabled = $state(false);
  let loading = $state(false);
  let saving = $state(false);
  let retryKind = $state<"read" | "write" | null>(null);
  let retryValue = $state<boolean | null>(null);

  onMount(() => {
    if (!adapter) return;
    const identity = adapter.identity;
    if (!identity) return;

    let active = true;
    let flagRevision = 0;
    const refreshAvailability = async (): Promise<void> => {
      const revision = ++flagRevision;
      const enabled = await hqAnywhereRuntimeEnabled(identity);
      if (!active || revision !== flagRevision) return;

      const wasAvailable = available;
      available = enabled;
      if (!enabled) {
        loaded = false;
        retryKind = null;
        retryValue = null;
        return;
      }
      if (!wasAvailable || !loaded) void loadSetting();
    };

    const unsubscribe = identity.subscribeFeature?.(
      HQ_ANYWHERE_RUNTIME_FLAG,
      () => void refreshAvailability(),
    ) ?? (() => {});
    void refreshAvailability();

    return () => {
      active = false;
      flagRevision += 1;
      unsubscribe();
    };
  });

  async function loadSetting(): Promise<void> {
    if (!adapter || loading || saving) return;
    loading = true;
    retryKind = null;
    retryValue = null;
    try {
      const result = await getHqAnywherePersonSetting(adapter.settings);
      if (result.ok) {
        enabled = result.value;
        loaded = true;
      } else {
        console.warn("[hq-anywhere] setting read failed:", result);
        retryKind = "read";
      }
    } catch (error) {
      console.warn("[hq-anywhere] setting read failed:", error);
      retryKind = "read";
    } finally {
      loading = false;
    }
  }

  async function saveSetting(value: boolean): Promise<void> {
    if (!adapter || !loaded || loading || saving) return;
    const previous = enabled;
    enabled = value;
    saving = true;
    retryKind = null;
    retryValue = null;
    try {
      const result = await putHqAnywherePersonSetting(adapter.settings, value);
      if (!result.ok) {
        console.warn("[hq-anywhere] setting write failed:", result);
        enabled = previous;
        retryKind = "write";
        retryValue = value;
      }
    } catch (error) {
      console.warn("[hq-anywhere] setting write failed:", error);
      enabled = previous;
      retryKind = "write";
      retryValue = value;
    } finally {
      saving = false;
    }
  }

  function retry(): void {
    if (retryKind === "read") {
      void loadSetting();
    } else if (retryKind === "write" && retryValue !== null) {
      void saveSetting(retryValue);
    }
  }
</script>

{#if available}
  <div class="setting-row" data-testid="hq-anywhere-setting-row">
    <div class="copy">
      <div class="label">HQ Anywhere</div>
      <div class="hint">Use your HQ context in Claude Code, Codex, ChatGPT and Grok</div>
    </div>
    <button
      type="button"
      class="toggle"
      class:on={enabled}
      role="switch"
      aria-checked={enabled}
      aria-label="HQ Anywhere"
      aria-busy={loading || saving}
      data-testid="hq-anywhere-setting-toggle"
      disabled={!loaded || loading || saving}
      onclick={() => void saveSetting(!enabled)}
    ></button>
    {#if loading}
      <span class="status" role="status" aria-live="polite">Loading…</span>
    {:else if saving}
      <span class="status" role="status" aria-live="polite">Saving…</span>
    {:else if retryKind}
      <button
        type="button"
        class="retry"
        data-testid="hq-anywhere-setting-retry"
        onclick={retry}
      >Tap to retry</button>
    {/if}
  </div>
{/if}

<style>
  .setting-row {
    display: flex;
    align-items: center;
    gap: 12px;
    border-top: 1px solid var(--line);
    padding: 14px 16px;
  }

  .copy {
    min-width: 0;
  }

  .label {
    color: var(--t1);
    font-size: 13px;
    font-weight: 500;
  }

  .hint {
    margin-top: 2px;
    color: var(--t2);
    font-size: 12px;
    line-height: 1.45;
  }

  .toggle {
    position: relative;
    flex: 0 0 34px;
    width: 34px;
    height: 20px;
    margin-left: auto;
    padding: 0;
    border: none;
    border-radius: 10px;
    background: var(--line2);
    cursor: pointer;
  }

  .toggle::after {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--t2);
    content: "";
    transition: transform 0.15s;
  }

  .toggle.on {
    background: #2a3644;
  }

  .toggle.on::after {
    transform: translateX(14px);
    background: var(--ice, #c9d6e4);
  }

  .toggle:focus-visible,
  .retry:focus-visible {
    outline: 1px solid var(--ice, #c9d6e4);
    outline-offset: 2px;
  }

  .toggle:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .status,
  .retry {
    flex: 0 0 auto;
    margin-left: 4px;
    color: var(--t3);
    font: inherit;
    font-size: 11px;
  }

  .retry {
    padding: 2px 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }
</style>
