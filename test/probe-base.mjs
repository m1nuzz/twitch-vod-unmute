const BASE = "https://d3fi1amfgojobc.cloudfront.net/e1827b6469d132875a98_jeens_319424545893_1795263362";
const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Origin: "https://www.twitch.tv",
  Referer: "https://www.twitch.tv/videos/2936051136"
};

const candidates = [
  "720p60/index-muted.m3u8",
  "720p60/index-dash.m3u8",
  "720p60/index.m3u8",
  "720p60/index-video.m3u8",
  "index-muted.m3u8",
  "index-dash.m3u8",
  "chunked/index-muted.m3u8",
  "720p60/454-muted.ts",
  "720p60/454.ts",
  "360p30/453-muted.ts",
  "storyboards/2936051136-info.json"
];

for (const c of candidates) {
  const r = await fetch(`${BASE}/${c}`, { headers: H }).catch((e) => ({ status: "err " + e.message }));
  const len = r.headers && r.headers.get ? r.headers.get("content-length") : null;
  console.log(String(r.status).padEnd(6), len ? String(len).padEnd(9) : "".padEnd(9), c);
  if (r.body) await r.body.cancel().catch(() => {});
}
