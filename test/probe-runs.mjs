const VOD = process.argv[2] || "2936051136";
const BASE = "https://d3fi1amfgojobc.cloudfront.net/e1827b6469d132875a98_jeens_319424545893_1795263362";
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Origin: "https://www.twitch.tv",
  Referer: `https://www.twitch.tv/videos/${VOD}`
};

const q = `query V($id: ID!) { video(id: $id) { lengthSeconds muteInfo { mutedSegmentConnection { nodes { offset duration } } } } }`;
const j = await fetch("https://gql.twitch.tv/gql", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Client-ID": CLIENT_ID },
  body: JSON.stringify({ query: q, variables: { id: VOD } })
}).then((r) => r.json());
const nodes = j.data.video.muteInfo.mutedSegmentConnection.nodes;
console.log("mute map:", nodes.length, "ranges, length", j.data.video.lengthSeconds);

async function st(p) {
  const r = await fetch(`${BASE}/${p}`, { headers: H }).catch(() => ({ status: 0 }));
  if (r.body) await r.body.cancel().catch(() => {});
  return r.status;
}

for (const quality of ["chunked", "720p60"]) {
  let found = 0;
  let miss = 0;
  const rows = [];
  for (const n of nodes) {
    const exp = Math.round(n.offset / 10);
    let hit = null;
    for (let d = 0; d <= 3 && hit === null; d++) {
      for (const i of d === 0 ? [exp] : [exp - d, exp + d]) {
        const s = await st(`${quality}/${i}-muted.ts`);
        if (s === 200) {
          hit = i;
          break;
        }
      }
    }
    if (hit === null) {
      miss++;
      rows.push(`${n.offset} exp ${exp} MISS`);
    } else {
      found++;
      rows.push(`${n.offset} exp ${exp} hit ${hit}${hit === exp ? "" : " DRIFT " + (hit - exp)}`);
    }
  }
  console.log(`\n${quality}: found ${found}/${nodes.length}, miss ${miss}`);
  console.log(rows.slice(0, 8).join("\n"));
}
