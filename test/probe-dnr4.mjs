import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const EXT = path.join(ROOT, ".build", "ext");
const PROFILE = path.join(ROOT, ".build", process.argv[2] || "p-dnr4");

const browser = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
const page = browser.pages()[0] || (await browser.newPage());
await page.goto("about:blank");
await new Promise((r) => setTimeout(r, 1000));
const sw = browser.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
if (!sw) {
  console.log("no SW");
  process.exit(1);
}
const out = await sw.evaluate(async () => {
  const store = await chrome.storage.local.get(null);
  const before = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  const defs = { buildRules: typeof buildRules, KEY: typeof KEY, sync: typeof sync };
  let err = null;
  try {
    globalThis.sync();
  } catch (e) {
    err = String((e && e.message) || e);
  }
  await new Promise((r) => setTimeout(r, 1500));
  const after = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  return {
    defs,
    err,
    storedRule: store.vxrRule ? "old" : null,
    storedRules: Array.isArray(store.vxrRules) ? store.vxrRules.length : null,
    storedErr: store.vxrRuleError || null,
    before,
    after
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
