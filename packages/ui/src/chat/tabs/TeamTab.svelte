<script lang="ts">
  /**
   * Team tab — humans, agents, permissions as current-state rows (US-015).
   * Removing an agent and changing an owner role require a second click
   * in the row, never a modal.
   */
  import type { LifecycleCardModel } from "../messaging/channelMessageModels.js";
  import {
    agentMetaLine,
    needsInlineConfirm,
    seedRowValues,
    visibleFields,
    type CompanyTabActionEvent,
    type CompanyTabModel,
  } from "./tab-model.js";

  interface Props {
    data: CompanyTabModel;
    onaction?: (event: CompanyTabActionEvent) => void;
  }

  let { data, onaction }: Props = $props();

  let values = $state(seedRowValues([]));
  let confirmingCardId = $state("");
  let confirmingActionId = $state("");

  $effect.pre(() => {
    values = seedRowValues(data.sections);
    confirmingCardId = "";
    confirmingActionId = "";
  });

  function rowValues(row: LifecycleCardModel) {
    return values[row.cardId] ?? {};
  }

  function setField(cardId: string, fieldId: string, value: string): void {
    const current = values[cardId] ?? {};
    values = { ...values, [cardId]: { ...current, [fieldId]: value } };
  }

  function act(row: LifecycleCardModel, actionId: string): void {
    if (!row.viewer.canAct) return;
    const nextValues = { ...rowValues(row) };
    if (needsInlineConfirm(row, actionId, nextValues)) {
      if (confirmingCardId !== row.cardId || confirmingActionId !== actionId) {
        confirmingCardId = row.cardId;
        confirmingActionId = actionId;
        return;
      }
    }
    confirmingCardId = "";
    confirmingActionId = "";
    onaction?.({
      channelId: "",
      cardId: row.cardId,
      actionId,
      values: nextValues,
      tab: data.tab,
      companyUid: data.companyUid,
    });
  }

  function actionLabel(row: LifecycleCardModel, actionId: string, label: string): string {
    if (confirmingCardId === row.cardId && confirmingActionId === actionId) {
      return actionId === "remove" ? "Confirm remove" : "Confirm";
    }
    return label;
  }

  function isAgentMetaId(id: string): boolean {
    return id === "size" || id === "provider" || id === "price";
  }
</script>

<div
  class="team-tab chat-shell"
  data-testid="company-tab-team"
  role="region"
  aria-label="Team"
>
  {#each data.sections as section (section.id)}
    <section class="team-set" data-testid={"team-section-" + section.id}>
      <div class="team-k">{section.title}</div>
      <div class="team-rows">
        {#each section.rows as row (row.cardId)}
          {@const fields = visibleFields(row)}
          {@const meta = agentMetaLine(row)}
          <div
            class="team-ro"
            data-testid={"team-row-" + row.cardId}
            data-can-act={row.viewer.canAct ? "true" : "false"}
          >
            <div class="team-left">
              {#each fields as field (field.id)}
                {#if isAgentMetaId(field.id)}
                  {#if field.id === "size" && meta}
                    <span class="team-help">{meta}</span>
                  {/if}
                {:else if field.control === "text" && row.viewer.canAct}
                  <input
                    class="team-in"
                    data-testid={"team-field-" + row.cardId + "-" + field.id}
                    placeholder={field.label}
                    value={rowValues(row)[field.id] ?? ""}
                    oninput={(e) =>
                      setField(row.cardId, field.id, e.currentTarget.value)}
                  />
                {:else if field.control === "select" && row.viewer.canAct}
                  <label class="team-sel-wrap">
                    <span class="visually-hidden">{field.label}</span>
                    <select
                      class="team-sel"
                      data-testid={"team-field-" + row.cardId + "-" + field.id}
                      value={rowValues(row)[field.id] ?? field.value}
                      onchange={(e) =>
                        setField(row.cardId, field.id, e.currentTarget.value)}
                    >
                      {#each field.options ?? [] as opt (opt.id)}
                        <option value={opt.id}>{opt.label}</option>
                      {/each}
                    </select>
                  </label>
                {:else if field.id === "name"}
                  <span class="team-name">{field.value}</span>
                {:else if field.id === "audience"}
                  <span class="team-val">{field.label}</span>
                  <span class="team-val">{field.value}</span>
                {:else}
                  <span class="team-val">{field.value}</span>
                {/if}
              {/each}
            </div>
            <div class="team-right">
              {#each row.actions as action (action.id)}
                <button
                  type="button"
                  class="team-btn"
                  class:primary={action.style === "primary"}
                  class:confirm={confirmingCardId === row.cardId &&
                    confirmingActionId === action.id}
                  data-testid={"team-action-" + row.cardId + "-" + action.id}
                  onclick={() => act(row, action.id)}
                >
                  {actionLabel(row, action.id, action.label)}
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/each}
</div>

<style>
  .team-tab {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 16px 20px 24px;
    overflow: auto;
  }

  .team-k {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--t3);
    margin-bottom: 8px;
  }

  .team-rows {
    display: flex;
    flex-direction: column;
  }

  .team-ro {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 36px;
    padding: 6px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--t1) 7%, transparent);
  }

  .team-left,
  .team-right {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .team-name {
    color: var(--t1);
    font-size: 13px;
    font-weight: 500;
  }

  .team-val,
  .team-help {
    color: var(--t2);
    font-size: 12px;
  }

  .team-help {
    color: var(--t3);
  }

  .team-in {
    width: 280px;
    height: 28px;
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--t1) 12%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
  }

  .team-sel {
    height: 28px;
    padding: 0 8px;
    border: 1px solid color-mix(in srgb, var(--t1) 12%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 12px;
  }

  .team-btn {
    appearance: none;
    height: 28px;
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--t1) 12%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .team-btn.primary {
    background: var(--t1);
    color: var(--bg, #111);
    border-color: var(--t1);
  }

  .team-btn.confirm {
    border-color: var(--err, #e25d5d);
    color: var(--err, #e25d5d);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
</style>
