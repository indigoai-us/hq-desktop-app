/**
 * Shared install-choice panel — used by both the New bot wizard's Home step
 * and the setup assistant. One component, one adapter (`install-choice.ts`)
 * so the two surfaces cannot drift.
 */
export { default as InstallChoice } from "./InstallChoice.svelte";
export {
  assistantAvailability,
  assistantOnlyChoices,
  buildChatGptCodexInstallUrl,
  buildClaudeDesktopInstallUrl,
  INSTALL_VIA_CHATGPT_PROMPT,
  INSTALL_VIA_CLAUDE_PROMPT,
  installPanelLede,
  resolveInstallChoices,
} from "./install-choice.js";
// NB: `AiTools` is NOT re-exported here — it is already exposed through the
// `onboarding` barrel and re-emitting it would collide the root `@hq/ui`
// export. Callers who need the type import it from
// `packages/ui/src/settings/setup-launch.js` (the canonical local source)
// or accept it structurally.
export type {
  AssistantId,
  CodingTool,
  InstallChoice as InstallChoiceOption,
  InstallOutcome,
} from "./install-choice.js";
