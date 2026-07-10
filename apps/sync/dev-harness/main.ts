import { mount } from 'svelte';
import Harness from './Harness.svelte';
// Load the base design tokens (the --pop-* / --c-* primitives + light/dark
// blocks) the same way the real app entry (src/main.ts) does, then the popover
// aliases on top. Without design-system.css the popover's --pop-* tokens are
// undefined in the harness and colors/dark-mode don't render.
import '../src/styles/design-system.css';
import '../src/styles/popover.css';

mount(Harness, { target: document.getElementById('app')! });
