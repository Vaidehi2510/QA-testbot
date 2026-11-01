# Reproduce Patchsentry without an account or API key

This is the judge-first demonstration for Patchsentry's QA engine. Its purpose is narrow and observable: show that an exact shipping-boundary defect produces a failed assertion and cannot become a successful QA result because of a report or AI summary.

For the product overview, visit [Patchsentry](https://patchsentry.vercel.app) or the [website repository](https://github.com/Vaidehi2510/patchsentry-web). The public [dashboard demo](https://patchsentry.vercel.app/demo) contains illustrative data; it is not the execution evidence below.

## 1. Run the deterministic demonstration

Prerequisites: Git, Node.js **24** and npm, plus network access for the initial public dependency installation. No Docker, browser installation, database, account, SMTP setup, GitHub token, OpenRouter key or local model is required for this path. The package supports Node22.17+, but Node24 matches the public CI recipe.

```sh
git clone https://github.com/Vaidehi2510/QA-testbot.git
cd QA-testbot
node --version
npm ci --ignore-scripts
npm run demo
```

`node --version` should report `v24.x`. The repository's package lock pins dependencies; the demo itself disables network access in its JavaScript HTTP path and uses temporary synthetic data. The basic fixture is trusted demo code running in a local process. It is not the security boundary used for untrusted product code, which requires the separately configured isolated execution path.

The demo does the following:

1. Runs the healthy synthetic shipping application: four tests pass.
2. Copies it and changes `amount >= 100` to `amount > 100`.
3. Runs the same tests: an order of exactly `$100` incorrectly incurs `$5` shipping, so one test fails.
4. Shows a simulated owner clarification and report preview.
5. Supplies another synthetic revision and confirms that old results/decisions cannot authorize it.

Look for these actual output excerpts (timestamps, run hashes and temporary paths may differ):

```text
1. Successful automated run, no routine human sign-off
Outcome: passed
Tests: 4 total, 4 passed, 0 failed, 0 skipped, 0 cancelled.

2. Intentionally introduced defect: >=100 becomes >100
Outcome: failed
Tests: 4 total, 3 passed, 1 failed, 0 skipped, 0 cancelled.

[REAL failure evidence]
not ok 1 - orders at the documented $100 threshold ship free
  expected: 0
  actual: 5

Demo checks passed. Temporary synthetic data, evidence, and state are cleaned up. No external writes occurred.
```

The **demo program exits successfully because it correctly detected the deliberately failed application test**. That exit code does not reclassify the defective application as passing QA. The final scenario is intentionally blocked because its fresh revision lacks new applicable results/decisions.

| Real in this demo | Simulated or out of scope |
| --- | --- |
| Node test subprocesses, assertions, structured test counts and failure excerpts | GitHub reads/comments/statuses, Slack delivery and Drive uploads; each is marked `MOCK` |
| Temporary source copies, durable fixture state, duplicate handling and revision invalidation | Product deployment identity, a live customer repository and authenticated external services |
| Report rendering from the captured outcomes | A real person's owner response; the sample decision is supplied by the fixture |
| Detection of this one declared boundary defect | Whole-product defect recall, live model diagnosis, browser/device execution and staffing savings |

You may save a local transcript with `npm run demo > demo-output.txt 2>&1`. Do not replace the observed failure with a screenshot of the illustrative public dashboard. The fixture cleans its temporary state and evidence when it finishes.

## 2. Optional AI interface demonstration

```sh
npm run demo:ai
```

This uses the real model adapter/tool-loop interfaces with **scripted model replies** and real fixture tests. It makes no model/network calls or external writes, and incurs no inference charge. It checks bounded source reads, proposed findings/test candidates, duplicate-review handling and a failed deterministic test remaining failed. It does not measure a real model's accuracy, usefulness or operating cost.

Expected checkpoints:

```text
AI QA TEAM DEMO — OpenRouter responses are MOCKED; fixture tests execute for real. No network or credentials.
[REAL executor] 1 test(s) failed (exit 1).
[REAL controller] Duplicate review deduplicated; AI suggestions never override the failed test.
AI demo passed. All temporary artifacts removed; no external writes or model charges.
```

Candidate source-code tests remain inert suggestions in this example. The source-only UI observation is not a browser accessibility audit. Read [AI configuration and limits](ai.md) before explicitly authorizing any live model connection.

## Verification of this quick-start

Both demonstration scripts were rerun successfully with the repository's installed locked dependencies on the macOS development host (Node26.3.1) and in an already prepared Linux/arm64 Node24 container with networking disabled and a read-only repository mount. This checks the demonstrations; dependency installation timing was not measured and no fresh-install timing guarantee is made. The broader product verification below remains a separate layer.

## 3. Read the evidence and limitations

The [verification record](https://github.com/Vaidehi2510/patchsentry-web/blob/main/docs/enterprise-verification.md) separates actual execution, injected provider fixtures, seeded-defect challenges and remaining external validation. It preserves the original four-defect challenge's **two detections and two misses**, plus the later regressions that caught those misses. Follow-up regressions are not new independent held-out recall evidence.

The existing [machine-readable evidence](https://github.com/Vaidehi2510/patchsentry-web/tree/main/docs/evidence/launch) includes pinned source manifests, measured local load/recovery, internal Ledger receipts and original/follow-up evaluation records. These results do not establish production capacity, real Entra/AWS interoperability, independent security assessment or authentic manual-time savings. The optional Java archive service has a scoped adapter but is not deployed by this demo.

## 4. Reproduce broader engine verification separately

Ordinary `npm test` runs the local test suite and may skip separately enrolled browser/Docker integrations. A green basic run does not mean those integrations executed. The authoritative full Linux CI recipe is [`.github/workflows/check.yml`](../.github/workflows/check.yml), which prepares public dependencies before the offline test runtime:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/playwright-core/cli.js install --with-deps chromium firefox webkit
docker build --tag patchsentry-offline-tests:review tools/test-image
QA_AUTONOMY_BROWSER_TEST=1 QA_PORTAL_BROWSER_TEST=1 \
QA_PUBLIC_TEST_IMAGE=patchsentry-offline-tests:review \
QA_WORKSPACE_TEST_IMAGE=patchsentry-offline-tests:review \
node --test --test-concurrency=4 test/*.test.js
```

This extended path needs Docker, Git, Python3, `zip`/`unzip`, browser binaries/system libraries and more time/resources. Initial dependency/browser/image preparation uses the network. Product test containers remain offline. On Linux systems enforcing AppArmor restrictions, use the reviewed Chromium profile step shown in CI; do not disable the browser sandbox. The full workflow also executes real browser demonstrations. See [execution isolation](execution.md) and [autonomous browser setup](autonomous-qa.md).

The GitHub App QA controller remains disabled in the public engine repository. Running any command above does not enable its schedule or connect GitHub, Slack, Drive, Entra, AWS or a paid model account.

## Help improve the project

A useful review can be a reproducibility report, a clarified requirement, a failing regression case, accessible UI feedback or a documentation correction. Record your environment, exact commit, command, expected outcome and actual output in a [GitHub issue](https://github.com/Vaidehi2510/QA-testbot/issues). Do not include credentials, private product code or personal data. Existing public contributions should be credited by their actual issue/PR history; automated AI roles are not evidence of human community participation.
