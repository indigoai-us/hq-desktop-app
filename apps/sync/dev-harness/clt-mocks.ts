/**
 * Apple developer tools card preview for the welcome flow.
 * `?view=onboarding&clt=missing`: the tools stay missing, so setup waits on the
 * installing card. `&clt=cancelled`: Apple's installer opens, then closes
 * without the tools, so the card turns into its retry state. Without `clt`,
 * the tools are present and no card shows.
 */
import { NOT_HANDLED } from './company-flow-mocks';

let installerOpenPolls = 0;

function mode(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('clt');
}

export function commandLineToolsAnswer(cmd: string): unknown {
  if (!cmd.startsWith('command_line_tools_')) return NOT_HANDLED;
  const m = mode();
  if (cmd === 'command_line_tools_show_installer') return m === 'cancelled' && installerOpenPolls < 2;
  if (m === 'missing') {
    return { required: true, present: false, installerOpen: false, simulated: true };
  }
  if (m === 'cancelled') {
    const open = cmd === 'command_line_tools_start_install' || (installerOpenPolls > 0 && installerOpenPolls < 2);
    if (cmd === 'command_line_tools_start_install') installerOpenPolls = 1;
    else if (installerOpenPolls > 0) installerOpenPolls += 1;
    return { required: true, present: false, installerOpen: open, simulated: false };
  }
  return { required: false, present: true, installerOpen: false, simulated: false };
}
