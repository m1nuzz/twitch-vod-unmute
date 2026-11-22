import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const EXT = path.join(ROOT, ".build", "ext");

const browser = await chromium.launchPersistentContext(path.join(ROOT, ".build", "p-dnr3"), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
const page = browser.pages()[0] || (await browser.newPage());
await page.goto("about:blank");
await new Promise((r) => setTimeout(r, 1500));
const sw = browser.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
if (!sw) {
  console.log("no SW");
  process.exit(1);
}
const out = await sw.evaluate(async () => {
  const BS = String.fromCharCode(92);
  const base = "http://localhost:63918/videos/2926037201/chunked/";
  const mkr = (i) => ({
    filter: "^" + base.replace(/[.*+?^${}()|[\]\\]/g, BS + "&") + i + "-muted" + BS + ".ts$",
    substitution: base + i + ".ts"
  });
  const mk = (r, id) => ({
    id,
    priority: 1,
    action: { type: "redirect", redirect: { regexSubstitution: r.substitution } },
    condition: { regexFilter: r.filter, resourceTypes: ["media", "xmlhttprequest", "other"] }
  });
  const res = {};
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  res.before = current.map((r) => r.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: current.map((r) => r.id),
      addRules: [mk(mkr(10), 1), mk(mkr(11), 2)]
    });
    res.two = "ok";
  } catch (e) {
    res.two = String((e && e.message) || e);
  }
  res.afterTwo = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id),
      addRules: Array.from({ length: 30 }, (_, k) => mk(mkr(10 + k), k + 1))
    });
    res.thirty = "ok";
  } catch (e) {
    res.thirty = String((e && e.message) || e);
  }
  res.afterThirty = (await chrome.declarativeNetRequest.getDynamicRules()).length;
  return res;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
