/**
 * Finishing a new company from the welcome report stays on that report.
 * Anywhere else, the app opens the company.
 */
export function finishNavigatesToCompany(welcomeConnectPending: boolean): boolean {
  return welcomeConnectPending !== true;
}
