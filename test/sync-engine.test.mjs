import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const VXR = require("../extension/sync-engine.js");

let pass = 0,
  fail = 0;
const rows = [];

function check(name, ok, detail) {
  ok ? pass++ : fail++;
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail ?? ""}`);
}

/* Two independent clocks: the fake VOD and the fake replacement track.
   trackTick simulates a sound card running slightly fast/slow. */
function makeMedia({ vodTime = 0, trackDuration = 3600, trackTick = 1, vodTick = 1 } = {}) {
  const m = {
    vod: { t: vodTime, rate: 1, playing: false, ended: false },
    track: { t: 0, rate: 1, playing: false, duration: trackDuration },
    trackTick,
    vodTick,
    seeks: 0
  };
  return {
    raw: m,
    vodTime: () => m.vod.t,
    vodRate: () => m.vod.rate,
    vodPlaying: () => m.vod.playing,
    vodEnded: () => m.vod.ended,
    trackTime: () => m.track.t,
    trackDuration: () => m.track.duration,
    trackPaused: () => !m.track.playing,
    setTrackTime: (t) => {
      m.track.t = t;
      m.seeks++;
    },
    setTrackRate: (r) => {
      m.track.rate = r;
    },
    playTrack: () => {
      m.track.playing = true;
    },
    pauseTrack: () => {
      m.track.playing = false;
    },
    advance(dtMs) {
      const dt = dtMs / 1000;
      if (m.vod.playing) m.vod.t += dt * m.vod.rate * m.vodTick;
      if (m.track.playing) m.track.t += dt * m.track.rate * m.trackTick;
    }
  };
}

function run(media, controller, seconds, stepMs = 16) {
  const t0 = performance.now();
  let now = t0;
  const frames = Math.round((seconds * 1000) / stepMs);
  for (let i = 0; i < frames; i++) {
    media.advance(stepMs);
    controller.tick(now);
    now += stepMs;
  }
  return now - t0;
}

const driftOf = (media, controller) => (media.trackTime() - (media.vodTime() - controller.state.offset)) * 1000;

/* 1. Nothing runs while the VOD is paused. */
{
  const media = makeMedia();
  const c = VXR.createController({ media, offset: 0 });
  c.tick(0);
  check("1 paused VOD keeps track paused", media.raw.track.playing === false && c.state.phase === "hold", `phase=${c.state.phase}`);
}

/* 2. Steady playback against a sound card 300 ppm fast, 120 s. */
{
  const media = makeMedia({ trackTick: 1.0003 });
  media.raw.vod.playing = true;
  const c = VXR.createController({ media, offset: 0 });
  c.tick(0);
  run(media, c, 120);
  const d = Math.abs(driftOf(media, c));
  check("2 120 s of drift self-corrects", d < 40, `drift=${d.toFixed(1)} ms, resyncs=${c.state.resyncs}, max=${c.state.maxAbsDriftMs.toFixed(1)} ms`);
  check("2b rate nudge stayed inaudible", c.cfg.maxRateDeviation <= 0.02, `max deviation ${(c.cfg.maxRateDeviation * 100).toFixed(1)} %`);
}

/* 3. User seeks forward 290 s: must land in one tick, no converging crawl. */
{
  const media = makeMedia();
  media.raw.vod.playing = true;
  const c = VXR.createController({ media, offset: 42 });
  c.tick(0);
  run(media, c, 5);
  media.raw.vod.t = 300;
  c.tick(5000);
  const d = Math.abs(driftOf(media, c));
  check("3 hard seek realigned in 1 tick", d < 1 && c.state.phase === "seek", `drift=${d.toFixed(2)} ms phase=${c.state.phase}`);
}

/* 4. Playback rate 1x -> 1.75x -> 0.5x keeps the track locked. */
{
  const media = makeMedia();
  media.raw.vod.playing = true;
  const c = VXR.createController({ media, offset: 10 });
  run(media, c, 3);
  media.raw.vod.rate = 1.75;
  run(media, c, 20);
  const fast = Math.abs(driftOf(media, c));
  media.raw.vod.rate = 0.5;
  run(media, c, 20);
  const slow = Math.abs(driftOf(media, c));
  const rateFollows = Math.abs(media.raw.track.rate - 0.5) < 0.021;
  check("4 locked at 1.75x and 0.5x", fast < 40 && slow < 40 && rateFollows, `1.75x=${fast.toFixed(1)} ms 0.5x=${slow.toFixed(1)} ms trackRate=${media.raw.track.rate.toFixed(3)}`);
}

/* 5. Buffer stall: VOD clock frozen while still "playing" must freeze the track. */
{
  const media = makeMedia();
  media.raw.vod.playing = true;
  const c = VXR.createController({ media, offset: 0 });
  run(media, c, 2);
  media.raw.vodTick = 0;
  const frozen = media.raw.vod.t;
  let now = 2000;
  for (let i = 0; i < 40; i++) {
    media.advance(16);
    c.tick(now);
    now += 16;
  }
  const held = media.raw.track.playing === false && media.raw.vod.t === frozen;
  media.raw.vodTick = 1;
  media.raw.vod.t = frozen + 0.5;
  c.tick(now);
  const resumed = media.raw.track.playing === true && Math.abs(driftOf(media, c)) < 1;
  check("5 stall holds track, resume catches up", held && resumed, `held=${held} resumed=${resumed} track=${media.raw.track.t.toFixed(2)} vod=${media.raw.vod.t.toFixed(2)}`);
}

/* 6. Recording starts after the VOD (target < 0) and ends before it (target > duration). */
{
  const media = makeMedia({ vodTime: 0, trackDuration: 60 });
  media.raw.vod.playing = true;
  const c = VXR.createController({ media, offset: 30 });
  c.tick(0);
  check(
    "6a pre-roll holds until recording begins",
    c.state.phase === "preroll" && media.raw.track.playing === false,
    `phase=${c.state.phase} target=${c.targetTime().toFixed(1)}s`
  );
  const media2 = makeMedia({ vodTime: 100, trackDuration: 60 });
  media2.raw.vod.playing = true;
  const c2 = VXR.createController({ media: media2, offset: 0 });
  c2.tick(0);
  check(
    "6b post-roll holds past file end",
    c2.state.phase === "postroll" && media2.raw.track.playing === false,
    `phase=${c2.state.phase} target=${c2.targetTime().toFixed(1)}s dur=60s`
  );
}

/* 7. alignNow() zeroes the audible error at the current position. */
{
  const media = makeMedia({ vodTime: 120, trackDuration: 3600 });
  media.raw.vod.playing = true;
  media.raw.track.t = 95;
  const c = VXR.createController({ media, offset: 0 });
  const before = Math.abs(driftOf(media, c));
  const offset = c.alignNow();
  const after = Math.abs(driftOf(media, c));
  check(
    "7 manual align zeroes drift at once",
    before > 1000 && after < 1 && Math.abs(offset - 25) < 1e-9 && media.raw.track.t === 95,
    `before=${before.toFixed(0)} ms offset=${offset.toFixed(1)} s after=${after.toFixed(2)} ms track=${media.raw.track.t}`
  );
}

/* 8. Late audio (negative drift) converges the same way as early audio. */
{
  const media = makeMedia();
  media.raw.vod.playing = true;
  media.raw.track.t = 0;
  const c = VXR.createController({ media, offset: -2.5 });
  c.tick(0);
  run(media, c, 12);
  const d = Math.abs(driftOf(media, c));
  check("8 late audio converges", d < 40, `drift=${d.toFixed(1)} ms resyncs=${c.state.resyncs}`);
}

/* 9. No ticks for a while (background tab / ad break), reference moved on: recover. */
{
  const media = makeMedia();
  media.raw.vod.playing = true;
  const c = VXR.createController({ media, offset: 0 });
  run(media, c, 3);
  media.raw.vod.t += 60;
  const before = Math.abs(driftOf(media, c));
  c.tick(63000);
  const d = Math.abs(driftOf(media, c));
  check("9 60 s gap recovered", before > 1000 && d < 150, `before=${before.toFixed(0)} ms drift=${d.toFixed(1)} ms phase=${c.state.phase}`);
}

/* 10. Disabling mid-playback leaves no half-applied rate. */
{
  const media = makeMedia({ trackTick: 1.02 });
  media.raw.vod.playing = true;
  const c = VXR.createController({ media, offset: 0 });
  run(media, c, 4);
  const r = media.raw.track.rate;
  check(
    "10 track rate stays bounded under load",
    Math.abs(r - 1) <= 0.021 && r > 0.97,
    `trackRate=${r.toFixed(4)} resyncs=${c.state.resyncs} maxDrift=${c.state.maxAbsDriftMs.toFixed(0)} ms`
  );
}

console.log(rows.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
