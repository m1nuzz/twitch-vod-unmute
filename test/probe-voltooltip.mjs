import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const EXT = path.join(ROOT, "..", "extension");
const VOD = process.argv[2] || "2936051136";
const PROFILE = path.join(ROOT, ".build", "p-voltt");
fs.rmSync(PROFILE, { recursive: true, force: true });

const browser = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  args: ["--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
const page = browser.pages()[0] || (await browser.newPage());
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 140)));
await page.goto(`https://www.twitch.tv/videos/${VOD}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("#vxr-panel", { timeout: 30000 });
await page.evaluate(() =>
  document
    .querySelector("video")
    .play()
    .catch(() => {})
);
await page.waitForTimeout(1500);

const state = () =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    const s = document.querySelector('input[type="range"].tw-range');
    const tips = Array.from(document.querySelectorAll("div,span,p"))
      .filter((e) => {
        const t = (e.textContent || "").trim();
        const r = e.getBoundingClientRect();
        return /^\d{1,3}\s*%$/.test(t) && r.width > 0 && r.height > 0 && r.height < 40;
      })
      .map((e) => ({ text: e.textContent.trim(), x: Math.round(e.getBoundingClientRect().x), y: Math.round(e.getBoundingClientRect().y) }));
    return {
      slider: s ? { value: s.value, x: Math.round(s.getBoundingClientRect().x), y: Math.round(s.getBoundingClientRect().y), w: Math.round(s.getBoundingClientRect().width) } : null,
      vol: v.volume,
      muted: v.muted,
      tips
    };
  });

const chooser = page.waitForEvent("filechooser");
await page.click("#vxr-panel .vxr-pick");
await (await chooser).setFiles(path.join(ROOT, "fixtures", "stream.mp3"));
await page.waitForFunction(() => /replacement on/.test(document.querySelector("#vxr-panel .vxr-status").textContent), null, { timeout: 15000 });
await page.evaluate(() =>
  document
    .querySelector("video")
    .play()
    .catch(() => {})
);
await page.waitForTimeout(1500);

await page.mouse.move(640, 300);
await page.waitForTimeout(800);
let st = await state();
console.log("controls        :", JSON.stringify(st));

const box = st.slider;
const click = async (frac) => {
  const x = box.x + Math.round(box.w * frac);
  const y = box.y + 8;
  await page.mouse.move(x, y);
  await page.waitForTimeout(500);
  console.log(`hover ${Math.round(frac * 100)}%    :`, JSON.stringify((await state()).tips));
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(900);
  const s2 = await state();
  console.log(`click ${Math.round(frac * 100)}%    :`, JSON.stringify(s2));
};
await click(0.2);
await click(0.85);
await page.mouse.move(640, 300);
await page.waitForTimeout(600);
console.log("after leave     :", JSON.stringify(await state()));
await page.screenshot({ path: path.join(ROOT, ".build", "voltt.png") });

await browser.close();
