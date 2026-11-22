import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const EXT = path.join(ROOT, "..", "extension");
const VOD = process.argv[2] || "2936051136";
const PROFILE = path.join(ROOT, ".build", "p-mute");
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
await page.evaluate(() =>
  document
    .querySelector("video")
    .play()
    .catch(() => {})
);
await page.waitForTimeout(2000);

const setSlider = (v) =>
  page.evaluate((x) => {
    const s = document.querySelector('input[type="range"].tw-range');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(s, String(x));
    s.dispatchEvent(new Event("input", { bubbles: true }));
    s.dispatchEvent(new Event("change", { bubbles: true }));
  }, v);

await page.evaluate(() => {
  const v = document.querySelector("video");
  v.muted = false;
  v.volume = 1;
});
await setSlider(1);
await page.waitForTimeout(800);

const state = () =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    const s = document.querySelector('input[type="range"].tw-range');
    const proto = HTMLMediaElement.prototype;
    const gm = Object.getOwnPropertyDescriptor(proto, "muted").get;
    const gv = Object.getOwnPropertyDescriptor(proto, "volume").get;
    const muteBtn = document.querySelector('button[data-a-target="player-mute-unmute-button"]');
    return {
      uiMuted: v.muted,
      uiVolume: v.volume,
      rawMuted: gm.call(v),
      rawVolume: gv.call(v),
      silentAttr: v.getAttribute("data-vxr-silent"),
      slider: s && s.value,
      muteBtn: muteBtn ? muteBtn.getAttribute("aria-label") : null,
      panel: document.querySelector(".vxr-status").textContent.trim().slice(0, 60)
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

console.log("before          :", JSON.stringify(await state()), "peak", (await peak(2000)).toFixed(0) + "%");

const chooser = page.waitForEvent("filechooser");
await page.click("#vxr-panel .vxr-pick");
await (await chooser).setFiles(path.join(ROOT, "fixtures", "stream.mp3"));
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(500);
  const t = await page.textContent("#vxr-panel .vxr-status");
  if (/replacement on/.test(t)) break;
}
await page.evaluate(() =>
  document
    .querySelector("video")
    .play()
    .catch(() => {})
);
await page.waitForTimeout(2500);

console.log("replacement on  :", JSON.stringify(await state()), "peak", (await peak(4000)).toFixed(0) + "%");
await page.screenshot({ path: path.join(ROOT, ".build", "mute-ui-on.png") });

const clickMute = () =>
  page.evaluate(() => {
    const b = document.querySelector('button[data-a-target="player-mute-unmute-button"]');
    if (!b) return false;
    b.click();
    return true;
  });
await clickMute();
await page.waitForTimeout(800);
console.log("twitch mute on  :", JSON.stringify(await state()), "peak", (await peak(2500)).toFixed(0) + "%");
await clickMute();
await page.waitForTimeout(800);
console.log("twitch mute off :", JSON.stringify(await state()), "peak", (await peak(3000)).toFixed(0) + "%");

await page.click("#vxr-panel .vxr-toggle");
await page.waitForTimeout(800);
console.log("replacement off :", JSON.stringify(await state()));

await browser.close();
