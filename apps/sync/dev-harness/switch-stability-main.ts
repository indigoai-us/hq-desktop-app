import { mount } from 'svelte';
import SwitchStabilityHarness from './SwitchStabilityHarness.svelte';
// Same token load order as the real desktop entry, so the stage measures the
// shipped metrics (row font, spacing, scrollbar) rather than browser defaults.
import '../src/styles/design-system.css';
import '../src/styles/popover.css';
import '../src/desktop-alt/styles/desktop-alt.css';

document.documentElement.setAttribute('data-window', 'desktop-alt');
mount(SwitchStabilityHarness, { target: document.getElementById('switch-stability')! });
