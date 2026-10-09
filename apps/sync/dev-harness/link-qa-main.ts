import { mount } from 'svelte';
import LinkQaHarness from './LinkQaHarness.svelte';
import '../src/styles/design-system.css';
import '../src/styles/popover.css';
import '../src/desktop-alt/styles/desktop-alt.css';
import '../../../packages/ui/src/chat/chat-tokens.css';

// ?theme=dark|light forces the theme the same way the app's appearance setting does.
const theme = new URLSearchParams(location.search).get('theme') ?? 'light';
document.documentElement.setAttribute('data-force-theme', theme);
document.documentElement.setAttribute('data-window', 'desktop-alt');
mount(LinkQaHarness, { target: document.getElementById('link-qa')! });
