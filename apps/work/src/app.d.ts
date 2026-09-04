// See https://svelte.dev/docs/kit/types#app.d.ts
/// <reference types="vite/client" />
import type { Session } from "$lib/server/auth";

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      /** Verified Cognito session (safe fields only — never the token). */
      session: Session | null;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
