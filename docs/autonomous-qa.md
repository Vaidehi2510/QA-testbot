# Autonomous QA

The autonomous runner discovers preview pages, asks the selected OpenRouter or local model to construct declarative journeys, executes them, and retains a regression only after two independent successful executions. It also runs the configured source-review specialists against final evidence. All generated tests, screenshots, baselines, repairs, reports, and state live in the separate bot workspace. Product files are read from immutable Git objects.

The model chooses actions; **trusted business assertions determine correctness**. An observed page is not proof of intended behavior. Empty generations, missing assertions, unavailable browsers, missing baselines, unverified deployment revisions, and interrupted work stay blocked or failed.

## First run

Install reviewed bot dependencies and browser binaries:

```sh
npm ci --ignore-scripts
node node_modules/playwright-core/cli.js install chromium firefox webkit
```

Use `npm run dashboard` to configure and enable a model. Provider keys remain in the runner environment. Local inference uses the existing compatible loopback server configuration; there is no hosted fallback.

Create a trusted preview suite **outside the product repository**:

```json
{
  "targetEnvironment": "preview",
  "url": "https://pr-{pr}.preview.example.test",
  "revisionHeader": "x-qa-revision",
  "pages": ["/"],
  "browsers": ["chromium", "firefox", "webkit"],
  "viewports": [
    { "name": "desktop", "width": 1440, "height": 900 },
    { "name": "mobile", "width": 390, "height": 844 }
  ],
  "allowMutations": false,
  "discovery": { "enabled": true, "exploreControls": true, "maxPages": 8 }
}
```

The deployment must report its actual built commit in the revision header. A caller-provided SHA or a proxy that simply echoes the requested SHA does not establish provenance. Preview URLs and dependencies must be explicitly allowed. Use disposable synthetic data; enabling `allowMutations` authorizes test-data changes in that preview, never product-code changes.

Create a separate goals file:

```json
{
  "schemaVersion": 1,
  "allowSemanticMaintenance": false,
  "goals": [{
    "id": "shipping-threshold",
    "name": "Free shipping at the threshold",
    "start": "/checkout",
    "requirement": "An order of 100 units has zero shipping charge.",
    "inputs": { "amount": "100" },
    "assertions": [{
      "id": "free-shipping",
      "action": "expectText",
      "selector": "[data-testid=shipping-total]",
      "text": "Shipping: 0"
    }]
  }]
}
```

Assertions support exact URL expectations, visible elements, and expected text. Goals must include explicit assertions; a natural-language wish alone cannot establish a passing result. The model can only reference discovered elements and approved synthetic inputs. It cannot emit executable JavaScript, shell commands, new endpoints, replacement assertions, or product patches.

```sh
npm run qa:autonomous -- \
  --repo /read-only/product-checkout \
  --repository example/product --pr 42 \
  --base main --head FULL_COMMIT_SHA \
  --product storefront \
  --suite /trusted-bot/preview.json \
  --goals /trusted-bot/goals.json \
  --config /trusted-bot/qa-config.json \
  --output-dir /trusted-bot/.qa-local/autonomy \
  --dry-run
```

Remove `--dry-run` after checking the plan and configuration. Add `--execute-baseline` to execute configured baseline suites in the isolated Docker runner. Without baseline execution or imported exact-revision evidence, configured baseline checks stay blocked. `--budget-usd` can reduce, never raise, the local model budget.

Repeated identical requests reuse completed evidence. `--rerun-token <unique-id>` creates an intentional new assessment. Interrupted calls retain their reserved budget; interrupted browser actions do not become silent retries. Each retained regression records the goal hash, policy, revisions, and two execution IDs. Changed goals require new validation.

## Visual regression

Add trusted visual settings to the suite:

```json
{
  "visual": {
    "baselineDir": "/trusted-bot/baselines/storefront",
    "pixelThreshold": 0,
    "maxDiffRatio": 0,
    "maxSnapshots": 24
  }
}
```

Snapshots are keyed by repository, check, browser, viewport, and tested state. A missing baseline blocks that visual check and produces a candidate. Inspect its PNG, then explicitly accept that exact candidate:

```sh
npm run qa:accept-baseline -- \
  --candidate /trusted-bot/run/visual/CANDIDATE.candidate.json \
  --baseline-dir /trusted-bot/baselines/storefront \
  --revision REVIEWED_COMMIT_SHA --approved-by qa-owner
```

Approval checks image digests and the previously accepted baseline to reject stale updates. Later runs produce pixel-difference counts and a diff PNG. Dimension changes fail. The runner never automatically approves a PR's changed appearance. Pixel comparisons detect appearance changes; they do not establish whether a design is better. AI visual improvements remain advisory.

## Selector maintenance

Generated interaction steps may record an exact semantic fallback: accessible role, name, and relevant element type. A missing selector can use that fallback only when it identifies exactly one visible compatible element. Ambiguous selectors, changed semantics, or failed actions are not retried through a different control. Assertions and synthetic inputs stay unchanged.

Repairs appear in evidence as proposals. Set `allowSemanticMaintenance: true` in the locally trusted goals policy to retain a semantic repair after two independent, SHA-verified successful executions. This authorizes maintenance of bot-owned tests only. It does not authorize baseline changes or product fixes.

## Website-triggered execution

The Patchsentry website stores a testing profile and queues an exact repository/PR/commit request. The outbound connector claims it with a lease and invokes the fixed `src/autonomy/portal.js` entrypoint. There is no shell command field in the API.

A locally enrolled policy limits the checkout, base ref, preview origins, browser engines, model backends, budgets, mutation permission, visual store, and baseline execution. Website settings cannot widen those limits or enable locally disabled AI. Model/GitHub credentials remain local. The bridge does not post anything to GitHub.

The connector publishes only bounded, sanitized summaries. Full screenshots, diffs, source, logs, and transcripts stay on the runner. See the [website connector guide](https://github.com/Vaidehi2510/patchsentry-web/blob/main/docs/agent.md) for enrollment and setup. A stale or missing runner is visible in the dashboard; signing up does not create a hosted browser or native-device fleet.

## Go, Vitest, and disposable worktrees

Trusted runners now support Go JSON events and Vitest JSON assertions in addition to TAP:

```json
{
  "execution": {
    "image": "your-reviewed-go-node-image@sha256:IMAGE_DIGEST",
    "scratchWorktree": true,
    "scratchMb": 1024,
    "memoryMb": 2048,
    "cpus": 2
  },
  "runners": [
    { "id": "go-tests", "type": "go-test", "packages": ["./internal/..."], "baseline": true },
    { "id": "frontend", "type": "npm-script", "cwd": "frontend", "script": "test", "format": "vitest-json", "baseline": true }
  ]
}
```

Prepare dependency images from reviewed manifests before execution. The QA container runs offline, without integration credentials, with a read-only source mount. Opt-in `scratchWorktree` makes a disposable tmpfs copy for frameworks that need local build files or ESM dependency resolution; the original product checkout and exact archive remain untouched. Dependencies belong at `/opt/qa/node_modules`; Go's module cache belongs at `/opt/qa/go/pkg/mod`. Scratch, memory, CPU, output, and wall-clock limits are bounded. The image must include Node for scratch setup and any selected test toolchain.

Go package/test completion and Vitest assertion counts are cross-checked. A zero process exit, missing JSON, partial results, zero tests, skipped tests, or contradictory summaries cannot establish a pass. Native desktop bridges and operating-system integrations require their own runtime checks; a React browser pass does not verify a Wails backend binding.

## Limits

Discovery is bounded and follows permitted routes. Optional control exploration opens semantic tabs, disclosure controls and dialogs to inventory their elements; it does not submit arbitrary forms. It cannot infer every workflow or business rule. Fresh browser contexts isolate browser state, but backend test-data reset remains part of the disposable preview setup. Automated accessibility rules do not replace full assistive-technology evaluation. Local model effectiveness depends on the model and hardware. The [native adapter](native-qa.md) requires separately enrolled disposable devices and explicit journeys. Required-check scores measure executed expectations, not code coverage, defect recall, or a guarantee of a bug-free product.

Verification includes intentionally broken fixture journeys, stale deployment identities, cross-origin redirects, ambiguous semantic targets, visual changes, tampered evidence, interrupted work, and account/runner isolation. Live model quality and staffing savings must be evaluated on representative authorized product work.
