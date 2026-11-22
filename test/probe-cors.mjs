import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const VOD = process.argv[2] || "2936051136";

const browser = await chromium.launchPersistentContext(path.join(ROOT, ".build", "p-cors"), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
});
const page = browser.pages()[0] || (await browser.newPage());
await page.goto(`https://www.twitch.tv/videos/${VOD}`, { waitUntil: "domcontentloaded", timeout: 60000 });
const out = await page.evaluate(async (VOD) => {
  const steps = [];
  try {
    const q = `query VxrToken($id: ID!) { videoPlaybackAccessToken(id: $id, params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }`;
    const r = await fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko" },
      body: JSON.stringify({ query: q, variables: { id: VOD } })
    });
    steps.push({ step: "gql", status: r.status });
    const j = await r.json();
    const tok = j && j.data && j.data.videoPlaybackAccessToken;
    steps.push({ step: "token", has: !!tok, err: (j.errors && j.errors[0] && j.errors[0].message) || "" });
    if (!tok) return steps;
    const usher = `https://usher.ttvnw.net/vod/${VOD}.m3u8?allow_source=true&allow_audio_only=true&p=${encodeURIComponent(tok.value)}&sig=${tok.signature}&token=${encodeURIComponent(tok.value)}`;
    const m = await fetch(usher);
    steps.push({ step: "usher", status: m.status });
    const text = await m.text();
    steps.push({ step: "usherText", len: text.length, head: text.slice(0, 80) });
    const variant = /https:\/\/[^\s"]+\/chunked\/index-muted-[A-Z0-9]+\.m3u8/.exec(text);
    steps.push({ step: "variant", found: !!variant, url: variant ? variant[0] : "" });
    if (!variant) return steps;
    const p = await fetch(variant[0]);
    steps.push({ step: "playlist", status: p.status });
    const pt = await p.text();
    steps.push({ step: "playlistText", len: pt.length, seg0: pt.split("\n").filter((l) => l && !l.startsWith("#"))[0] || "" });
  } catch (e) {
    steps.push({ step: "error", message: String((e && e.message) || e) });
  }
  return steps;
}, VOD);
console.log(JSON.stringify(out, null, 2));
await browser.close();
