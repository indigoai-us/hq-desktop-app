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
const onboarding = read('src/components/Onboarding.svelte');
const wizard = read('src/components/onboarding/OnboardingWizard.svelte');

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

  it("the ready screen's automatic finish reaches the held reveal", () => {
    // The ready screen has no button: its auto-finish effect finishes once,
    // through finishWithRecovery, which calls onfinish.
    const autoFinish = wizard.slice(wizard.indexOf("if (consentOnly || replay || currentStep !== READY_STEP_INDEX || scene !== 'ready') return;"));
    inOrder(autoFinish, ['autoFinishAttempted = true;', 'void finishWithRecovery()']);
    inOrder(fnBody(wizard, 'async function finishWithRecovery('), ['await onfinish?.();']);
    // onfinish is Onboarding's handleFinish, which opens the desktop through
    // the command that holds the welcome card until the takeover painted.
    inOrder(onboarding, ['onfinish={handleFinish}']);
    const finish = fnBody(onboarding, 'async function handleFinish(');
    inOrder(finish, ["invoke('mark_first_run_complete')", "await invoke('show_main_window_at_tray');"]);
    expect(finish).not.toContain('open_desktop_alt_window');
    expect(mainRs).toContain('commands::first_run::show_main_window_at_tray,');
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
      'arm_desktop_visible()',
      'first_run_reveal_plan(signal)',
      'RevealStep::ShowDesktop',
      'reveal_desktop_alt_window(&window)',
      'RevealStep::AwaitDesktopVisible',
      'await_desktop_on_screen(rx, DESKTOP_VISIBLE_TIMEOUT, DESKTOP_COMPOSITE_MARGIN)',
      'RevealStep::HideWelcome',
      'crate::tray::hide_onboarding_window(&app)',
    ]);
    // The only hide is the plan's last step, after both waits: the painted
    // report, then the shell's report that the shown desktop is on screen.
    const waitAt = reveal.indexOf('await_takeover_painted(');
    const onScreenAt = reveal.indexOf('await_desktop_on_screen(');
    expect(onScreenAt).toBeGreaterThan(waitAt);
    expect(reveal.indexOf('hide_onboarding_window')).toBeGreaterThan(onScreenAt);
    expect(reveal.split('hide_onboarding_window').length - 1).toBe(1);
    // Shown through the placed reveal, never centred a second time.
    expect(reveal).not.toMatch(/\.center\(\)/);
  });

  it('the plan shows the desktop before it hides the welcome window, also on the watchdog path', () => {
    const plan = fnBody(desktopAltRs, 'pub fn first_run_reveal_plan(');
    // The watchdog path only adds the log step in front of the shared tail.
    const guardAt = plan.indexOf('if signal == RevealSignal::TimedOut {');
    expect(guardAt).toBeGreaterThan(-1);
    const painted = fnBody(plan.slice(guardAt), 'if signal == RevealSignal::TimedOut');
    const tail = plan.slice(guardAt + painted.length);
    // Both paths share the tail: show, wait until the desktop is on screen, hide.
    expect(painted).toContain('plan.push(RevealStep::LogWatchdog)');
    inOrder(tail, ['RevealStep::ShowDesktop', 'RevealStep::AwaitDesktopVisible', 'RevealStep::HideWelcome']);
    expect(tail).not.toContain('LogWatchdog');
    expect(reveal).toContain('DESKTOP_FIRST_RUN_REVEAL_WATCHDOG');
    expect(reveal).toContain('DESKTOP_FIRST_RUN_VISIBLE_WATCHDOG');
  });

  it('the shell can send the ready signal: the command is registered and the desktop shell calls it', () => {
    expect(mainRs).toContain('commands::desktop_alt::desktop_first_run_takeover_painted,');
    expect(workShell).toContain("invokeFn('desktop_first_run_takeover_painted')");
  });

  it('the shell waits for the held route longer than the host holds it, so a slow flag read still lands its hint', () => {
    const hostWait = Number(/const PENDING_ROUTE_WAIT[^=]*=\s*std::time::Duration::from_millis\((\d+)\)/.exec(desktopAltRs)?.[1]);
    const shellWait = Number(/const HANDOFF_READ_TIMEOUT_MS = (\d+(?:_\d+)*);/.exec(workShell)?.[1].replace(/_/g, ''));
    expect(hostWait).toBeGreaterThan(0);
    expect(shellWait).toBeGreaterThan(hostWait);
  });
});
