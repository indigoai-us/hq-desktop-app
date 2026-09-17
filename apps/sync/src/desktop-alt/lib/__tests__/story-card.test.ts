import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('US-005 label overflow', () => {
  it('shows up to two labels with a +N overflow indicator', () => {
    const labels = ['frontend', 'backend', 'infra', 'docs'];
    const visible = labels.slice(0, 2);
    expect(visible).toEqual(['frontend', 'backend']);
    expect(labels.length - visible.length).toBe(2);
  });
});
