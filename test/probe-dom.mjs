import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const VOD = process.argv[2] || "2936051136";

const browser = await chromium.launchPersistentContext(path.join(ROOT, ".build", "p-dom"), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  args: ["--autoplay-policy=no-user-gesture-required"]
});
const page = browser.pages()[0] || (await browser.newPage());
await page.goto(`https://www.twitch.tv/videos/${VOD}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("video", { timeout: 30000 });
await page.evaluate(() => {
  const v = document.querySelector("video");
  if (v) v.play().catch(() => {});
});
await page.waitForTimeout(6000);

const out = await page.evaluate(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const info = (el) => (el ? { tag: el.tagName, cls: String(el.className).slice(0, 160), box: box(el), html: el.outerHTML.slice(0, 500) } : null);

  const share =
    document.querySelector('[data-a-target="player-share-button"]') ||
    Array.from(document.querySelectorAll("button")).find((b) => /Share/i.test((b.textContent || "") + " " + (b.getAttribute("aria-label") || "")));

  const seekSelectors = ['[data-a-target="player-seekbar"]', ".seekbar-bar", '[class*="seekbar"]', '[data-test-selector*="seekbar" i]', '[data-a-target="player-controls"]'];
  const seeks = seekSelectors.map((s) => {
    const el = document.querySelector(s);
    return { sel: s, count: document.querySelectorAll(s).length, el: info(el) };
  });

  const volume = document.querySelector('[data-a-target="player-volume-slider"]') || document.querySelector('input[type="range"][aria-label]') || null;
  const volInfo = volume
    ? { tag: volume.tagName, type: volume.type, aria: volume.getAttribute("aria-label"), cls: String(volume.className).slice(0, 120), value: volume.value }
    : null;

  const video = document.querySelector("video");
  const labels = Array.from(document.querySelectorAll("button[aria-label]"))
    .slice(0, 40)
    .map((b) => b.getAttribute("aria-label"));

  return {
    share: info(share),
    shareParent: share ? info(share.parentElement) : null,
    seeks,
    volInfo,
    volumeState: video ? { volume: video.volume, muted: video.muted } : null,
    labels,
    videoBox: box(video)
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
