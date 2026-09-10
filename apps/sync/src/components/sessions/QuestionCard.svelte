<script lang="ts">
  /**
   * A parked `AskUserQuestion` request, rendered above the composer.
   *
   * ONE request can carry SEVERAL questions, each single- or multi-select, and
   * the backend answers them all in one `agent_session_answer_question` call —
   * so this card renders every question in the request and submits once. Values
   * are option LABELS (what `QuestionAnswer.values` carries), not indices.
   *
   * Once answered the card COLLAPSES to a single line ("Answered · All") —
   * the decision stays visible as history without holding a screenful of
   * radio buttons open forever.
   *
   * Presentation-pure: props in, one callback out.
   */
  import type { SessionQuestion } from './session-events';

  interface Props {
    requestId: string;
    questions: SessionQuestion[];
    busy?: boolean;
    /** The one-line answer summary, once this client has answered. */
    resolution?: string | null;
    onsubmit?: (
      requestId: string,
      answers: { questionId: string; values: string[] }[],
    ) => void;
  }

  let { requestId, questions, busy = false, resolution = null, onsubmit }: Props = $props();

  /** questionId → picked option labels. Rebuilt whenever the request changes. */
  let picks = $state<Record<string, string[]>>({});
  /**
   * questionId → typed "Other" answer. `AskUserQuestion` always accepts a
   * free-text answer beside its options (the CLI's "Other" row); a card that
   * only draws the options strands questions like "What's your name?".
   */
  let others = $state<Record<string, string>>({});
  /** questionId → whether the "Other" row is the active choice. */
  let otherOn = $state<Record<string, boolean>>({});

  // A new request id means a different set of questions: start from a clean
  // selection rather than carrying the previous request's answers forward.
  let seededFor = $state('');
  $effect(() => {
    if (seededFor === requestId) return;
    seededFor = requestId;
    const seed: Record<string, string[]> = {};
    for (const question of questions) seed[question.id] = [];
    picks = seed;
    others = {};
    otherOn = {};
  });

  function selectedFor(questionId: string): string[] {
    return picks[questionId] ?? [];
  }

  function otherTextFor(questionId: string): string {
    return (others[questionId] ?? '').trim();
  }

  function otherActive(questionId: string): boolean {
    return otherOn[questionId] === true;
  }

  function chooseSingle(questionId: string, label: string) {
    picks = { ...picks, [questionId]: [label] };
    otherOn = { ...otherOn, [questionId]: false };
  }

  function toggleMulti(questionId: string, label: string) {
    const current = selectedFor(questionId);
    const next = current.includes(label)
      ? current.filter((value) => value !== label)
      : [...current, label];
    picks = { ...picks, [questionId]: next };
  }

  function chooseOther(question: SessionQuestion) {
    if (question.multiSelect) {
      otherOn = { ...otherOn, [question.id]: !otherActive(question.id) };
      return;
    }
    picks = { ...picks, [question.id]: [] };
    otherOn = { ...otherOn, [question.id]: true };
  }

  /** Typing in the Other field is choosing it. */
  function typeOther(question: SessionQuestion, value: string) {
    others = { ...others, [question.id]: value };
    if (!otherActive(question.id)) chooseOther(question);
  }

  /** What this question would send: picked labels plus the typed answer. */
  function valuesFor(questionId: string): string[] {
    const typed = otherActive(questionId) ? otherTextFor(questionId) : '';
    return typed ? [...selectedFor(questionId), typed] : selectedFor(questionId);
  }

  /** Submitting a half-answered request would send the agent a lie by omission. */
  const complete = $derived(questions.every((q) => valuesFor(q.id).length > 0));

  function submit() {
    if (!complete) return;
    onsubmit?.(
      requestId,
      questions.map((question) => ({
        questionId: question.id,
        values: valuesFor(question.id),
      })),
    );
  }

  function submitOnEnter(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    if (!busy) submit();
  }
</script>

{#if resolution}
  <p
    class="question-resolved"
    data-testid="session-question-resolved"
    data-request-id={requestId}
  >
    {resolution}
  </p>
{:else}
<section
  class="question-card"
  data-testid="session-question-card"
  data-request-id={requestId}
  aria-label="The agent needs an answer"
>
  {#each questions as question (question.id)}
    <fieldset class="question" data-testid="session-question">
      <legend class="question-header">{question.header}</legend>
      <p class="question-text">{question.text}</p>

      <div class="options" role={question.multiSelect ? 'group' : 'radiogroup'}>
        {#each question.options as option (option.label)}
          <label class="option" class:picked={selectedFor(question.id).includes(option.label)}>
            {#if question.multiSelect}
              <input
                type="checkbox"
                name={`${requestId}-${question.id}`}
                value={option.label}
                checked={selectedFor(question.id).includes(option.label)}
                onchange={() => toggleMulti(question.id, option.label)}
              />
            {:else}
              <input
                type="radio"
                name={`${requestId}-${question.id}`}
                value={option.label}
                checked={selectedFor(question.id).includes(option.label)}
                onchange={() => chooseSingle(question.id, option.label)}
              />
            {/if}
            <span class="option-body">
              <span class="option-label">{option.label}</span>
              {#if option.description}
                <span class="option-description">{option.description}</span>
              {/if}
            </span>
          </label>
        {/each}
        <label
          class="option option--other"
          class:picked={otherActive(question.id)}
          data-testid="session-question-other"
        >
          <input
            type={question.multiSelect ? 'checkbox' : 'radio'}
            name={`${requestId}-${question.id}`}
            value="__other__"
            checked={otherActive(question.id)}
            onchange={() => chooseOther(question)}
          />
          <span class="option-body">
            <span class="option-label">Type your own answer</span>
            <input
              class="other-input"
              type="text"
              autocomplete="off"
              placeholder="Type here…"
              aria-label={`Your own answer: ${question.text}`}
              data-testid="session-question-other-input"
              value={others[question.id] ?? ''}
              disabled={busy}
              oninput={(event) => typeOther(question, (event.currentTarget as HTMLInputElement).value)}
              onkeydown={submitOnEnter}
            />
          </span>
        </label>
      </div>
    </fieldset>
  {/each}

  <div class="question-actions">
    <button
      type="button"
      class="primary"
      disabled={busy || !complete}
      data-testid="session-question-submit"
      onclick={submit}
    >
      Submit
    </button>
    {#if !complete}
      <span class="question-hint">
        Answer {questions.length === 1 ? 'the question' : 'every question'} to continue.
      </span>
    {/if}
  </div>
</section>
{/if}

<style>
  .question-resolved {
    margin: 0;
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .question-card {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-3);
    padding: var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card);
    background: var(--v4-raised);
  }

  .question {
    margin: 0;
    padding: 0;
    border: 0;
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
    min-width: 0;
  }

  .question-header {
    padding: 0;
    font-size: var(--type-metadata);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--v4-text-3);
  }

  .question-text {
    margin: 0;
    font-size: var(--type-body);
    line-height: 1.45;
    color: var(--v4-text-1);
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .option {
    display: flex;
    align-items: flex-start;
    gap: var(--v4-space-2);
    padding: var(--v4-space-2);
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    cursor: pointer;
  }

  .option:hover {
    background: var(--v4-control-faint);
  }

  .option.picked {
    border-color: var(--v4-hairline);
    background: var(--v4-active-row);
  }

  .option input {
    margin-top: 2px;
    flex: none;
  }

  .option-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .option-label {
    font-size: var(--type-body);
    color: var(--v4-text-1);
  }

  .option-description {
    font-size: var(--type-metadata);
    line-height: 1.4;
    color: var(--v4-text-3);
  }

  .option--other .option-body {
    flex: 1;
    gap: 6px;
  }

  .other-input {
    width: 100%;
    max-width: 480px;
    font: inherit;
    font-size: var(--type-body);
    padding: 6px 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }

  .other-input::placeholder {
    color: var(--v4-text-3);
  }

  .other-input:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-hairline));
    outline-offset: 1px;
  }

  .question-actions {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
  }

  .question-actions button {
    height: var(--v4-row-h);
    padding: 0 var(--v4-space-4);
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font-family: inherit;
    font-size: var(--type-metadata);
    cursor: pointer;
  }

  .question-actions button:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .question-hint {
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }
</style>
