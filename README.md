# Lifecycle

A self-hosted prototype for policy-governed, multi-tenant agentic software delivery. It combines a Next.js control plane, PostgreSQL durable orchestration, outbound tenant runners, Codex, GitHub, and Slack.

**Implemented path:** GitHub issue → discovery → requirements → UI/UX → engineering → testing → pull request → merge → GitHub Actions deployment → release verification and continuous health checks.

This repository contains a working implementation and deterministic acceptance tests. Real Codex/GitHub/Slack/deployment acceptance requires operator credentials and infrastructure; it is not implied by fixture tests.

## Quick start

Requirements: Node.js 22+, npm, Docker with a running daemon, a GitHub account, a GitHub OAuth app (or GitHub App user authorization credentials), and a GitHub App installed on selected repositories. Agent execution additionally requires a runner-host OpenAI API key. The platform never reads your desktop Codex account.

1. `npm ci`
2. Copy `.env.example` to `.env`. Supply long database passwords and `ENCRYPTION_KEY` (`openssl rand -hex 32`). Use matching passwords in the URLs. Keep database URL passwords URL-safe or percent-encode them.
3. Configure `APP_URL` as your externally reachable HTTPS URL (or localhost during initial UI development). Set the GitHub OAuth callback to `APP_URL/api/auth/callback`; enter `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
4. `docker compose up --build -d`. The migration service creates the schema and a non-owner runtime role before web and worker start.
5. From the host, run `npm run db:bootstrap -- YOUR_GITHUB_LOGIN`. The script uses `MIGRATION_DATABASE_URL`, creates **Northstar Engineering** and **Fieldwork Labs**, and invites your GitHub account as admin. Bootstrap is idempotent.
6. Open `APP_URL`, sign in, and configure GitHub in **Connections**. Register a runner in **Runners** and copy its one-time token.
7. Add a project and its explicit autonomy policy. Test its GitHub connection. Add a request in the UI or label a GitHub issue `agent:ready`.

For local development, run only `docker compose up -d postgres`, then `npm run db:migrate`, `npm run dev`, and `npm run worker`. `.env` is loaded by Next.js and the service scripts. GitHub webhooks still require an HTTPS tunnel or hosted control-plane endpoint. The 30-second backlog reconciler can discover ready issues when webhooks are missed.

### Run the tenant runner

Build its isolated execution image: `docker build -f Dockerfile.agent -t lifecycle-agent:local .`.

On the runner host, configure `CONTROL_PLANE_URL`, `RUNNER_TOKEN`, `OPENAI_API_KEY`, optional `CODEX_MODEL`, and `RUNNER_DATA_DIR`, then run `npm run runner`. Use a separate runner host/data directory/token for each tenant. Run this supervisor directly on a Docker host; it is intentionally not given a Docker socket inside the control plane.

The supervisor maintains a private checkout and Codex session directory per run. It mounts only the worktree, stage input/output, and that run’s session state into disposable containers. Git metadata and platform/GitHub credentials stay on the supervisor. A short-lived model gateway injects the provider key server-side; the agent receives only a revocable per-stage gateway token. No other application processes should share the runner host. The gateway supports Responses requests, not arbitrary URL forwarding.

The Codex CLI is pinned to **0.161.0** and checked at stage startup. Explicit session IDs are used for resume; `--last` is never used. Repository text cannot approve privileged operations. GitHub writes are performed by the supervisor/control plane after policy checks, not by the agent container.

## Configuration

### GitHub

Create a GitHub App with selected-repository access:

- Contents: read/write (checkout and agent branches)
- Issues: read/write (backlog, labels, incident issues)
- Pull requests: read/write (PR creation and merge)
- Actions: read/write (workflow dispatch and status)
- Checks and commit statuses: read
- Metadata: read (implicit)

The prototype refuses agent edits to `.github/workflows/` and does not request Workflows permission. GitHub branch rules and environment protections still apply; the platform does not bypass them.

In **Connections**, enter the app ID, installation ID, PEM private key, and a high-entropy webhook secret. Configure the displayed tenant-specific webhook URL and subscribe to Issues events. Enable GitHub App user authorization or configure a separate OAuth app for sign-in. Installation does not grant organization membership.

Webhook signatures are validated over raw bytes; deliveries are durably recorded and deduplicated by tenant/provider/delivery ID. GitHub does not guarantee redelivery, so the worker reconciles ready issues every 30 seconds. Tokens are refreshed automatically and runner checkout/push tokens are narrowed to a repository and Contents access.

### Slack

Create an internal Slack app with Socket Mode enabled. Add the `/lifecycle` slash command, the `app_mention` bot event, and bot scopes `commands`, `app_mentions:read`, `chat:write`. Create an app-level token with `connections:write`. Install the app, invite it to the project channel, and save workspace ID, bot token, and app token in **Connections**. Set `slackChannel` in the project.

Use one project per Slack channel. Unknown users receive a private account-binding link. They must sign in and confirm the link in the correct organization. Permissions are rechecked on every command; emails are not used for account matching.

Commands:

- `/lifecycle request Title | Requirements` — creates a GitHub issue without starting it.
- `/lifecycle start #123` — marks an issue ready; explicitly starting a completed issue creates a new run.
- `/lifecycle answer RUN_ID response` — answers the current question and resumes.
- `/lifecycle cancel RUN_ID` or `resume RUN_ID` — controls execution.
- `/lifecycle message RUN_ID context` — adds instructions for subsequent stages.

Explicit mentions accept the same commands. Ordinary channel conversations are not ingested. Notifications use one Slack thread per run. Socket Mode is intended for internal apps; a public marketplace integration is future work.

### Project configuration

The **Projects** editor accepts validated JSON for execution configuration and policy. It is deliberately explicit in the prototype; convenience forms can be added without changing the API.

```json
{
  "baseBranch": "main",
  "environment": "staging",
  "deployWorkflow": "deploy.yml",
  "rollbackWorkflow": "rollback.yml",
  "healthUrl": "https://reference.example/health",
  "setupCommand": "npm ci",
  "testCommand": "npm test",
  "buildCommand": "npm run build",
  "ui": true,
  "browserCommand": "npm run test:ui",
  "slackChannel": "C0123456789"
}
```

Configured commands run in separate containers without provider or GitHub credentials. Browser verification must write PNG screenshots and optional JSON evidence to `lifecycle-artifacts/`; the supervisor collects bounded regular files only. Keep generated outputs and dependency directories in the application’s `.gitignore`. A UI run without screenshot evidence fails validation.

```json
{
  "actions": ["agent", "push", "merge", "deploy", "rollback", "issue"],
  "branches": ["main"],
  "environments": ["staging"],
  "requiredChecks": ["test"],
  "maxActiveMinutes": 60,
  "maxRepairs": 2
}
```

`branches` names the permitted target branches; generated work branches are always `agent/RUN_ID`. An empty action list denies autonomous actions. At least one required CI check must be configured for automatic merge. Tests and CI must match the exact PR head, and the base must match the recorded checkout base. A changed base pauses the run; reconcile it and start a fresh run so validation is regenerated.

Saving project configuration increments the policy version. Active runs pause; an operator must resume against the reviewed policy. Limits exclude human, external CI, and monitoring waits. Raising an exhausted limit requires an admin policy update. Reported token usage is retained; no exact provider spend cap is claimed.

### Deployment and monitoring

Deploy/rollback workflows must accept string inputs `lifecycle_run_id`, `sha`, and `environment`, and use `run-name: ${{ inputs.lifecycle_run_id }}`. That correlation key lets a restarted worker identify a previously dispatched workflow instead of dispatching it again. The reference workflows implement this contract.

The platform verifies deployment workflow success, then polls health every 60 seconds for a five-minute verification window. Three consecutive failures cause one rollback attempt during that window; outside it they cause an incident only. Automatic rollback requires a previously recorded healthy release. First-release failures without a baseline pause for manual recovery. A successful rollback resumes monitoring of the previous recorded release. Incidents remain open for review.

Health requests have a 10-second timeout and do not follow redirects. Loopback/private destinations require an explicit operator `HEALTH_ALLOWED_HOSTS` entry; tenant admins cannot grant themselves access to arbitrary private infrastructure.

## Verify and demonstrate

- `npm run typecheck` — application, service, and test type checks.
- `npm test` — real PostgreSQL-engine schema/RLS checks using PGlite and deterministic provider fixtures.
- `npm run build` — production Next.js build.
- `npm run test:browser` — desktop/mobile UI and accessibility checks with fixture API responses.
- `npm test --prefix reference-app` — reference application unit test.
- `npm run test:ui --prefix reference-app` — real browser screenshots/accessibility report. Install Chromium first with `npx playwright install chromium`.

See [acceptance procedure](docs/acceptance.md) for live setup, rollback, clarification, interruption, and two-tenant checks. `npm run test:live` is opt-in and makes real external changes; it is never part of normal CI. Fixture success is not evidence that your live GitHub, Slack, Codex account, runner, or deployment credentials work.

## Design and operational boundaries

See [architecture](docs/architecture.md) for interfaces, durability, security boundaries, and recovery behavior.

This is the agreed internal prototype. It does not include Teams, Jira/Azure Boards, arbitrary third-party adapters, multi-repository coordination, custom domains, billing, cloud provisioning, enterprise SSO, or a workflow builder. These are expansion points, not hidden working integrations. It also does not claim VM-grade isolation, HA operations, compliance certification, or enforced dollar budgets.

Containerized agents require trusted project admission and dedicated runner hosts. Production hardening should add stronger execution isolation, secret rotation/retention policies, service-level metrics, outbound network policy, independent penetration testing, and audited operational recovery tools.
