# Sitara

A fast, private photo and video gallery for Windows, macOS and Linux. Built with Rust and React on [Tauri v2](https://tauri.app).

Sitara reads the folders you choose, builds a timeline of every photo and clip, and keeps everything on your device. No account, no upload, no cloud.

> **Status: early development.** The interactive design prototype is done (`design/sitara-concept.html`). The desktop app foundation is being built now.

## Roadmap

| Stage | What ships |
|---|---|
| 1. Foundation | Folder indexing with live watching, EXIF, thumbnail cache, SQLite library, justified timeline grid, photo and video viewer, folder and manual albums, slideshow, installers |
| 2. Smart albums + cleanup | Trips and places auto-albums, duplicate and blurry-shot finder, safe Recycle Bin cleanup |
| 3. Editor | Non-destructive essentials, then curves, HSL, masks, healing and RAW |
| 4. On-device AI | Search by words (CLIP), faces and people. Models download on demand and run offline |
| 5. AI editing | To be designed |

## Design

Open `design/sitara-concept.html` in a browser to try the concept. It covers the library, viewer, albums, people, cleanup, memory reel and slideshow. It needs internet for sample photos.

Direction: **Noir Glass**, a near-black canvas where photos are the only color, frosted floating chrome and one signal-orange accent, plus a maximalist motion layer.

## Develop

Requirements: Rust (stable), Node 20+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev
```

Build installers:

```sh
npm run tauri build
```

## Principles

- **Private:** everything runs locally; nothing leaves the machine.
- **Non-destructive:** originals are never modified, and deletes go to the system Recycle Bin with undo.
- **Light:** cold start under a second, smooth scrolling through 100k+ items, small installer. Heavy AI models are optional downloads.

## License

[GPL-3.0-or-later](LICENSE)
