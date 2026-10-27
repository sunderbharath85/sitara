# Sitara

A fast, private photo and video gallery for Windows, macOS and Linux. Built with Rust and React on [Tauri v2](https://tauri.app).

Sitara reads the folders you choose, builds one timeline of every photo and clip, and keeps everything on your device. No account, no upload, no cloud.

> **Status: early development (v0.1).** The foundation works end to end on Windows; macOS and Linux builds run in CI. Expect rough edges.

## What works today

- **Your folders, live:** add any folder (button, suggestions or drag-and-drop). Sitara indexes it in the background and watches it, so new, edited and deleted files show up on their own.
- **Fast timeline:** justified photo rows grouped by month, a year/month rail, and virtual scrolling built for 100k+ items.
- **Thumbnails:**
  - JPEG, PNG, WebP, GIF, BMP and TIFF decode in Rust, with EXIF orientation applied.
  - Video, HEIC and RAW use the Windows thumbnailer, or FFmpeg if installed.
  - Everything is cached on disk and pre-rendered in the background.
- **Viewer:**
  - Zooms out of the grid, then wheel or double-click to zoom and drag to pan.
  - Panels show EXIF (camera, lens, exposure, GPS), a live RGB histogram, the color palette and mood.
  - Videos play inline, plus a filmstrip and keyboard navigation.
- **Slideshow:**
  - Transitions: Ken Burns, push, iris, zoom, mosaic and blinds, plus an Auto mode that picks one per photo.
  - Smart portrait pairs, chapter cards, captions, and a timeline scrubber.
  - A soundtrack generated on your device, with slides that cut on the beat.
- **Smart albums:** **Trips** (photos far from your home city, grouped by date), **Places** (by nearest city, matched offline), and smart collections: Favorites, Videos, Screenshots, Panoramas, Selfies, Night, On this day, Recently added.
- **Cleanup:**
  - exact duplicates (byte-for-byte);
  - similar shots (visual fingerprint, catches resized and upscaled copies);
  - possibly blurry photos;
  - old screenshots.

  Each group gets a best pick scored on sharpness, exposure and resolution. `Enter` recycles the rest, with Undo.
- **Albums:** every folder becomes an album automatically; make your own from any selection.
- **Select and act:** click, Ctrl/Shift-click or lasso to select, then favorite, add to an album, play as a slideshow, or move to the Recycle Bin with **Undo**.
- **Search** (Ctrl K): file and folder names, cameras, years, months, "videos", "favorites".

## Keyboard

| Key | Action |
|---|---|
| `Ctrl K` or `/` | Search and commands |
| `1` `2` `3` `4` | Library, Albums, Cleanup, Folders |
| `P` | Slideshow (of the selection, the album, or everything) |
| `Ctrl A`, `Esc` | Select all, clear |
| `F`, `A`, `Del` | Favorite, add to album, Recycle Bin |
| Viewer: `←` `→` `I` `0` `Esc` | Navigate, info panels, reset zoom, close |
| Slideshow: `Space` `T` `M` `S` `F` | Pause, transition, music, style panel, fullscreen |
| Cleanup: `Enter` `S` `A` | Recycle marked, skip group, keep all |

## Roadmap

| Stage | What ships |
|---|---|
| 1. Foundation ✅ | Indexing and live watching, EXIF, thumbnail cache, timeline, viewer, albums, slideshow, installers |
| 2. Smart albums + cleanup ✅ | Trips and places, duplicate and blurry-shot finder, safe cleanup |
| 3. Editor | Non-destructive essentials, then curves, HSL, masks, healing and RAW |
| 4. On-device AI | Search by words (CLIP), faces and people. Models download on demand and run offline |
| 5. AI editing | To be designed |

## Develop

Requirements: Rust (stable), Node 22+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev      # desktop app with hot reload
npm run tauri build    # optimized app + installers in src-tauri/target/release/bundle
```

UI-only work: `npm run dev`, then open http://localhost:1420 in a browser. Outside Tauri, a mock backend with sample photos stands in for Rust.

Tests: `cd src-tauri && cargo test`.

How it fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The original interactive design concept is in `design/sitara-concept.html`.

## Principles

- **Private:** everything runs locally. The only network request is "Open in OpenStreetMap", and only when you click it.
- **Non-destructive:** Sitara never writes to your photo folders. Deletes go to the system Recycle Bin or Trash.
- **Light:** about 35 MB of RAM at idle, a small installer, and heavy AI models only as optional downloads.

## License

[GPL-3.0-or-later](LICENSE)

Place names: [GeoNames](https://www.geonames.org) cities database, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Rebuild the embedded copy with `scripts/geonames.py`.
