# QA for builds and complete releases

Patchsentry can assess a pull request, a CI build, or a complete product version. Builds/releases have an explicit kind, name, platform and artifact SHA-256; they never invent a PR number. Product source stays read-only. Tests, configuration, accepted browser baselines, manifests, findings and reports belong in the separate bot workspace.

A full-version assessment runs the entire **configured release suite**, not only checks selected from changed paths. Source review remains bounded by the configured snapshot budget; uninspected files and missing expectations remain limitations. A version-level report does not imply exhaustive coverage of every feature, device or dependency.

## Build identity

Build once in your trusted CI, then test and deploy those same bytes. Do not rebuild after passing the gate. For an ordinary file (ZIP, APK, IPA, executable, package or archived image), use its SHA-256. macOS/iOS `.app` directories use the existing bounded native bundle identity algorithm.

```sh
npm run qa:hash-artifact -- /trusted-builds/product.zip
```

Store a reviewed manifest outside the product checkout, for example `/trusted-bot/manifests/ARTIFACT_SHA256.json`:

```json
{
  "schemaVersion": 1,
  "repository": "example/product",
  "revision": "FULL_40_CHARACTER_SOURCE_SHA",
  "artifactPath": "/trusted-builds/product.zip",
  "artifactSha256": "FULL_64_CHARACTER_ARTIFACT_SHA256",
  "platform": "web",
  "buildId": "build-842",
  "version": "v1.4.0"
}
```

The selected kind determines which name must match: `buildId` for a build, `version` for a release. Manifest identity and actual artifact bytes are checked before and after QA. These are **trusted builder inputs**, not independent remote build provenance verification. Product test processes must not have write access to these manifests. Web previews must report their actual deployed source revision in `x-qa-revision` and artifact digest in `x-qa-artifact-sha256`, including after navigation. Never use a proxy that merely echoes the requested identifiers.

## Run complete-version QA

Configure baseline test suites in the bot's reviewed `qa-config.json`. Existing Node, Go, Vitest, web and native runners remain available. Missing baseline tests block a release. For a web product, configure the browser suite and explicit trusted user goals as described in [autonomous QA](autonomous-qa.md).

```sh
npm run qa:release -- \
  --repo /read-only/product --repository example/product \
  --base LAST_RELEASE_SHA --head CANDIDATE_SHA \
  --kind release --name v1.4.0 --platform web \
  --artifact-sha256 ARTIFACT_SHA256 \
  --manifest /trusted-bot/manifests/ARTIFACT_SHA256.json \
  --config /trusted-bot/qa-config.json \
  --suite /trusted-bot/preview.json --goals /trusted-bot/goals.json \
  --output-dir /trusted-bot/release-results
```

Use `--kind build --name build-842` for an individual CI build. `--dry-run` previews without models, devices, test execution or saved assessment state. `--rerun-token UNIQUE_ID` intentionally creates a fresh assessment; completed identical requests reuse evidence. Interrupted baseline executions cannot silently retry into a pass. Locally selected AI backend/model, role choices, tool/call budgets and spending limits continue to apply.

For API/native/desktop products, omit browser suite/goals and enroll the appropriate baseline suites. API coverage needs an actual API/integration suite tagged `coverage: ["api"]` or an exact-artifact CI report. Generic unit tests alone cannot approve API/platform compatibility. Native Android/iOS/macOS suites must use the matching [device adapter](native-qa.md), artifact and platform. No device is provisioned automatically.

## Deployment gate

Place the gate **before** your existing deploy step. Patchsentry does not deploy or modify the product. The release command itself returns a nonzero exit code when its gate is not satisfied. The explicit gate verifies fresh stored evidence and rechecks the artifact again immediately before deployment:

```sh
npm run qa:gate -- \
  --repo /read-only/product --repository example/product \
  --report /trusted-bot/release-results/runs/RUN_KEY/report.json \
  --manifest /trusted-bot/manifests/ARTIFACT_SHA256.json \
  --config /trusted-bot/qa-config.json \
  --suite /trusted-bot/preview.json --goals /trusted-bot/goals.json \
  --revision CANDIDATE_SHA --kind release --name v1.4.0 \
  --platform web --artifact-sha256 ARTIFACT_SHA256 \
  --max-age-minutes 60
# Only if the previous command succeeds, deploy this exact immutable artifact.
```

Use the same reviewed runner configuration at the gate; web gates also require the current suite/goals files. Changed runner policies, business assertions, or imported CI inputs invalidate approval. The gate recomputes required outcomes; it does not trust a cached `passed` label. Wrong version/build name, artifact, repository, revision or platform; incomplete/zero/skipped/failed tests; omitted required gates; expired/future evidence; and unresolved human/high-severity findings cannot approve deployment. Gate freshness defaults to one hour and is bounded to 1–1440 minutes by the CLI. There is no portal override that changes a failure into a pass.

The portal also exposes an authenticated, project-scoped `GET /api/agent/release-gate` endpoint with query fields `recordId`, `revision`, `kind`, `name`, `platform`, and `artifactSha256`. It checks stored report identity, required checks, findings and one-hour freshness. It cannot rehash a private runner's local artifact; use the local CLI gate in the deployment job for that additional check. Both paths rely on a trusted enrolled runner's reports.

## Cross-platform CI reports

Python/pytest, Java/JUnit, .NET and other frameworks can supply JUnit XML. Windows/Linux desktop compatibility currently uses your own CI test runner and attested reports; Patchsentry does not provide a universal desktop UI driver.

```json
{
  "id": "platform-smoke",
  "type": "junit-report",
  "baseline": true,
  "platforms": ["windows"],
  "reportPath": "/trusted-ci/windows-results.xml",
  "attestationPath": "/trusted-ci/windows-results.json"
}
```

The locally enrolled attestation for that report is:

```json
{
  "schemaVersion": 1,
  "repository": "example/product",
  "revision": "FULL_40_CHARACTER_SOURCE_SHA",
  "artifactSha256": "FULL_64_CHARACTER_ARTIFACT_SHA256",
  "platform": "windows",
  "runnerId": "platform-smoke",
  "reportSha256": "SHA256_OF_EXACT_JUNIT_XML_BYTES"
}
```

For PR-only imports, supply `prNumber` instead of artifact/platform fields. Reports and attestations must be outside product source. A trusted CI step must create the attestation after executing tests against the identified build; a product-owned arbitrary XML file is not sufficient provenance. Imports are explicitly labeled and do not independently verify the CI host. The parser rejects entities/DOCTYPEs, malformed/deep/oversized XML, duplicate cases, zero tests, contradictory counts and incomplete outcomes. Failed/skipped cases remain failed/skipped. No XML, test source or report content executes on the portal.

## Website jobs and authored unit tests

Update both the QA engine and website connector. Explicitly extend the locally enrolled policy:

```json
{
  "allowedPlatforms": ["web"],
  "releaseManifestDir": "/trusted-bot/manifests",
  "executeBaseline": true,
  "allowWorkspaceTests": false
}
```

These are additions to the [existing enrollment policy](https://github.com/Vaidehi2510/patchsentry-web/blob/main/docs/agent.md). For non-browser runners, `allowedBrowsers` and `allowedPreviewOrigins` may be empty if no web platform is enrolled. Enroll only the platforms and infrastructure you actually provide. Build/release preview URLs cannot use `{pr}`; use a fixed staging origin or `{sha}`.

The website test library stores owner-authored drafts, versioned edits and SHA-256 identities. Node test sources can be explicitly enabled; Vitest/Python/Java/.NET drafts can be exported to your own CI. New requests freeze enabled Node tests, preventing later edits/deletions from changing already queued work. Up to eight enabled Node tests and 96 KB of source fit in one job.

Set `allowWorkspaceTests: true` locally to permit these enabled Node tests. They are staged under the bot's per-job workspace and mounted read-only at `/qa-tests` in the existing offline, credential-free, resource-limited container. `QA_PRODUCT_ROOT` identifies the exact read-only product snapshot. There is no user-supplied shell command, host execution, network install, or product-code write. No test source executes simply because it was saved in the website. Model-proposed source remains an unexecuted candidate on the runner until deliberately reviewed and enabled; declarative browser journeys retain their existing independent-replay rules.

## Verified scope

Controlled fixtures exercise three real browser engines, source/artifact mismatches at the same commit, offline authored-unit execution, read-only source mounts, JUnit imports, platform gates and stale/cross-artifact evidence. Native protocol fixtures do not certify real devices. Browser viewport emulation does not certify physical phones. No whole-product defect recall, commercial benchmark superiority, infrastructure scale, staffing savings or universal platform coverage has been established. See [comparison](comparison.md).
