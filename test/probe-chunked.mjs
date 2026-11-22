import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, ".build", "seg");
fs.mkdirSync(OUT, { recursive: true });
const VOD = process.argv[2] || "2936051136";
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Origin: "https://www.twitch.tv",
  Referer: `https://www.twitch.tv/videos/${VOD}`
};

const tokenQuery = `query VxrToken($id: ID!) { videoPlaybackAccessToken(id: $id, params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }`;
const tj = await fetch("https://gql.twitch.tv/gql", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Client-ID": CLIENT_ID },
  body: JSON.stringify({ query: tokenQuery, variables: { id: VOD } })
}).then((r) => r.json());
const tok = tj?.data?.videoPlaybackAccessToken;
const usher = `https://usher.ttvnw.net/vod/${VOD}.m3u8?allow_source=true&allow_audio_only=true&p=${encodeURIComponent(tok.value)}&sig=${tok.signature}&token=${encodeURIComponent(tok.value)}`;
const master = await fetch(usher, { headers: H }).then((r) => r.text());

const lines = master
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);
const variants = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="([^"]+)",NAME="([^"]+)"/.exec(lines[i]);
  if (m) {
    const nextStream = lines.findIndex((l, j) => j > i && l.startsWith("#EXT-X-STREAM-INF"));
    if (nextStream > -1) variants.push({ group: m[1], name: m[2], url: new URL(lines[nextStream + 1], usher).href });
  }
  const a = /^#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="([^"]+)",NAME="([^"]+)"/.exec(lines[i]);
  if (a) {
    const nextStream = lines.findIndex((l, j) => j > i && l.startsWith("#EXT-X-STREAM-INF"));
    if (nextStream > -1) variants.push({ group: a[1], name: "AUDIO:" + a[2], url: new URL(lines[nextStream + 1], usher).href });
  }
}
console.log("variants:", variants.map((v) => `${v.name}@${v.group}`).join(", "));

async function media(v) {
  const text = await fetch(v.url, { headers: H }).then((r) => r.text());
  const segs = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return { text, segs };
}

async function status(u) {
  const r = await fetch(u, { headers: H }).catch(() => ({ status: "err" }));
  if (r.body) await r.body.cancel().catch(() => {});
  return r.status;
}

const report = [];
for (const v of variants) {
  let m;
  try {
    m = await media(v);
  } catch (e) {
    report.push(`${v.name.padEnd(12)} playlist fetch failed: ${e.message}`);
    continue;
  }
  const mutedIdx = [];
  m.segs.forEach((s, i) => {
    if (/-muted\./.test(s)) mutedIdx.push(i);
  });
  const step = Math.max(1, Math.floor(mutedIdx.length / 12));
  let ok = 0;
  let tried = 0;
  let firstOk = "";
  for (let k = 0; k < mutedIdx.length && tried < 12; k += step) {
    const i = mutedIdx[k];
    const plain = new URL(m.segs[i].replace(/-muted/, ""), v.url).href;
    const s = await status(plain);
    tried++;
    if (s === 200) {
      ok++;
      if (!firstOk) firstOk = `idx ${i}`;
    }
  }
  report.push(`${v.name.padEnd(12)} segs ${String(m.segs.length).padEnd(5)} muted ${String(mutedIdx.length).padEnd(4)} plain200 ${ok}/${tried}  ${firstOk}`);
}
console.log("\n" + report.join("\n"));

/* download the first muted pair of 1080p60/chunked and compare */
const chunked = variants.find((v) => v.name === "1080p60") || variants[0];
const cm = await media(chunked);
const firstMuted = cm.segs.find((s) => /-muted\./.test(s));
const mutedUrl = new URL(firstMuted, chunked.url).href;
const plainUrl = new URL(firstMuted.replace(/-muted/, ""), chunked.url).href;

async function grab(u, file) {
  const r = await fetch(u, { headers: H });
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(path.join(OUT, file), buf);
  return { status: r.status, size: buf.length, sha: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16) };
}
const a = await grab(mutedUrl, "muted.ts");
const b = await grab(plainUrl, "plain.ts");
console.log("\npair", new URL(firstMuted, chunked.url).pathname.split("/").slice(-1)[0]);
console.log("muted:", a);
console.log("plain:", b);
console.log("identical:", a.sha === b.sha);
