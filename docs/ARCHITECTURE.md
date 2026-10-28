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
│ raw.rs       RAW develop         export.rs    EXIF for exports    │
│ ai/          CLIP search, faces, people, pinned model downloads   │
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

## Editor (stage 3)

- **The edit stack is data.** `src/lib/edit/stack.ts` defines it: global adjustments, the look and its strength, curves, color mixer, grading, geometry (quarter turns, flip, straighten, crop), masks and heal spots.
  - It is saved as JSON in the `edits` table, one row per photo.
  - The original file is never written.
  - Masks and heal spots live in *p-space*: the upright source scaled so its long edge is 1. That way they stay attached to the content when you crop or rotate.
- **Rendering** (`src/lib/edit/renderer.ts`, `shaders.ts`) is WebGL2. The source sits on the GPU at full resolution, mipmapped. Each change re-runs only the passes it touches:
  1. **Heal:** copies each spot's source patch onto it, plus a color offset measured from the rings around both patches, with a feathered edge.
  2. **Blur:** a 320 px luminance and dark-channel image, the local base for clarity, shadows/highlights and dehaze.
  3. **Brush masks:** instanced dabs into two RGBA atlases, one mask per channel.
  4. **Develop:** one fragment shader does everything per pixel:
     - in linear light: white balance, exposure, dehaze;
     - on perceptual luminance, applied as a ratio so hue is kept: tone;
     - in OKLab: vibrance, saturation, color mixer, grading;
     - then gamut mapping, vignette, curves (LUT), fade, grain and dither.
     - Each mask adds its own sliders to the global ones, weighted per pixel.
- **Geometry** (`geometry.ts`, `view.ts`) is a chain of 2D affine maps: screen → output → straightened frame → quarter turns → source uv. The crop is kept legal (inside the photo) by bisection over valid states.
- **Sources** (`source.ts`):
  - JPEG, PNG and WebP are decoded by the webview (`createImageBitmap`, EXIF-upright, color-managed).
  - RAW, HEIC and TIFF come from `preview://localhost/{id}?full=1` as raw pixels in an `SRC1` container.
  - RAW (`raw.rs`, via rawler) is demosaiced, white-balanced and converted to linear sRGB. It is then packed as 10-bit log codes (RGB10_A2), keeping about four stops above white for highlight recovery.
- **Saving** renders a 360 px-tall thumbnail and a 2560 px preview of the result. Rust stores them as `et/` and `ep/` next to the thumbnail cache, and `thumb://` and `preview://` serve them in place of the original's renders.
  - The library record gets an *edited* flag and the cropped size.
  - Its version mixes in the edit revision (the save time), so every cached URL refreshes.
- **Export** renders the output in 2048 px tiles and encodes it with the webview's encoder. Rust then writes the file:
  - for JPEG, it carries over the original's EXIF, marked upright, with the new size, and without the old thumbnail, MakerNote or (unless asked) GPS;
  - it refuses to overwrite the original.

## On-device AI (stage 4)

- **Nothing ships in the installer.** Turning a feature on (Folders → On-device AI) downloads its pieces into `%LOCALAPPDATA%\app.sitara.photos\models`:
  - ONNX Runtime 1.31: Microsoft's release library, loaded at runtime with `ort`'s `load-dynamic`. On Windows only the DLL is pulled out of the release zip, using HTTP range requests on its central directory.
  - The models, from Hugging Face.
  - Every file is checked against a SHA-256 pinned in `ai/mod.rs` before it is used.
- **Learning** runs on the warmer thread after thumbnails and analysis. Each photo is decoded once (the upright original at 1600 px or less; videos use their thumbnail), then used for both passes:
  - **CLIP ViT-B/32** (int8 ONNX) turns it into a 512-d vector, stored as int8 in `clip`.
  - **YuNet** finds faces with five landmarks. Each face is aligned to the ArcFace template with a least-squares similarity transform, and **SFace** turns it into a 128-d vector, stored in `faces` with a box normalized to the upright photo.
  - `ai_done` records which passes have seen a photo, so photos without faces aren't rescanned.
  - A changed file drops its rows and is learned again.
- **Search by meaning** (`ai_search`):
  - The query becomes `a photo of {query}.`, is tokenized with CLIP's byte-level BPE (`ai/clip.rs`) and embedded by the text model.
  - It is then scored against every vector in memory (int8 dot products; 100k photos is 51 MB).
  - Results within 0.05 of the best match, and above 0.245, are kept (unrelated photos sit around 0.20; calibrated on a 6k-photo library).
  - The UI lists exact name, folder and camera matches first, then matches by meaning. Queries made only of words the text search understands (years, months, "videos") skip it.
- **People** (`ai/people.rs`):
  - A new face joins the person whose average face is most similar (cosine ≥ 0.42; OpenCV suggests 0.363 for SFace).
  - The rest are grouped with each other (≥ 0.46), and a group of three faces in at least two photos becomes an unnamed person.
  - Names, merges, hiding and "not this person" are the user's, and regrouping never undoes them.
  - Portraits are cropped from the original on demand (`thumb://localhost/face/{id}`) and cached.

## AI editing (stage 5)

- **One pack per feature.** These download on demand like stage 4, each pinned by SHA-256 in `ai/mod.rs`:
  - remove objects: LaMa
  - subject: BiRefNet-lite
  - sky: U²-Net skyseg
  - denoise: NAFNet-SIDD
  - upscale: Real-ESRGAN general-x4v3
  - depth: Depth Anything V2 Small

  The editor offers each download where it's needed. The Folders card lists what is installed and deletes it on request.
- **Pixels in, pixels out.** `ai_op` runs a model on RGBA the editor sends and returns RGBA, a mask, or JSON.
  - The editor takes the pixels off the GPU (`Renderer.extract`), decoded and upright, so RAW, HEIC and TIFF work the same as JPEG.
  - For RAW, highlights above white are rolled off before a model sees them.
- **Results are layers.** `ai_layer_put` stores a PNG content-addressed by its BLAKE3 hash in `%LOCALAPPDATA%\app.sitara.photos\layers`, and `thumb://localhost/layer/{hash}` serves it. Edit stacks refer to layers by hash; on startup, layers no saved stack mentions are deleted. Uses of layers in the stack:
  - `ai.base`: a denoised or upscaled copy that stands in for the source. Upscaling changes the working size; masks and spots don't need adjusting, because they live in p-space.
  - `ai.patches`: removal results. Each is RGBA with a feathered alpha over a source-uv rectangle, composited in order after healing.
  - `ai.blur`: depth and subject masks for lens blur. The blur radius grows behind the focus plane (the subject's depth), and samples skip the subject so it doesn't bleed. Removing an object recomputes these maps.
  - AI masks (`kind: "ai"`): subject or sky as a grayscale layer, copied into the mask atlas like a brush mask.
- **Render order:** source → base blend → heal + patches → background blur → develop.
- **Describe an edit** (`edit/describe.ts`) is rule-based and fully offline.
  - Phrases become slider changes, scaled by "a bit" or "very".
  - Words about the sky or faces become masks: sky segmentation, or radial masks at faces YuNet finds.
  - Blur and noise words trigger those tools.
  - Style words ("like an old film") are matched by rendering every look at 224 px and scoring each against the text with CLIP. A look is applied only if it beats the unchanged photo by a clear margin.

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
| Renders of edited photos | `%LOCALAPPDATA%\app.sitara.photos\thumbs\et\` and `ep\` |
| Face portraits | `%LOCALAPPDATA%\app.sitara.photos\thumbs\f\` |
| AI models and runtime (optional) | `%LOCALAPPDATA%\app.sitara.photos\models\` |
| AI edit layers (removals, masks, denoise/upscale) | `%LOCALAPPDATA%\app.sitara.photos\layers\` |

## Developing without Tauri

`npm run dev` and open http://localhost:1420 in a browser. Outside Tauri, `src/lib/mock.ts` stands in for the backend, with sample images from picsum.photos, so UI work and browser tests don't need a native build.
