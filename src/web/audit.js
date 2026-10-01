// Browser QA lives in the bot repository. Target files are never mounted or edited.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { screenshotType } = require("../images");
const { redact } = require("../ai/context");
const { createPreviewProxy } = require("./proxy");
const {
  validateDiscovery,
  collectInventory,
  discoverPaths,
  discoverControls,
} = require("./discovery");
const { validateVisual, compareScreenshot } = require("./visual");
const { validateFallback, resolveStepLocator } = require("./maintenance");

const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const positive = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max;
function safeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Browser target must be an explicit HTTP(S) preview URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error(
      "Browser URLs cannot contain credentials, fragments, or non-HTTP protocols",
    );
  return url;
}
function validateWebSuite(input, metadata) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.targetEnvironment !== "preview"
  )
    throw new Error(
      "Web QA requires a trusted suite with targetEnvironment: preview",
    );
  if (
    !metadata ||
    typeof metadata.repository !== "string" ||
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(metadata.repository) ||
    !/^[a-f0-9]{40}$/.test(metadata.revision) ||
    !positive(metadata.prNumber, 1, 1e9)
  )
    throw new Error("Browser QA requires an exact commit SHA and PR number");
  const rendered = String(input.url || "")
    .replaceAll("{sha}", metadata.revision)
    .replaceAll("{pr}", String(metadata.prNumber));
  if (/[{}]/.test(rendered))
    throw new Error("Unsupported browser URL template");
  const url = safeUrl(rendered);
  const allowedOrigins = [
    ...new Set([
      url.origin,
      ...(input.allowedOrigins || []).map((value) => {
        const origin = safeUrl(value);
        if (origin.href !== `${origin.origin}/`)
          throw new Error(
            "allowedOrigins entries must be complete origins without paths",
          );
        return origin.origin;
      }),
    ]),
  ];
  if (allowedOrigins.length > 12)
    throw new Error("Browser origin allowlist is too large");
  const pages = input.pages || ["/"];
  if (
    !Array.isArray(pages) ||
    !pages.length ||
    pages.length > 8 ||
    pages.some(
      (value) =>
        typeof value !== "string" ||
        value.length > 1000 ||
        !value.startsWith("/") ||
        value.startsWith("//") ||
        new URL(value, url).origin !== url.origin,
    )
  )
    throw new Error("Configure one to eight same-origin page paths");
  const viewports = input.viewports || [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ];
  if (
    !Array.isArray(viewports) ||
    !viewports.length ||
    viewports.length > 3 ||
    new Set(viewports.map((v) => v?.name)).size !== viewports.length ||
    viewports.some(
      (value) =>
        !value ||
        !/^[a-zA-Z0-9_-]{1,30}$/.test(value.name) ||
        !positive(value.width, 240, 2560) ||
        !positive(value.height, 240, 1600),
    )
  )
    throw new Error("Configure one to three named, bounded browser viewports");
  const timeoutMs = input.timeoutMs ?? 15000;
  if (!positive(timeoutMs, 100, 30000))
    throw new Error("Browser timeoutMs must be between 100 and 30000");
  const revisionHeader =
    input.revisionHeader === undefined ? "x-qa-revision" : input.revisionHeader;
  if (
    revisionHeader !== null &&
    (typeof revisionHeader !== "string" ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(revisionHeader))
  )
    throw new Error("revisionHeader must be an HTTP header name or null");
  if (
    input.allowMutations !== undefined &&
    typeof input.allowMutations !== "boolean"
  )
    throw new Error("allowMutations must be boolean");
  const journeys = input.journeys || [];
  if (
    !Array.isArray(journeys) ||
    journeys.length > 8 ||
    new Set(journeys.map((j) => j?.name)).size !== journeys.length
  )
    throw new Error("Configure at most eight browser journeys");
  for (const journey of journeys) {
    if (
      !journey ||
      typeof journey.name !== "string" ||
      !journey.name.trim() ||
      journey.name.length > 150 ||
      !pages.includes(journey.start) ||
      !Array.isArray(journey.steps) ||
      !journey.steps.length ||
      journey.steps.length > 20
    )
      throw new Error(
        "Journeys need a name, a configured start path, and one to twenty steps",
      );
    let assertions = 0;
    for (const step of journey.steps) {
      if (
        !step ||
        ![
          "click",
          "fill",
          "press",
          "expectVisible",
          "expectText",
          "expectUrl",
        ].includes(step.action)
      )
        throw new Error(
          "Unsupported browser step; arbitrary JavaScript is not allowed",
        );
      validateFallback(step);
      if (
        step.exact !== undefined &&
        (step.action !== "expectText" || typeof step.exact !== "boolean")
      )
        throw new Error(
          "Exact text matching must be an explicit boolean on expectText",
        );
      if (step.action.startsWith("expect")) assertions++;
      if (
        step.action !== "expectUrl" &&
        !(
          (typeof step.selector === "string" &&
            step.selector.length <= 300 &&
            step.selector.trim()) ||
          (typeof step.role === "string" &&
            /^[a-z]+$/.test(step.role) &&
            typeof step.name === "string" &&
            step.name.length <= 300)
        )
      )
        throw new Error(
          "A browser step needs a bounded selector or accessible role/name",
        );
      if (
        ["fill", "press"].includes(step.action) &&
        (typeof step.value !== "string" || step.value.length > 1000)
      )
        throw new Error("Browser input must be a bounded synthetic value");
      if (
        step.action === "expectText" &&
        (typeof step.text !== "string" || !step.text || step.text.length > 1000)
      )
        throw new Error("Expected text must be explicit");
      if (
        step.action === "expectUrl" &&
        (typeof step.path !== "string" ||
          !step.path.startsWith("/") ||
          step.path.startsWith("//") ||
          new URL(step.path, url).origin !== url.origin)
      )
        throw new Error("Expected URL must be a same-origin path");
    }
    if (!assertions)
      throw new Error(
        "Every browser journey needs an explicit expected assertion",
      );
  }
  const browsers = input.browsers || ["chromium"];
  if (
    !Array.isArray(browsers) ||
    !browsers.length ||
    browsers.length > 3 ||
    new Set(browsers).size !== browsers.length ||
    browsers.some((name) => !["chromium", "firefox", "webkit"].includes(name))
  )
    throw new Error(
      "Choose a distinct explicit Chromium, Firefox, and/or WebKit matrix",
    );
  const discovery = validateDiscovery(input.discovery),
    visual = validateVisual(input.visual);
  return {
    browsers,
    discovery,
    visual,
    url: url.href,
    origin: url.origin,
    allowedOrigins,
    pages: [...new Set(pages)],
    viewports,
    timeoutMs,
    revisionHeader,
    allowMutations: input.allowMutations === true,
    journeys,
    targetEnvironment: "preview",
  };
}

function browserLaunchOptions(env = process.env, engine = "chromium") {
  if (!["chromium", "firefox", "webkit"].includes(engine))
    throw new Error("Unsupported browser engine");
  const environment = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "TEMP",
      "TMP",
      "SYSTEMROOT",
      "DISPLAY",
      "PLAYWRIGHT_BROWSERS_PATH",
    ]
      .filter((key) => env[key])
      .map((key) => [key, env[key]]),
  );
  const executable =
    env[`QA_${engine.toUpperCase()}_EXECUTABLE`] ||
    (engine === "chromium" && env.QA_BROWSER_EXECUTABLE);
  const options = {
    headless: true,
    env: environment,
    ...(executable ? { executablePath: executable } : {}),
  };
  if (engine === "chromium")
    Object.assign(options, {
      chromiumSandbox: true,
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--proxy-bypass-list=<-loopback>",
        "--disable-http2",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
  if (engine === "firefox")
    options.firefoxUserPrefs = {
      "network.proxy.allow_hijacking_localhost": true,
      "media.peerconnection.enabled": false,
      "dom.serviceWorkers.enabled": false,
      "network.http.http3.enable": false,
      "network.dns.disablePrefetch": true,
      "network.prefetch-next": false,
    };
  return options;
}

// Redirect response headers must update the isolated cookie jar before the next
// guarded navigation. Broader-domain cookies are refused rather than approximated.
async function applyRedirectCookies(context, url, headers) {
  const values = headers.getSetCookie();
  if (values.length > 40) throw new Error("Too many preview redirect cookies");
  const cookies = values.map((value) => {
    if (value.length > 4096) throw new Error("Preview cookie exceeds limits");
    const [pair, ...attributes] = value.split(";");
    const equal = pair.indexOf("=");
    if (equal < 1) throw new Error("Invalid preview cookie");
    const cookie = {
      name: pair.slice(0, equal).trim(),
      value: pair.slice(equal + 1).trim(),
      domain: url.hostname,
      path: url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) || "/",
    };
    let maxAge;
    for (const attribute of attributes) {
      const [raw, ...rest] = attribute.trim().split("="),
        key = raw.toLowerCase(),
        data = rest.join("=").trim();
      if (
        key === "domain" &&
        data.replace(/^\./, "").toLowerCase() !== url.hostname.toLowerCase()
      )
        throw new Error(
          "Redirect cookie requested a broader domain than the approved origin",
        );
      if (key === "path" && data.startsWith("/")) cookie.path = data;
      if (key === "secure") cookie.secure = true;
      if (key === "httponly") cookie.httpOnly = true;
      if (key === "samesite" && /^(strict|lax|none)$/i.test(data))
        cookie.sameSite = data[0].toUpperCase() + data.slice(1).toLowerCase();
      if (key === "expires" && Number.isFinite(Date.parse(data)))
        cookie.expires = Math.max(1, Math.floor(Date.parse(data) / 1000));
      if (key === "max-age" && /^-?\d+$/.test(data)) maxAge = Number(data);
    }
    if (maxAge !== undefined)
      cookie.expires =
        maxAge <= 0
          ? 1
          : Math.min(253402300799, Math.floor(Date.now() / 1000) + maxAge);
    return cookie;
  });
  if (cookies.length) await context.addCookies(cookies);
}

async function deadline(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded its lifecycle deadline`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runWebAudit({
  suite: input,
  metadata,
  outputDir,
  checkId = "web-browser-audit",
  chromium,
  browsers,
  axeFactory,
  proxyFactory = createPreviewProxy,
  env = process.env,
  onBrowserProcess = async () => {},
}) {
  const suite = validateWebSuite(input, metadata);
  const engines = {
    ...(browsers || require("playwright-core")),
    ...(chromium ? { chromium } : {}),
  };
  const runId = crypto.randomUUID();
  axeFactory ||= (page) =>
    new (require("@axe-core/playwright").default)({ page }).withTags([
      "wcag2a",
      "wcag2aa",
      "wcag21aa",
    ]);
  const output = path.resolve(outputDir);
  await fs.mkdir(output, { recursive: true });
  const observations = [],
    screenshots = [],
    inventory = [],
    states = [],
    repairs = [],
    visualResults = [],
    limitations = [
      "Browser checks cover only requested engines, bounded discovered/configured pages, viewports, and journeys. Unvisited states, assistive technologies, and unstated requirements remain outside coverage.",
      "Visual enhancement proposals are advisory. Screenshots and automated accessibility checks do not establish complete usability or accessibility.",
      ...(suite.browsers.includes("webkit")
        ? [
            "WebKit navigations use a guarded HTTP transport; redirect hops are checked individually. Subresource redirects, asynchronous redirects outside a tracked navigation, and redirects requiring POST replay remain blocked coverage.",
          ]
        : []),
    ];
  let imageBytes = 0,
    inventoryBytes = 0,
    unverifiedRevision = false,
    queuedExplorations = 0;
  const record = (name, status, details, location = "") =>
    observations.push({
      name,
      status,
      details: redact(details).slice(0, 4000),
      location: redact(location).slice(0, 500),
    });
  const captureState = async (
    page,
    { engine, viewport, target, bound, phase, stepIndex },
  ) => {
    const item = await deadline(
      collectInventory(page, {
        revision: metadata.revision,
        browser: engine,
        viewport: viewport.name,
        revisionVerified: bound,
        maxLinks: suite.discovery.maxLinksPerPage,
        startPath: target.start,
        navigationSteps: target.navigationSteps || [],
      }),
      suite.timeoutMs,
      "State inventory",
    );
    const size = JSON.stringify(item).length;
    if (
      states.length < suite.discovery.maxStates &&
      inventoryBytes + size <= 500000
    ) {
      states.push({
        stateId: item.stateId,
        path: item.path,
        browser: engine,
        viewport: viewport.name,
        phase,
        journey: target.name,
        stepIndex,
        revisionVerified: bound,
      });
      if (!inventory.some((existing) => existing.stateId === item.stateId)) {
        inventory.push(item);
        inventoryBytes += size;
      }
    } else
      limitations.push(
        "Visited state inventory reached its bounded limit; later states were not retained for model planning.",
      );
    return item;
  };
  const screenshot = async (page, label, identity) => {
    const needsVisual =
      suite.visual && visualResults.length < suite.visual.maxSnapshots;
    if (screenshots.length >= 4 && !needsVisual) {
      limitations.push(
        "Only the first four browser states were captured for AI image review.",
      );
      return;
    }
    try {
      const bytes = await page.screenshot({
        type: "png",
        fullPage: false,
        animations: "disabled",
        caret: "hide",
        timeout: suite.timeoutMs,
      });
      if (bytes.length > 2 * 1024 * 1024 || !screenshotType(bytes))
        throw new Error("Screenshot exceeded evidence limits");
      if (
        screenshots.length < 4 &&
        imageBytes + bytes.length <= 6 * 1024 * 1024
      ) {
        const sha256 = digest(bytes),
          filename = `screenshots/${sha256}.png`;
        await fs.mkdir(path.join(output, "screenshots"), { recursive: true });
        await fs.writeFile(path.join(output, filename), bytes, { mode: 0o600 });
        imageBytes += bytes.length;
        screenshots.push({
          name: label,
          path: filename,
          sha256,
          mimeType: "image/png",
          revision: metadata.revision,
          checkId,
          ...identity,
        });
      }
      if (needsVisual) {
        const compared = await compareScreenshot({
          bytes,
          ...suite.visual,
          identity: { repository: metadata.repository, checkId, ...identity },
          metadata: { ...metadata, revisionVerified: true },
          outputDir: output,
        });
        visualResults.push({ label, ...compared });
        record(
          `${label} visual baseline`,
          compared.status,
          compared.details,
          page.url(),
        );
      } else if (suite.visual)
        record(
          `${label} visual baseline`,
          "blocked",
          "Visual snapshot budget exhausted.",
        );
    } catch (error) {
      limitations.push(
        `Screenshot unavailable for ${label}; visual coverage is incomplete.`,
      );
      if (suite.visual)
        record(`${label} visual baseline`, "blocked", error.message);
    }
  };
  for (const engine of suite.browsers) {
    let browser, browserServer, browserPid;
    const closeBrowser = async () => {
      if (browser)
        await deadline(
          browser.close(),
          2000,
          "Browser connection cleanup",
        ).catch((error) =>
          record(`${engine} cleanup`, "execution_error", error.message),
        );
      if (browserServer) {
        try {
          await deadline(
            browserServer.close(),
            2000,
            "Browser process cleanup",
          );
        } catch (error) {
          record(`${engine} cleanup`, "execution_error", error.message);
          await deadline(
            browserServer.kill(),
            2000,
            "Browser force cleanup",
          ).catch(() => {
            try {
              process.platform === "win32"
                ? process.kill(browserPid, "SIGKILL")
                : process.kill(-browserPid, "SIGKILL");
            } catch {
              /* already exited */
            }
          });
        }
        await onBrowserProcess(browserPid, false);
      }
    };
    try {
      const type = engines[engine],
        options = {
          ...browserLaunchOptions(env, engine),
          timeout: suite.timeoutMs,
        };
      if (type?.launchServer && type?.connect) {
        browserServer = await type.launchServer({
          ...options,
          host: "127.0.0.1",
        });
        browserPid = browserServer.process().pid;
        await onBrowserProcess(browserPid, true);
        browser = await type.connect(browserServer.wsEndpoint(), {
          timeout: suite.timeoutMs,
        });
      } else browser = await type?.launch(options);
    } catch (error) {
      record(
        `${engine} engine availability`,
        "blocked",
        `Requested engine could not start: ${error.message}`,
      );
      await closeBrowser();
      continue;
    }
    if (!browser) {
      record(
        `${engine} engine availability`,
        "blocked",
        "Requested engine is unavailable; no engine substitution was made.",
      );
      continue;
    }
    try {
      for (const viewport of suite.viewports) {
        const proxy = await proxyFactory(suite);
        let context;
        try {
          context = await deadline(
            browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              serviceWorkers: "block",
              acceptDownloads: false,
              proxy: {
                server: proxy.server,
                ...(engine === "chromium" ? { bypass: "<-loopback>" } : {}),
              },
              permissions: [],
              ignoreHTTPSErrors: false,
              reducedMotion: "reduce",
              colorScheme: "light",
              locale: "en-US",
              timezoneId: "UTC",
              deviceScaleFactor: 1,
            }),
            suite.timeoutMs,
            "Browser context creation",
          );
          context.setDefaultTimeout?.(suite.timeoutMs);
          let requestsBlocked = 0,
            activeDiscovery = false;
          const pendingNavigations = new WeakMap();
          const replayedRedirects = new WeakSet();
          const navigate = async (page, destination) => {
            if (engine !== "webkit")
              return page.goto(destination, { waitUntil: "load" });
            let next = destination;
            for (let hop = 0; hop <= 10; hop++) {
              let notify;
              const redirected = new Promise((resolve) => {
                notify = resolve;
              });
              pendingNavigations.set(page, notify);
              const loaded = page.goto(next, { waitUntil: "load" }).then(
                (response) => ({ response }),
                (error) => ({ error }),
              );
              const outcome = await Promise.race([loaded, redirected]);
              pendingNavigations.delete(page);
              if (outcome.error) throw outcome.error;
              if (outcome.redirect) {
                next = outcome.redirect;
                continue;
              }
              return outcome.response;
            }
            throw new Error("Preview redirect chain exceeded ten hops");
          };
          const interact = async (page, action) => {
            if (engine !== "webkit") return action();
            let notify;
            const redirected = new Promise((resolve) => {
              notify = resolve;
            });
            pendingNavigations.set(page, notify);
            const performed = Promise.resolve()
              .then(action)
              .then(
                (value) => ({ value }),
                (error) => ({ error }),
              );
            const outcome = await Promise.race([performed, redirected]);
            pendingNavigations.delete(page);
            if (outcome.error) throw outcome.error;
            if (outcome.redirect) return navigate(page, outcome.redirect);
            return outcome.value;
          };
          await context.route("**/*", async (route) => {
            try {
              const target = safeUrl(route.request().url());
              const method = route.request().method();
              if (
                !suite.allowedOrigins.includes(target.origin) ||
                ((!suite.allowMutations || activeDiscovery) &&
                  !["GET", "HEAD", "OPTIONS"].includes(method))
              ) {
                requestsBlocked++;
                return route.abort();
              }
              if (engine === "webkit") {
                // WebKit/macOS bypasses loopback proxies on redirects. Intercept its
                // requests through a bounded, non-redirecting trusted HTTP client.
                const headers = await route.request().allHeaders();
                // WebKit exposes intercepted navigation headers before attaching
                // cookies added during our guarded redirect. Supply only matching
                // cookies from this isolated context to main-frame navigations.
                if (
                  !headers.cookie &&
                  route.request().isNavigationRequest() &&
                  route.request().frame() ===
                    route.request().frame().page().mainFrame()
                ) {
                  const cookies = await context.cookies(target.href);
                  if (cookies.length)
                    headers.cookie = cookies
                      .map((cookie) => `${cookie.name}=${cookie.value}`)
                      .join("; ");
                }
                for (const key of [
                  "host",
                  "connection",
                  "content-length",
                  "transfer-encoding",
                  "proxy-authorization",
                  "proxy-connection",
                ])
                  delete headers[key];
                const body = route.request().postDataBuffer();
                if (body && body.length > 1024 * 1024) {
                  requestsBlocked++;
                  return route.abort();
                }
                const controller = new AbortController(),
                  timer = setTimeout(() => controller.abort(), suite.timeoutMs);
                try {
                  const response = await fetch(target.href, {
                    method,
                    headers,
                    ...(body ? { body } : {}),
                    redirect: "manual",
                    signal: controller.signal,
                  });
                  const responseHeaders = Object.fromEntries(
                    response.headers.entries(),
                  );
                  const location = responseHeaders.location;
                  if (response.status >= 300 && response.status < 400) {
                    if (!location)
                      throw new Error("Redirect response omitted its location");
                    const next = safeUrl(new URL(location, target).href);
                    if (!suite.allowedOrigins.includes(next.origin)) {
                      requestsBlocked++;
                      await response.body?.cancel();
                      return route.abort();
                    }
                    // Native WebKit redirects bypass the loopback proxy and its
                    // route fulfillment cannot emit 3xx. Abort that navigation and
                    // repeat the normal guarded page.goto at each approved hop.
                    // Subresource or unobserved asynchronous redirects remain blocked.
                    const mayNavigateWithGet =
                      method === "GET" ||
                      (method === "POST" &&
                        [301, 302, 303].includes(response.status));
                    const notify =
                      route.request().isNavigationRequest() &&
                      mayNavigateWithGet &&
                      pendingNavigations.get(route.request().frame().page());
                    if (!notify)
                      throw new Error(
                        "This WebKit redirect cannot be replayed safely",
                      );
                    await applyRedirectCookies(
                      context,
                      target,
                      response.headers,
                    );
                    await response.body?.cancel();
                    replayedRedirects.add(route.request());
                    notify({ redirect: next.href });
                    await route.abort();
                    return;
                  }
                  const cookies = response.headers.getSetCookie();
                  if (cookies.length) {
                    await applyRedirectCookies(
                      context,
                      target,
                      response.headers,
                    );
                    delete responseHeaders["set-cookie"];
                  }
                  const chunks = [];
                  let length = 0;
                  for await (const chunk of response.body || []) {
                    length += chunk.length;
                    if (length > 8 * 1024 * 1024) {
                      controller.abort();
                      throw new Error(
                        "Preview response exceeded evidence limits",
                      );
                    }
                    chunks.push(chunk);
                  }
                  delete responseHeaders["content-encoding"];
                  delete responseHeaders["content-length"];
                  delete responseHeaders["transfer-encoding"];
                  await route.fulfill({
                    status: response.status,
                    headers: responseHeaders,
                    body: Buffer.concat(chunks),
                  });
                } finally {
                  clearTimeout(timer);
                }
              } else await route.continue();
            } catch {
              requestsBlocked++;
              await route.abort().catch(() => {});
            }
          });
          // WebSockets can mutate server state and evade the HTTP method allowlist.
          await context.routeWebSocket("**/*", (socket) => {
            requestsBlocked++;
            socket.close();
          });
          const targets = [
            ...suite.pages.map((start) => ({ start, depth: 0 })),
            ...suite.journeys,
          ];
          const visitedPaths = new Set(suite.pages);
          for (const target of targets) {
            activeDiscovery = !!target.navigationSteps;
            if (activeDiscovery) {
              queuedExplorations--;
              if (states.length >= suite.discovery.maxStates) {
                limitations.push(
                  "Control exploration reached the global state limit; additional states remain unvisited.",
                );
                continue;
              }
            }
            const page = await deadline(
              context.newPage(),
              suite.timeoutMs,
              "Browser page creation",
            );
            page.setDefaultTimeout(suite.timeoutMs);
            page.setDefaultNavigationTimeout(suite.timeoutMs);
            const label = `${engine}/${viewport.name}: ${target.name || target.start}${target.navigationSteps ? " [expand " + (target.navigationSteps[0].name || target.navigationSteps[0].fallback?.name || target.navigationSteps[0].selector) + "]" : ""}`;
            const errors = [],
              failedResources = [];
            let finalDocument,
              journeyStarted = false,
              initialInventory;
            page.on("pageerror", (error) => {
              if (errors.length < 10)
                errors.push(redact(error.message).slice(0, 500));
            });
            page.on("console", (message) => {
              if (message.type() === "error" && errors.length < 10)
                errors.push(redact(message.text()).slice(0, 500));
            });
            page.on("response", (response) => {
              if (
                response.request().resourceType() === "document" &&
                response.frame() === page.mainFrame()
              )
                finalDocument = response;
              if (response.status() >= 400 && failedResources.length < 10)
                failedResources.push(
                  `${response.status()} ${redact(response.url()).slice(0, 300)}`,
                );
            });
            page.on("requestfailed", (request) => {
              if (replayedRedirects.has(request)) return;
              if (failedResources.length < 10)
                failedResources.push(
                  `Request failed: ${redact(request.url()).slice(0, 300)}`,
                );
            });
            page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
            // Do not retain or follow application-created popups or downloads.
            page.on("popup", (popup) => popup.close().catch(() => {}));
            try {
              const destination = new URL(target.start, suite.url).href;
              const response = await navigate(page, destination);
              if (!response || response.status() >= 400)
                record(
                  `${label} loads`,
                  "failed",
                  `Main document HTTP ${response?.status() || "unavailable"}`,
                  destination,
                );
              else
                record(
                  `${label} loads`,
                  "passed",
                  `Main document HTTP ${response.status()}`,
                  destination,
                );
              const servedRevision =
                suite.revisionHeader &&
                (await response?.headerValue(suite.revisionHeader));
              let bound =
                servedRevision?.trim() === metadata.revision &&
                new URL(page.url()).origin === suite.origin;
              if (!bound) unverifiedRevision = true;
              record(
                `${label} deployment identity`,
                bound ? "passed" : "blocked",
                bound
                  ? "The preview reports the exact requested commit."
                  : "Preview commit could not be verified. Supply a preview/proxy revision header tied to its deployed commit; caller-provided SHA alone is insufficient.",
                destination,
              );
              if (target.navigationSteps) {
                if (!bound)
                  throw new Error(
                    "Control exploration requires verified deployed revision",
                  );
                for (const step of target.navigationSteps) {
                  const locator = await resolveStepLocator(page, step);
                  if (
                    (await locator.count()) !== 1 ||
                    !(await locator.isVisible())
                  )
                    throw new Error(
                      "Discovered control is no longer unique and visible",
                    );
                  const safe = await locator.evaluate(
                    (el) =>
                      !el.disabled &&
                      el.getAttribute("aria-disabled") !== "true" &&
                      !(el.form && el.type === "submit") &&
                      (el.getAttribute("aria-haspopup") === "dialog" ||
                        el.getAttribute("aria-expanded") === "false" ||
                        (el.getAttribute("role") === "tab" &&
                          el.getAttribute("aria-selected") !== "true") ||
                        (el.tagName === "SUMMARY" && !el.parentElement?.open)),
                  );
                  if (!safe)
                    throw new Error(
                      "Discovered control changed its non-submitting expansion contract",
                    );
                  await interact(page, () => locator.click());
                }
                const finalRevision =
                  suite.revisionHeader &&
                  (await (finalDocument || response)?.headerValue(
                    suite.revisionHeader,
                  ));
                bound =
                  bound &&
                  finalRevision?.trim() === metadata.revision &&
                  new URL(page.url()).origin === suite.origin;
                if (!bound) unverifiedRevision = true;
                record(
                  `${label} expanded deployment identity`,
                  bound ? "passed" : "blocked",
                  bound
                    ? "Expanded state remains bound to the requested revision."
                    : "Expanded state left the verified deployment.",
                  page.url(),
                );
              }
              initialInventory = await captureState(page, {
                engine,
                viewport,
                target,
                bound,
                phase: target.navigationSteps ? "expanded" : "loaded",
              });
              if (target.steps) {
                journeyStarted = true;
                for (const [stepIndex, step] of target.steps.entries()) {
                  const locator =
                    step.action === "expectUrl"
                      ? null
                      : await resolveStepLocator(page, step, {
                          repairs,
                          journey: target.name,
                          stepIndex,
                          revision: metadata.revision,
                          browser: engine,
                          viewport: viewport.name,
                        });
                  if (step.action === "click")
                    await interact(page, () => locator.click());
                  else if (step.action === "fill")
                    await interact(page, () => locator.fill(step.value));
                  else if (step.action === "press")
                    await interact(page, () => locator.press(step.value));
                  else if (step.action === "expectVisible")
                    await locator.waitFor({ state: "visible" });
                  else if (step.action === "expectText") {
                    if (step.exact) {
                      const deadline = Date.now() + suite.timeoutMs;
                      let matched = false;
                      do {
                        if (
                          (await locator.count()) === 1 &&
                          (await locator.isVisible()) &&
                          (await locator.textContent()) === step.text
                        ) {
                          matched = true;
                          break;
                        }
                        await new Promise((resolve) => setTimeout(resolve, 50));
                      } while (Date.now() < deadline);
                      if (!matched)
                        throw new Error(
                          "Exact expected text did not match the visible target",
                        );
                    } else
                      await locator
                        .filter({ hasText: step.text })
                        .waitFor({ state: "visible" });
                  } else if (step.action === "expectUrl")
                    await page.waitForURL(new URL(step.path, suite.url).href);
                  const stateRevision =
                    suite.revisionHeader &&
                    (await (finalDocument || response)?.headerValue(
                      suite.revisionHeader,
                    ));
                  const stateBound =
                    bound &&
                    stateRevision?.trim() === metadata.revision &&
                    new URL(page.url()).origin === suite.origin;
                  if (!stateBound) unverifiedRevision = true;
                  await captureState(page, {
                    engine,
                    viewport,
                    target,
                    bound: stateBound,
                    phase: "step",
                    stepIndex,
                  });
                }
                record(
                  `${label} journey`,
                  "passed",
                  "Every configured interaction and expected assertion completed.",
                  page.url(),
                );
                journeyStarted = false;
                const finalRevision =
                  suite.revisionHeader &&
                  (await (finalDocument || response)?.headerValue(
                    suite.revisionHeader,
                  ));
                bound =
                  bound &&
                  finalRevision?.trim() === metadata.revision &&
                  new URL(page.url()).origin === suite.origin;
                if (!bound) unverifiedRevision = true;
                record(
                  `${label} final deployment identity`,
                  bound ? "passed" : "blocked",
                  bound
                    ? "The journey ended on the expected deployment."
                    : "The journey changed deployment identity or left the configured preview origin.",
                  page.url(),
                );
              }
              const layout = await deadline(
                page.evaluate(() => ({
                  overflow:
                    document.documentElement.scrollWidth >
                    window.innerWidth + 1,
                  brokenImages: [...document.images]
                    .filter(
                      (image) =>
                        image.complete &&
                        image.currentSrc &&
                        image.naturalWidth === 0,
                    )
                    .map((image) => image.getAttribute("src"))
                    .slice(0, 10),
                  title: document.title,
                })),
                suite.timeoutMs,
                "Layout inspection",
              );
              record(
                `${label} horizontal layout`,
                layout.overflow ? "failed" : "passed",
                layout.overflow
                  ? "Content overflows the configured viewport horizontally."
                  : "No horizontal viewport overflow detected.",
                page.url(),
              );
              record(
                `${label} images`,
                layout.brokenImages.length ? "failed" : "passed",
                layout.brokenImages.length
                  ? `Broken images: ${layout.brokenImages.join(", ")}`
                  : "Loaded images have valid dimensions.",
                page.url(),
              );
              const accessibility = await deadline(
                axeFactory(page).analyze(),
                suite.timeoutMs,
                "Accessibility inspection",
              );
              const violations = accessibility.violations || [];
              record(
                `${label} accessibility`,
                violations.length ? "failed" : "passed",
                violations.length
                  ? violations
                      .slice(0, 15)
                      .map(
                        (item) =>
                          `${item.id} (${item.impact}): ${item.help}; ${(
                            item.nodes || []
                          )
                            .slice(0, 3)
                            .map((node) => JSON.stringify(node.target))
                            .join(", ")}`,
                      )
                      .join("\n")
                  : "No violations found by the configured automated WCAG rules.",
                page.url(),
              );
              if (accessibility.incomplete?.length)
                limitations.push(
                  `${label}: ${accessibility.incomplete.length} accessibility rules were inconclusive; these are not established passes.`,
                );
              record(
                `${label} browser errors`,
                errors.length ? "failed" : "passed",
                errors.length
                  ? errors.join("\n")
                  : "No captured console errors or uncaught exceptions.",
                page.url(),
              );
              record(
                `${label} resources`,
                failedResources.length ? "failed" : "passed",
                failedResources.length
                  ? failedResources.join("\n")
                  : "No captured HTTP resource errors.",
                page.url(),
              );
              // Images are eligible for AI review only when deployment identity was observed.
              if (bound)
                await screenshot(page, label, {
                  browser: engine,
                  viewport: viewport.name,
                  width: viewport.width,
                  height: viewport.height,
                  pagePath: target.start,
                  journey: target.name || null,
                  ...(target.navigationSteps
                    ? { navigationSteps: target.navigationSteps }
                    : {}),
                });
              else
                limitations.push(
                  `${label}: images withheld from AI because the deployed revision was not established.`,
                );
              if (
                suite.discovery.enabled &&
                suite.discovery.exploreControls &&
                !target.name &&
                !target.navigationSteps
              ) {
                for (const step of discoverControls(
                  initialInventory,
                  suite.discovery,
                )) {
                  if (
                    states.length + queuedExplorations >=
                    suite.discovery.maxStates
                  ) {
                    limitations.push(
                      "Control exploration reached the global state limit; additional states remain unvisited.",
                    );
                    break;
                  }
                  queuedExplorations++;
                  targets.push({
                    start: target.start,
                    depth: target.depth,
                    navigationSteps: [step],
                  });
                }
              }
              if (
                suite.discovery.enabled &&
                !target.name &&
                target.depth < suite.discovery.maxDepth
              ) {
                for (const next of discoverPaths(
                  initialInventory,
                  suite.discovery,
                )) {
                  if (visitedPaths.has(next)) continue;
                  if (visitedPaths.size >= suite.discovery.maxPages) {
                    limitations.push(
                      "Route discovery reached maxPages; additional links remain unvisited.",
                    );
                    break;
                  }
                  visitedPaths.add(next);
                  targets.push({
                    start: next,
                    depth: target.depth + 1,
                    discovered: true,
                  });
                }
              }
            } catch (error) {
              record(
                `${label} ${journeyStarted ? "journey" : "execution"}`,
                journeyStarted ? "failed" : "execution_error",
                error.message,
                target.start,
              );
            } finally {
              await deadline(page.close(), 2000, "Browser page cleanup").catch(
                (error) =>
                  record(`${label} cleanup`, "execution_error", error.message),
              );
            }
          }
          if (requestsBlocked)
            record(
              `${engine}/${viewport.name} network coverage`,
              "blocked",
              `${requestsBlocked} page request(s) were blocked by the trusted origin/method policy. Configure required synthetic preview dependencies before claiming full coverage.`,
            );
          // Chromium also attempts background service connections through its
          // context proxy. They remain denied but are not product test failures.
          // Failed page requests, including redirected resources, are captured above.
          if (proxy.blocked)
            limitations.push(
              `${engine}/${viewport.name}: the proxy refused ${proxy.blocked} unapproved connection(s). Page-level request failures are recorded separately from browser background traffic.`,
            );
        } finally {
          try {
            if (context)
              await deadline(context.close(), 2000, "Browser context cleanup");
          } finally {
            await deadline(proxy.close(), 2000, "Browser proxy cleanup");
          }
        }
      }
    } catch (error) {
      record(`${engine} execution`, "execution_error", error.message);
    } finally {
      await closeBrowser();
    }
  }
  const status = unverifiedRevision
    ? "blocked"
    : ["failed", "execution_error", "blocked", "skipped"].find((value) =>
        observations.some((item) => item.status === value),
      ) || (observations.length ? "passed" : "blocked");
  const counts = {
    tests: observations.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const item of observations) {
    if (item.status === "passed") counts.passed++;
    else if (item.status === "failed") counts.failed++;
    else if (item.status === "execution_error") counts.cancelled++;
    else counts.skipped++;
  }
  if (unverifiedRevision) {
    counts.passed = 0;
    counts.failed = 0;
    counts.cancelled = 0;
    counts.skipped = counts.tests;
    limitations.push(
      "One or more preview documents could not be bound to the requested commit. All browser counts are withheld as blocked; observations are unbound diagnostics, not confirmed defects at that SHA.",
    );
  }
  const evidencePath = `browser-${digest(checkId).slice(0, 16)}.json`;
  const result = {
    checkId,
    status,
    counts,
    details: unverifiedRevision
      ? "Preview revision identity was not verified. Browser observations are unbound diagnostics; no pass or defect is attributed to the requested SHA."
      : `${counts.tests} browser checks: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} blocked, ${counts.cancelled} execution errors.`,
    evidence: [
      {
        type: "browser",
        path: evidencePath,
        excerpt: observations
          .filter((item) => item.status !== "passed")
          .map((item) => `${item.name}: ${item.details}`)
          .join("\n")
          .slice(0, 6000),
      },
    ],
  };
  const evidence = {
    schemaVersion: 1,
    runId,
    suiteDigest: digest(JSON.stringify(suite)),
    browsers: suite.browsers,
    inventory,
    states,
    repairs,
    visualResults,
    repository: metadata.repository,
    prNumber: metadata.prNumber,
    revision: metadata.revision,
    environment: "disposable-web-preview",
    revisionVerified:
      !unverifiedRevision &&
      observations.some(
        (item) =>
          item.name.endsWith("deployment identity") && item.status === "passed",
      ),
    checkId,
    result,
    observations,
    screenshots,
    limitations: [...new Set(limitations)],
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(output, evidencePath),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  return evidence;
}

module.exports = { validateWebSuite, browserLaunchOptions, runWebAudit };
