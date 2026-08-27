/**
 * HQ Work install detection + launcher + handoff flag.
 *
 * Thin invoke wrappers. Detection is state, not a setup trigger: callers
 * must not treat `hq_work_installed` as a reason to open onboarding.
 *
 * Invoker is injectable so unit tests never hit Tauri.
 */

import { invoke } from '@tauri-apps/api/core';

export const HQ_WORK_BUNDLE_ID = 'ai.getindigo.hq-work';

export type HqWorkInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export function hqWorkHandoffEnabled(
  flag: boolean | null | undefined,
): boolean {
  return flag === true;
}

export async function detectHqWorkInstalled(
  invokeFn: HqWorkInvoker = invoke as HqWorkInvoker,
): Promise<boolean> {
  return invokeFn<boolean>('hq_work_installed');
}

export async function launchHqWork(
  invokeFn: HqWorkInvoker = invoke as HqWorkInvoker,
  url?: string | null,
): Promise<void> {
  await invokeFn<void>('launch_hq_work', { url: url ?? null });
}

export async function getHqWorkHandoff(
  invokeFn: HqWorkInvoker = invoke as HqWorkInvoker,
): Promise<boolean> {
  return invokeFn<boolean>('get_hq_work_handoff');
}

export async function setHqWorkHandoff(
  invokeFn: HqWorkInvoker,
  enabled: boolean,
): Promise<void> {
  await invokeFn<void>('set_hq_work_handoff', { enabled });
}

export async function installHqWork(
  invokeFn: HqWorkInvoker = invoke as HqWorkInvoker,
): Promise<void> {
  await invokeFn<void>('install_hq_work');
}

export async function getHqWorkHandoffCardShown(
  invokeFn: HqWorkInvoker = invoke as HqWorkInvoker,
): Promise<boolean> {
  return invokeFn<boolean>('get_hq_work_handoff_card_shown');
}
