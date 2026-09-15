// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('svelte', async () => {
  // @ts-expect-error Browser entry for mounted tests.
  return await import('../../../node_modules/svelte/src/index-client.js');
});
import { mount, unmount, flushSync } from 'svelte';
import SetupConnectStep from '../../../../../packages/ui/src/chat/SetupConnectStep.svelte';
let component: ReturnType<typeof mount>;
afterEach(async () => { if (component) await unmount(component); document.body.innerHTML = ''; });
async function settle() { for (let i=0;i<8;i++) { await Promise.resolve(); flushSync(); } }
function render(install = vi.fn().mockResolvedValue('installed')) {
 const login = vi.fn().mockResolvedValue({state:'connected'});
 const refresh = vi.fn().mockResolvedValue(undefined);
 component = mount(SetupConnectStep, {target:document.body,props:{api:{providerInstall:install,providerLoginStart:login} as any,providers:{hqReady:true,claudeAvailable:false,claudeLoggedIn:false,codexAvailable:false,codexLoggedIn:false},onrefresh:refresh}});
 flushSync();
 (document.querySelector('[data-testid="setup-connect-claude-signin"]') as HTMLButtonElement).click();
 return {login,refresh};
}
describe('welcome missing runtime recovery',()=>{
 it('installs the runtime before starting vendor login',async()=>{
  let finish!:()=>void;
  const install=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const {login,refresh}=render(install);await settle();
  expect(install).toHaveBeenCalledWith('claude');expect(login).not.toHaveBeenCalled();
  finish();await settle();expect(refresh).toHaveBeenCalled();expect(login).toHaveBeenCalledWith('claude');
 });
 it('does not start login after failed installation and offers retry',async()=>{
  const {login}=render(vi.fn().mockRejectedValue(new Error('private details')));await settle();
  expect(login).not.toHaveBeenCalled();expect(document.body.textContent).toContain('Could not connect the coding tool');
  expect(document.body.textContent).not.toContain('private details');expect(document.body.textContent).toContain('Try again');
 });
});
