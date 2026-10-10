import { mount } from 'svelte';
import '@fontsource-variable/geist-mono/wght.css';
import '../src/styles/design-system.css';
import '@hq/ui/button-standard.css';
import '../src/desktop-alt/styles/desktop-alt.css';
import BoardPolishStage from './BoardPolishStage.svelte';

// Dev-only stage for board card, task drawer and company switcher design work.
const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'light' || theme === 'dark') {
  document.documentElement.setAttribute('data-force-theme', theme);
}
document.documentElement.setAttribute('data-window', 'desktop-alt');
mount(BoardPolishStage, { target: document.getElementById('board-polish')! });
