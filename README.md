# QA Coverage Bot

Makes sure **every intern reviews every PR in a release**, and auto-generates a
**QA plan** for each PR. It lives in its own repo and watches your production
repo through a **GitHub App** — no code is added to the production codebase, and
no AI or paid service is used anywhere.

What it does:

- **Tracks coverage:** for each release PR, who has reviewed it and who hasn't.
- **Generates a QA plan** per PR from its changed files (rule-based, no AI), posts it to the PR and Slack.
- **Alerts new PRs:** posts once in Slack when a new PR needs review.
- **Weekly report:** every Friday, who still hasn't reviewed which PRs.

## Try the demo (no setup)

```bash
npm run demo
```

Runs the real logic against `mock/sample-prs.json` and prints the coverage table,
the Friday report, a new-PR alert, and a generated QA plan. No GitHub or Slack needed.

## The files you fill in

- `roster.json` — your interns as GitHub + Slack name pairs.
- `qa-config.json` — release milestone, label names, sign-off command.
- `qa-rules.json` — the QA-plan rules: file-path patterns → test templates. **Edit this to fit your codebase.**

## How the QA plan works (no AI)

For each PR the bot reads the title, description, and changed file paths. It
matches the paths against the patterns in `qa-rules.json` (e.g. `.tsx` →
"UI / Frontend", `auth` → "Authentication"), then assembles a markdown plan from
the matching templates: areas changed, test steps, regression checks, expected
results. If nothing matches, it falls back to a generic plan. It's posted as a
single comment on the PR (edited, never duplicated) and summarised in Slack, and
saved to `plans/pr-<n>.md`. It only regenerates if the PR's title, description, or
files change.

## Going live

1. **Create a GitHub App** (Settings → Developer settings). Permissions:
   Pull requests **Read & write**, Issues **Read & write**, Contents **Read**, Metadata **Read**.
2. Generate its **private key**; note the **App ID**.
3. **Install the App** on your production repo (an admin does this once).
4. In this repo add — Secrets: `QA_APP_ID`, `QA_APP_PRIVATE_KEY`, `SLACK_WEBHOOK_URL`;
   Variables: `TARGET_OWNER`, `TARGET_REPO`, optional `DRY_RUN` = `true`.
5. Group the release's PRs under a GitHub **milestone** matching `releaseMilestone`.

**Start in dry-run** (`DRY_RUN` = `true`): the bot reports and previews but changes
nothing on the real repo until you trust it.

## Files

```
src/core.js      coverage logic — who reviewed what (pure)
src/planner.js   QA-plan rule engine — files -> markdown plan (pure, no AI)
src/github.js    GitHub App login, fetching PRs/files, posting comments
src/run.js       the every-10-min sync (labels, alerts, plans, dashboard)
src/report.js    the Friday report
src/slack.js     Slack message wording
src/demo.js      local demo against mock data
qa-rules.json    QA-plan rules (edit for your codebase)
qa-config.json   settings
roster.json      your interns (GitHub + Slack names)
plans/           generated QA plans, one file per PR
state/           dedupe memory (alerts + plans), so nothing is posted twice
```

MIT licensed.
