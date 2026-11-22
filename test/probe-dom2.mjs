import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const VOD = process.argv[2] || "2936051136";

const browser = await chromium.launchPersistentContext(path.join(ROOT, ".build", "p-dom2"), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  args: ["--autoplay-policy=no-user-gesture-required"]
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
await page.waitForTimeout(5000);

const out = await page.evaluate(async () => {
  const res = {};
  const share =
    document.querySelector('button[aria-label="Share"]') ||
    Array.from(document.querySelectorAll("button")).find((b) => /Share/.test((b.textContent || "") + (b.getAttribute("aria-label") || "")));
  if (share) {
    res.shareHTML = share.outerHTML;
    res.shareText = share.textContent;
    res.wrapHTML = share.parentElement.outerHTML.slice(0, 2500);
    res.groupHTML = share.parentElement.parentElement.outerHTML.slice(0, 3000);
  }

  const v = document.querySelector("video");
  const slider = document.querySelector('input[type="range"].tw-range');
  res.before = { vol: v.volume, muted: v.muted, slider: slider && slider.value };
  if (slider) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(slider, "0.25");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    res.afterSliderTo25 = { vol: v.volume, muted: v.muted, slider: slider.value };
  }
  v.volume = 0.7;
  await new Promise((r) => setTimeout(r, 400));
  res.afterJsVolume = { vol: v.volume, slider: slider && slider.value };
  v.volume = 0.5;
  return res;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
