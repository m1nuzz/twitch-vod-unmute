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
if (!tok) {
  console.log("token failed:", JSON.stringify(tj).slice(0, 300));
  process.exit(1);
}
const usher = `https://usher.ttvnw.net/vod/${VOD}.m3u8?allow_source=true&allow_audio_only=true&p=${encodeURIComponent(tok.value)}&sig=${tok.signature}&token=${encodeURIComponent(tok.value)}`;
const master = await fetch(usher, { headers: H }).then((r) => r.text());
console.log("usher status lines:", master.split("\n").length, "| has STREAM-INF:", master.includes("#EXT-X-STREAM-INF"), "| has MEDIA:", master.includes("#EXT-X-MEDIA"));
const lines = master
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);
console.log("master head:\n" + lines.slice(0, 14).join("\n"));

const variants = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
    const name = /NAME="([^"]+)"/.exec(lines[i])?.[1] || "";
    variants.push({ name, url: new URL(lines[i + 1], usher).href });
  }
}
console.log("\nvariants:", variants.map((v) => v.name).join(", "));

const show = variants.find((v) => v.name === "720p60") || variants[0];
if (!show) process.exit(0);
console.log("\nplaylist url path:", new URL(show.url).pathname + new URL(show.url).search.slice(0, 60));
const media = await fetch(show.url, { headers: H }).then((r) => r.text());
const mlines = media
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);
const segs = mlines.filter((l) => !l.startsWith("#"));
const muted = segs.filter((l) => /-muted\./.test(l));
const unmuted = segs.filter((l) => /-unmuted\./.test(l));
console.log("media lines:", mlines.length, "segs:", segs.length, "| -muted:", muted.length, "| -unmuted:", unmuted.length);
console.log("sample segs:", segs.slice(0, 3).join("  "));
console.log("first -muted:", muted[0] || "-");
console.log("EXT-X-MAP lines:", mlines.filter((l) => l.startsWith("#EXT-X-MAP")).join(" | ") || "none");

async function status(u) {
  const r = await fetch(u, { headers: H }).catch((e) => ({ status: "err " + e.message }));
  if (r.body) await r.body.cancel().catch(() => {});
  return r.status;
}

/* playlist without -muted in the file name */
if (new URL(show.url).pathname.includes("-muted")) {
  const noMuted = show.url.replace(/-muted/g, "");
  console.log("\nplaylist without -muted name:", await status(noMuted), new URL(noMuted).pathname);
}
if (new URL(show.url).pathname.includes("-muted")) {
  const un = show.url.replace(/-muted/g, "-unmuted");
  console.log("playlist with -unmuted name:", await status(un), new URL(un).pathname);
}

/* plain twin of the first muted segment, with and without the query of the playlist entry */
if (muted[0]) {
  const mu = new URL(muted[0], show.url);
  const plain = new URL(mu.href.replace("-muted", ""));
  console.log("\nseg muted :", await status(mu.href), mu.pathname.slice(-40));
  console.log("seg plain :", await status(plain.href), plain.pathname.slice(-40));
  console.log("seg plain+q:", await status(mu.href.replace("-muted", "")), "same query kept");
  const unSeg = new URL(mu.href.replace("-muted", "-unmuted"));
  console.log("seg -unmut:", await status(unSeg.href), unSeg.pathname.slice(-40));
}
