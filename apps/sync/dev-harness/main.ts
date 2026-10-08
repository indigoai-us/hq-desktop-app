import { mount } from 'svelte';
import Harness from './Harness.svelte';
import { configureBriefSeed, octoberEightBrief } from '@hq/ui';
// Load the base design tokens (the --pop-* / --c-* primitives + light/dark
// blocks) the same way the real app entry (src/main.ts) does, then the popover
// aliases on top. Without design-system.css the popover's --pop-* tokens are
// undefined in the harness and colors/dark-mode don't render.
import '../src/styles/design-system.css';
import '../src/styles/popover.css';
// The desktop shell loads Geist Mono (src/desktop-alt/main.ts); the knowledge
// tree's ASCII grid and the first-run kickers are drawn in it.
import '@fontsource-variable/geist-mono/wght.css';

// The Daily Brief serves the approved mockup's Oct 8 day here: several of its
// sources (shipped PRs, fleet health) have no adapter route the mocks cover.
configureBriefSeed(() => octoberEightBrief(new Date()));

mount(Harness,{ target: document.getElementById('app')! });
