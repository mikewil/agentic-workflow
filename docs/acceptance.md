# Acceptance procedure

## Local automated acceptance

Run `npm run check`, install a Playwright Chromium browser, then run `npm run test:browser`. PostgreSQL-engine tests verify actual row-level policies, API authorization, durable queue admission, runner leases, limits, questions, side-effect reconciliation, head/base validation, full fixture lifecycle, incidents, and bounded rollback. Browser tests use explicitly stubbed API responses, not live provider claims.

The reference app is independent: `npm ci --prefix reference-app`, `npm test --prefix reference-app`, `npm run test:ui --prefix reference-app`.

## Prepare a live project

1. Copy **the contents** of `reference-app/` (including `.github/` and `.gitignore`) into an operator-selected GitHub repository and commit them to `main`. Do not use the platform repository as the demo application.
2. Install your GitHub App on that repository. Enable squash merges; ensure its branch rules permit the configured app to merge after the `test` check. Install a GitHub Actions runner with labels `self-hosted,lifecycle-reference` on a dedicated Docker host. This host serves the reference application on port 8080; provide an operator-managed HTTPS proxy or reachable health URL.
3. Create a `staging` GitHub environment. Its protection rules must permit the desired autonomy. Keep app and CI secrets in GitHub or the CI host; the agent containers do not receive them.
4. Configure the project with `deploy.yml`, `rollback.yml`, required check `test`, the health URL, and the example commands/policy in README. Configure a Slack channel if testing messaging.
5. Register/start a Lifecycle tenant runner separately from the GitHub Actions deployment runner. Ensure its image is built and its provider API key is configured.
6. Verify GitHub connection diagnostics, runner last-seen state, and Slack account binding.

## Healthy lifecycle

Create an issue asking for a small accessible feature. Add `agent:ready`. Verify discovery/profile, requirements, design evidence, an agent branch/PR, independent validation, matching GitHub checks, a merge at the expected head, a correlated deployment workflow, and five minutes of health verification. Inspect artifacts and the Slack thread. The run should finish `succeeded`.

Alternatively run:

```sh
LIVE_ACCEPT_EXTERNAL_WRITES=yes \
LIVE_TENANT_ID=YOUR_TENANT_ID \
LIVE_PROJECT_ID=YOUR_PROJECT_ID \
npm run test:live
```

This script creates an issue and relies on the running worker/runner. It may cause real PR, merge, deployment, and Slack activity according to project policy. It stops with an actionable URL if input is needed. It does not bypass approval or configuration.

## Clarification and controls

Create an issue with materially ambiguous behavior. Verify the run waits with a persisted question. Answer in the UI, then repeat on another issue using `/lifecycle answer RUN_ID ...`. Check that unauthorized/unlinked Slack users cannot answer, cancel, or resume. Add contextual instructions and verify the next stage receives them. Cancel an active agent run and verify the supervisor removes its container.

## Rollback and later incidents

First complete a healthy run so there is a known release to restore. Set the reference repository variable `REFERENCE_BREAK_HEALTH=true`, then run a second small change. The deploy workflow starts an unhealthy instance while reporting successful deployment. Three checks within the verification window must create one incident and trigger one rollback to the previous recorded SHA. The rollback workflow explicitly disables broken health. Verify the previous release resumes monitoring, then remove/reset the variable.

For a failure outside the release window, make the deployed health endpoint return failure after a successful verification. Verify one incident and Slack notification, with no automatic rollback. Fail a rollback workflow in a controlled environment and verify the run pauses without repeated dispatch.

## Isolation and interrupted execution

Switch between the two seeded organizations. Configure distinct branding and project visibility. Create separate Viewer and Operator invitations. Verify that Viewer cannot mutate and tenant A cannot request tenant B’s runs, artifacts, event stream, or runner job. Automated tests cover these denial paths at both API and RLS layers.

Stop a runner during a job. The lease should expire, pause the run, and avoid duplicate scheduling. Stop the old container and restore the same runner data before resuming. Restart the orchestration worker after a workflow dispatch; verify that it finds the correlated workflow instead of issuing another dispatch. An unknown outcome must remain paused until provider state can establish what happened.

## Evidence record

Keep run IDs, PR/workflow URLs, screenshot/accessibility artifacts, and incident IDs. Record which tests used fixtures and which used live providers. Do not claim live acceptance until these provider-backed exercises have actually passed.
