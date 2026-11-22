import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const EXT = path.join(ROOT, "..", "extension");
const VOD = process.argv[2] || "2936051136";

const browser = await chromium.launchPersistentContext(path.join(ROOT, ".build", "p-vol"), {
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

const chooser = page.waitForEvent("filechooser");
await page.click("#vxr-panel .vxr-pick");
await (await chooser).setFiles(path.join(ROOT, "fixtures", "stream.mp3"));
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const t = await page.textContent("#vxr-panel .vxr-status");
  if (/replacement on/.test(t)) break;
}
await page.evaluate(() =>
  document
    .querySelector("video")
    .play()
    .catch(() => {})
);
await new Promise((r) => setTimeout(r, 2500));

const state = () =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    const s = document.querySelector('input[type="range"].tw-range');
    return { vol: v.volume, muted: v.muted, paused: v.paused, slider: s && s.value, panel: document.querySelector(".vxr-status").textContent.trim().slice(0, 90) };
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

console.log("initial          :", JSON.stringify(await state()), "peak", (await peak(3000)).toFixed(0) + "%");

await page.evaluate(() => {
  const s = document.querySelector('input[type="range"].tw-range');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(s, "1");
  s.dispatchEvent(new Event("input", { bubbles: true }));
  s.dispatchEvent(new Event("change", { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 600));
console.log("slider -> 100    :", JSON.stringify(await state()), "peak", (await peak(3500)).toFixed(0) + "%");

const labels = await page.evaluate(() =>
  Array.from(document.querySelectorAll("button[aria-label]"))
    .map((b) => b.getAttribute("aria-label"))
    .slice(0, 60)
);
console.log("button labels    :", JSON.stringify(labels));

const mute = await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll("button[aria-label]")).find((x) => /mute|unmute/i.test(x.getAttribute("aria-label")));
  if (!b) return null;
  b.click();
  return b.getAttribute("aria-label");
});
await new Promise((r) => setTimeout(r, 600));
console.log("mute button      :", JSON.stringify(mute), JSON.stringify(await state()), "peak", (await peak(3000)).toFixed(0) + "%");

await page.evaluate(() => {
  document.querySelector("video").volume = 1;
});
await new Promise((r) => setTimeout(r, 400));
console.log("direct vol=1     :", JSON.stringify(await state()), "peak", (await peak(3500)).toFixed(0) + "%");

await browser.close();
