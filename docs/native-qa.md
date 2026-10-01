# Native app QA

The native adapter runs explicit Android, iOS, and macOS app journeys through an already provisioned local Appium server. It does not install Appium drivers, create devices, sign builds, create a VM, or launch an app on the developer's ordinary desktop automatically. Tests use a synthetic W3C server; real device and application execution has not been verified in this repository.

Use a dedicated disposable emulator/device or macOS VM with synthetic accounts and data. The Appium server and runner must share the staged artifact filesystem. Keep the server's environment free of model and integration credentials. For Mac2, both processes must run inside the disposable macOS VM, not on a personal workstation. Reset that VM between jobs; restarting an app does not clear macOS preferences, keychains, or other OS state. The adapter verifies configured enrollment, not actual virtualization or network isolation.

## Enroll the device and artifact

The runner requires both `QA_NATIVE_ENABLED=true` and `QA_NATIVE_DEVICE_ID` equal to the suite's `deviceId`. Mobile sessions also require an explicit matching `appium:udid`; they never select the first connected device. Android uses UiAutomator2, iOS uses XCUITest, and macOS uses Mac2. The driver must already be installed and its platform prerequisites satisfied. See the official [UiAutomator2 setup and capabilities](https://github.com/appium/appium-uiautomator2-driver), [XCUITest capabilities](https://appium.github.io/appium-xcuitest-driver/9.7/reference/capabilities/), and [Mac2 capabilities](https://appium.github.io/appium-mac2-driver/v4/reference/capabilities/).

The Appium endpoint must be literal loopback HTTP(S), such as `http://127.0.0.1:4723`, with optional `/wd/hub`. Remote hosts, credentials, queries, redirects, arbitrary base paths, scripts, custom capabilities, launch arguments, environment variables, shell commands, and WebDriver keyboard command codes are refused.

A trusted builder must associate the actual build with the source revision. Hash the artifact in that build process:

```sh
node src/native/hash-artifact.js /trusted-builds/Example.apk
```

Write a separate, trusted attestation outside the product repository and outside `.app` bundles:

```json
{
  "schemaVersion": 1,
  "repository": "example/product",
  "revision": "FULL_40_CHARACTER_COMMIT_SHA",
  "artifactSha256": "HASH_FROM_THE_TRUSTED_BUILD_STEP",
  "algorithm": "sha256"
}
```

The adapter cannot prove that an arbitrary manually written attestation came from the declared source. Protect the builder and attestation as part of your CI trust boundary. APK/IPA files use ordinary SHA-256. App bundles use `patchsentry-native-tree-v1`: SHA-256 of that algorithm name, a NUL byte, and JSON containing a sorted recursive manifest of relative paths, kinds, permission bits, file sizes/hashes, and internal symlink targets. Use the supplied helper to avoid implementation differences. External links, hard links, special files, trees deeper than 40 levels, more than 20,000 entries, or artifacts larger than 512 MiB are refused.

## Configure a trusted suite

Store this JSON in the bot workspace:

```json
{
  "targetEnvironment": "disposable-device",
  "deviceId": "emulator-5554",
  "serverUrl": "http://127.0.0.1:4723",
  "artifactPath": "/trusted-builds/Example.apk",
  "attestationPath": "/trusted-bot/build-attestation.json",
  "productRoot": "/read-only/product-checkout",
  "capabilities": {
    "platformName": "Android",
    "appium:automationName": "UiAutomator2",
    "appium:udid": "emulator-5554",
    "appium:deviceName": "Disposable QA emulator"
  },
  "captureScreenshots": true,
  "requestTimeoutMs": 30000,
  "timeoutMs": 180000,
  "maxRequests": 700,
  "journeys": [{
    "name": "Reject an invalid email",
    "steps": [
      { "action": "fill", "locator": { "using": "accessibilityId", "value": "Email address" }, "value": "not-an-email" },
      { "action": "click", "locator": { "using": "id", "value": "submit" } },
      { "action": "expectText", "locator": { "using": "id", "value": "error" }, "text": "Enter a valid email address" }
    ]
  }]
}
```

Locators support `accessibilityId`, `id`, and bounded XPath. Each must match exactly one element. Journeys support `click`, `fill`, `expectVisible`, and exact `expectText`; no model-generated code executes. Each of the maximum eight journeys needs a trusted assertion and may contain up to twenty steps. Expected results must come from requirements, not from observing the app and approving its current behavior.

For iOS, use `platformName: "iOS"`, `appium:automationName: "XCUITest"`, an explicitly enrolled simulator/device UDID, and a local `.ipa` or `.app` artifact. For macOS, use `platformName: "mac"`, `appium:automationName: "Mac2"`, and an explicit `appium:bundleId`; omit the UDID. The adapter generates `appium:app` for mobile or `appium:appPath` for Mac2, pointing to the verified staged copy. It forces fresh app sessions and mobile full resets; Mac2 app termination uses its documented capability. These commands use the fixed [Appium W3C endpoint subset](https://appium.io/docs/en/3.0/reference/api/webdriver/).

Supply exact run metadata:

```json
{ "repository": "example/product", "revision": "FULL_40_CHARACTER_COMMIT_SHA", "prNumber": 42 }
```

```sh
QA_NATIVE_ENABLED=true QA_NATIVE_DEVICE_ID=emulator-5554 npm run qa:native -- \
  --suite /trusted-bot/native-suite.json \
  --metadata /trusted-bot/revision.json \
  --output /trusted-bot/.qa-local/native-run
```

The existing executor also accepts a trusted runner with `type: "native-app"` and this object in `suite`. Mark it `baseline: true` to include it in explicitly enabled isolated baseline execution. Native installation and UI interactions run on the separately enrolled device, not inside the Docker test container.

The original artifact is read, hashed, and copied into the separate bot workspace. Source and staged copies are checked again after execution. Normal completed sessions are deleted and staged copies removed; uncertain session creation or failed cleanup quarantines further journeys and retains the staged copy for investigation. Reset the disposable device/VM before reusing it.

Unavailable drivers/devices, stale builds, malformed responses, exhausted budgets, missing assertions, ambiguous controls, and failed cleanup never become passes. Screenshots are opt-in, bounded PNG/JPEG files tied to the attested artifact revision; unverified images are withheld. Native report coverage is limited to these journeys. It does not establish exhaustive native accessibility, performance, device compatibility, visual regression, or app-store compliance.
