# Sitara architecture

Sitara is a Tauri v2 app: a Rust core that owns the library, and a React UI rendered by the system webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux).

```
┌──────────────────────── React UI (src/) ─────────────────────────┐
│ Grid (virtualized justified timeline) · Viewer · Slideshow       │
│ Albums · Folders · Palette · store.ts (tiny global store)        │
└──────▲───────────────────────▲─────────────────────▲─────────────┘
       │ invoke() IPC          │ thumb:// preview://  │ asset://
       │ events                │ (cached JPEGs)        │ (originals)
┌──────┴───────────────────────┴─────────────────────┴─────────────┐
│ Rust core (src-tauri/src/)                                        │
│ commands.rs  IPC API             protocol.rs  thumbnail serving   │
│ scan.rs      indexer + warmer    thumbs.rs    render + disk cache │
│ watch.rs     live folder watch   shell.rs     Windows thumbnailer │
│ meta.rs      EXIF + MP4 parsing  db.rs        SQLite (WAL)        │
└───────────────────────────────────────────────────────────────────┘
```

## Data flow

1. **Add folder:** the folder is stored in `folders`, added to the asset-protocol scope, watched with `notify`, and queued for a scan.
2. **Scan (`scan.rs`):** a single indexer thread walks the tree. Unchanged files (same size and mtime) are skipped. New or changed files have their metadata read in parallel (rayon), then are written in transactions of 256 rows. Each batch emits `library-changed`, so the grid fills in while a large library is still indexing. Files that disappeared are removed.
3. **Watch (`watch.rs`):** debounced file-system events become `Job::Paths`, handled by the same indexer thread. Files moved to the Recycle Bin by Sitara stay in the database, flagged `trashed`, until the session ends, so Undo can restore them with the same id, albums and favorites.
4. **Library to UI:** `library` returns every visible item packed as 24-byte records (id, version, capture time, size, kind, favorite, duration). 100k items are about 2.4 MB, decoded into typed arrays in under 10 ms. The UI never asks for pages.
5. **Thumbnails:**
   - The grid requests `thumb://localhost/{id}?v={mtime}`, so cached responses are immutable.
   - The handler serves the JPEG cache, or renders on demand on a FIFO semaphore, so visible tiles come first.
   - A background warmer pre-renders everything else on half the CPU cores.
6. **Rendering (`thumbs.rs`):**
   - JPEG/PNG/WebP/GIF/BMP/TIFF decode in Rust, with EXIF orientation applied, then resize with `fast_image_resize`.
   - Video, HEIC and RAW use the Windows Shell thumbnailer (`IShellItemImageFactory`, backed by the OS thumbnail cache), then FFmpeg if it is on `PATH`.
7. **Viewer:** the cached thumbnail appears instantly, then the original swaps in. Originals load through the asset protocol, or through `preview://` for formats the webview can't decode. The histogram, palette and mood tags are computed from the thumbnail's pixels in a canvas.

## Smart albums and cleanup (stage 2)

- **Analysis (`analysis.rs`):**
  - After a photo's thumbnail is cached, the warmer computes from it a 64-bit difference hash, a sharpness score (variance of the Laplacian), mean brightness, contrast, and the share of clipped pixels. These go in the `analysis` table.
  - Reading the 360 px thumbnail instead of the original keeps this at a few milliseconds per photo.
  - When a file changes, its analysis row and content hash are dropped.
- **Cleanup (`cleanup.rs`, on demand):**
  - **Exact duplicates:** blake3, only for files that share a size with another file, cached in `media.chash`.
  - **Similar shots:** a Hamming distance of 4 or less anywhere in the library, found without comparing every pair. Any two hashes that close share at least one identical 16-bit quarter, so photos are bucketed by each quarter and compared only within buckets. Bursts get a looser match (distance 8 or less, up to 10 s apart).
  - **Possibly blurry:** low sharpness in a scene that has real contrast.
  - **Old screenshots:** matched by file and folder name.
  - **Best pick:** scored on sharpness, exposure, resolution and clipping, and favorites always win.
- **Smart albums (`smart.rs`, on demand):**
  - GPS points map to the nearest city with 15k+ people (`geo.rs`, embedded GeoNames data on a 1° grid).
  - Home is your most frequent city.
  - Trips are runs of photos with no gap over 30 h, whose cities cluster more than 60 km from home; neighbouring runs in the same city merge.
  - Places are per-city groups of 5 or more photos.
  - Collections are simple rules over the media table.

## Conventions

- **Capture time** (`taken`) is the wall-clock time the photo was taken, stored as seconds as if it were UTC. Every UI formatter uses `timeZone: "UTC"`, so a photo taken at 9:00 in Kyoto reads 9:00 everywhere. Order of preference: EXIF `DateTimeOriginal`, then MP4 `mvhd` creation time converted to local time, then file mtime.
- **Media ids** use `AUTOINCREMENT` and are never reused, because they key the thumbnail cache.
- **Originals are read-only.** Sitara never writes to library folders. Deletes go to the OS Recycle Bin or Trash.

## Storage

| What | Where (Windows) |
|---|---|
| Library database | `%APPDATA%\app.sitara.photos\library.db` |
| Thumbnails (360 px tall JPEG) | `%LOCALAPPDATA%\app.sitara.photos\thumbs\t\` |
| Large previews (HEIC/RAW/TIFF) | `%LOCALAPPDATA%\app.sitara.photos\thumbs\p\` |

## Developing without Tauri

`npm run dev` and open http://localhost:1420 in a browser. Outside Tauri, `src/lib/mock.ts` stands in for the backend, with sample images from picsum.photos, so UI work and browser tests don't need a native build.

## Roadmap hooks

- **Smart albums and cleanup:** perceptual hashes and sharpness scores computed in the warmer pass, stored next to `media`.
- **Editor:** a non-destructive edit stack per media id, rendered on the GPU in the viewer.
- **AI:** ONNX Runtime with on-demand model download; CLIP embeddings and face clusters in their own tables.
