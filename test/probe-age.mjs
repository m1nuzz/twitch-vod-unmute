const VOD = process.argv[2] || "2936051136";
const BASE = process.argv[3] || "https://d3fi1amfgojobc.cloudfront.net/e1827b6469d132875a98_jeens_319424545893_1795263362";
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Origin: "https://www.twitch.tv",
  Referer: `https://www.twitch.tv/videos/${VOD}`
};

const query = `query VxrMeta($id: ID!) { video(id: $id) { id title createdAt publishedAt lengthSeconds status broadcastType owner { login } muteInfo { mutedSegmentConnection { nodes { offset duration } } } } }`;
const gql = await fetch("https://gql.twitch.tv/gql", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Client-ID": CLIENT_ID },
  body: JSON.stringify({ query, variables: { id: VOD } })
}).then((r) => r.json());

const v = gql && gql.data && gql.data.video;
if (!v) {
  console.log("GQL failed:", JSON.stringify(gql).slice(0, 400));
  process.exit(1);
}
const start = new Date(v.createdAt);
const end = new Date(start.getTime() + v.lengthSeconds * 1000);
const now = new Date();
const min = (ms) => Math.round(ms / 60000);
console.log("title        :", v.title);
console.log("owner        :", v.owner && v.owner.login);
console.log("createdAt    :", v.createdAt);
console.log("length       :", v.lengthSeconds, "s =", (v.lengthSeconds / 3600).toFixed(2), "h");
console.log("stream end   :", end.toISOString());
console.log("now          :", now.toISOString());
console.log("age since end:", min(now - end), "min =", (min(now - end) / 60).toFixed(2), "h");
console.log("age since st :", (min(now - start) / 60).toFixed(2), "h");
console.log("status/btype :", v.status, "/", v.broadcastType);

const nodes = ((v.muteInfo || {}).mutedSegmentConnection || {}).nodes || [];
const total = nodes.reduce((a, n) => a + (Number(n.duration) || 0), 0);
console.log("mute map     :", nodes.length, "segments,", total, "s =", Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0"));
console.log(
  "first offsets:",
  nodes
    .slice(0, 6)
    .map((n) => `${n.offset}+${n.duration}`)
    .join("  ")
);

async function status(p) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`${BASE}/${p}`, { headers: H, signal: ctrl.signal });
    if (r.body) await r.body.cancel().catch(() => {});
    return r.status;
  } catch (e) {
    return "err";
  } finally {
    clearTimeout(t);
  }
}

/* control: an unmuted index must answer 200 on the plain name */
let control = null;
for (let i = 0; i <= 30 && control === null; i++) {
  if (nodes.some((n) => i * 2 >= n.offset - 2 && i * 2 < n.offset + n.duration - 2)) continue;
  const s = await status(`720p60/${i}.ts`);
  if (s === 200) control = i;
}
console.log("control idx  :", control, "(plain 200)");

/* muted indices: scan around each range's computed index (drift makes the exact index unknown) */
const muted = [];
let probes = 0;
for (const n of nodes) {
  if (muted.length >= 3) break;
  const center = Math.floor(n.offset / 2);
  let found = null;
  outer: for (let d = 0; d <= 40; d++) {
    const cands = d === 0 ? [center] : [center - d, center + d];
    for (const i of cands) {
      if (probes++ > 600) break outer;
      const s = await status(`720p60/${i}-muted.ts`);
      if (s === 200) {
        found = i;
        break outer;
      }
    }
  }
  if (found !== null) muted.push({ offset: n.offset, duration: n.duration, index: found });
}
console.log("muted hits   :", JSON.stringify(muted), `(${probes} probes)`);

const QUAL = ["1080p60", "720p60", "720p30", "480p30", "360p30", "160p30", "audio_only"];
console.log("\nquality      plain/muted, muted idx " + muted.map((m) => m.index).join(",") + " | control " + control);
for (const q of QUAL) {
  const cells = [];
  for (const m of muted) {
    const p = await status(`${q}/${m.index}.ts`);
    const mu = await status(`${q}/${m.index}-muted.ts`);
    cells.push(`${p}/${mu}`);
  }
  const c = control !== null ? await status(`${q}/${control}.ts`) : "-";
  console.log(q.padEnd(12), cells.join("   "), "| control", c);
}

/* does any content exist under a query string the player may attach? */
if (muted.length) {
  const m = muted[0].index;
  const q1 = await status(`720p60/${m}.ts?x=1`);
  const q2 = await status(`720p60/${m}-muted.ts?x=1`);
  console.log(`query-string : plain ${q1} / muted ${q2}`);
}
