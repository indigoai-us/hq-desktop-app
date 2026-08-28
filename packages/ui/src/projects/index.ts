/** Projects area — portfolio Kanban, goals, and project detail (desktop-alt port). */
export { default as CompanyProjectsPage } from "./CompanyProjectsPage.svelte";
export { default as CompanyGoalsPage } from "./CompanyGoalsPage.svelte";
export { default as ProjectDetailView } from "./ProjectDetailView.svelte";
export { default as ProjectListView } from "./ProjectListView.svelte";
export { default as ProjectRow } from "./ProjectRow.svelte";
export { default as StoryCard } from "./StoryCard.svelte";
export { default as StoryDetailPanel } from "./StoryDetailPanel.svelte";
export { default as StoryKanban } from "./StoryKanban.svelte";
export { default as StoryList } from "./StoryList.svelte";
export { default as BoardCard } from "./BoardCard.svelte";
export * from "./projects-model.js";
export * from "./local-projects.js";
export {
  projectsStore,
  setProjectStatus,
  setStoryPasses,
  boardPathFor,
  type StatusWriteResult,
  type PassesWriteResult,
} from "./projects-store.svelte.js";
