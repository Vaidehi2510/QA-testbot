# Testing a product without changing its code

Keep the bot in a separate repository. Install its GitHub App on the product with **Contents read**, metadata/PR read, and the permissions needed to write PR comments, labels, and commit statuses. The App does not need Contents write, workflow write, branch write, or merge authority. The bot's own repository token stores state and dispatches its workflows; the controller rejects using the product repository as its bot-state repository.

The normal `targetAccess: "report-status"` mode publishes plans and results on the product PR. Optional `targetAccess: "read-only"` suppresses even those metadata writes. Neither mode provides a tool that edits product files, commits fixes, pushes branches, or merges a PR. Suggested patches and generated tests stay in reports or the bot workspace.

## Choose specific PRs

Configure `scope.prNumbers` in the bot's `qa-config.json`, for example:

```json
{ "scope": { "prNumbers": [42, 57] }, "targetAccess": "report-status" }
```

Explicit numbers bypass label/milestone discovery. A `PR_NUMBER` environment variable or the controller workflow's `pr_number` input selects one PR instead. Without an explicit list, the existing label/milestone selection applies. The bot reads each selected PR's exact head commit and invalidates results when that commit changes.

For PR #42, the workflow is:

1. Read its changes, requirements, surrounding code, and existing tests using the App's read permissions.
2. Have AI specialists identify affected journeys, select approved test suites, and propose missing assertions.
3. Run product tests against an isolated snapshot, and run bot-owned browser suites against its disposable PR preview.
4. Record failing assertions, browser errors, accessibility findings, screenshots, skipped coverage, and model suggestions separately.
5. Post the exact-SHA status/comment, update labels, and retain evidence in the bot's artifacts and configured reports.
6. Recheck the next commit. Ask an expert only when requirements are unresolved or a significant finding needs interpretation.

Default CSS rules no longer impose a routine human visual sign-off. Configured browser assertions establish automated UI outcomes. AI enhancement suggestions remain advisory; a subjective preference is not automatically a confirmed defect.

## Automated web UI QA

The `web-preview` runner is maintained entirely in the bot. It uses Playwright Chromium and axe to check:

- Configured desktop/mobile viewport layouts and horizontal overflow.
- Automated WCAG accessibility rules, such as missing input labels.
- Broken images, failed HTTP resources, console errors, and uncaught exceptions.
- Explicit interaction journeys and expected visible text, controls, and navigation.
- Screenshots for the image-capable AI reviewer to investigate and suggest improvements.

A suite does not have to be added to the product repository. Start with [examples/web-suite.json](../examples/web-suite.json), replace the preview URL, and add the product's page paths and expected journeys. Example:

```json
{
  "targetEnvironment": "preview",
  "url": "https://pr-{pr}.preview.example.com",
  "revisionHeader": "x-qa-revision",
  "pages": ["/checkout"],
  "viewports": [
    { "name": "desktop", "width": 1440, "height": 900 },
    { "name": "mobile", "width": 390, "height": 844 }
  ],
  "allowedOrigins": [],
  "allowMutations": false,
  "journeys": [
    {
      "name": "Invalid email is explained",
      "start": "/checkout",
      "steps": [
        { "action": "fill", "selector": "#email", "value": "invalid" },
        { "action": "click", "role": "button", "name": "Place order" },
        { "action": "expectText", "selector": "#email-error", "text": "Enter a valid email" }
      ]
    }
  ]
}
```

Only `{pr}` and `{sha}` substitutions are supported in a trusted URL template. Each journey must contain an assertion. Supported steps are `click`, `fill`, `press`, `expectVisible`, `expectText`, and `expectUrl`; suites cannot provide JavaScript or shell code. Use explicit accessible role/name locators where possible. Values must be synthetic data. With `allowMutations: false`, non-read HTTP methods and all WebSockets are blocked; coverage stays blocked if the product needs them. Set `allowMutations: true` only for an explicitly provisioned disposable preview to exercise its synthetic data. This permits application-state changes in that preview, never repository code changes. WebSockets remain unsupported.

The preview must report the deployed commit using the configured response header. This can be set by an existing preview host or reverse proxy during deployment; it does not require a product source edit. Do not simply echo the bot's requested SHA: the value must describe the actual deployed artifact. Missing/mismatched identity keeps QA blocked and withholds its screenshots from AI. A preview URL and caller-provided SHA alone are not sufficient verification.

The default network policy permits the preview origin and explicitly configured `allowedOrigins`. A browser-context proxy and guarded WebKit requests check destinations before following redirects. HTTP/2, HTTP/3, and WebSockets are disabled for this bounded audit; it is not a network performance test. Refused Chromium background connections are recorded separately from actual page request failures. Unlisted dependencies, unsupported redirect flows, login redirects, and blocked writes become visible coverage limits. No saved user browser profile, production cookies, integration keys, or model keys are passed to a browser. For authenticated journeys, configure synthetic login interactions against your test environment. Automatic discovery of credentials or production sessions is not provided.

### Run from the bot workspace

Install the locked dependencies and Chromium once:

```sh
npm ci --ignore-scripts
node node_modules/playwright-core/cli.js install chromium
npm run demo:web
```

Alternatively, set `QA_BROWSER_EXECUTABLE` to an explicitly trusted installed Chrome/Chromium executable. The demo automatically uses installed Google Chrome on macOS when available. It starts a temporary localhost fixture, finds deliberately introduced UI defects, verifies a corrected fixture, and removes its temporary files. It makes no model calls and does not touch product files.

On Ubuntu runners that restrict user namespaces through AppArmor, downloaded Chromium binaries need an explicit permission profile to create their sandbox. The workflows generate a profile for the exact installed Chromium executable paths and install it on the ephemeral runner after downloading locked browser tooling. The browser sandbox remains enabled. Local operators can inspect `node src/web/apparmor-profile.js` before provisioning their own machine. See [Chromium's AppArmor guidance](https://github.com/chromium/chromium/blob/main/docs/security/apparmor-userns-restrictions.md).

For browser-only QA, with a suite stored in the bot:

```sh
npm run qa:web -- --suite examples/web-suite.json \
  --repository owner/product --pr 42 --revision FULL_40_CHARACTER_SHA
```

For source investigation, browser checks, and AI triage together:

```sh
npm run review -- --repo /path/to/product --base main --head feature-branch \
  --repository owner/product --pr 42 --web-suite examples/web-suite.json
```

The source review uses committed Git objects and writes artifacts outside the product checkout. It can import separately executed baseline evidence with `--results`. A browser pass does not invent missing unit/API results. Repeat assessments reuse completed work; provide a unique `--rerun-token` to repeat a browser/model assessment at the same SHA. Dry-run launches neither models nor browsers.

### Run automatically for PRs

Add a trusted runner to `qa-config.json`, embedding your suite under `suite`:

```json
{
  "id": "ui-tests",
  "type": "web-preview",
  "baseline": true,
  "timeoutMs": 180000,
  "expected": "The configured browser assertions pass at the PR's deployed commit.",
  "suite": {
    "targetEnvironment": "preview",
    "url": "https://pr-{pr}.preview.example.com",
    "revisionHeader": "x-qa-revision",
    "pages": ["/", "/checkout"],
    "allowMutations": false
  }
}
```

The existing UI feature rules select `ui-tests`; setting `baseline: true` also runs it on every selected PR. The execution job installs the locked browser tooling only when a selected web suite needs it. Browser QA runs as a bounded process with Chromium's sandbox and a fresh context, on a separate ephemeral execution runner with no App/Slack/Drive/model keys. Product Node/npm tests continue to run in offline containers. Source is not executed or mounted into the browser worker; it visits only the configured preview and allowed dependencies. This browser path requires network access and is separate from offline product-test containers.

Limits are eight page paths, three viewports, eight journeys with twenty steps each, and a suite deadline up to ten minutes. Image evidence shares the existing four-image/6-MiB limit, with 2 MiB per image. Additional states, blocked requests, missing captures, and inconclusive accessibility rules remain explicit in reports. The native browser sandbox must work on the execution machine; startup failure is an execution error, and the bot does not disable it to claim success.

## Local models and keeping QA costs predictable

Choose **Local server** in the dashboard and configure your installed Ollama or LM Studio server. See [local AI setup](ai.md#local-models). Local inference can remove hosted per-token API charges; hardware, electricity, hosting, and maintenance still cost money. Choose a vision-capable local model for screenshots and verify tool calling for every enabled specialist.

To run unattended with a model on your machine, run the controller there with the documented GitHub/App configuration and scheduling, or use a dedicated self-hosted **controller** runner with the `QA_CONTROLLER_RUNNER` variable set to its label. The target execution job stays on a separate GitHub-hosted runner. A GitHub-hosted controller's localhost cannot reach a model on your laptop. Do not run untrusted product tests on the controller/model machine.

## What still needs product-specific setup

Provide a runnable disposable environment, expected behavior, starting pages, and synthetic data. The [autonomous workflow](autonomous-qa.md) can discover additional routes, generate constrained journeys, validate them through independent execution, and retain regressions. The bot cannot infer every business rule or prove every bug has been found. The browser matrix supports Chromium, Firefox and WebKit; mobile viewport emulation does not establish native-app coverage. Full screen-reader behavior, load testing and penetration testing remain separate requirements. Node/TAP, Vitest JSON and Go JSON adapters support existing suites in reviewed isolated images.

A practical staffing target is automated execution with an expert maintaining acceptance criteria and reviewing ambiguous/high-impact findings. Validate that arrangement on real PRs by measuring caught defects, missed defects, false alarms, and intervention time before treating the bot as a replacement for all QA expertise.

Browser implementation references: [Playwright accessibility testing](https://playwright.dev/docs/accessibility-testing), [locators](https://playwright.dev/docs/locators), and [browser contexts](https://playwright.dev/docs/api/class-browsercontext).
