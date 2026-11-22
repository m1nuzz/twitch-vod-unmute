import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const EXT = path.join(ROOT, ".build", "ext");
const GQL = {
  data: {
    video: {
      id: "2926037201",
      lengthSeconds: 120,
      muteInfo: { mutedSegmentConnection: { nodes: [{ offset: 20, duration: 60 }] } }
    }
  }
};

let alive = false;

function readBody(req) {
  return new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
}

/* 2 s segments, muted indices 10..39 (offset 20 s, duration 60 s) */
function mediaPlaylist() {
  const out = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2"];
  for (let i = 0; i < 45; i++) {
    const muted = 2 * i >= 20 && 2 * i < 80;
    out.push("#EXTINF:2.000,");
    out.push(`${i}${muted ? "-muted" : ""}.ts`);
  }
  out.push("#EXT-X-ENDLIST");
  return out.join("\n");
}

const srv = http.createServer(async (req, res) => {
  if (req.url === "/gql") {
    const body = await readBody(req);
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    if (body.includes("videoPlaybackAccessToken")) {
      return res.end(JSON.stringify({ data: { videoPlaybackAccessToken: { value: "fake-token", signature: "fake-sig" } } }));
    }
    return res.end(JSON.stringify(GQL));
  }
  if (req.url.startsWith("/vod/2926037201.m3u8")) {
    const host = req.headers.host;
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*" });
    return res.end(
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60",AUTOSELECT=NO,DEFAULT=NO',
        '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,VIDEO="chunked"',
        `http://${host}/videos/2926037201/chunked/index-muted-X.m3u8`,
        '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES',
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,VIDEO="720p60"',
        `http://${host}/videos/2926037201/720p60/index-muted-X.m3u8`
      ].join("\n")
    );
  }
  if (/^\/videos\/2926037201\/(chunked|720p60)\/index-muted-X\.m3u8$/.test(req.url)) {
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*" });
    return res.end(mediaPlaylist());
  }
  if (req.url.includes("/storyboards/")) {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end('{"count":1,"interval":1000}');
  }
  if (/\.ts/.test(req.url)) {
    const muted = /-muted\./.test(req.url);
    res.writeHead(muted || alive ? 200 : 403, { "Content-Type": "video/mp2t", "Access-Control-Allow-Origin": "*" });
    return res.end(muted ? "MUTED" : "ORIGINAL");
  }
  if (req.url === "/vod.mp4" || req.url === "/stream.mp3") {
    const f = path.join(ROOT, "fixtures", path.basename(req.url));
    const st = fs.statSync(f);
    res.writeHead(200, { "Content-Type": req.url.endsWith("mp4") ? "video/mp4" : "audio/mpeg", "Content-Length": st.size });
    return fs.createReadStream(f).pipe(res);
  }
  if (req.url.startsWith("/videos/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(ROOT, "page.html")));
  }
  res.writeHead(404);
  res.end("no");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const PORT = srv.address().port;

const browser = await chromium.launchPersistentContext(path.join(ROOT, ".build", "p-install"), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
const page = browser.pages()[0] || (await browser.newPage());
page.on("console", (m) => {
  if (/vxr/i.test(m.text())) console.log("console:", m.text());
});
await page.goto(`http://localhost:${PORT}/videos/2926037201`);
await page.waitForSelector("#vxr-panel", { timeout: 8000 });
await new Promise((r) => setTimeout(r, 2000));
async function search(label) {
  await page.click("#vxr-panel .vxr-cdn");
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const t = await page.textContent("#vxr-panel .vxr-status");
    if (/original found|audio not found|could not|check failed|no muted ranges|CDN unavailable/.test(t)) break;
  }
  console.log(label + ":", (await page.textContent("#vxr-panel .vxr-status")).replace(/\s+/g, " ").trim());
}
const nap2 = Number(process.argv[2] || 0);
if (nap2) {
  console.log("sleeping", nap2, "s so the service worker dies…");
  await new Promise((r) => setTimeout(r, nap2 * 1000));
}
await search("search #1 (originals gone)");
alive = true;
await search("search #2 (originals alive)");
const sw = browser.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
if (sw) {
  console.log("store:", JSON.stringify(await sw.evaluate(() => chrome.storage.local.get(null))).slice(0, 1200));
  console.log(
    "rules:",
    JSON.stringify(
      await sw.evaluate(() =>
        chrome.declarativeNetRequest
          .getDynamicRules()
          .then((r) => r.slice(0, 3).map((x) => ({ id: x.id, f: x.condition.regexFilter, s: x.action.redirect && x.action.redirect.regexSubstitution })))
      )
    ).slice(0, 800)
  );
} else {
  console.log("no extension service worker");
}
await browser.close();
srv.close();
