// hq-idea-board US-005: source-contract spec for the capture toast window.
//
// SOURCE-CONTRACT SPEC. The Rust side (window registration, capability file,
// command handlers) is owned by a concurrent agent on the same story; this
// spec asserts the seam between the Svelte toast and that Rust surface by
// literal search rather than driving the app, per repo policy
// hq-desktop-app-source-contract-specs-retarget-with-edits. If a Rust literal
// asserted here is still missing (the concurrent agent hasn't landed it yet),
// re-run after it lands rather than weakening the assertion.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const captureRs = read('src-tauri/src/commands/capture.rs');
const capabilityJson = read('src-tauri/capabilities/capture-toast.json');
const mainTs = read('src/main.ts');
const mainRs = read('src-tauri/src/main.rs');
const toastSvelte = read('src/components/capture/CaptureToast.svelte');

const INVOKED_COMMANDS = [
  'capture_toast_ready',
  'dismiss_capture_toast',
  'set_capture_toast_focusable',
  'ideas_delete_capture',
  'ideas_set_note',
  'ideas_move_capture',
  'ideas_list_companies',
  'ideas_open_board',
  'ideas_capture_preview',
];

describe('US-005 capture toast (source contract)', () => {
  it('registers the capture-toast window label in the Rust capture commands', () => {
    expect(captureRs).toContain('capture-toast');
  });

  it('scopes the capture-toast capability file to the capture-toast window', () => {
    expect(capabilityJson).toContain('capture-toast');
  });

  it('routes the capture-toast window label to CaptureToast in main.ts', () => {
    expect(mainTs).toContain('capture-toast');
    expect(mainTs).toContain('CaptureToast');
    const routerIdx = mainTs.indexOf("windowLabel === 'capture-toast'");
    expect(routerIdx).toBeGreaterThanOrEqual(0);
  });

  it('registers every command the toast invokes in the Tauri invoke_handler', () => {
    const handlerIdx = mainRs.indexOf('generate_handler!');
    expect(handlerIdx).toBeGreaterThanOrEqual(0);
    // The macro body is a long, flat list of `commands::<mod>::<fn>,` entries
    // with no nested brackets, so each command name is unique within it —
    // search the whole file rather than pin an exact close bracket, which
    // would make this spec brittle to unrelated additions elsewhere in the
    // (very long) invoke_handler! list.
    for (const command of INVOKED_COMMANDS) {
      expect(toastSvelte).toContain(`'${command}'`);
      expect(mainRs).toMatch(new RegExp(`commands::\\w+::${command}\\b`));
    }
  });

  it('grants the capture-toast window the minimum capability set', () => {
    // App-defined commands need no per-command token and the window drives no
    // core window/webview API itself, so anything beyond core:default +
    // core:event:default would be an unused grant on an always-on-top window.
    const parsed = JSON.parse(capabilityJson) as {
      windows: string[];
      permissions: string[];
    };
    expect(parsed.windows).toEqual(['capture-toast']);
    expect([...parsed.permissions].sort()).toEqual(['core:default', 'core:event:default']);
  });

  it('routes every "open" action through an app command, never plugin-shell', () => {
    // US-010's review found provenance URLs reaching @tauri-apps/plugin-shell
    // unvalidated. The toast must not grow that seam: its only open action is
    // the in-app board route.
    expect(toastSvelte).not.toContain('@tauri-apps/plugin-shell');
    expect(toastSvelte).not.toMatch(/\bopenUrl\s*\(/);
    expect(toastSvelte).toContain("'ideas_open_board'");
  });

  it('never swallows a write rejection into a fire-and-forget invoke', () => {
    // Every mutation (undo/note/reassign/open) must be awaited so a failure
    // can surface instead of leaving the toast claiming a change that never
    // happened.
    for (const command of ['ideas_delete_capture', 'ideas_set_note', 'ideas_move_capture', 'ideas_open_board']) {
      expect(toastSvelte).toContain(`await invoke('${command}'`);
      expect(toastSvelte).not.toMatch(
        new RegExp(`void invoke\\('${command}'[^)]*\\)\\.catch`),
      );
    }
    expect(toastSvelte).toContain('capture-toast-error');
  });

  it('never uses native browser dialogs', () => {
    expect(toastSvelte).not.toMatch(/window\.confirm\s*\(/);
    expect(toastSvelte).not.toMatch(/window\.alert\s*\(/);
    expect(toastSvelte).not.toMatch(/window\.prompt\s*\(/);
    expect(toastSvelte).not.toMatch(/(?<!window\.)\bconfirm\s*\(/);
    expect(toastSvelte).not.toMatch(/(?<!window\.)\balert\s*\(/);
    expect(toastSvelte).not.toMatch(/(?<!window\.)\bprompt\s*\(/);
  });

  it('requests focusable before any note input can render', () => {
    const focusableIdx = toastSvelte.indexOf('set_capture_toast_focusable');
    const noteInputIdx = toastSvelte.indexOf('capture-toast-note-input');
    expect(focusableIdx).toBeGreaterThanOrEqual(0);
    expect(noteInputIdx).toBeGreaterThanOrEqual(0);
    expect(focusableIdx).toBeLessThan(noteInputIdx);

    // The literal call site inside startNoteEdit() must invoke it with
    // focusable:true before noteEditing flips true (which is what reveals
    // the `{#if noteEditing}` input block).
    const startFnIdx = toastSvelte.indexOf('async function startNoteEdit');
    const startFnBody = toastSvelte.slice(startFnIdx, toastSvelte.indexOf('\n  }', startFnIdx));
    const setFocusableCallIdx = startFnBody.indexOf('setFocusable(true)');
    const noteEditingTrueIdx = startFnBody.indexOf('noteEditing = true');
    expect(setFocusableCallIdx).toBeGreaterThanOrEqual(0);
    expect(noteEditingTrueIdx).toBeGreaterThanOrEqual(0);
    expect(setFocusableCallIdx).toBeLessThan(noteEditingTrueIdx);
  });
});
