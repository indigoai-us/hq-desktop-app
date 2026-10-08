// Daily Brief module. Loaded only through shell/brief-lazy.ts.
export { default as DailyBrief } from "./DailyBrief.svelte";
export { gatherBriefInput, type BriefAdapter, type BriefCompanyRef } from "./brief-data.js";
export { generateBrief } from "./brief-generate.js";
