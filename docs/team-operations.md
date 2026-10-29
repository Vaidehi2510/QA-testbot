# Product teams, Slack and execution fleets

Patchsentry supports personal projects and shared product teams. These capabilities are implemented and fixture-tested; they do not establish enterprise certification, universal device coverage or parity with managed testing fleets.

## Roles and invitations

Open **Team & operations** in the website workspace. Access is scoped to a product project; joining one project grants no access to another.

| Role | Read reports and test library | Author tests, request/retry/cancel QA | Change models, trusted expectations, fleet capacity and Slack preferences | Invite/remove QA engineers and viewers | Appoint/remove admins | Rotate runner token / delete project |
| --- | --- | --- | --- | --- | --- | --- |
| Owner | Yes | Yes | Yes | Yes | Yes | Yes |
| Admin | Yes | Yes | Yes | Yes | No | No |
| QA engineer | Yes | Yes | No | No | No | No |
| Viewer | Yes | No | No | No | No | No |

The owner creates a project. An owner/admin invites a teammate by email and role, then shares a single-use invitation code privately. The invitee signs in through the verified-email flow and selects **Join a team with an invitation**. Invitations expire after seven days and only work for that verified email. Codes are stored hashed; creating an invitation does not send an unsolicited email or grant repository permissions. Membership removal revokes future API access. Existing queued jobs retain their original reviewed test snapshots.

API authorization enforces the roles independently of disabled controls in the browser. Membership changes, settings changes, QA requests, starts, cancellations, lease expiry and completion create product activity records. This is a database activity history, not a tamper-proof external compliance archive. Current limits are 200 members plus live invitations per product and 100 owned projects per account. SAML/SCIM, organization-wide policy inheritance and billing are not implemented.

## Optional Slack updates for each product

Each company connects its own Slack app and chooses its own channel; Slack is off by default. An admin selects queued, started, completed, blocked and/or cancelled events in **Team & operations**. Events are stored transactionally with the QA state change and deduplicated. A local connector delivers the bounded summary, never arbitrary Slack text from a model.

1. Create/install a Slack app with the [`chat:write` scope](https://docs.slack.dev/reference/methods/chat.postmessage). Invite the bot to the desired channel.
2. Store `SLACK_BOT_TOKEN` in the trusted connector's secret environment. Do not put it in the product repository, website settings, chat or model context.
3. Enroll the same channel in the separate bot's `qa-config.json`:

   ```json
   "teamUpdates": { "enabled": true, "channelId": "C0123456789" }
   ```

4. Save that channel ID and event preferences on the website, then run the website connector:

   ```sh
   node scripts/agent.mjs --bot-dir /path/to/QA-testbot \
     --watch --execute-jobs --runner-policy portal-policy.json \
     --runner-name company-web-01 --slack-updates --github-context
   ```

`--github-context` is optional. With a read-only `GITHUB_TOKEN`, the connector resolves PR author/merger only when the PR head matches the tested revision. Releases require the tag to resolve to the tested commit before using GitHub's release author. Build names of the form `actions-RUN_ID` can resolve the matching GitHub Actions triggering actor. Other build identifiers remain unknown rather than being attributed to the requester. GitHub metadata is a read-only lookup; the connector does not change product code, branches or PRs. The portal trusts its enrolled runner's report, so actor metadata is not a cryptographic identity attestation.

Messages include the requester, available author/merger/releaser/build actor, repository, complete revision, build/version, platform, artifact SHA-256, actual QA result, required-check score, finding count, selected model and dashboard link. An author is not the same as a merger, release publisher or deployment approver. QA completion does not claim the product has been deployed. Connect your deployment CI to its own deployment notification when you need that separate lifecycle event.

Updates for a job use a [Slack thread](https://docs.slack.dev/messaging/). Bot message IDs are stable per outbox item. A timeout, interrupted process or failed acknowledgement becomes **uncertain**, not sent. Such messages are not blindly retried because Slack may already have accepted them. Inspect channel history and the delivery list before deliberately posting a replacement. Slack delivery never changes a QA outcome. Disabling either portal preferences or local enrollment stops new sends; no credentials are passed into QA child processes. The legacy PR controller retains its existing webhook/bot support and remains independently configured.

## Runner fleet and parallel execution

Multiple enrolled machines can register separate workers. IDs bind hostname, explicit `--runner-name`, bot path and policy path. Every worker publishes an ephemeral heartbeat. The website registry retains up to 50 workers per project. Admins choose a project-wide maximum of **1–8 simultaneous assessments**; the default remains one. Each worker may hold one active job. Claims are serialized under a product lock, honor platform/browser/model-backend/page/cost/call limits, and never assign the same job twice. Offline or incompatible workers cannot claim work. Token rotation revokes jobs and clears runner enrollment.

Use a separate reviewed policy, regression store and disposable environment for each worker. In particular, give workers different `regressionDir` values: autonomy stores deliberately serialize their own state and model budget reservations. Reusing one regression directory is safe but serializes that store. Do not start multiple connectors against one physical native device or one mutable preview database without isolation.

A single assessment can also run independent baseline suites concurrently by explicitly enrolling:

```json
"execution": { "maxParallel": 4 }
```

The cap is eight; each container still has its own CPU/memory/time/output limits and read-only source mount. Total capacity must be provisioned by the operator. Results retain plan order, and screenshot capture shares the bounded image budget. Parallelism does not silently increase model budgets. Platform compatibility still needs genuine platform test evidence.

## Enrolled device pool

`npm run qa:fleet -- --fleet /trusted-bot/devices.json --metadata /trusted-bot/metadata.json --output /trusted-bot/fleet-results`

The fleet file has `schemaVersion: 1`, `maxParallel: 1..8` and `devices`, containing one to 32 full [native suite definitions](native-qa.md) with distinct device IDs. Metadata includes the exact assessment identity and an absolute `productRoot`. Every suite retains its own artifact attestation, platform/driver pinning, explicit assertions and fresh session cleanup.

Set `QA_NATIVE_ENABLED=true` and an explicit comma-separated `QA_NATIVE_DEVICE_IDS` list. A baseline with several `native-app` runners can use this same list. The standalone coordinator blocks any suite whose device is not enrolled. Devices sharing a bot workspace use atomic leases under `.qa-local/device-leases`. Crashes or uncertain cleanup quarantine a device by retaining its lease. Reset/discard the disposable device/VM before the operator removes that lease. Locks are local filesystem coordination, not a distributed lock across unrelated hosts; assign each physical device to one owning worker.

This implements pool coordination and evidence collection, not acquisition of hardware or paid cloud capacity. Provision Appium, emulator/simulator/VM, build signing and any cloud tunnel separately. Appium traffic stays at the existing explicitly enrolled loopback adapter. No external device-provider account was created, no cloud charges authorized and no real device fleet was certified by these fixtures.

## Browser-session recording

Recording is optional and does not require inserting a recorder into product source. It instruments a fresh QA browser on an attested disposable preview:

```sh
npm run qa:record -- --suite /trusted-bot/suite.json \
  --metadata /trusted-bot/metadata.json --goals /trusted-bot/goals.json \
  --goal checkout --output /trusted-bot/recorded-checkout
```

Metadata includes `productRoot` so all files remain outside product source. The browser requires the exact `x-qa-revision`; build/release previews must also return `x-qa-artifact-sha256`. Interactions stay on the enrolled origin, service workers and downloads are disabled, and write requests require `allowMutations: true` in the reviewed disposable-preview suite. Close the browser or press Ctrl+C to finish (maximum five minutes by default).

The recorder accepts stable IDs or `data-testid` locators, records up to 12 click/fill actions, and stores input **names**, never raw fill values. Sensitive password/email/telephone/file/credential fields are omitted. Fill inputs use `data-qa-input`, name or ID to reference a reviewed synthetic value in the trusted goal. Unsupported controls are limitations, not invented steps. Trusted goal assertions are appended when compiling `recorded-suite.json`; the current page never supplies the expected answer. Review the resulting draft, then use `qa:web` to execute it. Recording itself cannot pass a QA check.

A saved draft can be recompiled with `--recording /trusted-bot/recorded-checkout/recording.json`. The source, product, origin, target and trusted goal must match. This is explicit QA-session recording and replay, not passive production-user capture, full network cassettes or a deterministic browser scheduler. See the [comparison](comparison.md) for remaining differences.
