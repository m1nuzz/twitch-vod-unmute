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

  function audioPlaylist(vodId, withChunk) {
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
            var chunk = "";
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
              } else if (/\/chunked\/|^chunked\//.test(s)) {
                chunk = s;
              }
              pending = 0;
            }
            if (!audio) throw new Error("the VOD has no audio_only track");
            var audioUrl = new URL(audio, usherAbs).href;
            var chunkUrl = chunk ? new URL(chunk, usherAbs).href : "";
            return mediaPlaylist(audioUrl).then(function (plan) {
              plan.bitrate = bandwidth;
              plan.chunkUrl = withChunk ? chunkUrl : "";
              if (!withChunk || !chunkUrl) return plan;
              return mediaPlaylist(chunkUrl).then(function (cp) {
                plan.chunk = cp;
                return plan;
              });
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
          muted: segs.map(function (s) {
            return /-muted\./.test(s.uri || "");
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
    var muted = [];
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
      muted.push(/-muted\./.test(abs));
      duration += segDur;
      segDur = 0;
    }
    return { segments: segments, durations: durations, muted: muted, duration: duration, target: target, end: end };
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

  function planStarts(plan) {
    if (plan.starts) return plan.starts;
    var t = 0;
    plan.starts = plan.segments.map(function (_, i) {
      var s = t;
      t += (plan.durations && plan.durations[i]) || 0;
      return s;
    });
    return plan.starts;
  }

  /* chunked (1080p60) segments tile the same VOD timeline; a muted audio segment can
     only be replaced when whole chunks cover its range, otherwise the splice would shift. */
  function chunkCover(chunk, start, end) {
    if (!chunk || !chunk.segments.length) return null;
    var starts = planStarts(chunk);
    var lo = 0;
    var hi = starts.length - 1;
    var first = starts.length;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (starts[mid] + (chunk.durations[mid] || 0) > start + 0.01) {
        first = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    var out = [];
    var t = start;
    var i = first;
    while (t < end - 0.01) {
      if (i >= starts.length || Math.abs(starts[i] - t) > 0.05) return null;
      var d = chunk.durations[i] || 0;
      if (d <= 0) return null;
      out.push(i);
      t += d;
      i++;
    }
    return Math.abs(t - end) <= 0.2 ? out : null;
  }

  function plainOfUrl(url) {
    return url.replace(/-muted(\.[^/?#]+)/, "$1");
  }

  function dlPlainOk(st, url) {
    if (st.plains[url]) return st.plains[url];
    st.plains[url] = fetch(url, { credentials: "omit", signal: st.abort.signal })
      .then(function (r) {
        var ok = r.ok;
        if (r.body) r.body.cancel().catch(function () {});
        return ok;
      })
      .catch(function () {
        return false;
      });
    return st.plains[url];
  }

  function dlBoxType(view, off) {
    return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  }

  function dlFindBox(view, start, end, type) {
    var off = start;
    while (off + 8 <= end) {
      var size = view.getUint32(off);
      if (size < 8 || off + size > end) return null;
      if (dlBoxType(view, off + 4) === type) return { off: off, size: size };
      off += size;
    }
    return null;
  }

  function dlFlags(view, off) {
    return (view.getUint8(off) << 16) | (view.getUint8(off + 1) << 8) | view.getUint8(off + 2);
  }

  function dlFragInfo(buf) {
    var view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var moof = dlFindBox(view, 0, buf.byteLength, "moof");
    if (!moof) return null;
    var traf = dlFindBox(view, moof.off + 8, moof.off + moof.size, "traf");
    if (!traf) return null;
    var tfhd = dlFindBox(view, traf.off + 8, traf.off + traf.size, "tfhd");
    var tfdt = dlFindBox(view, traf.off + 8, traf.off + traf.size, "tfdt");
    var trun = dlFindBox(view, traf.off + 8, traf.off + traf.size, "trun");
    if (!tfhd || !tfdt || !trun) return null;
    var trunFlags = dlFlags(view, trun.off + 9);
    var count = view.getUint32(trun.off + 12);
    var p = trun.off + 16;
    if (trunFlags & 0x1) p += 4;
    if (trunFlags & 0x4) p += 4;
    var dur = 0;
    if (trunFlags & 0x100) {
      for (var i = 0; i < count; i++) {
        dur += view.getUint32(p);
        p += 4;
        if (trunFlags & 0x200) p += 4;
        if (trunFlags & 0x400) p += 4;
        if (trunFlags & 0x800) p += 4;
      }
    } else {
      var tfhdFlags = dlFlags(view, tfhd.off + 9);
      var q = tfhd.off + 16;
      if (tfhdFlags & 0x1) q += 8;
      if (tfhdFlags & 0x2) q += 4;
      dur = (tfhdFlags & 0x8 ? view.getUint32(q) : 1024) * count;
    }
    return { trackId: view.getUint32(tfhd.off + 12), dur: dur, tfhdOff: tfhd.off, tfdtOff: tfdt.off, tfdtV1: view.getUint8(tfdt.off + 8) === 1 };
  }

  function dlPatchFrag(buf, base, trackId) {
    var copy = new Uint8Array(buf.byteLength);
    copy.set(buf);
    var info = dlFragInfo(copy);
    if (!info) return { data: copy, dur: 0, trackId: trackId };
    var view = new DataView(copy.buffer);
    var tid = trackId || info.trackId;
    view.setUint32(info.tfhdOff + 12, tid);
    if (info.tfdtV1) {
      view.setUint32(info.tfdtOff + 12, Math.floor(base / 4294967296));
      view.setUint32(info.tfdtOff + 16, base - Math.floor(base / 4294967296) * 4294967296);
    } else view.setUint32(info.tfdtOff + 12, base);
    return { data: copy, dur: info.dur, trackId: tid };
  }

  function dlAudioEvents(buf) {
    return new Promise(function (resolve, reject) {
      var tr = new window.muxjs.mp4.Transmuxer({ remux: false });
      var out = [];
      tr.on("data", function (seg) {
        if (seg.type === "audio" && seg.data) out.push({ init: seg.initSegment || null, data: seg.data });
      });
      tr.on("done", function () {
        resolve(out);
      });
      try {
        tr.push(new Uint8Array(buf));
        tr.flush();
      } catch (e) {
        reject(e);
      }
    });
  }

  function dlTrackFormat(init) {
    var view = new DataView(init.buffer, init.byteOffset, init.byteLength);
    var moov = dlFindBox(view, 0, init.byteLength, "moov");
    var trak = moov && dlFindBox(view, moov.off + 8, moov.off + moov.size, "trak");
    var mdia = trak && dlFindBox(view, trak.off + 8, trak.off + trak.size, "mdia");
    var minf = mdia && dlFindBox(view, mdia.off + 8, mdia.off + mdia.size, "minf");
    var stbl = minf && dlFindBox(view, minf.off + 8, minf.off + minf.size, "stbl");
    var stsd = stbl && dlFindBox(view, stbl.off + 8, stbl.off + stbl.size, "stsd");
    var entry = stsd && dlFindBox(view, stsd.off + 16, stsd.off + stsd.size, "mp4a");
    if (!entry) return null;
    return { channels: view.getUint16(entry.off + 24), rate: view.getUint32(entry.off + 32) >>> 16 };
  }

  /* source and audio_only are both AAC-LC 48 kHz stereo on Twitch; a mismatch would
     make the inserted chunks play at the wrong rate, so refuse the splice instead. */
  function dlSameFormat(a, b) {
    var fa = dlTrackFormat(a);
    var fb = dlTrackFormat(b);
    if (!fa || !fb) return true;
    return fa.rate === fb.rate && fa.channels === fb.channels;
  }

  function dlUnmutedParts(st, buf, base) {
    return dlAudioEvents(buf).then(function (events) {
      var out = { init: null, parts: [], dur: 0, trackId: st.trackId, skip: false };
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (ev.init) {
          if (!st.init) {
            if (!out.init) out.init = ev.init;
          } else if (!dlSameFormat(st.init, ev.init)) {
            out.parts = [];
            out.skip = true;
            return out;
          }
        }
        if (!ev.data) continue;
        var patched = dlPatchFrag(ev.data, base + out.dur, out.trackId);
        if (!out.trackId) out.trackId = patched.trackId;
        out.parts.push(patched.data);
        out.dur += patched.dur;
      }
      return out;
    });
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
      unmuted: st.unmuted ? { done: st.recovered || 0, total: st.mutedTotal || 0 } : null,
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
      if (st.unmuted && p.muted) {
        var n = 0;
        for (var i = 0; i < p.muted.length; i++) if (p.muted[i]) n++;
        st.mutedTotal = n;
      }
      return p;
    }
    function refill() {
      return audioPlaylist(st.vodId, st.unmuted).then(planInfo);
    }
    function dlSources(p, idx) {
      var url = p.segments[idx];
      if (!st.unmuted || st.noChunks || !p.muted || !p.muted[idx] || !p.chunk) return Promise.resolve({ urls: [url], unmuted: false });
      var start = planStarts(p)[idx];
      var end = start + ((p.durations && p.durations[idx]) || 0);
      var cover = chunkCover(p.chunk, start, end);
      if (!cover) return Promise.resolve({ urls: [url], unmuted: false });
      var urls = [];
      var chain = Promise.resolve();
      cover.forEach(function (ci) {
        chain = chain.then(function () {
          if (st.cancelled) return;
          var cu = p.chunk.segments[ci];
          if (!/-muted\./.test(cu)) {
            urls.push(cu);
            return;
          }
          return dlPlainOk(st, plainOfUrl(cu)).then(function (ok) {
            if (ok) urls.push(plainOfUrl(cu));
          });
        });
      });
      return chain.then(function () {
        return urls.length === cover.length ? { urls: urls, unmuted: true } : { urls: [url], unmuted: false };
      });
    }
    /* Probe every muted segment before writing anything. Twitch purges the plain twins
       hours after the stream, and splicing is then impossible: without this check the
       "unmuted" download silently produced a fully muted file that looked like a bug. */
    function dlPreflight(p) {
      if (!st.unmuted) return Promise.resolve();
      var muted = [];
      for (var i = 0; i < p.segments.length; i++) if (p.muted && p.muted[i]) muted.push(i);
      st.mutedTotal = muted.length;
      st.available = 0;
      if (!p.chunk || !muted.length) return Promise.resolve();
      var next = 0;
      var done = 0;
      var found = 0;
      function worker() {
        if (next >= muted.length) return Promise.resolve();
        var idx = muted[next++];
        return dlSources(p, idx).then(function (picked) {
          if (picked.unmuted) found++;
          done++;
          if (done === muted.length || done % 10 === 0) {
            dlSend({
              phase: "run",
              done: 0,
              total: p.segments.length,
              bytes: 0,
              totalBytes: st.totalBytes,
              speed: 0,
              eta: 0,
              unmuted: { done: found, total: muted.length },
              note: "checking originals " + done + "/" + muted.length
            });
          }
        });
      }
      var jobs = [];
      for (var w = 0; w < 6 && w < muted.length; w++) jobs.push(worker());
      return Promise.all(jobs).then(function () {
        st.available = found;
      });
    }
    function consume(urls) {
      if (!st.unmuted) {
        var plain = Promise.resolve();
        urls.forEach(function (u) {
          plain = plain.then(function () {
            return dlFetchSeg(st, u).then(function (buf) {
              tr.push(new Uint8Array(buf));
              tr.flush();
            });
          });
        });
        return plain.then(function () {
          return true;
        });
      }
      var buffered = [];
      var segDur = 0;
      var init = null;
      var trackId = st.trackId;
      var bad = false;
      var queue = Promise.resolve();
      urls.forEach(function (u) {
        queue = queue.then(function () {
          if (bad) return;
          return dlFetchSeg(st, u).then(function (buf) {
            return dlUnmutedParts(st, buf, st.outSamples + segDur).then(function (seg) {
              if (seg.skip) {
                bad = true;
                return;
              }
              buffered.push(seg);
              segDur += seg.dur;
              if (!init && seg.init) init = seg.init;
              if (!trackId) trackId = seg.trackId;
            });
          });
        });
      });
      return queue.then(function () {
        if (bad) return false;
        if (!st.initDone && init) {
          dlWrite(st, init);
          st.init = init;
          st.initDone = true;
        }
        if (!st.trackId) st.trackId = trackId;
        for (var i = 0; i < buffered.length; i++) {
          for (var k = 0; k < buffered[i].parts.length; k++) dlWrite(st, buffered[i].parts[k]);
          st.outSamples += buffered[i].dur;
        }
        return true;
      });
    }
    function step() {
      if (st.cancelled) return Promise.reject(dlAbortError());
      if (st.pos < plan.segments.length) {
        var idx = st.pos;
        return dlSources(plan, idx).then(function (picked) {
          return consume(picked.urls)
            .then(function (ok) {
              if (ok === false) {
                picked.unmuted = false;
                st.noChunks = true;
                return consume([plan.segments[idx]]);
              }
            })
            .then(function () {
              if (picked.unmuted) st.recovered++;
              if (plan.durations) st.durationDone += plan.durations[idx] || 0;
              st.pos++;
              dlProgress(st, plan);
              return step();
            });
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
        unmuted: st.unmuted ? { done: st.recovered || 0, total: st.mutedTotal || 0 } : null,
        note: "waiting for new segments"
      });
      return dlSleep(st, Math.max(3, plan.target))
        .then(function () {
          var jobs = [mediaPlaylist(plan.mediaUrl)];
          if (st.unmuted && plan.chunkUrl) jobs.push(mediaPlaylist(plan.chunkUrl));
          return Promise.all(jobs);
        })
        .then(function (ps) {
          var p = ps[0];
          p.chunkUrl = plan.chunkUrl;
          if (ps[1]) p.chunk = ps[1];
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
          unmuted: st.unmuted ? { done: 0, total: st.mutedTotal || 0 } : null,
          note: st.unmuted ? "checking originals" : p.end ? "downloading" : "downloading (recording is still live)"
        });
        return dlPreflight(p).then(function () {
          if (st.unmuted && st.mutedTotal && !st.available) {
            throw new Error("no unmuted originals left on the CDN (0 of " + st.mutedTotal + " muted segments); Twitch already deleted them — use Download audio or a local file");
          }
          return step();
        });
      })
      .then(function () {
        return st.chain;
      })
      .then(function () {
        if (st.cancelled) throw dlAbortError();
        if (st.unmuted && st.mutedTotal && !st.recovered) {
          throw new Error("the CDN originals disappeared during the download (0 of " + st.mutedTotal + " muted segments recovered); nothing was saved");
        }
        return st.sink.close();
      })
      .then(function () {
        if (st.mem) memSave(st);
        var note = st.name;
        if (st.unmuted) note += " · unmuted " + (st.recovered || 0) + " of " + (st.mutedTotal || 0) + " muted segments";
        dlFinish(st, "done", note);
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

  function startAudioDownload(vodId, unmuted) {
    if (dlJob) {
      dlSend({ phase: "error", note: "download already running" });
      return;
    }
    var name = "twitch-" + vodId + (unmuted ? "-unmuted" : "") + "-audio.m4a";
    var st = {
      vodId: String(vodId),
      name: name,
      unmuted: !!unmuted,
      cancelled: false,
      ended: false,
      bytes: 0,
      pos: 0,
      total: 0,
      totalBytes: 0,
      etaOn: false,
      mediaDuration: 0,
      durationDone: 0,
      recovered: 0,
      mutedTotal: 0,
      plains: {},
      noChunks: false,
      outSamples: 0,
      initDone: false,
      trackId: 0,
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
      startAudioDownload(msg.payload.vodId, !!msg.payload.unmuted);
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
