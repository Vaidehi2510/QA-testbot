# Executing QA checks

The bot runs an essential baseline and the relevant configured checks selected by the deterministic planner. Runner definitions live in reviewed bot configuration. PR descriptions, patches, and comments cannot supply a command, workflow ref, container image, or credential. Required human decisions do not stop independent automated checks.

## Initial supported targets

Use Node.js 22.17 or newer for the bot. The initial runner types are:

| Runner | Configuration | Report |
| --- | --- | --- |
| Node built-in test runner | `{"id":"baseline","type":"node-test","baseline":true,"files":["test/*.test.js"],"timeoutMs":60000}` | The bot invokes `node --test --test-reporter=tap` on sorted matching files. |
| npm script | `{"id":"unit","type":"npm-script","script":"test:qa","format":"tap","timeoutMs":60000}` | The chosen script must emit TAP to stdout. npm pre/post lifecycle scripts are disabled. |

Files may be explicit relative paths or globs. No match, a missing script, an unsupported type, an escaping symlink, or a runner crash is an execution error. JUnit, browser automation, services requiring network access, external systems, and arbitrary shell commands are not supported in this first version. Configure those checks as human/unsupported and keep the limitation visible.

The default `node:22-bookworm-slim` image supports dependency-free Node projects. CommonJS applications with dependencies need a reviewed, prebuilt image that already contains their test dependencies at `/opt/qa/node_modules`; its `.bin` directory is added to `PATH`, and `NODE_PATH` points to that location. Native ES module package resolution does not use `NODE_PATH`; ES module targets must be dependency-free or bundle their dependencies into the checked-in test artifact in this initial version. Set `execution.image` to the reviewed image, preferably with an immutable digest. Build and review it outside these workflows. No dependency installation or application setup hook runs with credentials. The isolated container has no network access, so tests must use synthetic fixtures and local mocks. Source and the container root are read-only; `/tmp` is writable and bounded. Tests that write into the checkout need adaptation or a separately reviewed runner.

## GitHub Actions flow

1. `qa-control.yml` runs in the bot repository. It writes a trusted execution request to `requests/<key>.json` on `qa-state` before dispatching `qa-execute.yml` with only its SHA-256 request key. The workflow ref comes from trusted `executionRef` configuration.
2. The `prepare` job reads that request using the bot's token. The GitHub App downloads the exact target commit archive. It does not extract or execute target code. It uploads the archive, request, and an external SHA-256 source attestation as a short-lived artifact.
3. A fresh `execute` job has no Slack, Drive, or App secrets. It checks out trusted bot code and validates/extracts archive data. Archives with path traversal, links/devices, multiple roots, duplicate files, or excessive sizes are rejected. The reviewed test image is pulled before tests start.
4. The trusted host executor launches a separate Docker container per check, with no network, no added capabilities, no privilege escalation, a non-root user, bounded processes, 512 MiB memory, one CPU, and bounded writable temporary storage. Only source is mounted; trusted requests, attestations, results, credentials, and the Docker socket are not mounted. The host captures stdout/stderr, interprets TAP, and uploads `qa-results-<key>-attempt-<actions-attempt>` with `results.json` plus bounded logs. Each Actions attempt has a separate result artifact, so reruns preserve earlier evidence and cannot accidentally collect it as the new result.
5. The `workflow_run` completion event immediately triggers the controller. It validates the triggering workflow and expected run identity before applying results. It executes only default-branch bot code. Ten-minute reconciliation recovers missed events, missing reports, interrupted jobs, and integration retries.

The controller stores exact repository, PR, revision, logical run ID/attempt, Actions run ID/attempt, environment, and timestamps. Node and npm tests execute untrusted PR code; container isolation limits access, but a PR can still change its own assertions. Changes to tests and ambiguous expectations remain visible to planning and human review. Treat these as QA evidence, not a proof against a malicious contributor.

Protect the bot default branch and the `qa-control` GitHub environment. Restrict allowed workflow refs to reviewed bot code. Configure the environment with the target GitHub App secrets and integration secrets. Use GitHub-hosted ephemeral runners, not shared persistent runners. The target App needs repository contents and PR metadata read access, plus the configured comment/label permissions. Bot `GITHUB_TOKEN` needs contents write for `qa-state` and Actions write for dispatch/read for artifacts. No target workflow or target secret is needed.

These boundaries follow [GitHub's workflow security guidance](https://docs.github.com/en/actions/reference/security/secure-use) and Docker's documented [container restrictions](https://docs.docker.com/engine/containers/run/) and [network isolation](https://docs.docker.com/engine/network/drivers/none/).

## Outcome rules and limits

A zero exit code alone is insufficient. A TAP plan must match observed results and contain at least one test. Failed assertions produce `failed`; skipped/TODO tests produce `skipped`; missing/inconsistent output, timeout, cancellation, output overflow, or runner startup errors produce `execution_error`. Human and unsupported checks remain in the plan and are evaluated separately by the controller. An absent report or canceled Actions job cannot complete QA. Any skipped required coverage remains incomplete. The controller calculates the final outcome from structured results and revision-bound decisions.

Each runner has a timeout (default 60 seconds, hard maximum 10 minutes). The workflow has a 30-minute execution-job timeout. Output is capped at 512 KiB per check, with a 6,000-character evidence excerpt. A timeout kills the process group and removes the container. Source archives are limited to 100 MiB compressed, 250 MiB expanded, 25 MiB per file, and 30,000 entries.

## Local verification

`npm run demo` copies the synthetic application under `fixtures/tiny-app` to an isolated temporary directory. Its requirement is that an order of at least $100 ships free. Changing `>= 100` to `> 100` introduces a defect that the real Node runner detects; a mock runner is not used for this evidence. `node --test test/executor.test.js` verifies the defect and runner failure cases.

For offline execution against an exact clean git checkout:

```sh
node src/execute.js --request trusted-request.json --checkout /path/to/clean/checkout --output /tmp/qa-results
```

Docker must be running and the configured image must already be pulled. The request is `{ "plan": { "checks": [...] }, "config": { "runners": [...] }, "metadata": { "repository": "owner/repo", "prNumber": 1, "revision": "40-character-sha", "runId": "logical-run-key", "attempt": 1, "environment": "local-container" } }`. The executor checks the actual git revision, rejects dirty checkouts (including ignored local files), and creates a temporary source snapshot without `.git` before mounting it. This keeps local Git credential configuration outside the test container.

Only explicitly trusted local fixtures can use process isolation: both `metadata.fixture: true` and `--allow-local-fixture` are required, with `config.execution.isolation: "process"`. This mode records fixture provenance, strips inherited credentials, and is used by the credential-free demo/tests. It is not an isolation boundary for untrusted code. Remote preparation forcibly disables it.

Activation remains off by default. Set `QA_ENABLED=true` (or `config.enabled=true`) and `DRY_RUN=false` only during a separately authorized deployment. `DRY_RUN` prevents dispatch and all integration writes. Configure target, Drive, Slack, identity mapping, and protected environment before activation. Local execution tests do not establish that live GitHub Actions, Slack, or Drive configuration is correct.
