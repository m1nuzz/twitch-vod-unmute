# AGENTS.md

Guidance for AI agents and contributors working on **Twitch VOD Unmute**.

## What this project is

A Chrome Manifest V3 extension that restores the audio Twitch silences in VODs (DMCA-muted
segments are served as `N-muted.ts`). It can play a user-selected full-stream audio file instead
of the muted audio — either only inside muted ranges (default) or for the whole track — recover
unmuted originals from the Twitch CDN with DNR rules, and download the `audio_only` track as M4A.

Repository: https://github.com/m1nuzz/twitch-vod-unmute

## Commands

```bash
npm ci                          # install dev deps (Playwright pinned in package-lock.json)
npx playwright install chromium # one-time browser download for e2e

npm run lint                    # ESLint flat config
npm run format:check            # Prettier
npm run test:unit               # 12 sync-engine checks, fake clocks
npm run test:e2e                # 35 Playwright checks against a fake Twitch
npm test                        # unit + e2e (what CI runs)
npm run package                 # validates the manifest and builds dist/*.zip
```

Live probes need network and a real VOD; they are not part of CI:

```bash
node test/probe-mute-ui.mjs <vodId>
node test/probe-modes.mjs <vodId>
node test/probe-download.mjs <vodId> [segments]
node test/real-vod2.mjs <vodId>
```

## Architecture

| File                                  | World                  | Responsibility                                                                                         |
| ------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `extension/manifest.json`             | —                      | MV3, version is the release version                                                                    |
| `extension/gql-bridge.js`             | MAIN, `document_start` | GQL mute map, usher playlists, CDN probes, `VXR_SILENCE`/`VXR_UNSILENCE` volume shim, audio downloader |
| `extension/vendor/m3u8-parser.min.js` | MAIN, `document_idle`  | HLS media playlist parsing (fallback: built-in regex parser)                                           |
| `extension/vendor/mux.min.js`         | MAIN, `document_idle`  | TS → fMP4/AAC transmux for the downloader                                                              |
| `extension/sync-engine.js`            | isolated               | DOM-free two-tier sync between VOD time and the audio file                                             |
| `extension/content.js`                | isolated               | Panel UI, file input, Web Audio graph, mute map, modes, CDN search, download UI                        |
| `extension/background.js`             | SW                     | Dynamic per-segment DNR redirect rules                                                                 |
| `extension/panel.css`                 | isolated               | Panel and launcher styles                                                                              |

Message flow: content → page world via `CustomEvent("VXR_REQ", { detail: JSON.stringify(...) })`
and replies on `VXR_RES`; page → content via `VXR_VOLUME`, `VXR_DL`, `VXR_SILENCE`,
`VXR_UNSILENCE`. Always serialize event payloads as JSON strings — object `detail` does not cross
isolated-world boundaries reliably.

## Non-negotiable domain rules

- **Never set `video.muted` / `video.volume` from the content script.** Twitch mirrors the element
  state into its UI and the player flips to mute. Use `VXR_SILENCE` / `VXR_UNSILENCE`; the page
  world shadows the instance properties, keeps the element silent, and dispatches a synthetic
  `volumechange` when the fake values change (Twitch's volume % tooltip syncs only on that event).
- **Mute map entries are `{ start, duration }`**, not `offset`. The CDN search's GQL response also
  carries `{ offset, duration }`, but `muteInfo()` normalizes to `start`.
- **Prev/next jumps land inside the muted range** (`start + 0.25`), step by range index and wrap at
  both ends. Parking before the range left the player outside the muted moment and made a second
  click skip the range it was sitting on.
- **Pointwise mode is the default and is live**: gating is evaluated every frame against
  `vod.currentTime`; a seek in or out of a range must switch the original/stem instantly. If the
  map is not loaded yet, behave as full-track; an empty loaded map means the original only.
- **CDN recovery must install exact per-segment `urlFilter` rules**, never a broad `-muted` regex:
  plain twins exist only for a subset of muted segments in `chunked` (1080p60/Source) and Twitch
  purges them within hours. Verify the redirect by actually fetching a rewritten URL.
- **DNR lives in the service worker only.** Desired rules persist in `chrome.storage.local` under
  `vxrRules` and are re-applied on every SW wake.
- **Bump the manifest version for every release.** An unpacked extension's SW script stays cached
  in a long-lived Chrome profile until the manifest version changes.
- **Download transmuxing**: use the default `muxjs.mp4.Transmuxer` (timestamps start at 0). Do not
  set `keepOriginalTimestamps` or per-push `setBaseMediaDecodeTime` — the former keeps the original
  PTS, the latter collapses duration when segment PTS repeat. Poll the media playlist until
  `#EXT-X-ENDLIST` for recordings that are still live.
- **Download progress**: percent comes from segment counts (playlist total). Total bytes start at
  `audio_only` `BANDWIDTH × duration` and are re-calibrated as `bytes / downloaded media seconds ×
total duration` after ~10 s. The file is generated in the tab and streamed through the File
  System Access API, so Chrome's download manager cannot own it (`chrome.downloads` needs a ready
  URL; buffering a multi-hour VOD in memory is not acceptable). Progress lives in the panel.
- **Unmuted download**: only the `chunked` (source/1080p60) rendition keeps plain twins, and only
  per segment. Both `audio_only` and `chunked` playlists use a 10 s grid, so an audio segment is
  replaced only when whole chunks cover its range. Extract the chunk's AAC with
  `new muxjs.mp4.Transmuxer({remux:false})` (audio-only init + fragment), normalise the `tfhd`
  track ID (audio-only 256, source audio 257) and rewrite the fragment `tfdt` to the running
  output timeline. Check that `mp4a` rate/channels match, otherwise keep the silent segment. This
  path downloads the 1080p60 chunks themselves (~8 Mbps), so coverage and size are both partial.
- **UI language is English.** Twitch localizes both the visible Share label and its aria-label, so
  locate the Share button by the share icon (`button svg path[d^="M13 6v10h-2V6"]`), with the
  English aria-label and a localized label list as fallbacks. Never rely on English text alone —
  that removed the launcher on the Russian UI once.
- **A reloaded extension leaves stale content scripts in open tabs**: every `chrome.*` call from
  them throws `Extension context invalidated`. Route storage and messaging through
  `extensionAlive()` / `markContextLost()`; never leave a storage promise rejecting unhandled.
  The script also swallows matching `unhandledrejection`/`error` events and checks the context on
  the 1 s poll; the panel then tells the user to refresh the page instead of failing silently.
- **The panel starts hidden** (`vxr-hidden` set in `buildUI`); only the Unmute VOD pill opens it.
  In tests, wait for `#vxr-panel` with `state: "attached"` and click `.vxr-unmute` before using
  panel buttons.

## Conventions

- Plain ES5-style browser JS in `extension/` (no build step, no bundler); Node ESM in tests and
  scripts.
- 2-space indent, double quotes, no trailing commas (`Prettier`, width 180). Run `npm run format`
  after edits; CI enforces `format:check`.
- Tests must never use machine-specific paths. Playwright is loaded with
  `createRequire(import.meta.url)` from the repo's own `node_modules`.
- The e2e harness copies `extension/` to `test/.build/ext`, rewrites content-script matches to
  localhost and the GQL/usher URLs to the local fake server. Extend the fake server when testing
  new network behavior.
- Use fresh Playwright profiles under `test/.build/`; never launch, kill or attach to the user's
  own Chrome.
- Test artifacts stay in `.build/`, `test/.build/`, `dist/`, `node_modules/` (gitignored).

## Release process

1. Update `extension/manifest.json` version and run `npm version <x.y.z> --no-git-tag-version`.
2. `npm test && npm run package` — verify `dist/twitch-vod-unmute-v<x.y.z>.zip`.
3. Commit, push, then tag and push the tag:

   ```bash
   git tag -a v<x.y.z> -m "Twitch VOD Unmute <x.y.z>"
   git push origin v<x.y.z>
   ```

4. The **Release** workflow verifies that the tag equals the manifest version, reruns lint and all
   tests, packages the extension and publishes the GitHub Release with the zip.

The **CI** workflow runs on every push/PR (lint, format, unit + e2e, package artifact). **CodeQL**
scans shipped code (`security-and-quality`); live probes under `test/probe-*.mjs` are excluded
because they intentionally download and write Twitch segments. **Dependabot** updates npm and
Actions weekly. **Publish to Chrome Web Store** is a manual workflow enabled by the
`CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` and `CWS_REFRESH_TOKEN` secrets.

## Security

- Never commit credentials, cookies, tokens or captured URLs with signatures. Anonymous Twitch
  client ID in `gql-bridge.js` is public by design.
- CodeQL alerts must be triaged, not ignored: fix real issues, dismiss false positives with a
  written justification, and keep intentional test-only findings out of the scan (config-file).
