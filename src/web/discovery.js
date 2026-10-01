const crypto = require("node:crypto");
const { redact } = require("../ai/context");
const hash = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function validateDiscovery(value = {}) {
  if (value === false) value = {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "enabled",
          "exploreControls",
          "maxControlsPerPage",
          "maxPages",
          "maxDepth",
          "maxLinksPerPage",
          "maxStates",
          "includePaths",
          "excludePaths",
        ].includes(key),
    )
  )
    throw new Error("Invalid browser discovery settings");
  const result = {
    enabled: false,
    exploreControls: false,
    maxControlsPerPage: 4,
    maxPages: 8,
    maxDepth: 2,
    maxLinksPerPage: 40,
    maxStates: 24,
    includePaths: ["/**"],
    excludePaths: [],
    ...value,
  };
  if (
    typeof result.enabled !== "boolean" ||
    typeof result.exploreControls !== "boolean"
  )
    throw new Error("Discovery enabled must be boolean");
  for (const [key, min, max] of [
    ["maxControlsPerPage", 1, 4],
    ["maxPages", 1, 20],
    ["maxDepth", 0, 3],
    ["maxLinksPerPage", 1, 80],
    ["maxStates", 1, 60],
  ])
    if (
      !Number.isInteger(result[key]) ||
      result[key] < min ||
      result[key] > max
    )
      throw new Error(`Invalid discovery ${key}`);
  for (const key of ["includePaths", "excludePaths"])
    if (
      !Array.isArray(result[key]) ||
      result[key].length > 30 ||
      result[key].some(
        (p) =>
          typeof p !== "string" ||
          !/^\/(?!\/)[^?#\\\x00-\x1f]{0,300}$/.test(p) ||
          p.split("/").includes(".."),
      )
    )
      throw new Error(
        "Discovery paths must be bounded path patterns without queries",
      );
  return result;
}
function matches(value, pattern) {
  return new RegExp(
    "^" +
      pattern
        .split("*")
        .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  ).test(value);
}
function discoverPaths(inventory, options) {
  if (!inventory.revisionVerified) return [];
  return [
    ...new Set(
      (inventory.links || [])
        .map((item) => item.path)
        .filter((value) => {
          if (
            typeof value !== "string" ||
            !value.startsWith("/") ||
            value.startsWith("//") ||
            /[?#\\\x00-\x1f]/.test(value)
          )
            return false;
          // Never automatically follow likely state-changing, account-ending, or file downloads.
          if (
            /(?:^|\/)(?:logout|signout|delete|remove|destroy|unsubscribe|purchase|checkout\/complete)(?:\/|$)|\.(?:zip|pdf|exe|dmg|csv|png|jpe?g|gif|svg|mp4)$/i.test(
              value,
            )
          )
            return false;
          return (
            options.includePaths.some((p) => matches(value, p)) &&
            !options.excludePaths.some((p) => matches(value, p))
          );
        }),
    ),
  ].slice(0, options.maxLinksPerPage);
}
async function collectInventory(page, metadata) {
  const result = await page.evaluate(
    ({ maxElements, maxLinks }) => {
      const clip = (value, n = 240) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, n);
      const visible = (el) =>
        !!(
          el.getClientRects().length &&
          getComputedStyle(el).visibility !== "hidden" &&
          el.getAttribute("aria-hidden") !== "true"
        );
      const name = (el) => {
        const labelled = (el.getAttribute("aria-labelledby") || "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ");
        return clip(
          labelled ||
            el.getAttribute("aria-label") ||
            [...(el.labels || [])].map((x) => x.textContent).join(" ") ||
            el.getAttribute("alt") ||
            (["BUTTON", "A", "SUMMARY"].includes(el.tagName)
              ? el.textContent
              : "") ||
            el.getAttribute("title"),
        );
      };
      const role = (el) =>
        el.getAttribute("role") ||
        {
          BUTTON: "button",
          A: el.hasAttribute("href") ? "link" : "",
          TEXTAREA: "textbox",
          SELECT: el.multiple ? "listbox" : "combobox",
          SUMMARY: "button",
        }[el.tagName] ||
        (el.tagName === "INPUT"
          ? {
              checkbox: "checkbox",
              radio: "radio",
              submit: "button",
              button: "button",
              range: "slider",
              number: "spinbutton",
            }[el.type] ||
            (["hidden", "password"].includes(el.type) ? "" : "textbox")
          : "");
      const element = (el) => ({
        role: role(el),
        name: name(el),
        tag: el.tagName.toLowerCase(),
        type: el.type || undefined,
        ...(el.id && el.id.length < 150
          ? { selector: "#" + CSS.escape(el.id) }
          : {}),
      });
      const elements = [
        ...document.querySelectorAll(
          "a[href],button,input,textarea,select,summary,[role]",
        ),
      ]
        .filter(visible)
        .slice(0, maxElements)
        .map(element)
        .filter((el) => el.role || el.selector);
      const controls = [
        ...document.querySelectorAll('button,[role="tab"],summary'),
      ]
        .filter(visible)
        .filter((el) => {
          if (
            el.disabled ||
            el.getAttribute("aria-disabled") === "true" ||
            (el.form && el.type === "submit")
          )
            return false;
          if (
            /\b(delete|remove|destroy|purchase|pay|checkout|logout|sign out|submit)\b/i.test(
              name(el),
            )
          )
            return false;
          return (
            el.getAttribute("aria-haspopup") === "dialog" ||
            el.getAttribute("aria-expanded") === "false" ||
            (el.getAttribute("role") === "tab" &&
              el.getAttribute("aria-selected") !== "true") ||
            (el.tagName === "SUMMARY" && !el.parentElement?.open)
          );
        })
        .slice(0, 12)
        .map(element)
        .filter((el) => el.selector || (el.role && el.name));
      const links = [...document.querySelectorAll("a[href]")]
        .filter(visible)
        .slice(0, maxLinks)
        .flatMap((el) => {
          try {
            const url = new URL(el.href, location.href);
            return url.origin === location.origin &&
              !url.search &&
              !url.hash &&
              !el.hasAttribute("download")
              ? [{ path: url.pathname, name: name(el) }]
              : [];
          } catch {
            return [];
          }
        });
      const forms = [...document.forms].slice(0, 12).map((form) => {
        let action;
        try {
          const u = new URL(form.action, location.href);
          action = u.origin === location.origin ? u.pathname : "[external]";
        } catch {
          action = "[invalid]";
        }
        return {
          action,
          method: form.method.toUpperCase(),
          fields: [...form.elements].filter(visible).slice(0, 25).map(element),
        };
      });
      const visibleText = [
        ...document.querySelectorAll(
          'h1,h2,h3,label,[role="status"],[role="alert"]',
        ),
      ]
        .filter(visible)
        .slice(0, 40)
        .map((el) => clip(el.textContent, 300));
      return {
        title: clip(document.title),
        links,
        forms,
        elements,
        visibleText,
        controls,
      };
    },
    {
      maxElements: metadata.maxElements || 80,
      maxLinks: metadata.maxLinks || 40,
    },
  );
  // No form values, storage, cookies, hidden inputs, page HTML or arbitrary scripts are recorded.
  const sanitize = (value) =>
    typeof value === "string"
      ? redact(value)
      : Array.isArray(value)
        ? value.map(sanitize)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, sanitize(item)]),
            )
          : value;
  const clean = sanitize(result);
  const url = new URL(page.url());
  const item = {
    page: url.origin + url.pathname,
    path: url.pathname,
    revision: metadata.revision,
    revisionVerified: metadata.revisionVerified === true,
    browser: metadata.browser,
    viewport: metadata.viewport,
    startPath: metadata.startPath || url.pathname,
    navigationSteps: metadata.navigationSteps || [],
    ...clean,
  };
  return {
    ...item,
    stateId: hash([
      item.path,
      item.browser,
      item.viewport,
      item.elements,
      item.visibleText,
      item.navigationSteps,
    ]).slice(0, 24),
  };
}
function discoverControls(inventory, options) {
  if (!inventory.revisionVerified || !options.exploreControls) return [];
  return (inventory.controls || [])
    .flatMap((control) => {
      if (
        control.role &&
        control.name &&
        (inventory.elements || []).filter(
          (el) => el.role === control.role && el.name === control.name,
        ).length === 1
      ) {
        const semantic = { role: control.role, name: control.name };
        return [
          {
            action: "click",
            ...(control.selector
              ? {
                  selector: control.selector,
                  fallback: {
                    ...semantic,
                    tag: control.tag,
                    ...(control.type ? { type: control.type } : {}),
                  },
                }
              : semantic),
          },
        ];
      }
      if (
        control.selector &&
        (inventory.elements || []).filter(
          (el) => el.selector === control.selector,
        ).length === 1
      )
        return [{ action: "click", selector: control.selector }];
      return [];
    })
    .slice(0, options.maxControlsPerPage);
}
module.exports = {
  validateDiscovery,
  collectInventory,
  discoverPaths,
  discoverControls,
};
