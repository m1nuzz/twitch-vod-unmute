import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const PROFILE = path.join(ROOT, ".build", "p-tt3");
fs.rmSync(PROFILE, { recursive: true, force: true });
const browser = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  args: ["--autoplay-policy=no-user-gesture-required"]
});
const page = browser.pages()[0];
await page.goto("https://www.twitch.tv/videos/2936051136", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);
await page.mouse.move(640, 250);
await page.waitForTimeout(800);
const state = () =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    const s = document.querySelector('input[type="range"].tw-range');
    const tips = Array.from(document.querySelectorAll("*"))
      .filter((e) => /^\d{1,3}\s*%$/.test((e.textContent || "").trim()) && e.children.length === 0)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { text: e.textContent.trim(), x: Math.round(r.x), y: Math.round(r.y) };
      })
      .filter((t) => t.y > 0);
    return { slider: s && s.value, aria: s && s.getAttribute("aria-valuenow"), vol: v.volume, muted: v.muted, tips };
  });
console.log("init      :", JSON.stringify(await state()));
const b = await page.evaluate(() => {
  const r = document.querySelector('input[type="range"].tw-range').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width };
});
const y = b.y + 8,
  at = (f) => b.x + b.w * f;
await page.mouse.move(at(0.76), y);
await page.mouse.down();
await page.waitForTimeout(250);
console.log("down 76   :", JSON.stringify(await state()));
for (const f of [0.5, 0.25, 0.1]) {
  await page.mouse.move(at(f), y, { steps: 4 });
  await page.waitForTimeout(180);
  console.log(`drag ${Math.round(f * 100)}% :`, JSON.stringify(await state()));
}
await page.mouse.up();
await page.waitForTimeout(500);
console.log("up        :", JSON.stringify(await state()));
await browser.close();
