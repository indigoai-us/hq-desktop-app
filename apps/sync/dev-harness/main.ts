import { mount } from 'svelte';
import Harness from './Harness.svelte';
import { announceBadgeEarned, setBadgeProgressSource, setBadgeSource } from '@hq/ui';
import { earnedFromUrl, sampleBadges, sampleProgress } from './badge-fixtures';
// Load the base design tokens (the --pop-* / --c-* primitives + light/dark
// blocks) the same way the real app entry (src/main.ts) does, then the popover
// aliases on top. Without design-system.css the popover's --pop-* tokens are
// undefined in the harness and colors/dark-mode don't render.
import '../src/styles/design-system.css';
import '../src/styles/popover.css';
// The desktop shell loads Geist Mono (src/desktop-alt/main.ts); the knowledge
// tree's ASCII grid, the first-run kickers and the badge marks are drawn in it.
import '@fontsource-variable/geist-mono/wght.css';

// Sample badges on profile panes. Installed before the shell mounts, so the
// production loader (hq-pro GET /v1/badges) stays out of the harness.
setBadgeSource(sampleBadges);
setBadgeProgressSource(sampleProgress);

mount(Harness, { target: document.getElementById('app')! });

// ?earn=<badge>[:<tier>]: the "You earned" notice with its card reveal
// (dev-harness/badge-fixtures.ts).
const earned = earnedFromUrl(window.location.search);
if (earned.length) setTimeout(() => earned.forEach((badge) => announceBadgeEarned(badge)), 1500);
