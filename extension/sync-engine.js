/* Sync core: keeps a replacement audio clock locked to a reference video clock.
   Pure logic + injected media adapter so it can be driven by a fake clock in tests. */
(function (root, factory) {
  var api = factory();
  root.VXR = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  var DEFAULTS = {
    // ITU-R BT.1359-1: audio is detectable ~45 ms early / ~125 ms late. Keep |drift| inside that.
    hardSeekTolerance: 0.15,
    softDeadband: 0.005,
    maxRateDeviation: 0.02,
    rateCorrectionGain: 0.35,
    seekJump: 0.6,
    stallAfter: 0.2,
    endPad: 0.1,
    duckSeconds: 0.02
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function createController(options) {
    var media = options.media;
    if (!media) throw new Error("media adapter is required");
    var cfg = Object.assign({}, DEFAULTS, options.config || {});
    var st = {
      offset: options.offset || 0,
      lastVodTime: NaN,
      lastTickMs: NaN,
      stallMs: 0,
      phase: "idle",
      action: "none",
      driftMs: 0,
      target: 0,
      rate: 1,
      counts: { hold: 0, preroll: 0, postroll: 0, stall: 0, seek: 0, resync: 0, drift: 0, locked: 0 },
      maxAbsDriftMs: 0,
      resyncs: 0
    };

    function targetTime() {
      return media.vodTime() - st.offset;
    }

    function setPhase(phase, action) {
      st.phase = phase;
      st.action = action;
      st.counts[phase] = (st.counts[phase] || 0) + 1;
    }

    function hold(action) {
      if (!media.trackPaused()) media.pauseTrack();
      media.setTrackRate(media.vodRate());
      setPhase(action, action);
    }

    function tick(nowMs) {
      var dt = isFinite(st.lastTickMs) ? Math.max(0, (nowMs - st.lastTickMs) / 1000) : 0;
      st.lastTickMs = nowMs;

      var vodTime = media.vodTime();
      var vodRate = media.vodRate() || 1;
      st.rate = vodRate;

      if (!media.vodPlaying() || media.vodEnded()) {
        st.lastVodTime = vodTime;
        st.stallMs = 0;
        st.driftMs = 0;
        hold("hold");
        return st;
      }

      var target = vodTime - st.offset;
      var dur = media.trackDuration();

      if (!(target >= 0)) {
        st.lastVodTime = vodTime;
        hold("preroll");
        return st;
      }
      if (dur > 0 && target > dur - cfg.endPad) {
        st.lastVodTime = vodTime;
        hold("postroll");
        return st;
      }

      var advanced = isFinite(st.lastVodTime) && Math.abs(vodTime - st.lastVodTime) > 1e-4;
      if (isFinite(st.lastVodTime) && !advanced) st.stallMs += dt * 1000;
      else st.stallMs = 0;

      if (st.stallMs > cfg.stallAfter * 1000) {
        if (!media.trackPaused()) {
          media.pauseTrack();
          setPhase("stall", "stall");
        } else {
          st.phase = "stall";
        }
        st.lastVodTime = vodTime;
        return st;
      }

      // Reference resumed (or we were held at a new position): land exactly on it.
      if (media.trackPaused()) {
        media.setTrackTime(target);
        media.playTrack();
        media.setTrackRate(vodRate);
        st.lastVodTime = vodTime;
        st.driftMs = 0;
        setPhase("seek", "catch-up");
        st.resyncs++;
        return st;
      }

      var jump = isFinite(st.lastVodTime) && Math.abs(vodTime - st.lastVodTime) > cfg.seekJump;
      var drift = media.trackTime() - target;
      st.driftMs = drift * 1000;
      if (Math.abs(st.driftMs) > st.maxAbsDriftMs) st.maxAbsDriftMs = Math.abs(st.driftMs);

      if (jump || Math.abs(drift) > cfg.hardSeekTolerance) {
        media.setTrackTime(target);
        media.setTrackRate(vodRate);
        st.resyncs++;
        setPhase(jump ? "seek" : "resync", jump ? "seek" : "resync");
      } else if (Math.abs(drift) > cfg.softDeadband) {
        var corrected = clamp(vodRate * (1 - drift * cfg.rateCorrectionGain), vodRate * (1 - cfg.maxRateDeviation), vodRate * (1 + cfg.maxRateDeviation));
        media.setTrackRate(corrected);
        setPhase("drift", "rate-nudge");
      } else {
        media.setTrackRate(vodRate);
        setPhase("locked", "hold-rate");
      }

      st.lastVodTime = vodTime;
      st.target = target;
      return st;
    }

    return {
      cfg: cfg,
      state: st,
      tick: tick,
      targetTime: targetTime,
      /* offset = reference time that the recording's own 00:00 corresponds to. */
      setOffset: function (seconds) {
        st.offset = seconds;
        st.stallMs = 0;
      },
      shiftOffset: function (seconds) {
        st.offset += seconds;
      },
      /* Declare "whatever the recording is playing right now matches the picture right now".
         The mapping moves, the track must not. */
      alignNow: function () {
        st.offset = media.vodTime() - media.trackTime();
        media.setTrackRate(media.vodRate());
        st.lastVodTime = media.vodTime();
        st.lastTickMs = NaN;
        st.stallMs = 0;
        st.driftMs = 0;
        setPhase("seek", "manual-align");
        return st.offset;
      },
      resetClocks: function () {
        st.lastVodTime = NaN;
        st.lastTickMs = NaN;
        st.stallMs = 0;
      }
    };
  }

  return { createController: createController, DEFAULTS: DEFAULTS, clamp: clamp };
});
