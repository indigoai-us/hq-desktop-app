// US-010: no bare shell during first run.
//
// On macOS and Linux the welcome flow's handoff builds the desktop window
// hidden, waits for the shell to report that the first-run takeover painted
// (`desktop_first_run_takeover_painted`), shows the desktop window through the
// placed reveal, and only then hides the welcome window. So the welcome card
// is never hidden before the ready signal, and there is never a moment with
// neither window on screen. Windows keeps the original open-then-hide order.
//
// The plan order and the watchdog are Rust unit tests in desktop_alt.rs. This
// file pins the wiring those tests cannot see.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const mainRs = read('src-tauri/src/main.rs');
const firstRunRs = read('src-tauri/src/commands/first_run.rs');
const desktopAltRs = read('src-tauri/src/commands/desktop_alt.rs');
const workShell = read('src/desktop-alt/HqWorkWorkShell.svelte');
const welcomeCss = read('src/components/onboarding/welcome/welcome.css');

/** The source from `signature` to the end of its brace-balanced body. */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced body for ${signature}`);
}

/** The block guarded by `attr` inside `body`. */
function cfgBlock(body: string, attr: string): string {
  const at = body.indexOf(attr);
  expect(at, attr).toBeGreaterThan(-1);
  return fnBody(body.slice(at + attr.length), '{');
}

function inOrder(source: string, needles: string[]): void {
  let from = 0;
  for (const needle of needles) {
    const at = source.indexOf(needle, from);
    expect(at, `${needle} after offset ${from}`).toBeGreaterThan(-1);
    from = at + needle.length;
  }
}

describe('first-run reveal order (US-010)', () => {
  const handoff = fnBody(firstRunRs, 'pub async fn show_main_window_at_tray(');
  const reveal = fnBody(desktopAltRs, 'pub async fn open_desktop_alt_for_first_run(');

  it('macOS and Linux hand off through the held reveal and do not hide the welcome card themselves', () => {
    const held = cfgBlock(handoff, '#[cfg(not(target_os = "windows"))]');
    // The flag reads are spawned, not awaited, so they run while the window builds.
    inOrder(held, [
      'tauri::async_runtime::spawn(first_run_handoff_hint_now())',
      'open_desktop_alt_for_first_run(app.clone(), hint).await?',
    ]);
    expect(held).not.toContain('first_run_handoff_hint_now().await');
    expect(held).not.toContain('hide_onboarding_window');
  });

  it('Windows keeps the original open-then-hide order', () => {
    const windows = cfgBlock(handoff, '#[cfg(target_os = "windows")]');
    inOrder(windows, ['open_desktop_alt_window_inner(app.clone(), None).await?', 'crate::tray::hide_onboarding_window(&app)']);
    expect(windows).not.toContain('open_desktop_alt_for_first_run');
    const decl = desktopAltRs.slice(0, desktopAltRs.indexOf('pub async fn open_desktop_alt_for_first_run('));
    expect(decl.trimEnd().endsWith('#[cfg(not(target_os = "windows"))]')).toBe(true);
  });

  it('the welcome card is not hidden before the ready signal: build hidden, wait, show, then hide', () => {
    inOrder(reveal, [
      'arm_first_run_painted()',
      'hold_pending_route()',
      'build_desktop_alt_window(&app, None)',
      'let hint = hint.await.ok()',
      'release_pending_route(hint.as_deref())',
      'await_takeover_painted(rx, FIRST_RUN_PAINTED_TIMEOUT).await',
      'first_run_reveal_plan(signal)',
      'RevealStep::ShowDesktop',
      'reveal_desktop_alt_window(&window)',
      'RevealStep::HideWelcome => crate::tray::hide_onboarding_window(&app)',
    ]);
    // The only hide is the plan's last step, after the wait.
    const waitAt = reveal.indexOf('await_takeover_painted(');
    expect(reveal.indexOf('hide_onboarding_window')).toBeGreaterThan(waitAt);
    expect(reveal.split('hide_onboarding_window').length - 1).toBe(1);
    // Shown through the placed reveal, never centred a second time.
    expect(reveal).not.toMatch(/\.center\(\)/);
  });

  it('the plan shows the desktop before it hides the welcome window, also on the watchdog path', () => {
    const plan = fnBody(desktopAltRs, 'pub fn first_run_reveal_plan(');
    const paintedAt = plan.indexOf('RevealSignal::Painted =>');
    const timedOutAt = plan.indexOf('RevealSignal::TimedOut =>');
    expect(paintedAt).toBeGreaterThan(-1);
    expect(timedOutAt).toBeGreaterThan(paintedAt);
    const painted = plan.slice(paintedAt, timedOutAt);
    const timedOut = plan.slice(timedOutAt);
    inOrder(painted, ['RevealStep::ShowDesktop', 'RevealStep::HideWelcome']);
    expect(painted).not.toContain('LogWatchdog');
    inOrder(timedOut, ['RevealStep::LogWatchdog', 'RevealStep::ShowDesktop', 'RevealStep::HideWelcome']);
    expect(reveal).toContain('DESKTOP_FIRST_RUN_REVEAL_WATCHDOG');
  });

  it('the shell can send the ready signal: the command is registered and the desktop shell calls it', () => {
    expect(mainRs).toContain('commands::desktop_alt::desktop_first_run_takeover_painted,');
    expect(workShell).toContain("invokeFn('desktop_first_run_takeover_painted')");
  });

  it("the ready scene's handoff fade stays under 400ms", () => {
    const at = welcomeCss.indexOf('.hq-welcome .s-ready.on[data-handoff]');
    expect(at).toBeGreaterThan(-1);
    const rule = welcomeCss.slice(at, welcomeCss.indexOf('}', at));
    const ms = Number(/transition:\s*opacity\s+(\d+)ms/.exec(rule)?.[1]);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(400);
  });
});
