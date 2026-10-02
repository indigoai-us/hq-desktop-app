<script lang="ts">
  import { dismissable } from "../common/dismissable.js";
  /**
   * Reusable skill list. Selection is a background highlight only.
   * Callers own the catalog; this component does not fetch.
   */
  interface SkillRow {
    id: string;
    title: string;
    detail: string;
    blocked?: boolean;
  }

  interface Props {
    skills: readonly SkillRow[];
    selected: readonly string[];
    ontoggle: (id: string) => void;
    onclose: () => void;
  }

  let { skills, selected, ontoggle, onclose }: Props = $props();
  let query = $state("");

  const rows = $derived(
    skills.filter((skill) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return skill.title.toLowerCase().includes(q) || skill.detail.toLowerCase().includes(q);
    }),
  );
</script>

<div class="sp" role="dialog" aria-label="Choose skills" data-testid="skill-picker" use:dismissable={{ onclose, trap: false }}>
  <div class="sp-h">
    <h2>Skills</h2>
    <button type="button" class="sp-x" aria-label="Close" onclick={onclose}>✕</button>
  </div>
  <input class="sp-q" placeholder="Filter skills" bind:value={query} data-testid="skill-picker-filter" />
  <ul class="sp-list">
    {#each rows as skill (skill.id)}
      <li>
        <button
          type="button"
          class="sp-row"
          aria-pressed={selected.includes(skill.id)}
          disabled={skill.blocked}
          data-testid={`skill-picker-${skill.id}`}
          onclick={() => ontoggle(skill.id)}
        >
          <span class="sp-t">{skill.title}</span>
          <span class="sp-d">{skill.detail}</span>
        </button>
      </li>
    {:else}
      <li class="sp-empty">No skills match.</li>
    {/each}
  </ul>
  <div class="sp-f">
    <span>{selected.length} selected</span>
    <button type="button" class="sp-done" onclick={onclose}>Done</button>
  </div>
</div>

<style>
  .sp {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    background: var(--v4-raised, transparent);
    color: var(--v4-text-1, inherit);
    font-family: var(--font-ui, inherit);
  }
  .sp-h { display: flex; align-items: center; gap: 8px; }
  .sp-h h2 { margin: 0; font-size: var(--type-section, 16px); font-weight: 600; flex: 1; }
  .sp-x, .sp-done {
    border: 1px solid var(--v4-control-border, transparent);
    background: transparent;
    color: inherit;
    border-radius: 8px;
    padding: 4px 8px;
  }
  .sp-q {
    border: 1px solid var(--v4-control-border, transparent);
    background: transparent;
    color: inherit;
    border-radius: 8px;
    padding: 6px 8px;
    font: inherit;
  }
  .sp-list { list-style: none; margin: 0; padding: 0; overflow: auto; min-height: 0; }
  .sp-row {
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    color: inherit;
    border-radius: 8px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sp-row[aria-pressed="true"] { background: var(--v4-active-row, transparent); }
  .sp-t { font-size: var(--type-secondary, 14px); }
  .sp-d, .sp-empty, .sp-f { font-size: var(--type-metadata, 12px); color: var(--v4-text-3, inherit); }
  .sp-f { display: flex; align-items: center; justify-content: space-between; }
</style>
