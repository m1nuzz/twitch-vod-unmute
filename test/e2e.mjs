import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, "..", "extension");
const BUILD = path.join(ROOT, ".build");
const EXT = path.join(BUILD, "ext");
const FIX = path.join(ROOT, "fixtures");

/* ---------- build a test copy of the extension that also runs on localhost ---------- */
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(SRC, EXT, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
for (const cs of manifest.content_scripts) cs.matches = ["http://localhost:*/*"];
manifest.host_permissions = ["http://localhost/*"];
fs.writeFileSync(path.join(EXT, "manifest.json"), JSON.stringify(manifest, null, 2));
const bridge = fs.readFileSync(path.join(EXT, "gql-bridge.js"), "utf8").replaceAll("https://gql.twitch.tv/gql", "/gql").replaceAll("https://usher.ttvnw.net", "");
fs.writeFileSync(path.join(EXT, "gql-bridge.js"), bridge);

/* ---------- fake twitch: player page + mute map + CDN with segment retention switch ---------- */
const MUTE_MAP = {
  data: {
    video: {
      id: "2926037201",
      lengthSeconds: 9257,
      muteInfo: {
        mutedSegmentConnection: {
          nodes: [
            { duration: 180, offset: 12, __typename: "VideoMutedSegment" },
            { duration: 60, offset: 45, __typename: "VideoMutedSegment" },
            { duration: 180, offset: 70, __typename: "VideoMutedSegment" }
          ],
          __typename: "VideoMutedSegmentConnection"
        },
        __typename: "VideoMuteInfo"
      },
      __typename: "Video"
    }
  }
};

let cdnAlive = false;
let unmutedFixture = false;
const requests = [];

const AV_TS = path.join(BUILD, "av10.ts");
try {
  if (!fs.existsSync(AV_TS)) {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", path.join(FIX, "vod.mp4"), "-t", "10", "-c", "copy", "-f", "mpegts", AV_TS], { stdio: "pipe" });
  }
} catch (e) {}

function readBody(req) {
  return new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
}

function readBuf(req) {
  return new Promise((r) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => r(Buffer.concat(chunks)));
  });
}

let audioPolls = 0;

function audioPlaylist() {
  audioPolls++;
  const n = audioPolls === 1 ? 2 : 3;
  const out = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:3"];
  for (let i = 0; i < n; i++) {
    out.push("#EXTINF:10.000,");
    out.push(`seg${i}${unmutedFixture && i === 1 ? "-muted" : ""}.ts`);
  }
  if (audioPolls > 1) out.push("#EXT-X-ENDLIST");
  return out.join("\n");
}

/* media playlist in the shape Twitch serves: 2 s segments, muted names for silenced ranges */
function mediaPlaylist() {
  if (unmutedFixture) {
    return [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:10",
      "#EXTINF:10.000,",
      "0.ts",
      "#EXTINF:10.000,",
      "1-muted.ts",
      "#EXTINF:10.000,",
      "2.ts",
      "#EXT-X-ENDLIST"
    ].join("\n");
  }
  const out = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2"];
  for (let i = 0; i < 130; i++) {
    const isMuted = [
      [12, 192],
      [45, 105],
      [70, 250]
    ].some((r) => 2 * i >= r[0] && 2 * i < r[1]);
    out.push("#EXTINF:2.000,");
    out.push(`${i}${isMuted ? "-muted" : ""}.ts`);
  }
  out.push("#EXT-X-ENDLIST");
  return out.join("\n");
}

function serveFile(req, res, file) {
  const stat = fs.statSync(file);
  const type = file.endsWith(".mp3") ? "audio/mpeg" : file.endsWith(".mp4") ? "video/mp4" : "text/html; charset=utf-8";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", type);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Length": stat.size });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  requests.push(u.pathname);
  if (u.pathname === "/gql") {
    const body = await readBody(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (body.includes("videoPlaybackAccessToken")) {
      return res.end(JSON.stringify({ data: { videoPlaybackAccessToken: { value: "fake-token", signature: "fake-sig" } } }));
    }
    return res.end(JSON.stringify(MUTE_MAP));
  }
  if (u.pathname === "/vod/2926037201.m3u8") {
    const host = req.headers.host;
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end(
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60",AUTOSELECT=NO,DEFAULT=NO',
        '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,VIDEO="chunked"',
        `http://${host}/videos/2926037201/chunked/index-muted-X.m3u8`,
        '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES',
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,VIDEO="720p60"',
        `http://${host}/videos/2926037201/720p60/index-muted-X.m3u8`,
        '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="Audio Only"',
        '#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"',
        `http://${host}/videos/2926037201/audio_only/index-dvr.m3u8`
      ].join("\n")
    );
  }
  if (u.pathname === "/videos/2926037201/audio_only/index-dvr.m3u8") {
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end(audioPlaylist());
  }
  if (/^\/videos\/2926037201\/audio_only\/seg\d+(-muted)?\.ts$/.test(u.pathname)) {
    const f = path.join(FIX, `seg${/seg(\d+)/.exec(u.pathname)[1]}.ts`);
    res.writeHead(200, { "Content-Type": "video/mp2t", "Access-Control-Allow-Origin": "*" });
    return fs.createReadStream(f).pipe(res);
  }
  if (u.pathname === "/__saved") {
    const name = `dl-${u.searchParams.get("f") || "x"}.m4a`;
    const body = await readBuf(req);
    fs.appendFileSync(path.join(BUILD, name), body);
    res.writeHead(200);
    return res.end("ok");
  }
  if (/^\/videos\/2926037201\/(chunked|720p60)\/index-muted-X\.m3u8$/.test(u.pathname)) {
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end(mediaPlaylist());
  }
  if (unmutedFixture && /^\/videos\/2926037201\/chunked\/[012]\.ts$/.test(u.pathname)) {
    const idx = Number(/(\d)\.ts$/.exec(u.pathname)[1]);
    const f = idx === 1 && fs.existsSync(AV_TS) ? AV_TS : path.join(FIX, `seg${idx}.ts`);
    res.writeHead(200, { "Content-Type": "video/mp2t", "Access-Control-Allow-Origin": "*" });
    return fs.createReadStream(f).pipe(res);
  }
  if (u.pathname === "/vod.mp4" || u.pathname === "/stream.mp3") return serveFile(req, res, path.join(FIX, path.basename(u.pathname)));
  if (u.pathname === "/videos/2926037201") return serveFile(req, res, path.join(ROOT, "page.html"));
  if (u.pathname === "/videos/2926037201/storyboards/2926037201-info.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end('{"width":320,"height":180,"count":1,"interval":1000}');
  }
  const seg = /^\/videos\/2926037201\/(?:[^/]+\/)?(\d+)(-muted)?\.ts$/.exec(u.pathname);
  if (seg) {
    /* Twitch keeps one name per segment: silent audio lives at N-muted.ts, the audible
       original at N.ts. When the original is purged, only N-muted.ts answers. */
    const idx = Number(seg[1]);
    const isMuted = [
      [12, 192],
      [45, 105],
      [70, 250]
    ].some((r) => 2 * idx >= r[0] && 2 * idx < r[1]);
    const wantsMuted = !!seg[2];
    const ok = wantsMuted ? isMuted : isMuted ? cdnAlive : true;
    res.writeHead(ok ? 200 : 403, { "Content-Type": "video/mp2t", "Access-Control-Allow-Origin": "*" });
    return res.end(wantsMuted ? "MUTED" : isMuted ? "ORIGINAL" : "AUDIBLE");
  }
  res.writeHead(404);
  res.end("nope");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}`;

/* ---------- assertions ---------- */
const results = [];
let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(44)} ${detail ?? ""}`);
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=${name}::${detail ?? ""}`.slice(0, 900));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function clocks() {
  return page.evaluate(() => {
    const v = document.querySelector("video");
    const a = document.querySelector(".vxr-track");
    return {
      vod: v.currentTime,
      track: a ? a.currentTime : null,
      vodMuted: v.muted,
      trackPaused: a ? a.paused : null,
      trackRate: a ? a.playbackRate : null,
      vodRate: v.playbackRate,
      driftMs: a ? (a.currentTime - v.currentTime) * 1000 : null
    };
  });
}
const status = () => page.textContent("#vxr-panel .vxr-status");

let page;
try {
  fs.rmSync(path.join(BUILD, "profile"), { recursive: true, force: true });
  const browser = await chromium.launchPersistentContext(path.join(BUILD, "profile"), {
    channel: "chromium",
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  page = browser.pages()[0] || (await browser.newPage());
  const ctxErrors = [];
  const noteCtx = (text) => {
    if (/extension context invalidated|message port closed/i.test(String(text))) ctxErrors.push(String(text));
  };
  page.on("pageerror", noteCtx);
  page.on("console", (m) => {
    if (m.type() === "error") noteCtx(m.text());
  });

  await page.addInitScript(() => {
    let n = 0;
    window.showSaveFilePicker = async () => {
      const id = ++n;
      return {
        name: `dl-${id}.m4a`,
        createWritable: async () => ({
          write: (u8) => fetch(`/__saved?f=${id}`, { method: "POST", body: u8 }).then(() => {}),
          close: async () => {},
          abort: async () => {}
        })
      };
    };
  });

  const picker = page.waitForEvent("filechooser");
  await page.goto(`${BASE}/videos/2926037201`, { waitUntil: "load" });

  /* panel + mute map */
  await page.waitForSelector("#vxr-panel", { state: "attached", timeout: 8000 });
  check("panel built closed", (await page.locator("#vxr-panel").count()) === 1 && !(await page.isVisible("#vxr-panel")));
  await page.waitForFunction(() => /3 ranges/.test(document.querySelector("#vxr-panel .vxr-seg-info").textContent), null, { timeout: 8000 }).catch(() => {});
  const segInfo = await page.textContent("#vxr-panel .vxr-seg-info");
  check("mute map parsed from page context", /3 ranges/.test(segInfo), `info="${segInfo}"`);

  await page.waitForSelector(".vxr-unmute", { timeout: 5000 });
  const remute = await page.evaluate(() => {
    const b = document.querySelector(".vxr-unmute");
    const s = Array.from(document.querySelectorAll(".fake-share")).find((x) => !x.classList.contains("vxr-unmute"));
    if (!b || !s) return null;
    const rb = b.getBoundingClientRect();
    const rs = s.getBoundingClientRect();
    return { text: b.textContent.trim(), leftOfShare: rb.right <= rs.left + 1, gap: Math.round(rs.left - rb.right), visible: rb.width > 0 };
  });
  check(
    "Unmute VOD pill sits left of a localized Share",
    remute && remute.text === "Unmute VOD" && remute.leftOfShare && remute.gap >= 4 && remute.visible,
    JSON.stringify(remute)
  );
  await page.click(".vxr-unmute");
  check("Unmute VOD opens the panel", await page.isVisible("#vxr-panel"));
  await page.click(".vxr-unmute");
  check("Unmute VOD collapses the panel", !(await page.isVisible("#vxr-panel")));
  await page.click(".vxr-unmute");
  check("Unmute VOD reopens the panel", await page.isVisible("#vxr-panel"));
  check("map total sums durations", segInfo.includes("7:00"), `"${segInfo}" (180+60+180=420s)`);

  /* muted-range jumps: each click lands inside the next/previous range and wraps at the ends */
  const jumpTo = async (cls) => {
    await page.click(`#vxr-panel .${cls}`);
    await wait(350);
    return page.evaluate(() => document.querySelector("video").currentTime);
  };
  const j1 = await jumpTo("vxr-next");
  check("next jumps into the first muted range", Math.abs(j1 - 12.25) < 1, `t=${j1.toFixed(2)} (range starts 12)`);
  const j2 = await jumpTo("vxr-next");
  check("next advances to the following range", Math.abs(j2 - 45.25) < 1, `t=${j2.toFixed(2)} (range starts 45)`);
  const j3 = await jumpTo("vxr-prev");
  check("prev returns to the earlier range", Math.abs(j3 - 12.25) < 1, `t=${j3.toFixed(2)}`);
  const j4 = await jumpTo("vxr-prev");
  check("prev wraps to the last range", Math.abs(j4 - 70.25) < 1, `t=${j4.toFixed(2)} (range starts 70)`);
  const j5 = await jumpTo("vxr-next");
  check("next wraps to the first range", Math.abs(j5 - 12.25) < 1, `t=${j5.toFixed(2)}`);
  await page.evaluate(() => {
    document.querySelector("video").currentTime = 2;
  });

  check(
    "cdn base discovered from page timeline",
    requests.some((r) => r.includes("storyboards")),
    requests.filter((r) => r.includes("storyboard")).join(" ")
  );

  /* file picker -> blob -> engine */
  await page.click("#vxr-panel .vxr-pick");
  const chooser = await picker;
  await chooser.setFiles(path.join(FIX, "stream.mp3"));
  await page.waitForFunction(() => /replacement on/.test(document.querySelector("#vxr-panel .vxr-status").textContent), null, { timeout: 8000 });
  check("file loaded and engine armed", /replacement on/.test(await status()), (await status()).trim());
  await page.screenshot({ path: path.join(BUILD, "panel.png") });
  await page.waitForFunction(() => document.querySelector(".vxr-track").readyState >= 2, null, { timeout: 8000 });
  const gateState = () =>
    page.evaluate(() => {
      const v = document.querySelector("video");
      const proto = HTMLMediaElement.prototype;
      const gm = Object.getOwnPropertyDescriptor(proto, "muted").get;
      const gv = Object.getOwnPropertyDescriptor(proto, "volume").get;
      const m = document.querySelector(".vxr-level");
      return {
        silent: v.getAttribute("data-vxr-silent"),
        uiMuted: v.muted,
        uiVolume: v.volume,
        rawMuted: gm.call(v),
        rawVolume: gv.call(v),
        gain: m.dataset.gain,
        pointwise: document.querySelector(".vxr-mode-muted").classList.contains("vxr-active"),
        full: document.querySelector(".vxr-mode-full").classList.contains("vxr-active")
      };
    });
  await wait(500);
  const outside = await gateState();
  check(
    "pointwise default: original plays outside muted ranges",
    outside.pointwise && !outside.full && outside.silent === null && outside.rawMuted === false && outside.gain === "0.00",
    JSON.stringify(outside)
  );
  await page.evaluate(() => {
    document.querySelector("video").currentTime = 20;
  });
  await wait(800);
  const silence = await gateState();
  check(
    "pointwise: stem takes over inside a muted range",
    silence.silent === "1" && silence.uiMuted === false && silence.uiVolume > 0 && Number(silence.gain) > 0,
    JSON.stringify(silence)
  );

  await page.evaluate(() => document.querySelector("video").play());
  await wait(2500);
  const first = await clocks();
  check("track starts with reference", first.track !== null && Math.abs(first.driftMs) < 150, `drift=${first.driftMs?.toFixed(1)} ms vod=${first.vod.toFixed(2)}`);

  await wait(6000);
  const steady = await clocks();
  check("locked 8.5 s into playback", Math.abs(steady.driftMs) < 60, `drift=${steady.driftMs?.toFixed(1)} ms status="${(await status()).trim()}"`);

  /* the player's own volume control must drive the replacement track */
  async function meterPeak(ms) {
    let peak = 0;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const w = await page.evaluate(() => parseFloat(document.querySelector(".vxr-level > b").style.width) || 0);
      peak = Math.max(peak, w);
      await wait(60);
    }
    return peak;
  }
  await page.evaluate(() => {
    document.querySelector("video").volume = 1;
  });
  const volHigh = await meterPeak(8000);
  await page.evaluate(() => {
    document.querySelector("video").volume = 0.2;
  });
  await wait(300);
  const volLow = await meterPeak(5000);
  const dbg = () =>
    page.evaluate(() => {
      const m = document.querySelector(".vxr-level");
      const a = document.querySelector(".vxr-track");
      const v = document.querySelector("video");
      return { gain: m?.dataset.gain, muted: m?.dataset.muted, ctx: m?.dataset.ctx, trackPaused: a?.paused, trackTime: a?.currentTime, vodTime: v.currentTime };
    });
  check(
    "native Twitch volume drives file audio",
    volHigh > 10 && volLow < volHigh * 0.5,
    `high=${volHigh.toFixed(1)}% low=${volLow.toFixed(1)}% status="${(await status()).trim()}" dbg=${JSON.stringify(await dbg())}`
  );

  /* the live Twitch path: video is muted and volume stays 0, only the slider value moves */
  async function setSlider(v) {
    await page.evaluate((x) => {
      const s = document.querySelector('input[type="range"].tw-range');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(s, String(x));
      s.dispatchEvent(new Event("input", { bubbles: true }));
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }, v);
  }
  await page.evaluate(() => {
    document.querySelector("video").volume = 0;
  });
  await setSlider(1);
  const uiHigh = await meterPeak(8000);
  await setSlider(0);
  await wait(300);
  const uiLow = await meterPeak(2500);
  check(
    "Twitch volume slider drives file audio",
    uiHigh > 10 && uiLow < 1,
    `high=${uiHigh.toFixed(1)}% low=${uiLow.toFixed(1)}% video.volume=0 dbg=${JSON.stringify(await dbg())}`
  );
  await setSlider(1);
  await page.evaluate(() => {
    document.querySelector("video").volume = 1;
  });

  /* audio download: picker streams transmuxed chunks to the test server */
  fs.rmSync(path.join(BUILD, "dl-1.m4a"), { force: true });
  await page.evaluate(() => {
    window.__dlNotes = [];
    const note = document.querySelector("#vxr-panel .vxr-dl-note");
    new MutationObserver(() => window.__dlNotes.push(note.textContent)).observe(note, { childList: true, characterData: true, subtree: true });
  });
  const dlBefore = audioPolls;
  await page.click("#vxr-panel .vxr-dl");
  await page.waitForFunction(() => /audio saved/.test(document.querySelector("#vxr-panel .vxr-dl-note").textContent), null, { timeout: 45000 }).catch(() => {});
  const dlNote = await page.textContent("#vxr-panel .vxr-dl-note");
  const dlFile = path.join(BUILD, "dl-1.m4a");
  const dlSize = fs.existsSync(dlFile) ? fs.statSync(dlFile).size : 0;
  let dlProbe = null;
  if (dlSize) {
    try {
      dlProbe = JSON.parse(
        execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,start_time", "-show_entries", "stream=codec_name", "-of", "json", dlFile]).toString()
      );
    } catch (e) {}
  }
  const dlDuration = dlProbe ? Number(dlProbe.format.duration) : 0;
  check(
    "downloads audio_only track as m4a",
    /audio saved/.test(dlNote) &&
      dlSize > 200000 &&
      dlProbe &&
      dlProbe.streams[0].codec_name === "aac" &&
      Math.abs(Number(dlProbe.format.start_time)) < 0.05 &&
      Math.abs(dlDuration - 30) < 1.5 &&
      audioPolls - dlBefore >= 2,
    `note="${dlNote.trim()}" size=${dlSize} duration=${dlDuration} polls=${audioPolls - dlBefore}`
  );
  const dlNotes = await page.evaluate(() => window.__dlNotes || []);
  const progressNote = dlNotes.find((n) => /downloading: \d+\/3 · .*\/ ~.* · \d+% · [\d.]+ (KB|MB)\/s/.test(n)) || "";
  const barBuilt = await page.evaluate(() => !!document.querySelector("#vxr-panel .vxr-dl-bar > b"));
  check("download shows percent, speed and time left", !!progressNote && barBuilt, `note="${progressNote}" bar=${barBuilt}`);

  /* unmuted download: a muted audio segment is replaced with the recovered 1080p60 original */
  unmutedFixture = true;
  fs.rmSync(path.join(BUILD, "dl-2.m4a"), { force: true });
  const unBefore = requests.length;
  await page.click("#vxr-panel .vxr-dl-un");
  await page.waitForFunction(() => /audio saved/.test(document.querySelector("#vxr-panel .vxr-dl-note").textContent), null, { timeout: 45000 }).catch(() => {});
  const unNote = await page.textContent("#vxr-panel .vxr-dl-note");
  const unFile = path.join(BUILD, "dl-2.m4a");
  const unSize = fs.existsSync(unFile) ? fs.statSync(unFile).size : 0;
  let unProbe = null;
  if (unSize) {
    try {
      unProbe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_name", "-of", "json", unFile]).toString());
    } catch (e) {}
  }
  const unDuration = unProbe ? Number(unProbe.format.duration) : 0;
  const unRequests = requests.slice(unBefore);
  check(
    "unmuted download swaps in the recovered original",
    /unmuted 1 of 1/.test(unNote) && unSize > 200000 && Math.abs(unDuration - 30) < 1.5 && unRequests.includes("/videos/2926037201/chunked/1.ts"),
    `note="${unNote.trim()}" size=${unSize} duration=${unDuration} chunked=${unRequests.filter((p) => /chunked/.test(p)).slice(0, 3)}`
  );
  unmutedFixture = false;

  /* real signal through the Web Audio graph (beeps every 2 s) */
  const ctxState = await page.evaluate(async () => {
    const c = new AudioContext();
    await c.resume().catch(() => {});
    const s = c.state;
    await c.close();
    return s;
  });
  let peak = 0;
  for (let i = 0; i < 150 && peak === 0; i++) {
    const w = await page.evaluate(() => parseFloat(document.querySelector(".vxr-level > b").style.width) || 0);
    peak = Math.max(peak, w);
    await wait(100);
  }
  const signal = await page.evaluate(async () => {
    const buf = await (await fetch("/stream.mp3")).arrayBuffer();
    const c = new OfflineAudioContext(1, 48000, 48000);
    const decoded = await c.decodeAudioData(buf.slice(0, 300000));
    let sum = 0;
    const d = decoded.getChannelData(0);
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    return { rms: Math.sqrt(sum / d.length), dur: decoded.duration };
  });
  check("replacement audio actually flows", signal.rms > 0.01 && ctxState === "running", `decoded rms=${signal.rms.toFixed(3)} audioCtx=${ctxState} meter peak=${peak}%`);

  /* seek, rate, pause */
  await page.evaluate(() => {
    document.querySelector("video").currentTime = 100;
  });
  await wait(400);
  const afterSeek = await clocks();
  check("seeks realign at once", Math.abs(afterSeek.driftMs) < 60, `drift=${afterSeek.driftMs?.toFixed(1)} ms`);

  await page.evaluate(() => {
    document.querySelector("video").playbackRate = 1.75;
  });
  await wait(3000);
  const fast = await clocks();
  check("survives 1.75x", Math.abs(fast.driftMs) < 60 && Math.abs(fast.trackRate - 1.75) < 0.05, `drift=${fast.driftMs?.toFixed(1)} ms trackRate=${fast.trackRate.toFixed(3)}`);

  await page.evaluate(() => document.querySelector("video").pause());
  await wait(300);
  const paused = await clocks();
  check("pause propagates to track", paused.trackPaused === true);

  await page.evaluate(() => {
    const v = document.querySelector("video");
    v.currentTime = 2;
    v.play().catch(() => {});
  });
  await wait(1200);
  const backOutside = await gateState();
  const silentStem = await meterPeak(2500);
  check(
    "pointwise: original returns between muted ranges",
    backOutside.silent === null && backOutside.rawMuted === false && backOutside.gain === "0.00" && silentStem < 2,
    JSON.stringify(backOutside) + ` stemPeak=${silentStem}%`
  );
  await page.click("#vxr-panel .vxr-mode-full");
  await wait(600);
  const fullState = await gateState();
  const fullStem = await meterPeak(3000);
  check(
    "full mode replaces the whole track",
    fullState.full && fullState.silent === "1" && fullState.rawMuted === true && Number(fullState.gain) > 0 && fullStem > 10,
    JSON.stringify(fullState) + ` stemPeak=${fullStem}%`
  );
  await page.click("#vxr-panel .vxr-mode-muted");
  await page.evaluate(() => {
    document.querySelector("video").currentTime = 2;
  });
  await wait(800);
  const backPoint = await gateState();
  check("mode switches back to pointwise", backPoint.pointwise && backPoint.silent === null && backPoint.gain === "0.00", JSON.stringify(backPoint));

  await page.click("#vxr-panel .vxr-toggle");
  await wait(300);
  const off = await clocks();
  check("disable restores VOD audio", off.vodMuted === false, `vodMuted=${off.vodMuted}`);

  /* CDN verdict: originals deleted */
  cdnAlive = false;
  await page.evaluate(() => window.requestSegments(795));
  await page.click("#vxr-panel .vxr-cdn");
  await page.waitForFunction(() => /audio not found/.test(document.querySelector("#vxr-panel .vxr-status").textContent), null, { timeout: 90000 }).catch(() => {});
  check("reports missing originals", /audio not found/.test(await status()), (await status()).trim());

  /* CDN verdict: originals alive -> redirect rule must actually rewrite requests */
  cdnAlive = true;
  await page.evaluate(() => window.requestSegments(796));
  await page.click("#vxr-panel .vxr-cdn");
  await page.waitForFunction(() => /original found/.test(document.querySelector("#vxr-panel .vxr-status").textContent), null, { timeout: 90000 }).catch(() => {});
  check("finds live originals", /original found/.test(await status()), (await status()).trim());

  requests.length = 0;
  const redirected = await page.evaluate(async () => {
    const r = await fetch("/videos/2926037201/chunked/6-muted.ts");
    return { status: r.status, url: new URL(r.url).pathname, body: await r.text() };
  });
  const sawPlain = requests.includes("/videos/2926037201/chunked/6.ts");
  const sawMuted = requests.includes("/videos/2926037201/chunked/6-muted.ts");
  check(
    "redirect rule rewrites segments",
    sawPlain && !sawMuted && redirected.body === "ORIGINAL",
    `server saw=${JSON.stringify(requests)} fetch -> ${redirected.url} ${redirected.status} "${redirected.body}"`
  );

  /* a reloaded extension leaves this tab with a stale content script */
  const sw = browser.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  const extId = sw ? new URL(sw.url()).host : "";
  let reloaded = "no worker";
  if (extId) {
    const extPage = await browser.newPage();
    await extPage.goto("chrome://extensions");
    await extPage.waitForTimeout(500);
    reloaded = await extPage.evaluate(
      (id) =>
        new Promise((resolve) => {
          try {
            chrome.developerPrivate.reload(id, { failQuietly: false }, () => {
              void chrome.runtime.lastError;
              resolve("ok");
            });
          } catch (e) {
            resolve("error: " + e.message);
          }
        }),
      extId
    );
    await extPage.close();
  }
  await page.click("#vxr-panel .vxr-mode-full");
  const refreshHint = await page
    .waitForFunction(() => /refresh the page/.test(document.querySelector("#vxr-panel .vxr-status").textContent), null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(500);
  check(
    "extension reload is caught in the panel",
    reloaded === "ok" && refreshHint && ctxErrors.length === 0,
    `reload=${reloaded} hint=${refreshHint} errors=${JSON.stringify(ctxErrors.slice(0, 2))}`
  );

  await browser.close();
} catch (e) {
  check("harness completed", false, String(e && e.message ? e.message.split("\n")[0] : e));
} finally {
  server.close();
}

console.log(results.join("\n"));
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
