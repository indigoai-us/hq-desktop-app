// @vitest-environment happy-dom
// The parked-question card must always offer a typed answer beside the
// options: AskUserQuestion accepts free text (the CLI's "Other" row), and a
// question like "What's your name?" is unanswerable without it.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { mount, tick, unmount } from 'svelte';
import QuestionCard from './QuestionCard.svelte';
import type { SessionQuestion } from './session-events';

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
});

async function mountCard(questions: SessionQuestion[], onsubmit = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(QuestionCard, {
    target: host,
    props: { requestId: 'req-1', questions, onsubmit },
  });
  await tick();
  return onsubmit;
}

const $ = <T extends Element>(sel: string) => host.querySelector<T>(sel);

function typeOther(value: string) {
  const input = $<HTMLInputElement>('[data-testid="session-question-other-input"]')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const nameQuestion: SessionQuestion = {
  id: 'q1',
  header: 'Your name',
  text: "What's your name?",
  multiSelect: false,
  options: [
    { label: 'Type it in', description: 'First name is fine.' },
    { label: 'Skip for now' },
  ],
};

describe('QuestionCard typed answers', () => {
  it('sends the typed answer as the value for a single-select question', async () => {
    const onsubmit = await mountCard([nameQuestion]);
    expect($<HTMLButtonElement>('[data-testid="session-question-submit"]')?.disabled).toBe(true);
    typeOther('Jacob');
    await tick();
    expect($<HTMLInputElement>('[data-testid="session-question-other"] input[type="radio"]')?.checked).toBe(true);
    expect($<HTMLButtonElement>('[data-testid="session-question-submit"]')?.disabled).toBe(false);
    $<HTMLButtonElement>('[data-testid="session-question-submit"]')!.click();
    expect(onsubmit).toHaveBeenCalledWith('req-1', [{ questionId: 'q1', values: ['Jacob'] }]);
  });

  it('Enter in the typed answer submits', async () => {
    const onsubmit = await mountCard([nameQuestion]);
    typeOther('Jacob');
    await tick();
    const input = $<HTMLInputElement>('[data-testid="session-question-other-input"]')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onsubmit).toHaveBeenCalledWith('req-1', [{ questionId: 'q1', values: ['Jacob'] }]);
  });

  it('picking an option after typing drops the typed answer for single-select', async () => {
    const onsubmit = await mountCard([nameQuestion]);
    typeOther('Jacob');
    await tick();
    const skip = host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!;
    skip.checked = true;
    skip.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    $<HTMLButtonElement>('[data-testid="session-question-submit"]')!.click();
    expect(onsubmit).toHaveBeenCalledWith('req-1', [{ questionId: 'q1', values: ['Skip for now'] }]);
  });

  it('multi-select sends picked labels plus the typed answer', async () => {
    const onsubmit = await mountCard([
      { ...nameQuestion, id: 'q2', text: 'Which tools?', multiSelect: true, options: [{ label: 'Slack' }, { label: 'Linear' }] },
    ]);
    const slack = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!;
    slack.checked = true;
    slack.dispatchEvent(new Event('change', { bubbles: true }));
    typeOther('Notion');
    await tick();
    $<HTMLButtonElement>('[data-testid="session-question-submit"]')!.click();
    expect(onsubmit).toHaveBeenCalledWith('req-1', [{ questionId: 'q2', values: ['Slack', 'Notion'] }]);
  });

  it('a blank typed answer does not count as an answer', async () => {
    await mountCard([nameQuestion]);
    typeOther('   ');
    await tick();
    expect($<HTMLButtonElement>('[data-testid="session-question-submit"]')?.disabled).toBe(true);
  });
});
