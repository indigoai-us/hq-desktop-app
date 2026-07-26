import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from './projects-model';
import { projectsStore, setProjectStatus } from './projects-store.svelte';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function project(prdPath: string): Project {
  return {
    id: 'duplicate-id',
    title: prdPath.includes('first') ? 'First' : 'Second',
    description: '',
    company: 'indigo',
    status: 'planned',
    prdPath,
    storiesTotal: 0,
    storiesComplete: 0,
  };
}

describe('project status mutation identity', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    projectsStore._reset();
  });

  it('keeps same-id projects isolated by PRD path in IPC writes and optimistic state', async () => {
    const first = project('companies/indigo/projects/first/prd.json');
    const second = project('companies/indigo/projects/second/prd.json');

    await setProjectStatus(first, 'planned', 'active');
    await setProjectStatus(second, 'planned', 'completed');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'set_local_project_status', {
      boardPath: 'companies/indigo/board.json',
      projectId: 'duplicate-id',
      prdPath: first.prdPath,
      status: 'active',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'set_local_project_status', {
      boardPath: 'companies/indigo/board.json',
      projectId: 'duplicate-id',
      prdPath: second.prdPath,
      status: 'completed',
    });
    expect(projectsStore.statusOverride(first)).toBe('active');
    expect(projectsStore.statusOverride(second)).toBe('completed');
  });

  it('serializes same-identity writes and preserves the latest optimistic value', async () => {
    const firstWriteGate = deferred<void>();
    const secondWriteGate = deferred<void>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    invokeMock
      .mockReset()
      .mockImplementationOnce(() => firstWriteGate.promise)
      .mockImplementationOnce(() => secondWriteGate.promise);
    const target = project('companies/indigo/projects/first/prd.json');

    const firstWrite = setProjectStatus(target, 'planned', 'active');
    const secondWrite = setProjectStatus(target, 'active', 'completed');

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(projectsStore.statusPending(target)).toBe(true);
    expect(projectsStore.statusOverride(target)).toBe('completed');

    firstWriteGate.reject(new Error('first write failed'));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expect(projectsStore.statusOverride(target)).toBe('completed');
    expect(projectsStore.statusPending(target)).toBe(true);

    secondWriteGate.resolve();
    await expect(Promise.all([firstWrite, secondWrite])).resolves.toEqual([
      expect.objectContaining({ ok: false, status: 'planned' }),
      expect.objectContaining({ ok: true, status: 'completed' }),
    ]);
    expect(projectsStore.statusOverride(target)).toBe('completed');
    expect(projectsStore.statusPending(target)).toBe(false);
    consoleError.mockRestore();
  });
});
