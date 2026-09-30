# OpenRouter and local AI QA team

The AI team adds code investigation and test selection to the existing evidence-based QA controller. It is a bounded agentic workflow: each specialist can choose read-only tools, inspect their results, and continue investigating before returning structured findings. The coordinator controls stages, budgets, allowed runners, and the final QA outcome.

| Specialist | Work |
| --- | --- |
| Test planner | Read requirements and changes; select existing trusted suites; propose requirement-backed test candidates and clarification questions. |
| Code reviewer | Inspect changed and surrounding code; cite possible regressions and suggest fixes; review again after execution. |
| Security reviewer | Inspect validation, permissions, sensitive data, and unsafe execution paths; report evidence and uncertainty. |
| UI/UX reviewer | Review interface source and accessibility concerns; when enabled, inspect screenshots from the exact revision. |
| Bug triage | Read actual executor results, investigate failures against source, and suggest fixes or additional tests. |

Planning runs before dispatch. Final review runs after test completion and includes triage/code review, plus UI/UX when approved images exist. Specialists run sequentially within a shared budget. Independent test suites still execute when a model call fails. Slack receives the test outcome promptly, followed by the final AI findings and any targeted questions; Drive reports contain both.

## Choose models and supply a key

```sh
npm run dashboard
```

Open **http://127.0.0.1:8787**. The Model library browses OpenRouter's live catalog without a key. Search models, compare published prices/context, filter tools and image input, and assign either one default model or different models to individual roles. Save from **Your QA team**. See [dashboard details](dashboard.md).

For live calls, provide **one OpenRouter key**, using a terminal secret manager or environment variable named `OPENROUTER_API_KEY`. Do not put it in configuration or browser code. The same key serves the selected OpenRouter models; separate provider keys are not required by this adapter. Catalog availability does not guarantee that your account has access to a compatible endpoint.

You can choose hosted open-weight models offered in the catalog, subject to their licenses and tool/image capabilities. “Open-weight” does not necessarily mean an unrestricted open-source license, free inference, or local execution. You can also select the local backend for Ollama or LM Studio; setup is below. The bot retains its MIT license.

Every enabled role needs text input/output and tool calling. Screenshot review requires image input for the UI/UX role. Select a specific model; automatic model-router aliases are rejected. Models, prices, and available providers can change, so the runtime rechecks capabilities against the current catalog.

OpenRouter references: [model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [tool calling](https://openrouter.ai/docs/guides/features/tool-calling), and [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

## Local models

In the dashboard, choose **Local server**, enter its loopback `/v1` URL, and browse installed models. Typical endpoints are Ollama at `http://127.0.0.1:11434/v1` and LM Studio at `http://127.0.0.1:1234/v1`. The bot does not download models, start an inference service, or change your model-server configuration. Keep the server running separately.

Because the compatibility `/models` response does not reliably specify tool support, image input, or context size, explicitly configure a capability profile for each selected model. Use its actual context and completion limits, confirm tool calling, and enable vision only for a model that accepts images. Unprofiled models remain visible but ineligible for agent reviews. A profile is an operator declaration, not an automatic benchmark; incompatible tool responses fail visibly.

The resulting `ai` configuration includes, for example:

```json
{
  "backend": "local",
  "enabled": true,
  "model": "YOUR_INSTALLED_MODEL_ID",
  "local": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "models": [
      { "id": "YOUR_INSTALLED_MODEL_ID", "contextLength": 32768, "maxCompletionTokens": 3000, "tools": true, "vision": false }
    ]
  }
}
```

Replace the ID and capabilities with values for your installed model. Choose a separate vision-capable model for the UI/UX role if needed. The adapter supports the model IDs returned by that server, including IDs without an OpenRouter-style provider prefix. It calls `/models` and `/chat/completions` with a bounded OpenAI-compatible tool protocol, and omits OpenRouter-specific routing controls.

Local requests do not need an OpenRouter key. If your local server requires authentication, set `LOCAL_MODEL_API_KEY` only in the controller/CLI environment. Model keys are never stored in JSON or exposed to the dashboard. Only literal loopback addresses are accepted, redirects are rejected, and a failed local request never falls back to a cloud provider. To reach a model on another machine, use a separately configured authenticated tunnel bound to loopback; arbitrary LAN/cloud URLs are not accepted.

A loopback URL does not prove inference stays on your hardware: some servers can proxy hosted models. Select downloaded models and disable cloud routing in that server if local-only inference is required. For Ollama, consult its [cloud controls](https://docs.ollama.com/faq#how-do-i-disable-ollama-cloud-features). An egress restriction at the inference-server layer provides a stronger boundary than an API URL alone.

Local usage records zero tracked API-provider charge and explicitly excludes hardware, electricity, and hosting costs. Tool-call, token/context, and output budgets still apply. Local inference uses a longer request timeout to accommodate slower hardware. Remote GitHub-hosted runners cannot reach your laptop's loopback service; run the controller on the model machine or a dedicated configured controller runner. Product execution remains isolated on separate runners.

Compatibility references: [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [LM Studio compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat), and [LM Studio tool use](https://lmstudio.ai/docs/developer/openai-compat/tools).

## Review a local product

With a model selected, AI enabled, and the key in your environment:

```sh
npm run review -- --repo /path/to/product --base main --head HEAD
```

This reads committed Git objects at the resolved revision, including changed files and a bounded selection of surrounding source, specifications, and tests. Uncommitted edits are not reviewed. Git hooks, target scripts, and external diff helpers are not executed. Default source capture is at most 80 files and 100,000 characters; tools can read only the captured snapshot. File/path truncation and missing context appear in the report.

The command saves `.qa-local/state.json`, reports under `.qa-local/reports/`, and inert candidate JSON under `.qa-local/candidates/`. These paths are ignored by Git. Repeating the same assessment reuses completed reviews; `--rerun-token <unique-value>` deliberately requests a new assessment. Set `--repository owner/product --pr 123` to match imported result identity. Other options include `--config`, `--rules`, `--description-file`, `--output-dir`, and `--model <catalog-id>` (overrides all role models for this invocation).

```sh
npm run review -- --repo /path/to/product --base main --head HEAD --dry-run
npm run demo:ai
```

Dry-run does not call a model or save state. The credential-free AI demo uses clearly labeled mock model replies through the real adapter/tool loop, and actually runs fixture tests that expose a defect.

The local review command does not execute product scripts or dispatch Actions. Its optional `--web-suite <bot-owned-suite.json>` runs configured browser checks against a disposable preview; see [product QA](product-qa.md). Without revision-bound execution evidence it reports automated coverage as blocked/untested. To include already collected test evidence, pass `--results results.json`:

```json
{
  "schemaVersion": 1,
  "repository": "owner/product",
  "prNumber": 123,
  "revision": "FULL_40_CHARACTER_COMMIT_SHA",
  "results": [
    {
      "checkId": "CHECK_ID_FROM_THE_SAVED_QA_PLAN",
      "status": "failed",
      "counts": { "tests": 3, "passed": 2, "failed": 1, "skipped": 0, "cancelled": 0 },
      "details": "Expected free shipping at the specified threshold.",
      "evidence": [{ "path": "test/shipping.test.js", "excerpt": "Assertion failed at subtotal 100." }]
    }
  ]
}
```

The CLI rejects mismatched identities and unknown/duplicate check IDs. It labels local imports as lacking independent remote workflow provenance. In the integrated workflow, the controller validates the repository, PR, revision, environment, logical run and Actions attempt before accepting artifacts.

## Add visual evidence

For browser checks without adding tests to the product repository, configure a [bot-owned web preview suite](product-qa.md#automated-web-ui-qa). For captures from existing product tests, configure a reviewed browser image and an existing Node/npm TAP UI suite, then enable `execution.captureScreenshots`. Tests can write PNG/JPEG files to `/qa-evidence`. The executor collects bounded images after the isolated test container stops. See [browser runner example and limits](execution.md#screenshot-evidence-for-ai-uiux-review).

For a local review, use `--screenshots /path/to/manifest.json`:

```json
{
  "revision": "FULL_40_CHARACTER_COMMIT_SHA",
  "environment": "local synthetic checkout",
  "images": [
    { "name": "checkout-mobile", "path": "checkout-mobile.png", "viewport": { "width": 390, "height": 844 } }
  ]
}
```

Paths are relative to the manifest directory. Escaping paths and symlinks, wrong revisions, malformed formats, oversized images, and excessive dimensions are rejected. Limits: four images, 2 MiB each, 6 MiB total, 16 million pixels per image. Enable `ai.allowImages` and select a vision-capable UI/UX model. Images themselves are not text-redacted; capture synthetic data without secrets or customer information.

Screenshot findings must cite supplied images from the exact revision. Without images, review is explicitly source-only. The model itself does not launch or click through the application; the trusted browser runner performs the configured journeys and supplies their evidence. Screenshots cover the states captured by your tests, not all pages, devices, interactions, or visual regressions; automated baseline-image comparison is not implemented.

## Configuration and deployment

The `ai` section of `qa-config.json` is independent of top-level production activation:

| Setting | Default | Purpose |
| --- | --- | --- |
| `backend` | `"openrouter"` | Choose hosted routing or the local model adapter. |
| `local` | Loopback URL, empty profiles | Local `/v1` endpoint and explicitly confirmed model capabilities/context. |
| `enabled` | `false` | Opt into source submission and model reviews. |
| `model`, `roleModels` | Empty | Default catalog ID and optional overrides by role. |
| `roles` | All five | Specialists to run. |
| `requireReview` | `true` | Incomplete/error AI stages prevent QA completion. |
| `maxToolRounds` | `3` | Tool rounds per specialist invocation. |
| `maxCallsPerRun` | `20` | Shared call limit across planning, final review, and recovery. |
| `maxInputChars` | `100000` | Captured text budget; individual excerpts and messages are also bounded. |
| `maxOutputTokens` | `3000` | Per-request output limit. |
| `maxCostUsd` | `2` | Conservative shared cost reservation limit. |
| `includePaths`, `excludePaths` | `["**"]`, `[]` | Repository-relative globs, applied before source submission. |
| `allowImages` | `false` | Opt into image submission. |
| `provider` | See below | Routing, privacy, and price constraints. |

Default provider settings are `data_collection: "deny"`, `allow_fallbacks: false`, and `require_parameters: true`. Optional `only`, `order`, `ignore`, `sort`, `zdr`, and `max_price` can further constrain providers. An unavailable compliant endpoint produces a visible review error; the adapter does not relax these choices automatically.

Before each paid request, the coordinator persists a call and conservative cost reservation. Reservations include tool schemas and output limits; vision requests reserve the model's full available input context because image tokenization differs among models. This can exhaust a small budget even when the eventual billed amount would be lower. Reports distinguish provider-reported costs from estimates. Price caps accompany requests; additional calls stop on exhausted limits or inconsistent reported costs. Use an OpenRouter key spending limit as an additional account-level control.

For GitHub integration, commit the reviewed settings to the bot repository and configure `OPENROUTER_API_KEY` in its protected `qa-control` environment. The key is passed only to the controller, never to the job executing PR code. Configure trusted runners, target GitHub App, Slack, Drive, and owners as described in the [README](../README.md). Production activation remains a separate explicit deployment step.

## Evidence, privacy, and recovery boundaries

- Read tools are `list_files`, `read_file`, `search_code`, and `get_test_results`. They access only a bounded in-memory snapshot and supplied results. Model output cannot execute shell commands, fetch arbitrary URLs, or access credentials.
- Secret-bearing paths are excluded by default and common credential patterns are redacted from text. Redaction is best effort. Review your include/exclude rules before enabling submission: selected source and opted-in images go to the selected backend. Local mode has no hosted fallback; its server is responsible for actually running locally.
- Findings require verified code quotes, known test evidence, or approved screenshot citations. A valid citation supports investigation; it does not establish that a model's conclusion is correct. Prompt injection in repository content is treated as untrusted input, and the model has no write tools.
- Models can add allowlisted suites but cannot remove the deterministic baseline. Generated tests and fixes remain reviewable proposals. Validate assertions against requirements, add approved tests to the product, and run them through a configured suite before treating them as evidence.
- High/critical findings and unresolved requirement questions create specific revision-bound human decisions. Lower-severity suggestions remain in the report. A decision cannot override an actual failed test.
- Each stage creates individual requests for up to 12 questions and 12 high/critical findings; additional items remain visible in the full report and require a separate overflow review decision before QA can pass.
- Durable checkpoints retain completed specialists and reserve interrupted requests conservatively. A lost provider response may still be billed; no API transaction guarantees exactly-once charging. Failed/partial reviews remain visible and require an intentional rerun after configuration or budget changes.
- A new commit invalidates earlier conclusions. Late artifacts cannot replace the current run; native Actions reruns preserve history, reset final-review completion, and retain the assessment's spent budget.

This is an extensible QA system, not a guarantee that every bug or product behavior has been checked. It needs your requirements, suitable trusted test suites, synthetic environments, and visual evidence. Unsupported languages/services, browser navigation authored by the model, automatic patch application, and autonomous execution of generated tests are not implemented.

The public model catalog, local desktop/mobile dashboard, and Chromium fixture audit were verified live. Model calls are covered by mocked integration tests; paid/local inference, deployed Actions, live Slack/Drive delivery, and Docker capture require staging verification with your credentials and reviewed image. No production integrations were activated.
