import { describe, expect, it } from 'vitest';
import { copyableText } from './conversation-copy';

describe('copyableText', () => {
  it('returns the trimmed message body for a body copy', () => {
    expect(copyableText({ body: '  hello team  ' }, 'body')).toBe('hello team');
  });

  it('returns the trimmed agent prompt for a prompt copy', () => {
    expect(
      copyableText({ body: 'see prompt', prompt: '  /run audit  ' }, 'prompt'),
    ).toBe('/run audit');
  });

  it('returns null for a prompt copy when the message has no prompt', () => {
    expect(copyableText({ body: 'just a message' }, 'prompt')).toBeNull();
    expect(copyableText({ body: 'just a message', prompt: null }, 'prompt')).toBeNull();
  });

  it('returns null when the requested text is empty or whitespace', () => {
    expect(copyableText({ body: '   ' }, 'body')).toBeNull();
    expect(copyableText({ body: 'x', prompt: '   ' }, 'prompt')).toBeNull();
  });

  it('copies body and prompt independently from the same message', () => {
    const msg = { body: 'kick off the run', prompt: '/execute-task US-001' };
    expect(copyableText(msg, 'body')).toBe('kick off the run');
    expect(copyableText(msg, 'prompt')).toBe('/execute-task US-001');
  });

  // DEV-1835 regression: a "Copy message" on a block-formatted message must
  // include the details block, not just the top-level body line.
  it('includes block-formatted details in a body copy, joined by a blank line', () => {
    const msg = {
      body: 'Deploy finished',
      details: 'Workspace: /Users/x/HQ\nCompany: indigo\nFiles: 42',
    };
    expect(copyableText(msg, 'body')).toBe(
      'Deploy finished\n\nWorkspace: /Users/x/HQ\nCompany: indigo\nFiles: 42',
    );
  });

  it('trims body and details independently before joining', () => {
    expect(
      copyableText({ body: '  headline  ', details: '  the block  ' }, 'body'),
    ).toBe('headline\n\nthe block');
  });

  it('falls back to body alone when details is absent, null, or empty', () => {
    expect(copyableText({ body: 'just body' }, 'body')).toBe('just body');
    expect(copyableText({ body: 'just body', details: null }, 'body')).toBe('just body');
    expect(copyableText({ body: 'just body', details: '   ' }, 'body')).toBe('just body');
  });

  it('does not fold details into a prompt copy', () => {
    const msg = { body: 'b', details: 'the block', prompt: '/run it' };
    expect(copyableText(msg, 'prompt')).toBe('/run it');
  });
});
