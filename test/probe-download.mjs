import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const EXT = path.join(ROOT, "..", "extension");
const VOD = process.argv[2] || "2936051136";
const TARGET = Number(process.argv[3] || 8);
const UNMUTED = process.argv[4] === "unmuted";
const DL_BTN = UNMUTED ? "#vxr-panel .vxr-dl-un" : "#vxr-panel .vxr-dl";
const PROFILE = path.join(ROOT, ".build", "p-dl");
fs.rmSync(PROFILE, { recursive: true, force: true });

const browser = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  args: ["--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
const page = browser.pages()[0] || (await browser.newPage());
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 160)));
await page.addInitScript(() => {
  window.__dlChunks = [];
  window.showSaveFilePicker = async () => {
    window.__activationAtPick = navigator.userActivation ? navigator.userActivation.isActive : "n/a";
    return {
      name: "live-audio.m4a",
      createWritable: async () => ({
        write: async (u8) => {
          window.__dlChunks.push(new Uint8Array(u8));
        },
        close: async () => {},
        abort: async () => {}
      })
    };
  };
});
await page.goto(`https://www.twitch.tv/videos/${VOD}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("#vxr-panel", { state: "attached", timeout: 30000 });
await page.waitForSelector(".vxr-unmute", { timeout: 15000 });
await page.click(".vxr-unmute");

const note = () => page.textContent("#vxr-panel .vxr-dl-note");
const btn = () => page.textContent(DL_BTN);

await page.click(DL_BTN);
console.log("started          :", JSON.stringify((await btn()).trim()), JSON.stringify((await note()).trim().slice(0, 80)));
console.log("activation       :", await page.evaluate(() => window.__activationAtPick));

await page
  .waitForFunction(
    (n) => {
      const m = /downloading: (\d+)\/(\d+)/.exec(document.querySelector("#vxr-panel .vxr-dl-note").textContent);
      return m && Number(m[1]) >= n;
    },
    TARGET,
    { timeout: 120000, polling: 500 }
  )
  .catch(() => {});
console.log("progress         :", JSON.stringify((await note()).trim().slice(0, 90)));

const bytes = await page.evaluate(async () => {
  const chunks = window.__dlChunks || [];
  const blob = new Blob(chunks);
  const fr = new FileReader();
  const b64 = await new Promise((r) => {
    fr.onload = () => r(String(fr.result).split(",")[1] || "");
    fr.readAsDataURL(blob);
  });
  return { count: chunks.length, size: blob.size, b64 };
});
console.log("chunks           :", bytes.count, "size", bytes.size);

await page.click("#vxr-panel .vxr-dl");
await page.waitForTimeout(1200);
console.log("after cancel     :", JSON.stringify((await btn()).trim()), JSON.stringify((await note()).trim()));

const out = path.join(ROOT, ".build", "live-dl.m4a");
fs.writeFileSync(out, Buffer.from(bytes.b64, "base64"));
try {
  const probe = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,start_time",
    "-show_entries",
    "stream=codec_name,sample_rate,channels",
    "-of",
    "json",
    out
  ]).toString();
  console.log("ffprobe          :", probe.replace(/\s+/g, " ").slice(0, 300));
} catch (e) {
  console.log("ffprobe failed   :", String(e.message).slice(0, 200));
}

await browser.close();
