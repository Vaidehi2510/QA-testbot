# QA team dashboard

Start the local workspace from the repository root:

~~~sh
npm run dashboard
~~~

Open the printed URL, normally **http://127.0.0.1:8787**. The server binds only to loopback. A key is not needed to browse the public OpenRouter model catalog or save configuration. OpenRouter reviews need `OPENROUTER_API_KEY` in the server or CLI environment. Local model servers do not require an OpenRouter account or key; an optional local server key uses `LOCAL_MODEL_API_KEY`.

The dashboard has three views:

- **Your QA team:** choose OpenRouter or a local model server, configure local capability profiles, choose a default model, override individual roles, enable or pause roles, set budget and investigation limits, and enable screenshot review.
- **Model library:** browse the selected OpenRouter or local model catalog, search names and descriptions, filter tool calling, image input, free token pricing, and context length, and compare input/output prices per million tokens.
- **Review activity:** inspect the latest 50 locally saved runs, real test evidence, model findings, proposed fixes, test candidates, model costs, and coverage limitations.

Select a model in the library and return to **Your QA team → Save configuration** to apply it. Unsaved selections do not change the configuration. An enabled team needs eligible models for every enabled role. Tool calling and text input/output are required; screenshot review also needs image input for the UI/UX reviewer. Router aliases that choose a model automatically are ineligible, so each review retains an explicit model selection.

Each backend, local address, and capability profile combination has its own five-minute catalog cache. Changing the model connection clears draft model assignments and disables AI until you choose models and enable it again; click **Save configuration** to apply the change. The **Refresh models** button previews the current draft connection without saving it.

For local models, start a compatible server on this machine, select **Local model server**, and enter its literal loopback `/v1` address, such as `http://127.0.0.1:11434/v1` or `http://127.0.0.1:1234/v1`. Addresses using DNS names, non-loopback IPs, credentials, queries, or other paths are rejected. No local request falls back to OpenRouter. A local server configured to forward requests elsewhere is outside this guarantee; configure it for local inference.

Local catalogs often omit the context length and tool/image support. Use **Configure capabilities** on a discovered model, or **Add or edit a model profile**, to enter the exact model ID, actual configured context tokens, optional output limit, and explicit tool and vision declarations. Neither checkbox is preselected for a new profile. Tool calling is required; image input is also required for screenshot review. These profiles describe what you have configured; they do not test the server or verify the model’s quality. You can save local connections, profiles, and assignments while the model server is stopped. Profiles can appear in the library before server availability is confirmed, and execution still requires the selected model to be served.

Local models display **Local compute** instead of free pricing. The bot records no provider token charge for local inference; hardware, electricity, memory, and latency still have costs. The USD budget is inactive for local calls, while model call, output token, context, and tool-round limits still apply.

For OpenRouter, catalog prices are published model prices, not a guaranteed quote from every provider. Unknown token prices are displayed as unknown; review execution must establish a bounded price before calling that model. A model listed with free token pricing can still have provider limitations or other fees. Model catalog availability does not prove that your account has access to a compatible provider.

API keys are read from the server environment. They are never sent to the browser, accepted by the settings endpoint, or written into configuration. The browser sees only whether each backend has a credential configured, and whether the active backend requires one. Changes save the `ai` section of `qa-config.json`; existing runners, production activation, integration settings, and other fields are preserved. The production `enabled` flag is separate from the AI enable switch.

To review committed changes with the saved configuration:

~~~sh
npm run review -- --repo /path/to/product --base main --head HEAD
~~~

Use `--screenshots manifest.json` to supply visual evidence and `--results results.json` to attach revision-bound test results. See [AI review configuration and input formats](ai.md). The screenshot-input option analyzes supplied images; it does not itself launch the product. Model-generated test candidates remain proposals until reviewed and executed through an approved test runner.

The dashboard reads `.qa-local/state.json` by default. It does not automatically download GitHub-hosted runs from the state branch. To inspect an already downloaded state file, set `QA_STATE_PATH` when starting the dashboard.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Unset | Credential for OpenRouter calls; its catalog browsing is public. |
| `LOCAL_MODEL_API_KEY` | Unset | Optional credential for a local inference server; never used for OpenRouter. |
| `QA_DASHBOARD_PORT` | `8787` | Local HTTP port. |
| `QA_CONFIG` | `qa-config.json` in the working directory | Configuration to inspect and update. |
| `QA_STATE_PATH` | `.qa-local/state.json` in the working directory | Local run history to display. |

Settings saves use a process lock, atomic replacement, and a configuration revision check. If another dashboard or editor changes configuration, reload before retrying. Reload discards unsaved browser changes. If a process crashes during saving, stop every dashboard process before removing the adjacent `qa-config.json.dashboard.lock` file.

The HTTP API rejects unexpected Host and Origin headers, cross-site requests, unsupported methods and content types, oversized bodies, and writes or draft catalog previews without a per-process CSRF token. Static assets are served from a fixed allowlist. The interface renders model catalog data and review findings as text. There are no browser routes that execute code, start a review, read arbitrary files, or accept a credential.
