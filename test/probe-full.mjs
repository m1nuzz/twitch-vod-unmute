const VOD = process.argv[2] || "2936051136";
const ONLY = process.argv[3] || "";
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
    const ns = lines.findIndex((l, j) => j > i && l.startsWith("#EXT-X-STREAM-INF"));
    if (ns > -1) variants.push({ name: m[2], url: new URL(lines[ns + 1], usher).href });
  }
}

async function probe(u) {
  for (let a = 0; a < 3; a++) {
    const c = new AbortController();
    try {
      const r = await fetch(u, { headers: H, signal: c.signal });
      const s = r.status;
      c.abort();
      if (s !== 429 && s < 500) return s;
    } catch {
      c.abort();
    }
    await new Promise((res) => setTimeout(res, 200 * (a + 1)));
  }
  return 0;
}

for (const v of variants) {
  if (ONLY && v.name !== ONLY) continue;
  const media = await fetch(v.url, { headers: H }).then((r) => r.text());
  const segs = media
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const muted = [];
  segs.forEach((s, i) => {
    if (/-muted\.(ts|m4s|mp4)/.test(s)) muted.push({ i, uri: s });
  });
  const found = [];
  let done = 0;
  const queue = [...muted];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const m = queue.shift();
      const plain = new URL(m.uri.replace(/-muted/, ""), v.url).href;
      const s = await probe(plain);
      done++;
      if (s === 200) found.push(m.i);
      if (done % 60 === 0) process.stdout.write(`\r${v.name}: ${done}/${muted.length}  found ${found.length}`);
    }
  });
  await Promise.all(workers);
  const blocks = [];
  for (const i of found) {
    const last = blocks[blocks.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else blocks.push([i, i]);
  }
  console.log(`\n${v.name}: muted ${muted.length}, plain200 ${found.length}  blocks ${JSON.stringify(blocks)}`);
  console.log(
    `  first uris: ${found
      .slice(0, 5)
      .map((i) => new URL(segs[i], v.url).pathname.split("/").pop())
      .join(" ")}`
  );
}
