/**
 * The only door into company Outpost jobs.
 * The shell imports the host; this chunk loads on first open.
 */
type CompanyJobsModule = typeof import("../outpost/CompanyJobsPage.svelte");

let pending: Promise<CompanyJobsModule> | null = null;

export function loadCompanyJobs(): Promise<CompanyJobsModule> {
  pending ??= import("../outpost/CompanyJobsPage.svelte").catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
