(function () {
  "use strict";

  var REQ = "VXR_REQ";
  var RES = "VXR_RES";
  var POLL_MS = 1000;

  var vod = null;
  var audio = null;
  var fileInput = null;
  var ctx = null;
  var gainNode = null;
  var analyser = null;
  var levelBuf = null;
  var ctrl = null;
  var blobUrl = null;
  var savedAudio = null;
  var pageMuted = false;
  var dlBusy = false;
  var dlNote = "";
  var dlPercent = 0;
  var running = false;
  var rafId = 0;
  var lastRender = 0;
  var levelPeak = 0;
  var seq = 0;
  var pending = new Map();

  var S = {
    vodId: null,
    offset: 0,
    gain: 0.5,
    playerGain: 0.5,
    gate: 1,
    mode: "muted",
    fileName: "",
    trackDuration: 0,
    segments: null,
    lengthSeconds: 0,
    mapError: "",
    cdn: "unknown",
    note: ""
  };

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function fmt(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "--:--";
    var s = Math.round(seconds);
    var hrs = Math.floor(s / 3600);
    var mins = Math.floor((s % 3600) / 60);
    var secs = s % 60;
    var pad = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    return (hrs ? hrs + ":" : "") + pad(mins) + ":" + pad(secs);
  }

  function rpc(type, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = "r" + ++seq;
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error("browser did not respond"));
      }, timeoutMs || 8000);
      pending.set(id, function (msg) {
        clearTimeout(timer);
        pending.delete(id);
        resolve(msg);
      });
      document.dispatchEvent(new CustomEvent(REQ, { detail: JSON.stringify({ id: id, type: type, payload: payload || {} }) }));
    });
  }

  document.addEventListener(RES, function (e) {
    var msg;
    try {
      msg = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    var cb = msg && pending.get(msg.id);
    if (cb) cb(msg);
  });

  /* ---------- storage ---------- */

  function loadPrefs() {
    return new Promise(function (resolve) {
      if (!chrome.storage || !chrome.storage.local) return resolve({});
      chrome.storage.local.get("vxr", function (data) {
        resolve((data && data.vxr) || {});
      });
    });
  }

  function savePrefs() {
    if (!chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get("vxr", function (data) {
      var prev = (data && data.vxr) || {};
      var offsets = prev.offsets || {};
      if (S.vodId) offsets[S.vodId] = S.offset;
      chrome.storage.local.set({ vxr: { offsets: offsets, fileName: S.fileName, mode: S.mode } });
    });
  }

  /* ---------- elements ---------- */

  function pickVideo() {
    var all = Array.prototype.slice.call(document.querySelectorAll("video"));
    all = all.filter(function (v) {
      var r = v.getBoundingClientRect();
      return r.width > 100 && r.height > 60;
    });
    if (!all.length) return document.querySelector("video");
    all.sort(function (a, b) {
      var ar = a.getBoundingClientRect();
      var br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    });
    return all[0];
  }

  function ensureAudio() {
    if (audio) return audio;
    audio = h("audio", "vxr-track");
    audio.preload = "auto";
    audio.volume = 1;
    audio.setAttribute("aria-hidden", "true");
    audio.addEventListener("error", function () {
      S.note = "the browser cannot read the file";
      render(true);
    });
    audio.addEventListener("loadedmetadata", function () {
      S.trackDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (running) ctrl.resetClocks();
      render(true);
    });
    document.documentElement.appendChild(audio);
    return audio;
  }

  function ensureFileInput() {
    if (fileInput) return fileInput;
    fileInput = h("input", "vxr-file");
    fileInput.type = "file";
    fileInput.accept = "audio/*,video/*,.m4a,.mp3,.opus,.ogg,.wav,.flac,.aac";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(file);
      S.fileName = file.name;
      S.trackDuration = 0;
      S.note = "";
      ensureAudio().src = blobUrl;
      ensureAudio().load();
      savePrefs();
      setActive(true);
      render(true);
      fileInput.value = "";
    });
    document.documentElement.appendChild(fileInput);
    return fileInput;
  }

  /* ---------- graph ---------- */

  function openGraph() {
    if (ctx) return true;
    var AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return false;
    ctx = new AudioCtor();
    gainNode = ctx.createGain();
    gainNode.gain.value = 0;
    ctx.createMediaElementSource(ensureAudio()).connect(gainNode);
    gainNode.connect(ctx.destination);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    gainNode.connect(analyser);
    levelBuf = new Float32Array(analyser.fftSize);
    return true;
  }

  function level() {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(levelBuf);
    var sum = 0;
    for (var i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
    return Math.sqrt(sum / levelBuf.length);
  }

  function rampGain(value, seconds) {
    if (!ctx || !gainNode) {
      if (audio) audio.volume = value;
      return;
    }
    var now = ctx.currentTime;
    var current = gainNode.gain.value;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(current, now);
    gainNode.gain.linearRampToValueAtTime(value, now + Math.max(0.005, seconds || 0.02));
  }

  /* The page-world shim keeps video.volume/muted at the user's values while the
     element itself is silent; every change is announced as VXR_VOLUME. */
  function volumeSlider() {
    return document.querySelector('input[type="range"].tw-range');
  }

  function sliderGain() {
    var slider = volumeSlider();
    var v = slider ? Number(slider.value) : NaN;
    return isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
  }

  function refreshGain(seconds) {
    var desired = Math.max(0, Math.min(1, S.playerGain * S.gate));
    if (Math.abs(desired - S.gain) < 0.001) return;
    S.gain = desired;
    if (running) rampGain(S.gain, seconds || 0.02);
  }

  function applyPageVolume(vol, muted) {
    pageMuted = !!muted;
    var g = pageMuted ? 0 : Math.max(0, Math.min(1, Number(vol)));
    if (!isFinite(g)) return;
    S.playerGain = g;
    refreshGain(0.02);
  }

  function fmtMB(bytes) {
    var mb = (Number(bytes) || 0) / 1048576;
    return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + " MB";
  }

  function fmtSpeed(bytesPerSec) {
    var bps = Number(bytesPerSec) || 0;
    if (bps >= 1048576) return (bps / 1048576).toFixed(1) + " MB/s";
    return Math.max(1, Math.round(bps / 1024)) + " KB/s";
  }

  function fmtEta(sec) {
    var s = Math.max(0, Math.round(sec));
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  document.addEventListener("VXR_DL", function (e) {
    var st;
    try {
      st = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    if (!st) return;
    if (st.phase === "done") {
      dlBusy = false;
      dlPercent = 0;
      dlNote = "audio saved: " + fmtMB(st.bytes) + (st.note ? " · " + st.note : "");
    } else if (st.phase === "error") {
      dlBusy = false;
      dlPercent = 0;
      dlNote = "error: " + (st.note || "unknown");
    } else if (st.phase === "cancel") {
      dlBusy = false;
      dlPercent = 0;
      dlNote = "download cancelled";
    } else if (st.phase === "prepare") {
      dlBusy = true;
      dlPercent = 0;
      dlNote = st.note || "preparing…";
    } else if (st.phase === "run") {
      dlBusy = true;
      var totalSegs = Number(st.total) || 0;
      var doneSegs = Number(st.done) || 0;
      dlPercent = totalSegs ? Math.min(100, Math.round((doneSegs / totalSegs) * 100)) : 0;
      var line = "downloading: " + doneSegs + "/" + (totalSegs || "?") + " · " + fmtMB(st.bytes);
      if (st.totalBytes) line += " / ~" + fmtMB(st.totalBytes) + " · " + dlPercent + "%";
      if (st.speed) line += " · " + fmtSpeed(st.speed);
      if (st.eta) line += " · ~" + fmtEta(st.eta) + " left";
      if (st.unmuted && st.unmuted.total) line += " · unmuted " + st.unmuted.done + "/" + st.unmuted.total;
      if (st.note && st.note !== "downloading") line += " · " + st.note;
      dlNote = line;
    }
    render(true);
  });

  document.addEventListener("VXR_VOLUME", function (e) {
    var st;
    try {
      st = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    if (!st) return;
    applyPageVolume(st.volume, st.muted);
  });

  function ensureVolumeHook() {
    var slider = volumeSlider();
    if (!slider || slider.__vxrHooked) return;
    slider.__vxrHooked = true;
    var apply = function () {
      var v = Number(slider.value);
      if (!isFinite(v)) return;
      applyPageVolume(v, pageMuted && v <= 0 ? true : false);
    };
    slider.addEventListener("input", apply);
    slider.addEventListener("change", apply);
  }

  /* ---------- active state ---------- */

  function adapter() {
    return {
      vodTime: function () {
        return vod ? vod.currentTime : 0;
      },
      vodRate: function () {
        return vod ? vod.playbackRate || 1 : 1;
      },
      vodPlaying: function () {
        return !!vod && !vod.paused && !vod.ended;
      },
      vodEnded: function () {
        return !!vod && vod.ended;
      },
      trackTime: function () {
        return audio ? audio.currentTime : 0;
      },
      trackDuration: function () {
        return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      },
      trackPaused: function () {
        return !audio || audio.paused;
      },
      setTrackTime: function (t) {
        try {
          audio.currentTime = t;
        } catch (e) {}
      },
      setTrackRate: function (r) {
        if (audio && Math.abs(audio.playbackRate - r) > 1e-4) audio.playbackRate = r;
      },
      playTrack: function () {
        var p = audio.play();
        if (p && p.catch) p.catch(function () {});
      },
      pauseTrack: function () {
        if (audio) audio.pause();
      }
    };
  }

  function silenceTwitch() {
    if (!vod) return;
    if (!vod.hasAttribute("data-vxr-silent")) document.dispatchEvent(new CustomEvent("VXR_SILENCE"));
    /* page-world shim missing: fall back to a plain mute (player UI will show it) */
    if (!vod.muted && !document.documentElement.hasAttribute("data-vxr-shim")) vod.muted = true;
  }

  function restoreTwitch() {
    document.dispatchEvent(new CustomEvent("VXR_UNSILENCE"));
    if (vod && savedAudio && !document.documentElement.hasAttribute("data-vxr-shim")) vod.muted = savedAudio.muted;
  }

  var passing = false;

  function inMutedRange(t) {
    var segs = S.segments;
    if (!segs) return false;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (t >= s.start && t < s.start + s.duration) return true;
    }
    return false;
  }

  /* "muted" mode: the stem is audible only inside Twitch's muted ranges, the original
     plays everywhere else. "full" mode: the stem replaces the whole track. */
  function updateGate(force) {
    if (!running || !vod) return;
    var haveMap = Array.isArray(S.segments);
    var inside = S.mode === "full" || !haveMap ? true : inMutedRange(vod.currentTime);
    if (inside) {
      passing = false;
      silenceTwitch();
    } else if (!passing) {
      passing = true;
      document.dispatchEvent(new CustomEvent("VXR_UNSILENCE"));
      if (!document.documentElement.hasAttribute("data-vxr-shim") && savedAudio) vod.muted = savedAudio.muted;
    }
    var gate = inside ? 1 : 0;
    if (gate !== S.gate || force) {
      S.gate = gate;
      refreshGain(0.03);
    }
  }

  function setMode(mode) {
    if (mode !== "muted" && mode !== "full") return;
    S.mode = mode;
    savePrefs();
    updateGate(true);
    render(true);
  }

  function setActive(on) {
    if (on) {
      if (!blobUrl) {
        S.note = "pick a file first";
        return false;
      }
      if (!openGraph()) {
        S.note = "Web Audio unavailable";
        return false;
      }
      if (ctx.state === "suspended") {
        ctx.resume().then(function () {
          if (ctx.state === "running") {
            S.note = "";
            render(true);
          }
        });
      }
      vod = vod || pickVideo();
      if (!vod) {
        S.note = "player not found";
        return false;
      }
      var preVol = sliderGain();
      if (preVol == null || preVol <= 0) {
        var realVol = Number(vod.volume);
        preVol = isFinite(realVol) && realVol > 0 ? realVol : vod.muted ? 0 : 1;
      }
      pageMuted = !!vod.muted;
      S.playerGain = Math.min(1, pageMuted ? 0 : preVol);
      S.gate = 1;
      S.gain = 0;
      passing = false;
      savedAudio = { muted: vod.muted };
      ctrl = VXR.createController({ media: adapter(), offset: S.offset });
      running = true;
      updateGate(true);
      rampGain(S.gain, 0.03);
      loop();
      S.note = ctx.state === "suspended" ? "click again (the browser needs a gesture)" : "";
      return true;
    }
    running = false;
    cancelAnimationFrame(rafId);
    if (ctrl) ctrl.state.phase = "idle";
    rampGain(0, 0.02);
    setTimeout(function () {
      if (!running && audio) audio.pause();
    }, 30);
    if (vod && savedAudio) restoreTwitch();
    savedAudio = null;
    passing = false;
    S.gate = 1;
    return false;
  }

  function loop() {
    if (!running) return;
    updateGate();
    ctrl.tick(performance.now());
    levelPeak = Math.max(levelPeak, level());
    var t = performance.now();
    if (t - lastRender > 250) {
      lastRender = t;
      render(false);
    }
    rafId = requestAnimationFrame(loop);
  }

  /* ---------- mute map ---------- */

  function refreshMuteMap() {
    if (!S.vodId) return;
    rpc("muteInfo", { vodId: S.vodId }).then(
      function (msg) {
        if (!msg || !msg.ok) {
          S.segments = null;
          S.mapError = (msg && msg.error) || "no GQL response";
        } else {
          S.segments = msg.segments || [];
          S.lengthSeconds = msg.lengthSeconds || 0;
          S.mapError = S.segments.length ? "" : "no muted ranges";
        }
        render(true);
      },
      function (err) {
        S.mapError = String(err && err.message ? err.message : err);
        render(true);
      }
    );
  }

  function jumpSegment(dir) {
    if (!vod || !S.segments || !S.segments.length) return;
    var now = vod.currentTime;
    var target = null;
    if (dir > 0) {
      for (var i = 0; i < S.segments.length; i++) {
        if (S.segments[i].start > now + 0.5) {
          target = S.segments[i].start;
          break;
        }
      }
      target = target == null ? S.segments[0].start : target;
    } else {
      for (var j = S.segments.length - 1; j >= 0; j--) {
        if (S.segments[j].start < now - 2) {
          target = S.segments[j].start;
          break;
        }
      }
    }
    if (target == null) return;
    vod.currentTime = Math.max(0, target - 1.5);
    if (ctrl) ctrl.resetClocks();
  }

  /* ---------- CDN probe ---------- */

  function storageSet(value) {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (res) {
        if (settled) return;
        settled = true;
        resolve(res || { ok: true });
      };
      var guard = setTimeout(function () {
        finish({ ok: true, late: true });
      }, 1500);
      if (!chrome.storage || !chrome.storage.local) {
        clearTimeout(guard);
        return finish({ ok: false, error: "storage unavailable" });
      }
      try {
        chrome.storage.local.set({ vxrRules: value }, function () {
          clearTimeout(guard);
          finish({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
        });
        try {
          chrome.runtime.sendMessage({ op: "cdnSync" }, function () {
            void chrome.runtime.lastError;
          });
        } catch (e) {}
      } catch (e) {
        clearTimeout(guard);
        finish({ ok: false, error: String(e) });
      }
    });
  }

  function cdnInstall(rules) {
    try {
      chrome.runtime.sendMessage({ op: "cdnInstall", rules: rules }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
    return storageSet(rules);
  }

  function cdnClear() {
    return storageSet(null);
  }

  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  function mapPool(items, limit, fn) {
    var i = 0;
    function worker() {
      if (i >= items.length) return Promise.resolve();
      var item = items[i++];
      return Promise.resolve(fn(item)).then(worker);
    }
    var workers = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
    return Promise.all(workers);
  }

  var MUTED_RE = /-muted\.[^/?#]+(?:[?#]|$)/;

  function parseMuted(text, base) {
    var seen = {};
    var out = [];
    text.split(/\r?\n/).forEach(function (line) {
      line = line.replace(/^\s+|\s+$/g, "");
      if (!line || line.charAt(0) === "#") return;
      var abs;
      try {
        abs = new URL(line, base).href;
      } catch (e) {
        return;
      }
      if (!MUTED_RE.test(abs) || seen[abs]) return;
      seen[abs] = 1;
      out.push(abs);
    });
    return out;
  }

  function plainOf(url) {
    return url.replace(/-muted(\.[^/?#]+)/, "$1");
  }

  function probeStatus(url) {
    return rpc("probe", { url: url }, 12000).then(function (msg) {
      return (msg && msg.status) || 0;
    });
  }

  function probeFull(url) {
    return rpc("probe", { url: url }, 12000).then(function (msg) {
      return { status: (msg && msg.status) || 0, finalUrl: (msg && msg.finalUrl) || url };
    });
  }

  function exists(status) {
    return status === 200 || status === 206;
  }

  function searchCdn() {
    S.cdn = "checking";
    S.note = "searching CDN for originals…";
    render(true);
    var fail = function (err) {
      S.cdn = "error";
      S.note = "check failed: " + String((err && err.message) || err);
      render(true);
    };
    var checked = 0;
    var qualitiesSeen = 0;

    Promise.resolve()
      .then(function () {
        if (S.segments) return { ok: true, segments: S.segments };
        return rpc("muteInfo", { vodId: S.vodId });
      })
      .then(function (map) {
        if (!map || !map.ok) throw new Error((map && map.error) || "mute map unavailable");
        var muted = (map.segments || []).filter(function (s) {
          return s.duration > 0;
        });
        if (!muted.length) {
          S.cdn = "clean";
          S.note = "this VOD has no muted ranges — CDN is not needed";
          render(true);
          return null;
        }
        S.note = "searching CDN: signed playlist…";
        render(true);
        return rpc("cdnPlaylists", { vodId: S.vodId }, 20000).then(function (p) {
          if (!p || !p.ok) throw new Error((p && p.error) || "CDN playlists not received");
          return { playlists: p.playlists || [] };
        });
      })
      .then(function (ctx) {
        if (!ctx) return;
        if (!ctx.playlists.length) throw new Error("no variants in the master playlist");
        var order = ctx.playlists.slice().sort(function (a, b) {
          return (a.folder === "chunked" ? 0 : 1) - (b.folder === "chunked" ? 0 : 1);
        });
        var pi = 0;
        function tryPlaylist() {
          if (pi >= order.length) {
            S.cdn = "gone";
            S.note = "audio not found: no unmuted copies on the CDN (checked " + checked + " segments in " + qualitiesSeen + " qualities). use a local file";
            render(true);
            return;
          }
          var pl = order[pi++];
          var name = pl.label || pl.folder || "?";
          qualitiesSeen++;
          S.note = "searching originals: " + name + ", reading playlist…";
          render(true);
          return rpc("fetchText", { url: pl.url }, 20000).then(function (res) {
            if (!res || !res.ok) return tryPlaylist();
            var mutedUrls = parseMuted(res.text || "", pl.url);
            if (!mutedUrls.length) return tryPlaylist();
            S.note = "checking originals: " + name + " 0/" + mutedUrls.length + "…";
            render(true);
            var verified = [];
            var done = 0;
            return mapPool(mutedUrls, 6, function (u) {
              return probeStatus(plainOf(u)).then(function (st) {
                done++;
                checked++;
                if (exists(st)) verified.push({ muted: u, plain: plainOf(u) });
                if (done % 40 === 0 && !verified.length) {
                  S.note = "checking originals: " + name + " " + done + "/" + mutedUrls.length + "…";
                  render(true);
                }
              });
            }).then(function () {
              if (!verified.length) return tryPlaylist();
              var installed = verified.slice(0, 2000);
              var rules = installed.map(function (v) {
                return { url: v.muted, redirect: v.plain };
              });
              S.note = "originals found (" + verified.length + " of " + mutedUrls.length + "), installing rules…";
              render(true);
              return cdnInstall(rules).then(function (res) {
                var attempts = 0;
                function verify() {
                  return probeFull(installed[0].muted).then(function (probe) {
                    if (probe.finalUrl !== installed[0].muted) {
                      S.cdn = "on";
                      S.note =
                        "original found: " +
                        installed.length +
                        " of " +
                        mutedUrls.length +
                        " segments, quality " +
                        name +
                        (verified.length < mutedUrls.length ? " — some already deleted" : "") +
                        ". switch the player to this quality and seek: already loaded segments stay silent";
                      render(true);
                      return;
                    }
                    if (++attempts < 20) return sleep(1000).then(verify);
                    if (attempts === 20) {
                      attempts = 21;
                      return cdnInstall(rules)
                        .then(function () {
                          return sleep(1000);
                        })
                        .then(verify);
                    }
                    if (attempts < 30) return sleep(1000).then(verify);
                    S.cdn = "error";
                    S.note = res && res.ok ? "rule saved, but the redirect did not apply — try again" : "could not install the rule: " + (res && res.error);
                    render(true);
                  });
                }
                return verify();
              });
            });
          });
        }
        return tryPlaylist();
      })
      .catch(fail);
  }

  function clearCdn() {
    cdnClear().then(function () {
      S.cdn = "off";
      S.note = "redirect rule removed";
      render(true);
    });
  }

  /* ---------- UI ---------- */

  var el = {};

  function buildUI() {
    var root = document.querySelector("#player-root") || document.querySelector('[data-a-target="video-player"]') || document.body;
    if (document.getElementById("vxr-panel")) return;

    el.panel = h("div", "vxr-panel");
    el.panel.id = "vxr-panel";

    var head = h("div", "vxr-head");
    head.appendChild(h("span", "vxr-title", "VOD audio replacement"));
    el.collapse = h("button", "vxr-icon", "—");
    el.collapse.addEventListener("click", function () {
      el.panel.classList.add("vxr-hidden");
    });
    head.appendChild(el.collapse);
    el.panel.appendChild(head);

    el.status = h("div", "vxr-status", "ready");
    el.panel.appendChild(el.status);

    el.rowFile = h("div", "vxr-row");
    el.pick = h("button", "vxr-btn vxr-btn-primary vxr-pick", "Choose audio file");
    el.pick.addEventListener("click", function () {
      ensureFileInput().click();
    });
    el.fileName = h("span", "vxr-file-name", S.fileName || "no file selected");
    el.rowFile.appendChild(el.pick);
    el.rowFile.appendChild(el.fileName);
    el.panel.appendChild(el.rowFile);

    el.rowDl = h("div", "vxr-row");
    function beginDownload(unmuted) {
      if (dlBusy) {
        rpc("audioDownloadCancel", {}, 5000).catch(function () {});
        return;
      }
      if (!S.vodId) {
        dlNote = "open a VOD first";
        render(true);
        return;
      }
      dlBusy = true;
      dlPercent = 0;
      dlNote = "preparing…";
      render(true);
      rpc("audioDownloadStart", { vodId: S.vodId, unmuted: !!unmuted }, 15000).then(
        function (out) {
          if (!out || !out.ok) {
            dlBusy = false;
            dlNote = "error: " + ((out && out.error) || "no response");
            render(true);
          }
        },
        function (err) {
          dlBusy = false;
          dlNote = "error: " + ((err && err.message) || err);
          render(true);
        }
      );
    }
    el.dlBtn = h("button", "vxr-btn vxr-dl", "Download audio");
    el.dlBtn.addEventListener("click", function () {
      beginDownload(false);
    });
    el.dlUn = h("button", "vxr-btn vxr-dl-un", "Download unmuted");
    el.dlUn.title = "Splices in the 1080p60 originals that Twitch still has; downloads those video chunks, so coverage is partial";
    el.dlUn.addEventListener("click", function () {
      beginDownload(true);
    });
    el.dlNote = h("span", "vxr-file-name vxr-dl-note", "");
    el.dlBar = h("i", "vxr-dl-bar");
    el.dlBarFill = h("b", "", "");
    el.dlBar.appendChild(el.dlBarFill);
    var dlPair = h("div", "vxr-pair");
    dlPair.appendChild(el.dlBtn);
    dlPair.appendChild(el.dlUn);
    el.rowDl.appendChild(dlPair);
    el.rowDl.appendChild(el.dlNote);
    el.rowDl.appendChild(el.dlBar);
    el.panel.appendChild(el.rowDl);

    el.rowMain = h("div", "vxr-row");
    el.toggle = h("button", "vxr-btn vxr-btn-primary vxr-toggle vxr-wide", "Enable replacement");
    el.toggle.addEventListener("click", function () {
      setActive(!running);
      render(true);
    });
    el.cdnBtn = h("button", "vxr-btn vxr-cdn", "Search CDN for original");
    el.cdnBtn.addEventListener("click", searchCdn);
    el.cdnOff = h("button", "vxr-btn", "Remove CDN mode");
    el.cdnOff.addEventListener("click", clearCdn);
    var cdnPair = h("div", "vxr-pair");
    cdnPair.appendChild(el.cdnBtn);
    cdnPair.appendChild(el.cdnOff);
    el.rowMain.appendChild(el.toggle);
    el.rowMain.appendChild(cdnPair);
    el.panel.appendChild(el.rowMain);

    el.rowMode = h("div", "vxr-row");
    el.rowMode.appendChild(h("span", "vxr-label", "mode"));
    el.modeMuted = h("button", "vxr-btn vxr-mini vxr-mode-muted", "muted only");
    el.modeFull = h("button", "vxr-btn vxr-mini vxr-mode-full", "full track");
    el.modeMuted.addEventListener("click", function () {
      setMode("muted");
    });
    el.modeFull.addEventListener("click", function () {
      setMode("full");
    });
    var modePair = h("div", "vxr-pair");
    modePair.appendChild(el.modeMuted);
    modePair.appendChild(el.modeFull);
    el.rowMode.appendChild(modePair);
    el.panel.appendChild(el.rowMode);

    el.rowOffset = h("div", "vxr-row");
    el.rowOffset.appendChild(h("span", "vxr-label", "offset"));
    el.align = h("button", "vxr-btn vxr-mini", "Sync now");
    el.align.addEventListener("click", function () {
      if (!ctrl) setActive(true);
      if (ctrl) {
        S.offset = ctrl.alignNow();
        savePrefs();
      }
      render(true);
    });
    el.rowOffset.appendChild(el.align);
    el.offsetOut = h("span", "vxr-offset-out", "+0.00 c");
    el.rowOffset.appendChild(el.offsetOut);
    var steps = h("div", "vxr-steps");
    [
      [-1, "−1 s"],
      [-0.1, "−100 ms"],
      [-0.01, "−10 ms"],
      [0.01, "+10 ms"],
      [0.1, "+100 ms"],
      [1, "+1 s"]
    ].forEach(function (spec) {
      var b = h("button", "vxr-btn vxr-mini", spec[1]);
      b.addEventListener("click", function () {
        S.offset += spec[0];
        if (ctrl) ctrl.shiftOffset(spec[0]);
        savePrefs();
        render(true);
      });
      steps.appendChild(b);
    });
    el.rowOffset.appendChild(steps);
    el.panel.appendChild(el.rowOffset);

    el.rowVol = h("div", "vxr-row");
    el.rowVol.appendChild(h("span", "vxr-label", "level"));
    el.levelMeter = h("i", "vxr-level");
    el.levelBar = h("b");
    el.levelMeter.appendChild(el.levelBar);
    el.rowVol.appendChild(el.levelMeter);
    el.rowVol.appendChild(h("span", "vxr-file-name", "volume — in the Twitch player"));
    el.panel.appendChild(el.rowVol);

    el.rowSeg = h("div", "vxr-row");
    el.rowSeg.appendChild(h("span", "vxr-label", "muted"));
    el.segInfo = h("span", "vxr-seg-info", "…");
    el.rowSeg.appendChild(el.segInfo);
    var prev = h("button", "vxr-btn vxr-mini", "◀");
    prev.addEventListener("click", function () {
      jumpSegment(-1);
    });
    var next = h("button", "vxr-btn vxr-mini", "▶");
    next.addEventListener("click", function () {
      jumpSegment(1);
    });
    el.rowSeg.appendChild(prev);
    el.rowSeg.appendChild(next);
    el.panel.appendChild(el.rowSeg);

    el.panel.classList.add("vxr-hidden");
    root.appendChild(el.panel);

    if (root.classList && !root.classList.contains("vxr-host")) root.classList.add("vxr-host");
  }

  function togglePanel() {
    if (el.panel) el.panel.classList.toggle("vxr-hidden");
  }

  /* Twitch localizes both the Share label and its aria-label, so the icon is the only
     locale-independent anchor: the share glyph's first path is stable across locales. */
  var SHARE_ICON = 'button svg path[d^="M13 6v10h-2V6"]';
  var SHARE_WORDS =
    "Share|Поделиться|Поділитися|Compartir|Partager|Teilen|Condividi|Compartilhar|Partilhar|Udostępnij|Paylaş|Delen|Dela|Del|Jaa|Sdílet|Megosztás|Distribuie|Zdieľať|Κοινοποίηση|共有|分享|共用|공유|مشاركة|साझा करें|แชร์|Chia sẻ|Bagikan|Kongsi";

  function shareButton() {
    var icons = document.querySelectorAll(SHARE_ICON);
    for (var i = 0; i < icons.length; i++) {
      var owner = icons[i].closest("button");
      if (owner && !owner.classList.contains("vxr-unmute")) return owner;
    }
    var share = document.querySelector('button[aria-label="Share"]');
    if (share && !share.classList.contains("vxr-unmute")) return share;
    var buttons = document.querySelectorAll("button");
    var words = new RegExp("^(" + SHARE_WORDS + ")$", "i");
    for (i = 0; i < buttons.length; i++) {
      var label = (buttons[i].getAttribute("aria-label") || "").replace(/\s*\(.*\)$/, "").trim();
      var text = (buttons[i].textContent || "").replace(/^\s+|\s+$/g, "");
      if (words.test(label) || words.test(text)) return buttons[i];
    }
    return null;
  }

  /* Launcher clone of Twitch's own Share pill, inserted to its left. Twitch rebuilds the
     control bar on hover/fullscreen, so the poll re-adds it when it disappears. */
  function ensureUnmute() {
    if (document.querySelector(".vxr-unmute")) return;
    var share = shareButton();
    if (!share || !share.parentElement || !share.parentElement.parentElement) return;
    var wrap = share.parentElement;
    var btn = share.cloneNode(true);
    btn.classList.add("vxr-unmute");
    btn.removeAttribute("data-a-target");
    btn.setAttribute("aria-label", "Unmute VOD");
    var icon = btn.querySelector(".tw-core-button-icon");
    if (icon) {
      var holder = icon.parentElement;
      icon.remove();
      if (holder && !holder.children.length && !(holder.textContent || "").replace(/\s+/g, "")) holder.remove();
    }
    var labelNode = btn.querySelector('[data-a-target="tw-core-button-label-text"]');
    if (labelNode) labelNode.textContent = "Unmute VOD";
    else btn.textContent = "Unmute VOD";
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
    var parent = wrap.parentElement;
    while (parent && parent !== document.body) {
      var cs = getComputedStyle(parent);
      if (cs.display === "flex" && cs.flexDirection === "row") break;
      parent = parent.parentElement;
    }
    if (!parent || parent === document.body) return;
    var child = share;
    while (child.parentElement && child.parentElement !== parent) child = child.parentElement;
    if (child.parentElement !== parent) return;
    var wrapClone = wrap.cloneNode(false);
    wrapClone.classList.add("vxr-unmute-wrap");
    wrapClone.appendChild(btn);
    parent.insertBefore(wrapClone, child);
  }

  function render(force) {
    if (!el.status) return;
    var drift = running && ctrl ? ctrl.state.driftMs : 0;
    var parts = [running ? "replacement on" : "replacement off"];
    if (running) parts.push("drift " + Math.round(drift) + " ms", phaseLabel(ctrl.state.phase));
    if (S.note) parts.push("· " + S.note);
    el.status.textContent = parts.filter(Boolean).join("  ");
    el.status.className = "vxr-status " + (running ? "vxr-on" : S.note ? "vxr-warn" : "");
    el.toggle.textContent = running ? "Disable replacement" : "Enable replacement";
    el.toggle.classList.toggle("vxr-active", running);
    el.fileName.textContent = S.fileName ? S.fileName + (S.trackDuration ? " · " + fmt(S.trackDuration) : "") : "no file selected";
    el.offsetOut.textContent = (S.offset >= 0 ? "+" : "−") + Math.abs(S.offset).toFixed(2) + " c";
    el.cdnBtn.textContent = S.cdn === "checking" ? "checking…" : S.cdn === "on" ? "CDN mode on" : "Search CDN for original";
    el.cdnOff.style.display = S.cdn === "on" ? "" : "none";
    el.levelBar.style.width = Math.min(100, Math.round(levelPeak * 320)) + "%";
    levelPeak = 0;
    if (el.modeMuted) {
      el.modeMuted.classList.toggle("vxr-active", S.mode === "muted");
      el.modeFull.classList.toggle("vxr-active", S.mode === "full");
    }
    el.dlBtn.textContent = dlBusy ? (dlPercent ? "Cancel download · " + dlPercent + "%" : "Cancel download") : "Download audio";
    el.dlBtn.classList.toggle("vxr-active", dlBusy);
    el.dlUn.disabled = dlBusy;
    el.dlUn.style.display = S.segments && !S.segments.length ? "none" : "";
    el.dlNote.style.display = dlNote ? "" : "none";
    el.dlNote.textContent = dlNote;
    el.dlBar.style.display = dlBusy && dlPercent ? "" : "none";
    el.dlBarFill.style.width = dlPercent + "%";
    el.levelMeter.setAttribute("data-gain", S.gain.toFixed(2));
    el.levelMeter.setAttribute("data-muted", pageMuted ? "1" : "0");
    el.levelMeter.setAttribute("data-ctx", ctx ? ctx.state : "none");
    var total = S.segments
      ? S.segments.reduce(function (a, s) {
          return a + s.duration;
        }, 0)
      : 0;
    el.segInfo.textContent = S.segments == null ? S.mapError || "…" : S.segments.length ? fmt(total) + " in " + S.segments.length + " ranges" : S.mapError || "0";
    if (force) lastRender = 0;
  }

  function phaseLabel(phase) {
    return (
      { locked: "locked", drift: "adjusting", seek: "seeking", resync: "resync", stall: "buffering", hold: "paused", preroll: "before start", postroll: "file ended", idle: "" }[
        phase
      ] || phase
    );
  }

  /* ---------- lifecycle ---------- */

  function currentVodId() {
    var m = /^\/videos\/(\d+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function onVodEvent(e) {
    if (e.type === "volumechange" && running) updateGate();
    if (e.type === "seeked" && ctrl) ctrl.resetClocks();
    if (e.type === "ratechange" && ctrl) ctrl.resetClocks();
  }

  function bindPlayer() {
    var found = pickVideo();
    if (!found || found === vod) return;
    if (vod) vod.removeEventListener("volumechange", onVodEvent);
    vod = found;
    ["play", "pause", "seeked", "ratechange", "volumechange", "ended", "loadedmetadata"].forEach(function (ev) {
      vod.addEventListener(ev, onVodEvent, true);
    });
    if (running) updateGate();
  }

  function poll() {
    bindPlayer();
    var id = currentVodId();
    if (id !== S.vodId) {
      S.vodId = id;
      if (running) setActive(false);
      S.segments = null;
      S.mapError = "";
      S.cdn = "unknown";
      S.note = "";
      if (id) {
        loadPrefs().then(function (prefs) {
          S.offset = (prefs.offsets && prefs.offsets[id]) || 0;
          S.fileName = prefs.fileName || S.fileName;
          refreshMuteMap();
        });
      }
      render(true);
    }
    ensureUnmute();
    ensureVolumeHook();
  }

  loadPrefs().then(function (prefs) {
    if (prefs.fileName) S.fileName = prefs.fileName;
    S.mode = prefs.mode === "full" ? "full" : "muted";
    S.vodId = currentVodId();
    if (S.vodId && prefs.offsets) S.offset = prefs.offsets[S.vodId] || 0;
    buildUI();
    bindPlayer();
    ensureUnmute();
    render(true);
    refreshMuteMap();
    setInterval(poll, POLL_MS);
  });
})();
