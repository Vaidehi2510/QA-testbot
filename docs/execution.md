# Executing QA checks

The bot runs an essential baseline and the relevant configured checks selected by the deterministic planner. Runner definitions live in reviewed bot configuration. PR descriptions, patches, and comments cannot supply a command, workflow ref, container image, or credential. Required human decisions do not stop independent automated checks.

## Initial supported targets

Use Node.js 22.17 or newer for the bot. The initial runner types are:

| Runner | Configuration | Report |
| --- | --- | --- |
| Node built-in test runner | `{"id":"baseline","type":"node-test","baseline":true,"files":["test/*.test.js"],"timeoutMs":60000}` | The bot invokes `node --test --test-reporter=tap` on sorted matching files. |
| Bot-owned web preview | `{"id":"ui-tests","type":"web-preview","suite":{"targetEnvironment":"preview","url":"https://pr-{pr}.preview.example.com","pages":["/"]}}` | Structured layout/accessibility/resource/journey checks and exact-revision screenshots. |
| npm script | `{"id":"unit","type":"npm-script","script":"test:qa","format":"tap","timeoutMs":60000}` | The chosen script must emit TAP to stdout. npm pre/post lifecycle scripts are disabled. |

Files may be explicit relative paths or globs. No match, a missing script, an unsupported type, an escaping symlink, or a runner crash is an execution error. Browser checks can use a bot-owned `web-preview` suite without adding tests to the product, or a configured Node/npm TAP script in a reviewed image; see [product QA](product-qa.md) and screenshot capture below. JUnit, services requiring external network access, external systems, and model-generated shell commands are unsupported. Configure those checks as human/unsupported and keep the limitation visible.

The default `node:22-bookworm-slim` image supports dependency-free Node projects. CommonJS applications with dependencies need a reviewed, prebuilt image that already contains their test dependencies at `/opt/qa/node_modules`; its `.bin` directory is added to `PATH`, and `NODE_PATH` points to that location. Native ES module package resolution does not use `NODE_PATH`; ES module targets must be dependency-free or bundle their dependencies into the checked-in test artifact in this initial version. Set `execution.image` to the reviewed image, preferably with an immutable digest. Build and review it outside these workflows. No dependency installation or application setup hook runs with credentials. The isolated product-test container has no network access, so those tests must use synthetic fixtures and local mocks. The separate trusted `web-preview` worker visits an explicitly configured disposable preview using a sandboxed browser and bounded origin/method policy; it does not execute target scripts. Source and the container root are read-only; `/tmp` is writable and bounded. Tests that write into the checkout need adaptation or a separately reviewed runner.

## GitHub Actions flow

1. `qa-control.yml` runs in the bot repository. It writes a trusted execution request to `requests/<key>.json` on `qa-state` before dispatching `qa-execute.yml` with only its SHA-256 request key. The workflow ref comes from trusted `executionRef` configuration.
2. The `prepare` job reads that request using the bot's token. The GitHub App downloads the exact target commit archive. It does not extract or execute target code. It uploads the archive, request, and an external SHA-256 source attestation as a short-lived artifact.
3. A fresh `execute` job has no Slack, Drive, or App secrets. It checks out trusted bot code and validates/extracts archive data. Archives with path traversal, links/devices, multiple roots, duplicate files, or excessive sizes are rejected. The reviewed test image is pulled before tests start.
4. For Node/npm suites, the trusted host executor launches a separate Docker container per check, with no network, no added capabilities, no privilege escalation, a non-root user, bounded processes, 512 MiB memory, one CPU, and bounded writable temporary storage. Source is mounted read-only; optional screenshot capture adds a separate empty tmpfs volume capped at 8 MiB and 128 filesystem entries. Trusted requests, attestations, results, credentials, and the Docker socket are not mounted. The host captures stdout/stderr, interprets TAP, and uploads `qa-results-<key>-attempt-<actions-attempt>` with `results.json`, bounded logs, and accepted screenshot files. Each Actions attempt has a separate result artifact, so reruns preserve earlier evidence and cannot accidentally collect it as the new result.
5. For a `web-preview` suite, the execution job installs locked bot browser tooling, then starts a separate bounded worker process with a minimal environment. Chromium uses its native sandbox and a fresh browser context, with no target source mount or integration/model credentials. The worker executes only trusted bot code and declarative suite steps; the preview's page code runs inside the browser. This path intentionally permits configured preview network access and does not use the offline Node/npm container. A missing revision response header blocks attribution to the requested SHA.
6. The `workflow_run` completion event immediately triggers the controller. It validates the triggering workflow and expected run identity before applying results. It executes only default-branch bot code. Ten-minute reconciliation recovers missed events, missing reports, interrupted jobs, and integration retries.

The controller stores exact repository, PR, revision, logical run ID/attempt, Actions run ID/attempt, environment, and timestamps. Node and npm tests execute untrusted PR code; container isolation limits access, but a PR can still change its own assertions. Changes to tests and ambiguous expectations remain visible to planning and human review. Treat these as QA evidence, not a proof against a malicious contributor.

Protect the bot default branch and the `qa-control` GitHub environment. Restrict allowed workflow refs to reviewed bot code. Configure the environment with the target GitHub App secrets and integration secrets. Use GitHub-hosted ephemeral runners, not shared persistent runners. The target App needs repository contents and PR metadata read access, plus the configured comment/label permissions. Bot `GITHUB_TOKEN` needs contents write for `qa-state` and Actions write for dispatch/read for artifacts. No target workflow or target secret is needed.

These boundaries follow [GitHub's workflow security guidance](https://docs.github.com/en/actions/reference/security/secure-use) and Docker's documented [container restrictions](https://docs.docker.com/engine/containers/run/) and [network isolation](https://docs.docker.com/engine/network/drivers/none/).

## Outcome rules and limits

A zero exit code alone is insufficient. A TAP plan must match observed results and contain at least one test. Failed assertions produce `failed`; skipped/TODO tests produce `skipped`; missing/inconsistent output, timeout, cancellation, output overflow, or runner startup errors produce `execution_error`. Human and unsupported checks remain in the plan and are evaluated separately by the controller. An absent report or canceled Actions job cannot complete QA. Any skipped required coverage remains incomplete. The controller calculates the final outcome from structured results and revision-bound decisions.

Each runner has a timeout (default 60 seconds, hard maximum 10 minutes). The workflow has a 30-minute execution-job timeout. Output is capped at 512 KiB per check, with a 6,000-character evidence excerpt. A timeout kills the process group and removes the container. Source archives are limited to 100 MiB compressed, 250 MiB expanded, 25 MiB per file, and 30,000 entries.

## Screenshot evidence for AI UI/UX review

Set `execution.captureScreenshots: true` in trusted bot configuration and choose a reviewed, prebuilt `execution.image` containing your application test dependencies, Playwright package, browser binaries, and browser system dependencies. The default Node image does not include a browser. The image must work under the existing non-root, read-only, offline container restrictions and resource limits. Build it outside the QA workflow; the executor does not install packages or browser binaries. Playwright's [Docker documentation](https://playwright.dev/docs/docker) describes what its base images contain.

Register a Node/npm TAP runner for UI checks. For example, a target repository can expose `test:qa:ui` as `node --test --test-reporter=tap test/ui-qa.test.cjs`. Its test starts the application inside the same container, binds to loopback, exercises synthetic data, asserts expected behavior, and captures a named state:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestApp } = require('../test-support/app'); // Supply your app's test server.

test('mobile checkout exposes the purchase action', async (t) => {
  const app = await startTestApp({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`http://127.0.0.1:${app.port}/checkout`);
  const purchase = page.getByRole('button', { name: 'Place order' });
  await purchase.waitFor({ state: 'visible' });
  await page.screenshot({ path: '/qa-evidence/checkout-mobile.png' });
  assert.equal(await purchase.isEnabled(), true);
});
```

`startTestApp` is a project-specific helper returning `{port, close}` after the application is ready. Keep fixtures, assets, and mocks inside the container. External URLs and remote browser endpoints are unavailable under `--network=none`. Screenshot capture follows Playwright's [screenshot API](https://playwright.dev/docs/screenshots); the script's assertions still determine TAP pass/fail.

The executor creates a fresh `/qa-evidence` tmpfs volume for each check, with an 8 MiB aggregate storage quota and 128-inode limit while tests run. A separate trusted Node helper holds the volume read-only so its contents survive the test container stopping. After the test stops, the helper copies bounded candidate images through stdout to host validation. The helper has no source, configuration, results, or credential mounts; it is offline, non-root, and limited to 128 MiB memory. The executor removes the helper and volume after collection, including failure paths.

Only top-level PNG/JPEG regular files are accepted: four screenshots and 6 MiB total per run, at most 2 MiB per file, at most 16 million pixels, and no links or nested directories. These image limits apply during evidence collection; they do not limit browser temporary files, which remain in the existing bounded `/tmp`. Malformed signatures, invalid dimensions, missing captures, and collection limits appear in `screenshotLimitations`; they do not become visual success. The tmpfs lifecycle and helper commands have mocked control-flow tests; live Docker/browser capture still needs verification with your reviewed image.

Accepted files are copied by the host to `screenshots/<sha256>.png` or `.jpg`. `results.json.screenshots` records `name`, `path`, `mimeType`, `sha256`, `revision`, and `checkId`; it contains no image base64. The controller verifies artifact identity and hashes before supplying screenshots to the selected image-capable UI/UX model when `ai.allowImages` is enabled. Source-only UI/UX review remains available without screenshots. Captures show only the states exercised by your configured test scripts; they do not establish coverage of every screen or interaction.

## Local verification

`npm run demo:web` exercises real Chromium against a temporary local product fixture, detects intentional accessibility/layout/asset/console defects, then verifies the corrected page and synthetic interaction journey. Install the locked browser packages and Chromium first, or specify `QA_BROWSER_EXECUTABLE`. Browser screenshot and audit verification are independent of model calls. See [bot-owned browser suites](product-qa.md).


`npm run demo` copies the synthetic application under `fixtures/tiny-app` to an isolated temporary directory. Its requirement is that an order of at least $100 ships free. Changing `>= 100` to `> 100` introduces a defect that the real Node runner detects; a mock runner is not used for this evidence. `node --test test/executor.test.js` verifies the defect and runner failure cases.

For offline execution against an exact clean git checkout:

```sh
node src/execute.js --request trusted-request.json --checkout /path/to/clean/checkout --output /tmp/qa-results
```

Docker must be running and the configured image must already be pulled. The request is `{ "plan": { "checks": [...] }, "config": { "runners": [...] }, "metadata": { "repository": "owner/repo", "prNumber": 1, "revision": "40-character-sha", "runId": "logical-run-key", "attempt": 1, "environment": "local-container" } }`. The executor checks the actual git revision, rejects dirty checkouts (including ignored local files), and creates a temporary source snapshot without `.git` before mounting it. This keeps local Git credential configuration outside the test container.

Only explicitly trusted local fixtures can use process isolation: both `metadata.fixture: true` and `--allow-local-fixture` are required, with `config.execution.isolation: "process"`. This mode records fixture provenance, strips inherited credentials, and is used by the credential-free demo/tests. It is not an isolation boundary for untrusted code. Remote preparation forcibly disables it.

Activation remains off by default. Set `QA_ENABLED=true` (or `config.enabled=true`) and `DRY_RUN=false` only during a separately authorized deployment. `DRY_RUN` prevents dispatch and all integration writes. Configure target, Drive, Slack, identity mapping, and protected environment before activation. Local execution tests do not establish that live GitHub Actions, Slack, or Drive configuration is correct.
