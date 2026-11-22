import fs from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));

const declared = new Set();
for (const cs of manifest.content_scripts || []) {
  for (const f of [...(cs.js || []), ...(cs.css || [])]) declared.add(f);
}
if (manifest.background && manifest.background.service_worker) declared.add(manifest.background.service_worker);
const missing = [...declared].filter((f) => !fs.existsSync(path.join(src, f)));
if (missing.length) {
  console.error("manifest references missing files:", missing.join(", "));
  process.exit(1);
}

const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `twitch-vod-unmute-v${manifest.version}.zip`);

await new Promise((resolve, reject) => {
  const output = fs.createWriteStream(out);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  output.on("close", resolve);
  archive.on("error", reject);
  archive.pipe(output);
  archive.directory(src, false);
  archive.finalize();
});

console.log(`packaged ${path.relative(root, out)} (${manifest.version})`);
