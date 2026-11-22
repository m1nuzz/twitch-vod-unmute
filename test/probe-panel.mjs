import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const EXT = path.join(ROOT, "..", "extension");
const VOD = process.argv[2] || "2936051136";
const PROFILE = path.join(ROOT, ".build", "p-panel");
fs.rmSync(PROFILE, { recursive: true, force: true });

const browser = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  args: ["--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
const page = browser.pages()[0] || (await browser.newPage());
await page.goto(`https://www.twitch.tv/videos/${VOD}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("#vxr-panel", { state: "attached", timeout: 30000 });
await page.waitForSelector(".vxr-unmute", { timeout: 15000 });
await page.waitForTimeout(800);

const visible = () => page.evaluate(() => !!document.querySelector("#vxr-panel").getClientRects().length);
const gap = () =>
  page.evaluate(() => {
    const b = document.querySelector(".vxr-unmute");
    const s = Array.from(document.querySelectorAll("button")).find((x) => /share|подел/i.test(x.getAttribute("aria-label") || "") && !x.classList.contains("vxr-unmute"));
    if (!b || !s) return null;
    const rb = b.getBoundingClientRect();
    const rs = s.getBoundingClientRect();
    return { text: b.textContent.trim(), gap: Math.round(rs.left - rb.right), leftOf: rb.right <= rs.left + 1 };
  });

console.log("on load          : panelVisible", await visible(), "pill", JSON.stringify(await gap()));
await page.click(".vxr-unmute");
await page.waitForTimeout(400);
console.log("after click      : panelVisible", await visible());
await page.click(".vxr-unmute");
await page.waitForTimeout(400);
console.log("second click     : panelVisible", await visible());

/* simulate the Russian UI: localize the Share button, drop the pill, let the poll rebuild it */
await page.evaluate(() => {
  const s = Array.from(document.querySelectorAll("button")).find((x) => /share|подел/i.test(x.getAttribute("aria-label") || "") && !x.classList.contains("vxr-unmute"));
  if (s) {
    s.setAttribute("aria-label", "Поделиться");
    const label = s.querySelector('[data-a-target="tw-core-button-label-text"]');
    if (label) label.textContent = "Поделиться";
  }
  const wrap = document.querySelector(".vxr-unmute-wrap");
  if (wrap) wrap.remove();
});
await page.waitForTimeout(2500);
console.log("localized Share  : pill", JSON.stringify(await gap()));
await page.screenshot({ path: path.join(ROOT, ".build", "panel-closed.png") });
await page.click(".vxr-unmute").catch(() => {});
await page.waitForTimeout(400);
console.log("open after locale: panelVisible", await visible());
await browser.close();
