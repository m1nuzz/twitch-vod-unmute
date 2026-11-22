import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const EXT = path.join(ROOT, "..", "extension");
const VOD = process.argv[2] || "2936051136";
const PROFILE = path.join(ROOT, ".build", "p-modes");
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
await page.click(".vxr-unmute");
await page.waitForFunction(() => /\d+ ranges/.test(document.querySelector("#vxr-panel .vxr-seg-info").textContent), null, { timeout: 20000 }).catch(() => {});

await page.waitForSelector(".vxr-unmute", { timeout: 15000 }).catch(() => {});
const gap = await page.evaluate(() => {
  const b = document.querySelector(".vxr-unmute");
  let s = document.querySelector('button[aria-label="Share"]');
  if (!s) {
    s = Array.from(document.querySelectorAll("button")).find((x) => /^Share$/i.test((x.textContent || "").trim()) && !x.classList.contains("vxr-unmute"));
  }
  if (!b || !s) return { remute: !!b, share: !!s };
  const rb = b.getBoundingClientRect();
  const rs = s.getBoundingClientRect();
  return { remuteRight: Math.round(rb.right), shareLeft: Math.round(rs.left), gap: Math.round(rs.left - rb.right) };
});
console.log("remute gap      :", JSON.stringify(gap));

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
await page.waitForTimeout(1200);

const state = () =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    const proto = HTMLMediaElement.prototype;
    const gm = Object.getOwnPropertyDescriptor(proto, "muted").get;
    const gv = Object.getOwnPropertyDescriptor(proto, "volume").get;
    return {
      t: Math.round(v.currentTime * 10) / 10,
      silent: v.getAttribute("data-vxr-silent"),
      rawMuted: gm.call(v),
      rawVolume: Math.round(gv.call(v) * 100) / 100,
      uiVolume: v.volume,
      uiMuted: v.muted,
      slider: document.querySelector('input[type="range"].tw-range').value,
      gain: document.querySelector(".vxr-level").dataset.gain,
      mutedFlag: document.querySelector(".vxr-level").dataset.muted,
      pointwise: document.querySelector(".vxr-mode-muted").classList.contains("vxr-active"),
      full: document.querySelector(".vxr-mode-full").classList.contains("vxr-active")
    };
  });

async function peak(ms) {
  let p = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const w = await page.evaluate(() => parseFloat(document.querySelector(".vxr-level > b").style.width) || 0);
    p = Math.max(p, w);
    await new Promise((r) => setTimeout(r, 60));
  }
  return p;
}

console.log("start (outside) :", JSON.stringify(await state()), "peak", (await peak(2500)).toFixed(0) + "%");

await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("#vxr-panel .vxr-btn"));
  const next = btns.find((b) => b.textContent.trim() === "▶");
  if (next) next.click();
});
await page.waitForTimeout(1200);
const start = await page.evaluate(() => document.querySelector("video").currentTime);
console.log("range start     :", start.toFixed(2));

await page.evaluate((t) => {
  document.querySelector("video").currentTime = t + 2;
}, start);
await page.waitForTimeout(1000);
console.log("start +2 (in)   :", JSON.stringify(await state()));

await page.evaluate((t) => {
  document.querySelector("video").currentTime = Math.max(0, t - 2);
}, start);
await page.waitForTimeout(1000);
console.log("start -2 (out)  :", JSON.stringify(await state()));

await page.click("#vxr-panel .vxr-mode-full");
await page.waitForTimeout(900);
console.log("full at -2      :", JSON.stringify(await state()));

await page.click("#vxr-panel .vxr-mode-muted");
await page.waitForTimeout(900);
console.log("point at -2     :", JSON.stringify(await state()));

await page.screenshot({ path: path.join(ROOT, ".build", "modes.png") });
await browser.close();
