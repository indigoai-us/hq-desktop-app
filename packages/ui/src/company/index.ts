/** Company area barrel — desktop-alt company surface, platform-pure. */
export { default as CompanyPage } from "./CompanyPage.svelte";
export { default as CompanyBoardPanel } from "./CompanyBoardPanel.svelte";
export { default as CompanyOperationsPanel } from "./CompanyOperationsPanel.svelte";
export { default as CompanyKnowledgePanel } from "./CompanyKnowledgePanel.svelte";
export { default as CompanyLibraryPanel } from "./CompanyLibraryPanel.svelte";
export { default as DeploymentsPanel } from "./DeploymentsPanel.svelte";
export { default as SecretsPanel } from "./SecretsPanel.svelte";
export { default as TeamPanel } from "./TeamPanel.svelte";
export {
  default as DeploymentRow,
  type DeploymentEntry,
  type DeploymentState,
} from "./DeploymentRow.svelte";
export {
  default as SecretEnvRow,
  isSealedSecretEnv,
  type SecretEnv,
  type SecretItem,
} from "./SecretEnvRow.svelte";
export {
  companyStore,
  configureCompanyApi,
  startCompanyStore,
  stopCompanyStore,
  setActiveCompanyResource,
  invalidateCompanyResources,
  isCompanyResourceUnavailable,
  CompanyResourceUnavailableError,
  type CompanyResource,
} from "./company-store.svelte";
export {
  useCompanyBoard,
  emptyCompanyBoard,
  type CompanyBoard,
  type CompanyBoardCard,
} from "./company-board.svelte";
export {
  useCompanySummary,
  emptyCompanySummary,
  type CompanySummary,
} from "./company-summary.svelte";
export * from "./team-telemetry";
export {
  openAgentWorkflow,
  type AgentWorkflowApi,
  type AgentWorkflowResult,
} from "./agent-workflow";
export * from "./company-tabs";
export {
  buildCompanyDisplayMap,
  companyDisplayName,
  looksLikeCompanyUid,
  membershipRowsFrom,
  workspacesFromMembershipRows,
} from "./company-display-map";
