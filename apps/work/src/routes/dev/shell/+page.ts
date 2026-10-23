/**
 * The shell is a client-runtime surface — it reads localStorage (pins, drafts)
 * and hydrates everything it shows after mount, exactly as `/` does. Rendering
 * it on the server buys nothing and breaks the browser-only reads, so this
 * harness route is client-only too.
 */
export const ssr = false;
export const prerender = false;
