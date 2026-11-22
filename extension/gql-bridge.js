/* Runs in the page world: Twitch rejects extension-origin reads, so the mute map
   query and every CDN probe are issued from the twitch.tv document itself. */
(function () {
  "use strict";

  var REQ = "VXR_REQ";
  var RES = "VXR_RES";
  var CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

  /* Twitch derives its volume UI from the <video> element, so muting the element to
     silence the original also flips the player to mute. Shadow volume/muted on the
     instance instead: the element stays silent, the page keeps seeing the user's
     volume/mute state, and every write is reported back to the content script. */
  var mediaProto = window.HTMLMediaElement && HTMLMediaElement.prototype;
  var volDesc = mediaProto && Object.getOwnPropertyDescriptor(mediaProto, "volume");
  var mutedDesc = mediaProto && Object.getOwnPropertyDescriptor(mediaProto, "muted");
  var shimVideo = null;
  var shimVol = 1;
  var shimMuted = false;
  var plainSilenced = false;

  document.documentElement.setAttribute("data-vxr-shim", "1");

  function announceVolume() {
    document.dispatchEvent(new CustomEvent("VXR_VOLUME", { detail: JSON.stringify({ volume: shimVol, muted: shimMuted }) }));
  }

  function silencePlayer() {
    var v = document.querySelector("video");
    if (!v) return;
    if (shimVideo === v) return;
    restorePlayer();
    shimVideo = v;
    v.setAttribute("data-vxr-silent", "1");
    shimVol = Math.max(0, Math.min(1, Number(volDesc && volDesc.get.call(v)) || 0));
    shimMuted = !!(mutedDesc && mutedDesc.get.call(v));
    if (!volDesc || !mutedDesc) {
      plainSilenced = true;
      try {
        v.muted = true;
      } catch (e) {}
      return;
    }
    Object.defineProperty(v, "volume", {
      configurable: true,
      get: function () {
        return shimVol;
      },
      set: function (x) {
        var next = Math.max(0, Math.min(1, Number(x) || 0));
        var changed = next !== shimVol;
        shimVol = next;
        volDesc.set.call(v, 0);
        if (changed) {
          /* the element's real volume never moves after silencing, but Twitch's
             volume UI (the % tooltip) only syncs on volumechange */
          try {
            v.dispatchEvent(new Event("volumechange"));
          } catch (e) {}
          announceVolume();
        }
      }
    });
    Object.defineProperty(v, "muted", {
      configurable: true,
      get: function () {
        return shimMuted;
      },
      set: function (x) {
        var next = !!x;
        var changed = next !== shimMuted;
        shimMuted = next;
        mutedDesc.set.call(v, true);
        if (changed) {
          try {
            v.dispatchEvent(new Event("volumechange"));
          } catch (e) {}
          announceVolume();
        }
      }
    });
    volDesc.set.call(v, 0);
    mutedDesc.set.call(v, true);
    announceVolume();
  }

  function restorePlayer() {
    var v = shimVideo;
    if (!v) return;
    shimVideo = null;
    try {
      v.removeAttribute("data-vxr-silent");
      if (plainSilenced) {
        plainSilenced = false;
        shimMuted = false;
        mutedDesc && mutedDesc.set.call(v, false);
        return;
      }
      delete v.volume;
      delete v.muted;
      volDesc.set.call(v, shimVol);
      mutedDesc.set.call(v, shimMuted);
    } catch (e) {}
  }

  document.addEventListener("VXR_SILENCE", silencePlayer, true);
  document.addEventListener("VXR_UNSILENCE", restorePlayer, true);
  function reply(id, out) {
    document.dispatchEvent(new CustomEvent(RES, { detail: JSON.stringify(Object.assign({ id: id }, out)) }));
  }

  function muteInfo(vodId) {
    var query = "query VxrMute($id: ID!) { video(id: $id) { id lengthSeconds muteInfo { mutedSegmentConnection { nodes { offset duration } } } } }";
    return fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-ID": CLIENT_ID },
      credentials: "omit",
      body: JSON.stringify({ query: query, variables: { id: String(vodId) } })
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        var v = j && j.data && j.data.video;
        if (!v) {
          var first = j && j.errors && j.errors[0];
          throw new Error(first ? first.message : "video not found");
        }
        var nodes = ((v.muteInfo || {}).mutedSegmentConnection || {}).nodes || [];
        return {
          ok: true,
          lengthSeconds: v.lengthSeconds || 0,
          segments: nodes
            .map(function (n) {
              return { start: Number(n.offset) || 0, duration: Number(n.duration) || 0 };
            })
            .sort(function (a, b) {
              return a.start - b.start;
            })
        };
      });
  }

  /* The player pulls segments from a worker and keeps its manifest in MSE, so the
     document timeline only reliably carries the storyboard URL — which sits on the
     same CDN directory as the quality folders with the segments. */
  function cdnBase() {
    var names;
    try {
      names = performance.getEntriesByType("resource").map(function (e) {
        return e.name;
      });
    } catch (e) {
      return { ok: false, error: "performance API unavailable" };
    }
    var base = null;
    for (var i = 0; i < names.length; i++) {
      var m = /^(https?:\/\/[^/]+\/.+\/)storyboards\/[^/]*\.(?:json|jpg)$/.exec(names[i]);
      if (m) {
        base = m[1];
        break;
      }
    }
    if (!base) return { ok: false, error: "no VOD CDN folder in the page timeline" };
    return { ok: true, base: base };
  }

  /* Master playlist with per-quality media playlists. The usher token is anonymous;
     the CDN serves the media playlists to the page origin (CORS is open for MSE). */
  function playlists(vodId) {
    var query = 'query VxrToken($id: ID!) { videoPlaybackAccessToken(id: $id, params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }';
    return fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-ID": CLIENT_ID },
      credentials: "omit",
      body: JSON.stringify({ query: query, variables: { id: String(vodId) } })
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        var t = j && j.data && j.data.videoPlaybackAccessToken;
        if (!t) {
          var first = j && j.errors && j.errors[0];
          throw new Error(first ? first.message : "no playlist token");
        }
        var usher =
          "https://usher.ttvnw.net/vod/" +
          encodeURIComponent(String(vodId)) +
          ".m3u8?allow_source=true&allow_audio_only=true&p=" +
          encodeURIComponent(t.value) +
          "&sig=" +
          encodeURIComponent(t.signature) +
          "&token=" +
          encodeURIComponent(t.value);
        var usherAbs = new URL(usher, location.href).href;
        return fetch(usherAbs, { credentials: "omit" }).then(function (r) {
          if (!r.ok) throw new Error("usher responded " + r.status);
          return r.text().then(function (text) {
            var lines = text.split(/\r?\n/);
            var out = [];
            var label = "";
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].replace(/^\s+|\s+$/g, "");
              if (!line) continue;
              var media = /^#EXT-X-MEDIA:TYPE=VIDEO.*NAME="([^"]+)"/.exec(line);
              if (media) {
                label = media[1];
                continue;
              }
              if (line.charAt(0) === "#") continue;
              if (!/\.m3u8(\?|$)/.test(line)) continue;
              var abs;
              try {
                abs = new URL(line, usherAbs).href;
              } catch (e) {
                continue;
              }
              var fm = /\/([^/]+)\/index-[^/]*\.m3u8/.exec(abs);
              var folder = fm ? fm[1] : "";
              out.push({ folder: folder, label: label || folder, url: abs });
              label = "";
            }
            return { ok: true, playlists: out };
          });
        });
      });
  }

  /* ---------- audio download (TwitchDownloader-style) ---------- */

  var DL_EVT = "VXR_DL";
  var dlJob = null;

  function dlSend(o) {
    document.dispatchEvent(new CustomEvent(DL_EVT, { detail: JSON.stringify(o) }));
  }

  function audioPlaylist(vodId) {
    var query = 'query VxrToken($id: ID!) { videoPlaybackAccessToken(id: $id, params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }';
    return fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-ID": CLIENT_ID },
      credentials: "omit",
      body: JSON.stringify({ query: query, variables: { id: String(vodId) } })
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        var t = j && j.data && j.data.videoPlaybackAccessToken;
        if (!t) {
          var first = j && j.errors && j.errors[0];
          throw new Error(first ? first.message : "no playlist token");
        }
        var usher =
          "https://usher.ttvnw.net/vod/" +
          encodeURIComponent(String(vodId)) +
          ".m3u8?allow_source=true&allow_audio_only=true&p=" +
          encodeURIComponent(t.value) +
          "&sig=" +
          encodeURIComponent(t.signature) +
          "&token=" +
          encodeURIComponent(t.value);
        var usherAbs = new URL(usher, location.href).href;
        return fetch(usherAbs, { credentials: "omit" })
          .then(function (r) {
            if (!r.ok) throw new Error("usher responded " + r.status);
            return r.text();
          })
          .then(function (master) {
            var lines = master.split(/\r?\n/);
            var audio = "";
            var bandwidth = 0;
            var pending = 0;
            for (var i = 0; i < lines.length; i++) {
              var s = lines[i].replace(/^\s+|\s+$/g, "");
              if (!s) continue;
              if (s.indexOf("#EXT-X-STREAM-INF:") === 0) {
                var bw = /(?:^|[,:])BANDWIDTH=(\d+)/.exec(s);
                pending = bw ? Number(bw[1]) : 0;
                continue;
              }
              if (s.charAt(0) === "#") continue;
              if (/audio_only\//.test(s)) {
                audio = s;
                bandwidth = pending;
                break;
              }
              pending = 0;
            }
            if (!audio) throw new Error("the VOD has no audio_only track");
            return mediaPlaylist(new URL(audio, usherAbs).href).then(function (plan) {
              plan.bitrate = bandwidth;
              return plan;
            });
          });
      });
  }

  function parseMedia(text, base) {
    var lib = window.m3u8Parser;
    if (lib && lib.Parser) {
      try {
        var parser = new lib.Parser();
        parser.push(text);
        parser.end();
        var manifest = parser.manifest || {};
        var segs = manifest.segments || [];
        var durSum = 0;
        for (var d = 0; d < segs.length; d++) durSum += Number(segs[d].duration) || 0;
        return {
          segments: segs.map(function (s) {
            return new URL(s.uri, base).href;
          }),
          durations: segs.map(function (s) {
            return Number(s.duration) || 0;
          }),
          duration: durSum,
          target: Number(manifest.targetDuration) || 6,
          end: !!manifest.endList
        };
      } catch (e) {}
    }
    var lines = text.split(/\r?\n/);
    var segments = [];
    var durations = [];
    var duration = 0;
    var segDur = 0;
    var target = 6;
    var end = false;
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].replace(/^\s+|\s+$/g, "");
      if (!s) continue;
      var m;
      if ((m = /^#EXT-X-TARGETDURATION:\s*([\d.]+)/.exec(s))) {
        target = parseFloat(m[1]) || target;
        continue;
      }
      if ((m = /^#EXTINF:\s*([\d.]+)/.exec(s))) {
        segDur = parseFloat(m[1]) || 0;
        continue;
      }
      if (s === "#EXT-X-ENDLIST") {
        end = true;
        continue;
      }
      if (s.charAt(0) === "#") continue;
      var abs;
      try {
        abs = new URL(s, base).href;
      } catch (e) {
        continue;
      }
      segments.push(abs);
      durations.push(segDur);
      duration += segDur;
      segDur = 0;
    }
    return { segments: segments, durations: durations, duration: duration, target: target, end: end };
  }

  function mediaPlaylist(url) {
    return fetch(url, { credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("playlist responded " + r.status);
        return r.text();
      })
      .then(function (text) {
        var plan = parseMedia(text, url);
        plan.mediaUrl = url;
        return plan;
      });
  }

  function dlAbortError() {
    try {
      return new DOMException("cancelled", "AbortError");
    } catch (e) {
      var err = new Error("cancelled");
      err.name = "AbortError";
      return err;
    }
  }

  function dlSleep(st, seconds) {
    return new Promise(function (res) {
      var timer = setTimeout(finish, Math.max(0, seconds * 1000));
      st.wake = function () {
        clearTimeout(timer);
        finish();
      };
      function finish() {
        st.wake = null;
        res();
      }
    });
  }

  function dlFetchSeg(st, url) {
    var attempt = 0;
    function go() {
      if (st.cancelled) return Promise.reject(dlAbortError());
      return fetch(url, { credentials: "omit", signal: st.abort.signal })
        .then(function (r) {
          if (!r.ok) throw new Error("segment responded " + r.status);
          return r.arrayBuffer();
        })
        .catch(function (e) {
          if (st.cancelled) throw dlAbortError();
          if (++attempt >= 3) throw e;
          return dlSleep(st, attempt).then(go);
        });
    }
    return go();
  }

  function dlWrite(st, bytes) {
    var copy = new Uint8Array(bytes);
    st.bytes += copy.byteLength;
    st.chain = st.chain.then(function () {
      return st.sink.write(copy);
    });
  }

  function dlRate(st) {
    var elapsed = Math.max(0.5, (Date.now() - st.startedAt) / 1000);
    var speed = Math.round(st.bytes / elapsed);
    var total = st.totalBytes;
    if (st.etaOn && st.mediaDuration > 0 && st.durationDone >= 10) total = Math.round((st.bytes / st.durationDone) * st.mediaDuration);
    var eta = st.etaOn && speed > 0 && total > st.bytes ? Math.round((total - st.bytes) / speed) : 0;
    return { totalBytes: total, speed: speed, eta: eta };
  }

  function dlProgress(st, plan) {
    var now = Date.now();
    if (st.pos !== plan.segments.length && now - st.lastSend < 800) return;
    st.lastSend = now;
    var rate = dlRate(st);
    dlSend({
      phase: "run",
      done: st.pos,
      total: Math.max(plan.segments.length, st.total),
      bytes: st.bytes,
      totalBytes: rate.totalBytes,
      speed: rate.speed,
      eta: rate.eta,
      note: plan.end ? "downloading" : "downloading (recording is still live)"
    });
  }

  function dlFinish(st, phase, note) {
    if (st.ended) return;
    st.ended = true;
    if (dlJob === st) dlJob = null;
    dlSend({ phase: phase, done: st.pos || 0, total: st.total || 0, bytes: st.bytes || 0, note: note || "" });
  }

  function memSave(st) {
    var blob = new Blob(st.mem, { type: "audio/mp4" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = st.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 60000);
  }

  function runAudioDownload(st) {
    var lib = window.muxjs;
    if (!lib || !lib.mp4 || !lib.mp4.Transmuxer) return Promise.reject(new Error("mux.js failed to load"));
    st.startedAt = Date.now();
    var tr = new lib.mp4.Transmuxer();
    var initWritten = false;
    tr.on("data", function (seg) {
      if (seg.initSegment && !initWritten) {
        initWritten = true;
        dlWrite(st, seg.initSegment);
      }
      if (seg.data) dlWrite(st, seg.data);
    });

    var plan = null;
    function planInfo(p) {
      plan = p;
      st.total = Math.max(st.total, p.segments.length);
      st.etaOn = !!p.end;
      st.mediaDuration = p.duration || 0;
      st.totalBytes = p.end && p.bitrate && p.duration ? Math.round((p.bitrate / 8) * p.duration) : 0;
      return p;
    }
    function refill() {
      return audioPlaylist(st.vodId).then(planInfo);
    }
    function step() {
      if (st.cancelled) return Promise.reject(dlAbortError());
      if (st.pos < plan.segments.length) {
        var url = plan.segments[st.pos];
        return dlFetchSeg(st, url).then(function (buf) {
          if (plan.durations) st.durationDone += plan.durations[st.pos] || 0;
          st.pos++;
          tr.push(new Uint8Array(buf));
          tr.flush();
          dlProgress(st, plan);
          return step();
        });
      }
      if (plan.end) return Promise.resolve();
      var rate = dlRate(st);
      dlSend({
        phase: "run",
        done: st.pos,
        total: st.total,
        bytes: st.bytes,
        totalBytes: rate.totalBytes,
        speed: rate.speed,
        eta: rate.eta,
        note: "waiting for new segments"
      });
      return dlSleep(st, Math.max(3, plan.target))
        .then(function () {
          return mediaPlaylist(plan.mediaUrl);
        })
        .then(function (p) {
          planInfo(p);
          return step();
        });
    }

    return refill()
      .then(function (p) {
        st.total = p.segments.length;
        dlSend({
          phase: "run",
          done: 0,
          total: st.total,
          bytes: 0,
          totalBytes: st.totalBytes,
          speed: 0,
          eta: 0,
          note: p.end ? "downloading" : "downloading (recording is still live)"
        });
        return step();
      })
      .then(function () {
        return st.chain;
      })
      .then(function () {
        if (st.cancelled) throw dlAbortError();
        return st.sink.close();
      })
      .then(function () {
        if (st.mem) memSave(st);
        dlFinish(st, "done", st.name);
      })
      .catch(function (e) {
        var cancelled = st.cancelled || (e && e.name === "AbortError");
        var drop = st.sink ? st.sink.abort() : Promise.resolve();
        return Promise.resolve(drop)
          .catch(function () {})
          .then(function () {
            dlFinish(st, cancelled ? "cancel" : "error", cancelled ? "" : String((e && e.message) || e));
          });
      });
  }

  function startAudioDownload(vodId) {
    if (dlJob) {
      dlSend({ phase: "error", note: "download already running" });
      return;
    }
    var name = "twitch-" + vodId + "-audio.m4a";
    var st = {
      vodId: String(vodId),
      name: name,
      cancelled: false,
      ended: false,
      bytes: 0,
      pos: 0,
      total: 0,
      totalBytes: 0,
      etaOn: false,
      mediaDuration: 0,
      durationDone: 0,
      startedAt: Date.now(),
      lastSend: 0,
      chain: Promise.resolve(),
      sink: null,
      mem: null,
      abort: new AbortController(),
      wake: null
    };
    dlJob = st;
    if (typeof window.showSaveFilePicker === "function") {
      var picked;
      try {
        picked = window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: "M4A audio", accept: { "audio/mp4": [".m4a"] } }]
        });
      } catch (e) {
        dlJob = null;
        dlSend({ phase: "error", note: "could not open the save dialog: " + ((e && e.message) || e) });
        return;
      }
      dlSend({ phase: "prepare", note: "choose where to save" });
      Promise.resolve(picked)
        .then(function (handle) {
          return handle.createWritable().then(function (w) {
            st.sink = {
              write: function (u) {
                return w.write(u);
              },
              close: function () {
                return w.close();
              },
              abort: function () {
                return w.abort();
              }
            };
            st.name = handle.name || name;
            return runAudioDownload(st);
          });
        })
        .catch(function (e) {
          var cancelled = st.cancelled || (e && e.name === "AbortError");
          dlFinish(st, cancelled ? "cancel" : "error", cancelled ? "" : String((e && e.message) || e));
        });
    } else {
      st.mem = [];
      st.sink = {
        write: function (u) {
          st.mem.push(u);
          return Promise.resolve();
        },
        close: function () {
          return Promise.resolve();
        },
        abort: function () {
          st.mem = [];
          return Promise.resolve();
        }
      };
      dlSend({ phase: "prepare", note: "collecting the file in memory" });
      runAudioDownload(st);
    }
  }

  function cancelAudioDownload() {
    if (!dlJob) return;
    dlJob.cancelled = true;
    try {
      dlJob.abort.abort();
    } catch (e) {}
    if (dlJob.wake) dlJob.wake();
  }

  function fetchText(url) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      ctrl.abort();
    }, 10000);
    return fetch(url, { credentials: "omit", signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) return { ok: false, status: r.status, error: "HTTP " + r.status };
        return r.text().then(function (text) {
          return { ok: true, status: r.status, text: text.slice(0, 4000000) };
        });
      })
      .catch(function (e) {
        clearTimeout(timer);
        return { ok: false, status: 0, error: String((e && e.message) || e) };
      });
  }

  function probe(url) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      ctrl.abort();
    }, 8000);
    return fetch(url, { method: "GET", credentials: "omit", signal: ctrl.signal })
      .then(function (r) {
        var status = r.status;
        clearTimeout(timer);
        ctrl.abort();
        return { ok: true, status: status, finalUrl: r.url, bytes: Number(r.headers.get("content-length")) || 0 };
      })
      .catch(function (e) {
        clearTimeout(timer);
        return { ok: true, status: 0, error: String((e && e.message) || e) };
      });
  }

  document.addEventListener(REQ, function (e) {
    var msg;
    try {
      msg = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    if (!msg || !msg.id) return;

    if (msg.type === "muteInfo") {
      muteInfo(msg.payload.vodId).then(
        function (out) {
          reply(msg.id, out);
        },
        function (err) {
          reply(msg.id, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      );
      return;
    }
    if (msg.type === "cdnBase") {
      reply(msg.id, cdnBase());
      return;
    }
    if (msg.type === "probe") {
      probe(msg.payload.url).then(function (out) {
        out.url = msg.payload.url;
        reply(msg.id, out);
      });
      return;
    }
    if (msg.type === "cdnPlaylists") {
      playlists(msg.payload.vodId).then(
        function (out) {
          reply(msg.id, out);
        },
        function (err) {
          reply(msg.id, { ok: false, error: String((err && err.message) || err) });
        }
      );
      return;
    }
    if (msg.type === "fetchText") {
      fetchText(msg.payload.url).then(function (out) {
        out.url = msg.payload.url;
        reply(msg.id, out);
      });
      return;
    }
    if (msg.type === "audioDownloadStart") {
      startAudioDownload(msg.payload.vodId);
      reply(msg.id, { ok: true });
      return;
    }
    if (msg.type === "audioDownloadCancel") {
      cancelAudioDownload();
      reply(msg.id, { ok: true });
      return;
    }
    reply(msg.id, { ok: false, error: "unsupported request" });
  });
})();
