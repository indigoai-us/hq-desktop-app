/**
 * The root shell is a client-rendered app surface (localStorage-seeded rail,
 * MeshClient-style wiring). Disable SSR so the windowed shell hydrates cleanly
 * without a server pass over browser-only state.
 */
export const ssr = false;
