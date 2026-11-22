import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, "..", "extension");
const EXT = path.join(ROOT, ".build", "ext-real");
const PROFILE = path.join(ROOT, ".build", "p-real2");
const VOD = process.argv[2] || "2936051136";
const TS = process.argv[3] || "";

fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(SRC, EXT, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
mf.host_permissions = ["<all_urls>"];
fs.writeFileSync(path.join(EXT, "manifest.json"), JSON.stringify(mf, null, 2));

const browser = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  args: ["--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
const page = browser.pages()[0] || (await browser.newPage());
const muted = [];
page.on("request", (r) => {
  if (/-muted\./.test(r.url())) muted.push(r.url());
});

const target = `https://www.twitch.tv/videos/${VOD}${TS ? "?t=" + TS : ""}`;
console.log("goto", target);
await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
const ok = await page
  .waitForSelector("#vxr-panel", { timeout: 30000 })
  .then(() => true)
  .catch(() => false);
console.log("panel injected:", ok);
if (!ok) {
  console.log("title:", await page.title());
  await browser.close();
  process.exit(1);
}

await page.evaluate(() => {
  const v = document.querySelector("video");
  if (v) v.play().catch(() => {});
});
await new Promise((r) => setTimeout(r, 8000));
console.log("\npanel after load :", (await page.textContent("#vxr-panel")).replace(/\s+/g, " ").trim().slice(0, 260));
console.log(
  "muted requests   :",
  muted.length,
  muted
    .slice(0, 2)
    .map((u) => u.slice(0, 140))
    .join("\n                   ")
);

const ui = await page.evaluate(() => {
  const b = document.querySelector(".vxr-unmute");
  const s = document.querySelector('button[aria-label="Share"]');
  const rb = b && b.getBoundingClientRect();
  const rs = s && s.getBoundingClientRect();
  return {
    remute: !!b,
    text: b && b.textContent.trim(),
    leftOfShare: !!(rb && rs && rb.right <= rs.left + 1)
  };
});
console.log("ui               :", JSON.stringify(ui));
await page.evaluate(() => document.querySelector(".vxr-unmute").click());
const hidden = await page.evaluate(() => !document.querySelector("#vxr-panel").getClientRects().length);
await page.evaluate(() => document.querySelector(".vxr-unmute").click());
const shown = await page.evaluate(() => !!document.querySelector("#vxr-panel").getClientRects().length);
console.log("panel toggle     :", JSON.stringify({ hidden, shown }));

/* --- file replacement on the real player --- */
const chooser = page.waitForEvent("filechooser");
await page.click("#vxr-panel .vxr-pick");
await (await chooser).setFiles(path.join(ROOT, "fixtures", "stream.mp3"));
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const t = await page.textContent("#vxr-panel .vxr-status");
  if (!/paused/.test(t)) break;
}
await page.evaluate(() =>
  document
    .querySelector("video")
    .play()
    .catch(() => {})
);
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate(() => {
  const v = document.querySelector("video");
  v.currentTime = v.currentTime + 30;
});
await new Promise((r) => setTimeout(r, 1200));
const m1 = await page.evaluate(() => {
  const v = document.querySelector("video");
  const a = document.querySelector(".vxr-track");
  return { vod: v.currentTime, track: a && a.currentTime, driftMs: a ? (a.currentTime - v.currentTime) * 1000 : null, muted: v.muted, paused: a && a.paused };
});
await new Promise((r) => setTimeout(r, 8000));
const m2 = await page.evaluate(() => {
  const v = document.querySelector("video");
  const a = document.querySelector(".vxr-track");
  return { vod: v.currentTime, track: a && a.currentTime, driftMs: a ? (a.currentTime - v.currentTime) * 1000 : null, muted: v.muted };
});
console.log("\nfile mode t+1.2s :", JSON.stringify(m1));
console.log("file mode t+9.2s :", JSON.stringify(m2));
console.log("file mode status :", (await page.textContent("#vxr-panel .vxr-status")).replace(/\s+/g, " ").trim());

async function meterPeak(ms) {
  let peak = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const w = await page.evaluate(() => parseFloat(document.querySelector(".vxr-level > b").style.width) || 0);
    peak = Math.max(peak, w);
    await new Promise((r) => setTimeout(r, 60));
  }
  return peak;
}
await page.evaluate(() => {
  document.querySelector("video").volume = 1;
});
const volHigh = await meterPeak(4500);
await page.evaluate(() => {
  document.querySelector("video").volume = 0;
});
await new Promise((r) => setTimeout(r, 300));
const volLow = await meterPeak(2500);
console.log("native volume    :", JSON.stringify({ high: volHigh, low: volLow }));
await page.evaluate(() => {
  document.querySelector("video").volume = 1;
});
await page.evaluate(() => {
  const v = document.querySelector("video");
  v.volume = 1;
});
await page.click("#vxr-panel .vxr-toggle");
await new Promise((r) => setTimeout(r, 400));
console.log(
  "after disable   :",
  JSON.stringify(await page.evaluate(() => ({ muted: document.querySelector("video").muted, trackPaused: document.querySelector(".vxr-track").paused })))
);

await page.click("#vxr-panel .vxr-cdn");
let last = "";
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  last = (await page.textContent("#vxr-panel .vxr-status")).replace(/\s+/g, " ").trim();
  if (/original found|audio not found|could not|check failed|no muted ranges/.test(last)) break;
}
console.log("\nsearch verdict   :", last);

const sw0 = browser.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
if (sw0) {
  const rules = await sw0.evaluate(() =>
    chrome.declarativeNetRequest
      .getDynamicRules()
      .then((rs) => rs.slice(0, 1).map((r) => ({ muted: (r.condition.urlFilter || "").replace(/^\|/, "").replace(/\|$/, ""), plain: r.action.redirect && r.action.redirect.url })))
  );
  console.log("rules installed  :", await sw0.evaluate(() => chrome.declarativeNetRequest.getDynamicRules().then((rs) => rs.length)));
  if (rules[0]) {
    const u = rules[0].muted;
    const res = await page.evaluate(async (x) => {
      const r = await fetch(x, { cache: "no-store" });
      const info = { final: r.url, status: r.status };
      if (r.body) r.body.cancel().catch(() => {});
      return info;
    }, u);
    console.log(
      "rule check       :",
      JSON.stringify({ sent: u.split("/").slice(-2).join("/"), final: new URL(res.final).pathname.split("/").slice(-2).join("/"), status: res.status })
    );
  }
}

if (muted.length) {
  const probeUrl = muted[muted.length - 1];
  const res = await page.evaluate(async (u) => {
    const r = await fetch(u, { cache: "no-store" });
    return { sent: u, final: r.url, status: r.status, body: (await r.text()).slice(0, 20) };
  }, probeUrl);
  console.log("redirect check   :", JSON.stringify({ sent: new URL(res.sent).pathname, final: new URL(res.final).pathname, status: res.status, body: res.body }));
}
const sw = browser.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
console.log("worker           :", sw ? "running" : "absent");
if (sw)
  console.log(
    "rules            :",
    JSON.stringify(
      await sw.evaluate(() =>
        chrome.declarativeNetRequest
          .getDynamicRules()
          .then((rs) => rs.map((r) => ({ id: r.id, type: r.action.type, sub: String(r.action.redirect && r.action.redirect.regexSubstitution).slice(0, 90) })))
      )
    )
  );
await page.screenshot({ path: path.join(ROOT, ".build", `real-${VOD}.png`) });
console.log("screenshot       :", path.join(ROOT, ".build", `real-${VOD}.png`));
await browser.close();
