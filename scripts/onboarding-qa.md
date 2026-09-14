# Repeatable onboarding QA

Run from this repo: `pnpm exec tsx scripts/onboarding-qa.ts`.

In a fresh worktree, first install the frozen workspace dependencies and run
`pnpm --dir apps/work exec svelte-kit sync` to generate its TypeScript config.

This runs the existing card and lifecycle simulator regressions in parallel,
with a 60-second limit per suite. It saves logs, results, and a fresh native
acceptance checklist under `output/onboarding/<timestamp>/`. It never deploys,
creates cloud resources, purchases a plan, or deletes anything.

## Fast iteration (no cloud cleanup)

1. Run the regression command.
2. Start `pnpm --dir apps/sync dev:preview --host 127.0.0.1`.
3. Open `http://127.0.0.1:1422/?view=lifecycle` on the computer. This is the
   production UI with an **in-memory simulated backend**, not native/live E2E.
4. Click through company creation → Starter completion. Reload to reset the
   simulated data, then click **welcome** (the shell remembers the last channel).
5. Reload and test the paid-plan → agent path; no real checkout or agent exists.
6. Repeat with `&role=member` and `&state=blocked` for permissions and errors;
   click **welcome** after changing variants.
7. After a repair, repeat the whole relevant path, not just the final click.

## Native acceptance (separate evidence)

Use the local native build, record its exact version and backend target, and
fill `native-checks.json` from observed UI/API evidence. Record `failed` or
`blocked` with the cause, not `passed`, when the native build still points to an
older backend. A simulator pass is never evidence of native success.

The fixture contains illustrative plan prices and canned cloud/agent responses.
It does not establish current billing rules, successful provisioning, or website
handoff. Verify those separately against the actual authorized backend.

For company persistence, navigate away/back and restart before checking the
same company again. Test website continuation with the same signed-in identity.
For real agents, inspect the company-specific quote first. Stop before a new
recurring charge or access grant until that exact action is approved.

## Resource ledger and bounded cleanup

Use only a uniquely named `HQ Onboarding QA <run>` company for disposable live
tests. Immediately record exact UID, display name, owner, and creation evidence
in the run's resource ledger. Never infer ownership from a name prefix. Never
delete the user's existing Test Onboarding Co.

Reuse the disposable company within a run. Do not repeatedly create/tear down
companies for a label, layout, loading, or validation check: use the simulator.

At the end, spend at most **two minutes** on normal HQ-supported cleanup of the
exact test resources. Verify billed/running agents, company/vault, membership,
and channel separately. Record incomplete phases and the next supported action;
do not begin a raw database investigation. Running/billed resources or access
grants are urgent leftovers; historical receipts and expiring retry records are
not. Report both honestly, and continue local simulation while any urgent live
cleanup remains blocked. Never claim a timeout proves deletion.

No public release or production deployment is part of this workflow.
