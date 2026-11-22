import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const VOD = process.argv[2] || "2936051136";
const EXT = path.join(ROOT, "..", "extension");

const browser = await chromium.launchPersistentContext(path.join(ROOT, ".build", "p-launcher"), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1920, height: 1000 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  args: ["--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
const page = browser.pages()[0] || (await browser.newPage());
await page.goto(`https://www.twitch.tv/videos/${VOD}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("video", { timeout: 30000 });
await page.evaluate(() =>
  document
    .querySelector("video")
    .play()
    .catch(() => {})
);
await page.waitForTimeout(9000);

const out = await page.evaluate(() => {
  const rem = document.querySelector(".vxr-unmute");
  const rr = rem && rem.getBoundingClientRect();
  const shares = Array.from(document.querySelectorAll('button[aria-label="Share"]')).map((s) => {
    const r = s.getBoundingClientRect();
    const cy = (e) => Math.round(e.y + e.height / 2);
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      sameRow: !!(rr && Math.abs(cy(rr) - cy(r)) < 4),
      leftOf: !!(rr && rr.right <= r.x + 1)
    };
  });
  return { remute: rr ? { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width) } : null, shares };
});
console.log(JSON.stringify(out, null, 2));
await page.screenshot({ path: path.join(ROOT, ".build", "launcher-1920.png") });
await browser.close();
