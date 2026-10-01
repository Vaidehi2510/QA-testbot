const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateDiscovery,
  discoverPaths,
  discoverControls,
  collectInventory,
} = require("../src/web/discovery");
const { browserLaunchOptions, validateWebSuite } = require("../src/web/audit");
const metadata = {
  repository: "owner/product",
  prNumber: 1,
  revision: "a".repeat(40),
};
test("route discovery stays bounded, explicitly same-origin and excludes queries, destructive links, and downloads", () => {
  const options = validateDiscovery({
    enabled: true,
    maxPages: 4,
    maxLinksPerPage: 4,
    includePaths: ["/shop/**"],
    excludePaths: ["/shop/private*"],
  });
  const inventory = {
    revisionVerified: true,
    links: [
      "/shop/item",
      "//outside",
      "/shop/logout",
      "/shop/export.pdf",
      "/shop/item?delete=1",
      "/shop/private",
      "/shop/other",
    ].map((path) => ({ path })),
  };
  assert.deepEqual(discoverPaths(inventory, options), [
    "/shop/item",
    "/shop/other",
  ]);
  assert.deepEqual(
    discoverPaths({ ...inventory, revisionVerified: false }, options),
    [],
  );
  for (const value of [
    { maxPages: 99 },
    { maxDepth: 4 },
    { maxStates: 10000 },
    { includePaths: ["//outside"] },
    { excludePaths: ["/../secret"] },
    { maxLinksPerPage: 0 },
  ])
    assert.throws(() => validateDiscovery(value));
});
test("inventory records a stable bounded state identity and redacts page content before returning it", async () => {
  const page = {
    url: () => "https://preview.test/shop?token=private",
    evaluate: async () => ({
      title: "Shop",
      visibleText: ['api_key="super-secret-value"'],
      elements: [{ role: "button", name: "Continue" }],
      forms: [],
      links: [],
    }),
  };
  const a = await collectInventory(page, {
      ...metadata,
      revisionVerified: true,
      browser: "chromium",
      viewport: "desktop",
    }),
    b = await collectInventory(page, {
      ...metadata,
      revisionVerified: true,
      browser: "chromium",
      viewport: "desktop",
    });
  assert.equal(a.stateId, b.stateId);
  assert.equal(a.page, "https://preview.test/shop");
  assert.equal(a.revision, metadata.revision);
  assert.doesNotMatch(JSON.stringify(a), /super-secret-value|token=private/);
});
test("browser matrix validates engines and avoids Chromium flags and secrets in other engines", () => {
  const parsed = validateWebSuite(
    {
      targetEnvironment: "preview",
      url: "https://preview.test",
      browsers: ["chromium", "firefox", "webkit"],
      discovery: { enabled: true },
    },
    metadata,
  );
  assert.equal(parsed.browsers.length, 3);
  for (const browsers of [[], ["chrome"], ["chromium", "chromium"]])
    assert.throws(() =>
      validateWebSuite(
        { targetEnvironment: "preview", url: "https://preview.test", browsers },
        metadata,
      ),
    );
  for (const engine of ["firefox", "webkit"]) {
    const options = browserLaunchOptions(
      {
        PATH: "/usr/bin",
        OPENROUTER_API_KEY: "private",
        QA_BROWSER_EXECUTABLE: "/chrome",
      },
      engine,
    );
    assert.equal(options.args, undefined);
    assert.equal(options.chromiumSandbox, undefined);
    assert.equal(options.executablePath, undefined);
    assert.doesNotMatch(JSON.stringify(options), /private/);
  }
  assert.equal(
    browserLaunchOptions({}, "firefox").firefoxUserPrefs[
      "network.proxy.allow_hijacking_localhost"
    ],
    true,
  );
});

test("control exploration is explicit, bounded, unique and tied to verified inventory", () => {
  const controls = [
    {
      role: "button",
      name: "Open",
      tag: "button",
      type: "button",
      selector: "#open",
    },
    { role: "tab", name: "Details", tag: "button", type: "button" },
  ];
  const inventory = { revisionVerified: true, controls, elements: controls };
  assert.deepEqual(discoverControls(inventory, validateDiscovery()), []);
  const options = validateDiscovery({
    enabled: true,
    exploreControls: true,
    maxControlsPerPage: 1,
  });
  const steps = discoverControls(inventory, options);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0], {
    action: "click",
    selector: "#open",
    fallback: { role: "button", name: "Open", tag: "button", type: "button" },
  });
  assert.deepEqual(
    discoverControls({ ...inventory, revisionVerified: false }, options),
    [],
  );
  assert.deepEqual(
    discoverControls(
      {
        revisionVerified: true,
        controls: [controls[1]],
        elements: [controls[1], controls[1]],
      },
      options,
    ),
    [],
  );
  assert.throws(() => validateDiscovery({ exploreControls: "yes" }));
  assert.throws(() => validateDiscovery({ maxControlsPerPage: 5 }));
});
