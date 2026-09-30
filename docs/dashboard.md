# QA team dashboard

Start the local workspace from the repository root:

~~~sh
export OPENROUTER_API_KEY='your-openrouter-key'
npm run dashboard
~~~

Open the printed URL, normally **http://127.0.0.1:8787**. The server binds only to loopback. A key is not needed to browse the public OpenRouter model catalog or save configuration. Actual model reviews need a key in the server or CLI environment.

The dashboard has three views:

- **Your QA team:** choose a default model, override individual roles, enable or pause roles, set budget and investigation limits, and enable screenshot review.
- **Model library:** browse the live OpenRouter catalog, search names and descriptions, filter tool calling, image input, free token pricing, and context length, and compare input/output prices per million tokens.
- **Review activity:** inspect the latest 50 locally saved runs, real test evidence, model findings, proposed fixes, test candidates, model costs, and coverage limitations.

Select a model in the library and return to **Your QA team → Save configuration** to apply it. Unsaved selections do not change the configuration. An enabled team needs eligible models for every enabled role. Tool calling and text input/output are required; screenshot review also needs image input for the UI/UX reviewer. Router aliases that choose a model automatically are ineligible, so each review retains an explicit model selection.

The catalog is cached for five minutes. Its prices are published model prices, not a guaranteed quote from every provider. Unknown token prices are displayed as unknown; review execution must establish a bounded price before calling that model. A model listed with free token pricing can still have provider limitations or other fees. Model catalog availability does not prove that your account has access to a compatible provider.

The API key is read from the server environment. It is never sent to the browser, accepted by the settings endpoint, or written into configuration. The browser sees only whether a credential is configured. Changes save the `ai` section of `qa-config.json`; existing runners, production activation, integration settings, and other fields are preserved. The production `enabled` flag is separate from the AI enable switch.

To review committed changes with the saved configuration:

~~~sh
npm run review -- --repo /path/to/product --base main --head HEAD
~~~

Use `--screenshots manifest.json` to supply visual evidence and `--results results.json` to attach revision-bound test results. See [AI review configuration and input formats](ai.md). Screenshot analysis examines supplied images; it does not launch or interact with the product. Model-generated test candidates remain proposals until reviewed and executed through an approved test runner.

The dashboard reads `.qa-local/state.json` by default. It does not automatically download GitHub-hosted runs from the state branch. To inspect an already downloaded state file, set `QA_STATE_PATH` when starting the dashboard.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Unset | Credential for model calls; catalog browsing is public. |
| `QA_DASHBOARD_PORT` | `8787` | Local HTTP port. |
| `QA_CONFIG` | `qa-config.json` in the working directory | Configuration to inspect and update. |
| `QA_STATE_PATH` | `.qa-local/state.json` in the working directory | Local run history to display. |

Settings saves use a process lock, atomic replacement, and a configuration revision check. If another dashboard or editor changes configuration, reload before retrying. Reload discards unsaved browser changes. If a process crashes during saving, stop every dashboard process before removing the adjacent `qa-config.json.dashboard.lock` file.

The HTTP API rejects unexpected Host and Origin headers, cross-site requests, unsupported methods and content types, oversized bodies, and writes without a per-process CSRF token. Static assets are served from a fixed allowlist. The interface renders model catalog data and review findings as text. There are no browser routes that execute code, start a review, read arbitrary files, or accept a credential.
