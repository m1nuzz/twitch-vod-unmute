# Twitch VOD Unmute

[![CI](https://github.com/m1nuzz/twitch-vod-unmute/actions/workflows/ci.yml/badge.svg)](https://github.com/m1nuzz/twitch-vod-unmute/actions/workflows/ci.yml)

A Chrome extension (Manifest V3) for Twitch VODs. Twitch silences DMCA-muted parts of a recording
server-side: the segments are delivered as `N-muted.ts` and the audio in them is dead silence.
The extension replaces that audio with your own copy of the full stream audio (downloaded in
advance), keeps it in sync with the picture, can recover unmuted segments from the CDN, and can
download the unmuted audio track as M4A — even while the VOD is still recording.

## Features

- **Two replacement modes**
  - **Muted only (default)** — your track is audible only inside Twitch's muted ranges; the
    original audio plays everywhere else. Switching follows seeks and is sample-accurate.
  - **Full track** — your file replaces the audio for the whole recording.
- **Native player controls** — volume, mute and the volume tooltip stay Twitch's own. The original
  `<video>` is silenced behind the scenes, so the player never flips to mute when a file is loaded.
- **Mute map** — exact muted ranges from Twitch GQL (`muteInfo`), total time, range count and
  prev/next jumps. Twitch already draws its own marks on the seek bar; the extension adds none.
- **Launcher pill** — an **Unmute VOD** button cloned from Twitch's Share pill sits next to it and
  opens/closes the panel (the panel starts closed). It is found by the share icon, so it also works
  when Twitch localizes the Share label.
- **CDN recovery** — for some muted segments Twitch still has the unmuted twin (`N.ts`) on the
  `chunked` (Source/1080p60) rendition. The extension checks the signed playlists and installs
  exact per-segment DNR redirects, so the player itself fetches the audible original.
- **Audio download** — saves the stream's `audio_only` playlist as a single M4A (AAC) with
  timestamps starting at 0. Works for finished VODs and for recordings that are still live.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select the `extension` folder.

The extension only runs on `https://www.twitch.tv/videos/<id>` pages.

## Usage

1. Open a VOD. The **VOD audio replacement** panel starts closed in the top-right corner of the
   player. Click the **Unmute VOD** pill next to **Share** to open it; the pill toggles it and the
   panel's “—” button hides it. The pill is located by the Share icon, so a localized Twitch UI
   (for example «Поделиться») works the same way.
2. Click **Choose audio file** and pick your audio file (mp3, m4a, aac, ogg/opus, wav, flac).
   The file starts playing; the original is muted without changing the player's volume or mute UI.
   Volume follows the Twitch player slider (including the mute button) and the level meter in the
   panel shows the real signal. The percentage tooltip of the slider always matches the knob.
3. Pick a mode with **muted only** / **full track**. The choice is remembered and can be changed
   on the fly.
4. If the file does not start at the beginning of the recording, click **Sync now** at a moment
   when the file sound matches the picture. The offset is stored per VOD. Fine tuning:
   −1 s / −100 ms / −10 ms / +10 ms / +100 ms / +1 s.
5. **Download audio** saves the unmuted `audio_only` track as M4A. During the download the button
   becomes **Cancel download**; a cancelled download is discarded. For a still-recording VOD the
   extension keeps polling the playlist for new segments and finishes the file when the recording
   ends.
6. **Disable replacement** returns Twitch's own audio.

The “drift N ms” indicator is the current audio-to-picture offset. Up to ~40 ms is inaudible
(ITU-R BT.1359: 45 ms early / 125 ms late are the perception thresholds).

## How it works

### Sync engine

`extension/sync-engine.js` is a DOM-free controller with a two-tier correction: a hard seek when
the offset exceeds 150 ms, and a playback-rate nudge (≤2 %) for small drift. Video and audio time
are compared continuously; seeks, rate changes and buffering reset the clocks. Sync is time-based
only — Twitch media is cross-origin/MSE and cannot be captured for content-based alignment.

### Volume and mute

Twitch derives its volume UI from the `<video>` element, so muting the element to silence the
original also puts the player into mute. The page-world script shadows `volume` and `muted` on the
element instance: the element itself stays silent at 0/muted, while the page sees the user's
values, and every write is announced to the content script with a synthetic `volumechange` so
Twitch's percentage tooltip and internal store keep following the knob.

### Muted-only gating

While a file is playing, `updateGate()` compares `video.currentTime` with the GQL mute map on
every frame. Inside a muted range the original is silenced and the stem gain follows the player
volume; outside it the original is restored and the stem is muted. If the map has not loaded yet,
the extension falls back to full replacement so the recording never goes silent.

### CDN recovery

The extension asks GQL for an anonymous playback token, reads the master playlist and every media
playlist from the `usher` endpoint, finds `-muted` segments and probes their plain twins.
Measured on a VOD 2 h 53 min after the stream ended: `chunked` had 187 of 468 originals; 40 minutes
later, 139 — Twitch purges them in near-real time. The other renditions (720p60, 480p30, 360p30,
160p30, audio_only) had no originals at all. `72.ts` measured −23.9 dB mean level versus −91 dB in
`72-muted.ts`, so the CDN twin really carries audio. Rules are installed per exact URL
(`urlFilter`), never as a broad `-muted` regex, because coverage is partial and a broad rule would
403 the missing segments.

### Audio download

The page-world downloader reuses TwitchDownloader's approach: GQL token → `usher` master → the
`audio_only` media playlist → segment download. TS segments are transmuxed to fMP4/AAC with
mux.js (the same library hls.js uses) and written as a stream into the file chosen through the
File System Access API. Playlists are parsed with videojs `m3u8-parser` (fallback: built-in regex
parser). A VOD that is still `RECORDING` has no `#EXT-X-ENDLIST`: the playlist is re-read every
`max(3, targetDuration)` seconds and new segments are appended until the recording ends.

## Permissions

- `storage` — per-VOD offset, file name, mode, desired DNR rules.
- `declarativeNetRequest` — segment redirects.
- `host_permissions`: `www.twitch.tv`, `gql.twitch.tv`, `*.ttvnw.net`, `*.cloudfront.net`,
  `*.fastly.net`, `*.llnwd.net`, `*.akamaized.net` — Twitch and its CDNs. Without host access
  Chrome installs a DNR rule but does not apply it (verified).
- `optional_host_permissions: <all_urls>` — for CDNs not in the list.

No network request leaves the Twitch page origin for account data; GQL calls are anonymous.

## Limitations

- The file has to be picked again on every page load (the blob lives in tab memory).
- Offset steps are 10 ms; finer control is not meaningful for `<audio>`.
- Direct access to Twitch's own audio is impossible (cross-origin/MSE), so sync is time-based.
- Twitch segments have variable duration; segment indices cannot be derived from time, only
  discovered from the playlist.
- CDN originals exist only for a subset of muted segments and disappear within hours.
- In muted-only mode, if the mute map cannot be loaded, the extension behaves as full-track.

## Tests, CI and releases

```
npm install
npm test                  # unit + browser e2e
npm run test:unit         # 12 sync-engine checks with fake clocks
npm run test:e2e          # 26 Playwright checks against a fake Twitch
npm run lint
npm run format:check
```

The e2e harness (`test/e2e.mjs`) builds a localhost copy of the extension, serves a fake Twitch
player, GQL, usher, HLS playlists, TS segments, and drives the real extension in Chromium through
Playwright's persistent context. It covers the panel, launcher pill, mute map, pointwise/full
gating, volume paths, real audio RMS, seeks, rate changes, pause, disable, CDN verdicts and a real
DNR redirect, plus a full audio download whose M4A is verified with `ffprobe`.

Live probes (need a real Twitch VOD and network):

```
node test/probe-mute-ui.mjs <id>      # player stays unmuted; mute button controls the stem
node test/probe-modes.mjs <id>        # pointwise/full around a muted range, launcher gap
node test/probe-download.mjs <id> [n] # download n+ segments, cancel, ffprobe the file
node test/real-vod2.mjs <id> [t]      # full live pass: panel, map, replacement, CDN verdict
```

### GitHub Actions

- **CI** (`.github/workflows/ci.yml`) runs on every push and pull request: ESLint, Prettier check,
  unit tests and the Playwright e2e suite; it packages `dist/twitch-vod-unmute-v<version>.zip`
  and uploads it as a workflow artifact (14 days). Failed runs upload screenshots.
- **Release** (`.github/workflows/release.yml`) runs on `v*` tags, verifies that the tag equals
  the manifest version, repeats lint and all tests, packages the extension and creates a GitHub
  Release with the zip and generated notes.
- **CodeQL** scans JavaScript on pushes, pull requests and weekly; **Dependabot** updates npm and
  Actions weekly.
- **Publish to Chrome Web Store** is a manual workflow (`cws-publish.yml`). It uploads and
  publishes the package when `CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` and
  `CWS_REFRESH_TOKEN` secrets are configured; without them it only warns.

`npm run package` builds the store-ready zip locally after checking that every file referenced by
the manifest exists.

## Tooling

The implementation follows the tools professionals use for this class of task:

- [TwitchDownloader](https://github.com/lay295/TwitchDownloader) — reference for downloading
  Twitch VODs, including VODs that are still recording, and for audio-only quality selection.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) and
  [twitch-dlp](https://github.com/DmitryScaletta/twitch-dlp) — reference for Twitch HLS access,
  anonymous playback tokens and `--live-from-start` behavior.
- [streamlink](https://streamlink.github.io/) — reference for Twitch playlist handling.
- [mux.js](https://github.com/videojs/mux.js) — TS → fMP4 transmuxing (the hls.js stack).
- [m3u8-parser](https://github.com/videojs/m3u8-parser) — HLS media playlist parsing.
- [hls.js](https://github.com/video-dev/hls.js) — reference for browser HLS behavior.
- [Playwright](https://playwright.dev/docs/chrome-extensions) — the standard way to e2e-test
  Chrome extensions, including unpacked MV3 with a persistent context.
- [ESLint](https://eslint.org/), [Prettier](https://prettier.io/) and
  [GitHub Actions](https://docs.github.com/actions) — linting, formatting, CI.
- [upload-artifact](https://github.com/actions/upload-artifact),
  [action-gh-release](https://github.com/softprops/action-gh-release) — CI artifacts and releases.
- [CodeQL](https://codeql.github.com/) and
  [Dependabot](https://docs.github.com/code-security/dependabot) — code scanning and dependency
  updates.
- [chrome-webstore-upload-cli](https://github.com/fregante/chrome-webstore-upload-cli) — optional
  Chrome Web Store publishing from Actions.
- `ffmpeg`/`ffprobe` — fixture generation and verification in probes and tests.

## Project structure

```
extension/
  manifest.json           MV3: two MAIN-world scripts, sync engine, content script, service worker
  sync-engine.js          time-based sync controller (no DOM)
  content.js              panel, file picking, Web Audio, mute map, CDN search, modes, download UI
  gql-bridge.js           page world: mute map, usher playlists, CDN probes, volume shim, downloader
  background.js           per-segment DNR redirect rules (the SW is the only place DNR survives)
  panel.css
  vendor/mux.min.js       mux.js 6.3.0 (Apache-2.0)
  vendor/m3u8-parser.min.js  videojs m3u8-parser 7.2.1 (Apache-2.0)
test/
  sync-engine.test.mjs    unit tests with fake clocks
  e2e.mjs                 browser end-to-end suite
  page.html               fake Twitch player page
  fixtures/               audio/video/TS fixtures
  probe-*.mjs             live Twitch probes (network)
scripts/package.mjs       validates the manifest and builds dist/*.zip
.github/workflows/        CI, release, CodeQL, optional Chrome Web Store publish
.github/dependabot.yml    weekly npm and Actions updates
```
