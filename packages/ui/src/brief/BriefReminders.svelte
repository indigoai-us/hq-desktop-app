<script lang="ts">
  /**
   * You asked to be reminded: what you told HQ to remind you of, in your own
   * words, on the day it matters. Each row is the quote (weight 500, two
   * lines at most), a mono line saying when and where you said it and when it
   * is due, and on hover its own actions: Start in <engine> with the
   * reminder's prompt, and Done, which marks it in this brief only
   * (brief.cleared) until the brief-log append seam exists. The row's peek
   * holds the full text, where and when, and the prompt. Never a count card.
   * Hidden when nothing is due by the end of tomorrow, by the same rule the
   * picker uses (brief-reminders.ts, dueReminders).
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { dueLabel, dueReminders, dueState, reminderPrompt, reminderRows, saidLabel, saidLine, whenLine } from "./brief-reminders.js";
  import type { BriefReminder } from "./brief-types.js";

  interface Props {
    reminders: BriefReminder[];
    prompts: Record<string, string>;
    /** ISO time the brief is generated for. */
    now: string;
    /** The brief's local day, YYYY-MM-DD (ctx.today). */
    today: string;
    rows: number;
    cols?: number;
  }
  let { reminders, prompts, now, today, rows, cols = 2 }: Props = $props();
  const brief = useBrief();
  const due = $derived(dueReminders(reminders, now));
  // At most five rows in a list; a one-column slot shows three. The rest open in the "+N more" peek.
  const split = $derived(reminderRows(due, cols >= 2 || rows > 1 ? 5 : 3));
  const shown = $derived(split.shown);
  const rest = $derived(split.rest);
  const done = $derived(due.filter((r) => brief.cleared[r.id]).length);

  const promptFor = (r: BriefReminder): string => prompts[r.id] ?? r.prompt ?? reminderPrompt(r);
  const late = (r: BriefReminder): boolean => dueState(r, today) === "overdue";
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  function content(r: BriefReminder): PeekContent {
    const where = r.where.trim();
    const when = whenLine(r.saidAt);
    return {
      eyebrow: `Reminder · ${saidLabel(r.saidAt, now)}`,
      title: r.text,
      status: brief.cleared[r.id] ? "Done in this brief" : cap(dueLabel(r, today)),
      sections: [
        {
          label: "Where and when",
          text: `${where ? `You said it in ${where}` : "You said it"}${when ? `, ${when}` : ""}.${r.dueAt && whenLine(r.dueAt) ? ` Due ${whenLine(r.dueAt)}.` : ""}`,
        },
      ],
      prompt: { id: r.id, text: promptFor(r) },
    };
  }

  const morePeek = (): PeekContent => ({
    title: `${rest.length} more reminder${rest.length === 1 ? "" : "s"}`,
    status: "Also due by tomorrow",
    sections: [
      {
        label: "In your words",
        lines: rest.map((r) => ({
          label: r.text,
          state: brief.cleared[r.id] ? "DONE" : dueLabel(r, today).toUpperCase(),
          ...(late(r) && !brief.cleared[r.id] ? { tone: "warn" as const } : {}),
        })),
      },
    ],
  });
</script>

{#if due.length}
  <div class="w" data-testid="brief-reminders">
    <div class="eyebrow">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21v-4M9 4h6l-.8 6.2 2.3 2.3a1 1 0 0 1-.7 1.7H8.2a1 1 0 0 1-.7-1.7l2.3-2.3z" /></svg>
      You asked to be reminded
    </div>
    <div class="list">
      {#each shown as r (r.id)}
        <div
          class="it"
          class:done={brief.cleared[r.id]}
          class:late={late(r) && !brief.cleared[r.id]}
          data-testid="brief-reminder"
          role="group"
          aria-label={r.text}
          use:peek={{ state: brief, content: () => content(r) }}
        >
          <div class="tx">
            <div class="q" data-testid="brief-reminder-text">{r.text}</div>
            <div class="said" data-testid="brief-reminder-said">{saidLine(r, now, today)}</div>
            {#if brief.notes[r.id]}<div class="said note" role="status">{brief.notes[r.id]}</div>{/if}
          </div>
          <div class="acts">
            {#if brief.cleared[r.id]}
              <span class="donechip">Done</span>
            {:else}
              <BriefLaunch id={r.id} prompt={promptFor(r)} compact />
              <button type="button" class="mark" data-testid="brief-reminder-done" title="Mark done in this brief" onclick={() => brief.clear(r.id)}>Done</button>
            {/if}
          </div>
        </div>
      {/each}
      {#if rest.length}
        <div class="it more-row" role="button" tabindex="0" data-testid="brief-reminder-more" use:peek={{ state: brief, content: morePeek }}>
          +{rest.length} more
        </div>
      {/if}
    </div>
    {#if rows > 1}
      <div class="foot"><span>{done} of {due.length} done</span><span>Hover a row to start it</span></div>
    {/if}
  </div>
{/if}

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 12px;
    min-height: 0;
  }
  /* Glass row: lit from the top, hairline rim, soft drop. No backdrop-filter, no inner shadow. */
  .it {
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 10px 9px 12px;
    border-radius: 6px;
    background: rgb(var(--b-ink) / 0.04);
    border: 1px solid rgb(var(--b-ink) / 0.09);
    box-shadow: none;
    transition: background 0.25s, opacity 0.5s;
  }
  .it:hover {
    background: rgb(var(--b-ink) / 0.07);
  }
  .it.done {
    opacity: 0.45;
  }
  .it.done .q {
    text-decoration: line-through;
    text-decoration-color: rgb(var(--b-ink) / 0.4);
  }
  .tx {
    flex: 1;
    min-width: 0;
  }
  /* The owner's words: weight 500, two lines, then the ellipsis. The quote marks are decoration, not text. */
  .q {
    font-size: 13px;
    font-weight: 500;
    line-height: 1.3;
    letter-spacing: -0.005em;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .q::before {
    content: "\201C";
    color: var(--b-t3);
  }
  .q::after {
    content: "\201D";
    color: var(--b-t3);
  }
  .said {
    margin-top: 3px;
    font-family: var(--b-mono);
    font-size: 11px;
    letter-spacing: 0;
    color: var(--b-t3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .late .said {
    color: var(--b-warn);
  }
  .said.note {
    color: var(--b-t1);
    white-space: normal;
  }
  /* Actions appear only on the row that has your attention. */
  .acts {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    opacity: 0;
    translate: 8px 0;
    transition: opacity 0.3s, translate 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .it:hover .acts,
  .it:focus-within .acts,
  .it.done .acts {
    opacity: 1;
    translate: 0 0;
  }
  .it:not(:hover):not(:focus-within):not(.done) .acts {
    position: absolute;
    right: 10px;
    pointer-events: none;
  }
  .mark {
    all: unset;
    cursor: pointer;
    font-family: var(--b-mono);
    font-size: 11px;
    letter-spacing: 0;
    color: var(--b-t2);
    padding: 6px 9px;
    border-radius: 999px;
    border: 1px solid rgb(var(--b-ink) / 0.14);
    transition: background 0.2s, color 0.2s;
  }
  .mark:hover,
  .mark:focus-visible {
    color: var(--b-t1);
    background: rgb(var(--b-ink) / 0.1);
    outline: none;
  }
  .donechip {
    font-size: 13px;
    font-weight: 500;
    padding: 6px 12px;
    border-radius: 999px;
    color: var(--b-t2);
    border: 1px solid rgb(var(--b-ink) / 0.14);
  }
  .more-row {
    justify-content: center;
    padding: 6px 12px;
    font-size: 13px;
    color: var(--b-t2);
    cursor: default;
  }
</style>
