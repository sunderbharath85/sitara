//! On-device AI: search by meaning (CLIP) and people (face detection + recognition).
//!
//! Nothing ships with the app. When the user turns a feature on, Sitara downloads ONNX Runtime and the
//! models once, checks each against a pinned SHA-256, and from then on everything runs locally: photos
//! never leave the machine.

pub mod clip;
pub mod edit;
pub mod faces;
pub mod fetch;
pub mod people;

use crate::{db, thumbs};
use image::{DynamicImage, RgbImage};
use ort::session::Session;
use ort::value::Tensor;
use rusqlite::{Connection, params};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

struct Asset {
    file: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
    /// Library inside a release archive (zip or tgz).
    member: Option<&'static str>,
}

const ORT: &str = "https://github.com/microsoft/onnxruntime/releases/download/v1.31.0";

#[cfg(all(windows, target_arch = "x86_64"))]
const RUNTIME: Option<Asset> = Some(Asset {
    file: "onnxruntime.dll",
    url: "onnxruntime-win-x64-1.31.0.zip",
    sha256: "0c42dc4e278f0968fdf9ebf1b1e54a74c657a9942e70803e453c91993451cf4c",
    size: 17_253_176,
    member: Some("lib/onnxruntime.dll"),
});
#[cfg(all(windows, target_arch = "aarch64"))]
const RUNTIME: Option<Asset> = Some(Asset {
    file: "onnxruntime.dll",
    url: "onnxruntime-win-arm64-1.31.0.zip",
    sha256: "b6da671624bce049c13c34a3b48b7ddfd1b521dbf07d20e83ff9af4441110641",
    size: 17_507_640,
    member: Some("lib/onnxruntime.dll"),
});
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const RUNTIME: Option<Asset> = Some(Asset {
    file: "libonnxruntime.so",
    url: "onnxruntime-linux-x64-1.31.0.tgz",
    sha256: "469849977cb60744ea160927e1a3a0643fd4c55c0aff743251c6d293402e334e",
    size: 29_345_384,
    member: Some("lib/libonnxruntime.so.1.31.0"),
});
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const RUNTIME: Option<Asset> = Some(Asset {
    file: "libonnxruntime.so",
    url: "onnxruntime-linux-aarch64-1.31.0.tgz",
    sha256: "595c7f7a6775f5c7b3d567c3ed94c04f722092575abcc092560f5208a54daf99",
    size: 25_266_408,
    member: Some("lib/libonnxruntime.so.1.31.0"),
});
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const RUNTIME: Option<Asset> = Some(Asset {
    file: "libonnxruntime.dylib",
    url: "onnxruntime-osx-arm64-1.31.0.tgz",
    sha256: "2a50a63e7f41f8d4d551d3ee47248df3864f6540109fce8ad520ca3b51af4b70",
    size: 44_830_288,
    member: Some("lib/libonnxruntime.1.31.0.dylib"),
});
#[cfg(not(any(
    all(windows, any(target_arch = "x86_64", target_arch = "aarch64")),
    all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")),
    all(target_os = "macos", target_arch = "aarch64")
)))]
const RUNTIME: Option<Asset> = None;

/// OpenAI CLIP ViT-B/32 (MIT), int8-quantized ONNX export.
const SEARCH: [Asset; 4] = [
    Asset {
        file: "clip-vision.onnx",
        url: "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx",
        sha256: "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299",
        size: 89_117_001,
        member: None,
    },
    Asset {
        file: "clip-text.onnx",
        url: "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/text_model_quantized.onnx",
        sha256: "73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a",
        size: 64_504_507,
        member: None,
    },
    Asset {
        file: "clip-vocab.json",
        url: "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/vocab.json",
        sha256: "5047b556ce86ccaf6aa22b3ffccfc52d391ea4accdab9c2f2407da5b742d4363",
        size: 862_328,
        member: None,
    },
    Asset {
        file: "clip-merges.txt",
        url: "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/merges.txt",
        sha256: "9fd691f7c8039210e0fced15865466c65820d09b63988b0174bfe25de299051a",
        size: 524_619,
        member: None,
    },
];

/// YuNet face detector (MIT) and SFace recognizer (Apache-2.0) from the OpenCV model zoo.
const PEOPLE: [Asset; 2] = [
    Asset {
        file: "yunet.onnx",
        url: "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
        sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
        size: 232_589,
        member: None,
    },
    Asset {
        file: "sface.onnx",
        url: "https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx",
        sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
        size: 38_696_353,
        member: None,
    },
];

/// AI editing models (stage 5), one optional pack per feature.
const ERASE: [Asset; 1] = [Asset {
    // LaMa (Apache-2.0): fills a masked region from its surroundings
    file: "lama.onnx",
    url: "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
    sha256: "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
    size: 208_044_816,
    member: None,
}];
const SUBJECT: [Asset; 1] = [Asset {
    // BiRefNet-lite (MIT): the main subject, as a soft mask
    file: "birefnet.onnx",
    url: "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx",
    sha256: "d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402",
    size: 114_538_221,
    member: None,
}];
const SKY: [Asset; 1] = [Asset {
    // U2-Net sky segmentation (MIT)
    file: "skyseg.onnx",
    url: "https://huggingface.co/JianyuanWang/skyseg/resolve/main/skyseg.onnx",
    sha256: "ab9c34c64c3d821220a2886a4a06da4642ffa14d5b30e8d5339056a089aa1d39",
    size: 175_997_079,
    member: None,
}];
const DENOISE: [Asset; 1] = [Asset {
    // NAFNet trained on SIDD real-camera noise (MIT)
    file: "nafnet.onnx",
    url: "https://huggingface.co/tomfl/obscura-models/resolve/main/nafnet-sidd-w32-fp16.onnx",
    sha256: "74bb136d6e78ebab8490c7db29b5bda37c270bd382a03990c66d9cc17271f581",
    size: 58_957_563,
    member: None,
}];
const UPSCALE: [Asset; 1] = [Asset {
    // Real-ESRGAN general x4v3 (BSD-3-Clause)
    file: "esrgan.onnx",
    url: "https://huggingface.co/jonathanst29/tinier-upscale-models/resolve/main/realesr-general-x4v3.onnx",
    sha256: "924ebad6532777303582d4ce7811849b88869231a3ae7093e0f21200249df8d5",
    size: 4_866_396,
    member: None,
}];
const DEPTH: [Asset; 1] = [Asset {
    // Depth Anything V2 Small (Apache-2.0)
    file: "depth.onnx",
    url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx",
    sha256: "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c",
    size: 99_060_839,
    member: None,
}];

const COLORIZE: [Asset; 1] = [Asset {
    // DDColor-tiny (Apache-2.0): color for black-and-white photos
    file: "ddcolor.onnx",
    url: "https://huggingface.co/edgetools/ddcolor/resolve/main/ddcolor-tiny-fp16.onnx",
    sha256: "2653da00dc15e54a45e5200b61dbf82ee9ceaf56b02bb9b9657569ac775e82e6",
    size: 135_444_402,
    member: None,
}];
/// GFPGAN v1.4 (Apache-2.0, with some upstream components under non-commercial terms) restores faces; it
/// shares YuNet with People to find them.
const RESTORE: [Asset; 2] = [
    Asset {
        file: "gfpgan.onnx",
        url: "https://huggingface.co/HowToSD/GFPGAN-ONNX/resolve/main/GFPGANv1.4.onnx",
        sha256: "15c36ba1a8304e077a9d99954427eac3fb604bb790636dd5e34e72cdeb0830d8",
        size: 340_357_025,
        member: None,
    },
    Asset {
        file: "yunet.onnx",
        url: "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
        sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
        size: 232_589,
        member: None,
    },
];

/// Every optional pack: key, display name, files.
const PACKS: [(&str, &str, &[Asset]); 10] = [
    ("search", "Search model", &SEARCH),
    ("people", "Face models", &PEOPLE),
    ("erase", "Remove objects model", &ERASE),
    ("subject", "Subject model", &SUBJECT),
    ("sky", "Sky model", &SKY),
    ("denoise", "Denoise model", &DENOISE),
    ("upscale", "Upscale model", &UPSCALE),
    ("depth", "Depth model", &DEPTH),
    ("colorize", "Colorize model", &COLORIZE),
    ("restore", "Face restoration model", &RESTORE),
];

fn pack(key: &str) -> Option<(&'static str, &'static [Asset])> {
    PACKS.iter().find(|p| p.0 == key).map(|p| (p.1, p.2))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub key: &'static str,
    pub on: bool,
    pub mb: u64,
}

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub label: String,
    pub done: u64,
    pub total: u64,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub supported: bool,
    pub search: bool,
    pub people: bool,
    pub search_mb: u64,
    pub people_mb: u64,
    pub runtime_mb: u64,
    pub download: Option<Download>,
    pub indexed: i64,
    pub pending: i64,
    pub faces: i64,
    pub working: bool,
    /// Every optional pack (search, people and the editing models), installed or not.
    pub packs: Vec<Pack>,
}

#[derive(Default)]
struct Engines {
    vision: Option<Session>,
    text: Option<Session>,
    det: Option<Session>,
    rec: Option<Session>,
    /// Editing models, loaded on first use and released when the editor closes.
    edit: std::collections::HashMap<&'static str, Session>,
}

pub struct Ai {
    pub dir: PathBuf,
    /// Pixels made by AI edits, content-addressed (`{hash}.png`), referenced from edit stacks.
    pub layers: PathBuf,
    env: Mutex<Option<ort::environment::Environment>>,
    engines: Mutex<Engines>,
    tok: Mutex<Option<Arc<clip::Tokenizer>>>,
    download: Mutex<Option<Download>>,
    installing: AtomicBool,
    pub working: AtomicBool,
    /// Normalized int8 CLIP vectors, loaded on first search and refreshed when the count changes.
    index: Mutex<Option<Arc<Index>>>,
}

pub struct Index {
    ids: Vec<i64>,
    vecs: Vec<i8>,
}

impl Ai {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            layers: dir.parent().map(|p| p.join("layers")).unwrap_or_else(|| dir.join("layers")),
            dir,
            env: Mutex::new(None),
            engines: Mutex::new(Engines::default()),
            tok: Mutex::new(None),
            download: Mutex::new(None),
            installing: AtomicBool::new(false),
            working: AtomicBool::new(false),
            index: Mutex::new(None),
        }
    }

    fn has(&self, assets: &[Asset]) -> bool {
        assets.iter().all(|a| self.dir.join(a.file).is_file())
    }
    fn runtime_ok(&self) -> bool {
        RUNTIME.as_ref().is_some_and(|r| self.dir.join(r.file).is_file())
    }
    pub fn search_on(&self) -> bool {
        self.runtime_ok() && self.has(&SEARCH)
    }
    pub fn people_on(&self) -> bool {
        self.runtime_ok() && self.has(&PEOPLE)
    }
    pub fn any_on(&self) -> bool {
        self.search_on() || self.people_on()
    }
    pub fn pack_on(&self, key: &str) -> bool {
        self.runtime_ok() && pack(key).is_some_and(|(_, a)| self.has(a))
    }

    pub fn status(&self, c: &Connection) -> AiStatus {
        let mb = |a: &[Asset]| a.iter().map(|x| x.size).sum::<u64>() / 1_000_000;
        let count = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
        let (s, p) = (self.search_on(), self.people_on());
        AiStatus {
            supported: RUNTIME.is_some(),
            search: s,
            people: p,
            search_mb: mb(&SEARCH),
            people_mb: mb(&PEOPLE),
            runtime_mb: if self.runtime_ok() { 0 } else { RUNTIME.as_ref().map(|r| r.size / 1_000_000).unwrap_or(0) },
            download: self.download.lock().unwrap().clone(),
            indexed: count("SELECT COUNT(*) FROM ai_done WHERE clip=1 OR faces=1"),
            pending: if s || p { count(&pending_sql(s, p, true)) } else { 0 },
            faces: count("SELECT COUNT(*) FROM faces"),
            working: self.working.load(Ordering::Relaxed),
            packs: PACKS.iter().map(|(k, _, a)| Pack { key: k, on: self.pack_on(k), mb: mb(a) }).collect(),
        }
    }

    // ---------- install ----------

    /// Download what `feature` needs (a pack key) on a background thread, reporting progress.
    pub fn install(self: &Arc<Self>, app: AppHandle, feature: String, done: impl FnOnce() + Send + 'static) -> Result<(), String> {
        let rt = RUNTIME.as_ref().ok_or("On-device AI isn't available for this kind of computer yet.")?;
        let (name, models) = pack(&feature).ok_or("Unknown AI feature")?;
        if self.installing.swap(true, Ordering::SeqCst) {
            return Err("A download is already running.".into());
        }
        let me = self.clone();
        std::thread::Builder::new()
            .name("ai-install".into())
            .spawn(move || {
                let res = (|| -> Result<(), String> {
                    std::fs::create_dir_all(&me.dir).map_err(es)?;
                    let mut todo: Vec<(&Asset, String)> = vec![];
                    if !me.runtime_ok() {
                        todo.push((rt, "AI runtime".into()));
                    }
                    for a in models {
                        if !me.dir.join(a.file).is_file() {
                            todo.push((a, name.into()));
                        }
                    }
                    let total: u64 = todo.iter().map(|(a, _)| a.size).sum();
                    let mut base = 0u64;
                    for (a, label) in todo {
                        let set = |done: u64| {
                            *me.download.lock().unwrap() = Some(Download { label: label.clone(), done: base + done.min(a.size), total, error: None });
                            let _ = app.emit("ai-progress", ());
                        };
                        set(0);
                        let dest = me.dir.join(a.file);
                        let last = std::cell::Cell::new(0u64);
                        let progress = |d: u64, _t: u64| {
                            if d - last.get() > 512 * 1024 || d >= a.size {
                                last.set(d);
                                set(d);
                            }
                        };
                        match a.member {
                            Some(m) if a.url.ends_with(".zip") => fetch::zip_member(&format!("{ORT}/{}", a.url), m, &dest, a.sha256, &progress)?,
                            Some(m) => fetch::tgz_member(&format!("{ORT}/{}", a.url), m, &dest, a.sha256, &progress)?,
                            None => fetch::file(a.url, &dest, a.sha256, &progress)?,
                        }
                        base += a.size;
                    }
                    Ok(())
                })();
                *me.download.lock().unwrap() =
                    res.as_ref().err().map(|e| Download { label: "Download".into(), done: 0, total: 0, error: Some(e.clone()) });
                me.installing.store(false, Ordering::SeqCst);
                let _ = app.emit("ai-progress", ());
                if res.is_ok() {
                    done();
                }
            })
            .map_err(es)?;
        Ok(())
    }

    /// Delete a feature's models and what was learned with them.
    pub fn remove(&self, c: &Connection, feature: &str) -> Result<(), String> {
        let mut e = self.engines.lock().unwrap();
        if feature == "people" {
            e.det = None;
            e.rec = None;
            let restore = self.pack_on("restore");
            for a in PEOPLE.iter().filter(|a| !(restore && a.file == "yunet.onnx")) {
                let _ = std::fs::remove_file(self.dir.join(a.file));
            }
            c.execute_batch("DELETE FROM faces; DELETE FROM people; UPDATE ai_done SET faces=0;").map_err(es)?;
        } else if let Some((_, files)) = pack(feature).filter(|_| feature != "search") {
            e.edit.clear();
            e.det = None;
            // keep files another installed pack still needs (YuNet is shared with People)
            let shared: Vec<&str> = PACKS.iter().filter(|p| p.0 != feature && self.pack_on(p.0)).flat_map(|p| p.2.iter().map(|a| a.file)).collect();
            for a in files.iter().filter(|a| !shared.contains(&a.file)) {
                let _ = std::fs::remove_file(self.dir.join(a.file));
            }
        } else {
            e.vision = None;
            e.text = None;
            for a in &SEARCH {
                let _ = std::fs::remove_file(self.dir.join(a.file));
            }
            c.execute_batch("DELETE FROM clip; UPDATE ai_done SET clip=0;").map_err(es)?;
            *self.index.lock().unwrap() = None;
        }
        Ok(())
    }

    // ---------- inference ----------

    fn env(&self) -> Result<ort::environment::Environment, String> {
        let mut g = self.env.lock().unwrap();
        if let Some(e) = g.as_ref() {
            return Ok(e.clone());
        }
        let rt = RUNTIME.as_ref().ok_or("unsupported platform")?;
        let env = ort::init_from(self.dir.join(rt.file)).map_err(es)?.with_name("sitara").build().map_err(es)?;
        *g = Some(env.clone());
        Ok(env)
    }

    fn session(&self, file: &str) -> Result<Session, String> {
        let threads = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).max(1);
        Session::builder(&self.env()?).map_err(es)?.with_intra_threads(threads).map_err(es)?.commit_from_file(self.dir.join(file)).map_err(es)
    }

    fn tokenizer(&self) -> Result<Arc<clip::Tokenizer>, String> {
        let mut g = self.tok.lock().unwrap();
        if g.is_none() {
            *g = Some(Arc::new(clip::Tokenizer::load(&self.dir.join("clip-vocab.json"), &self.dir.join("clip-merges.txt"))?));
        }
        Ok(g.clone().unwrap())
    }

    /// Normalized CLIP embedding of a text query.
    pub fn embed_text(&self, q: &str) -> Result<Vec<f32>, String> {
        let ids = self.tokenizer()?.encode(&format!("a photo of {q}."));
        let mut e = self.engines.lock().unwrap();
        if e.text.is_none() {
            e.text = Some(self.session("clip-text.onnx")?);
        }
        let s = e.text.as_mut().unwrap();
        let n = ids.len();
        let out = s.run(ort::inputs!["input_ids" => Tensor::from_array(([1usize, n], ids)).map_err(es)?]).map_err(es)?;
        let (_, v) = out["text_embeds"].try_extract_tensor::<f32>().map_err(es)?;
        let mut v = v.to_vec();
        clip::normalize(&mut v);
        Ok(v)
    }

    fn embed_images(&self, imgs: &[&RgbImage]) -> Result<Vec<Vec<f32>>, String> {
        let mut px = Vec::with_capacity(imgs.len() * 3 * 224 * 224);
        for im in imgs {
            clip::pixels(im, &mut px);
        }
        let mut e = self.engines.lock().unwrap();
        if e.vision.is_none() {
            e.vision = Some(self.session("clip-vision.onnx")?);
        }
        let s = e.vision.as_mut().unwrap();
        let out = s.run(ort::inputs!["pixel_values" => Tensor::from_array(([imgs.len(), 3, 224, 224], px)).map_err(es)?]).map_err(es)?;
        let (_, v) = out["image_embeds"].try_extract_tensor::<f32>().map_err(es)?;
        Ok(v.chunks(clip::DIM)
            .map(|c| {
                let mut c = c.to_vec();
                clip::normalize(&mut c);
                c
            })
            .collect())
    }

    /// Faces in an image (boxes and landmarks in image pixels), big enough to recognize.
    fn faces_raw(&self, img: &RgbImage) -> Result<Vec<faces::Det>, String> {
        let min_side = (img.width().max(img.height()) as f32 / 40.0).max(36.0);
        self.detect(img, min_side)
    }

    fn detect(&self, img: &RgbImage, min_side: f32) -> Result<Vec<faces::Det>, String> {
        let mut e = self.engines.lock().unwrap();
        if e.det.is_none() {
            e.det = Some(self.session("yunet.onnx")?);
        }
        let (input, scale) = faces::det_input(img);
        let det = e.det.as_mut().unwrap();
        let s = faces::DET_SIZE as usize;
        let out = det.run(ort::inputs!["input" => Tensor::from_array(([1usize, 3, s, s], input)).map_err(es)?]).map_err(es)?;
        let get = |name: &str| -> Result<Vec<f32>, String> { Ok(out[name].try_extract_tensor::<f32>().map_err(es)?.1.to_vec()) };
        let (c8, c16, c32) = (get("cls_8")?, get("cls_16")?, get("cls_32")?);
        let (o8, o16, o32) = (get("obj_8")?, get("obj_16")?, get("obj_32")?);
        let (b8, b16, b32) = (get("bbox_8")?, get("bbox_16")?, get("bbox_32")?);
        let (k8, k16, k32) = (get("kps_8")?, get("kps_16")?, get("kps_32")?);
        let found = faces::decode([&c8, &c16, &c32], [&o8, &o16, &o32], [&b8, &b16, &b32], [&k8, &k16, &k32], scale, 0.82);
        Ok(found.into_iter().filter(|d| d.w.min(d.h) >= min_side).take(24).collect())
    }

    /// Faces in an image: boxes in image pixels and normalized 128-d embeddings.
    fn faces(&self, img: &RgbImage) -> Result<Vec<(faces::Det, Vec<f32>)>, String> {
        let found = self.faces_raw(img)?;
        let mut e = self.engines.lock().unwrap();
        if e.rec.is_none() {
            e.rec = Some(self.session("sface.onnx")?);
        }
        let rec = e.rec.as_mut().unwrap();
        let mut res = vec![];
        for d in found {
            let out = rec.run(ort::inputs!["data" => Tensor::from_array(([1usize, 3, 112, 112], faces::aligned(img, &d))).map_err(es)?]).map_err(es)?;
            let mut v = out["fc1"].try_extract_tensor::<f32>().map_err(es)?.1.to_vec();
            clip::normalize(&mut v);
            res.push((d, v));
        }
        Ok(res)
    }

    /// Free the indexing models once the queue is empty (the text model stays for searches).
    pub fn idle(&self) {
        let mut e = self.engines.lock().unwrap();
        e.vision = None;
        e.det = None;
        e.rec = None;
    }

    // ---------- search ----------

    fn load_index(&self, c: &Connection) -> Result<Arc<Index>, String> {
        let n: i64 = c.query_row("SELECT COUNT(*) FROM clip", [], |r| r.get(0)).map_err(es)?;
        if let Some(ix) = self.index.lock().unwrap().as_ref() {
            if ix.ids.len() as i64 == n {
                return Ok(ix.clone());
            }
        }
        let mut st = c.prepare("SELECT media_id, vec FROM clip").map_err(es)?;
        let mut ids = Vec::with_capacity(n as usize);
        let mut vecs = Vec::with_capacity(n as usize * clip::DIM);
        let mut rows = st.query([]).map_err(es)?;
        while let Some(r) = rows.next().map_err(es)? {
            let b: Vec<u8> = r.get(1).map_err(es)?;
            if b.len() == clip::DIM {
                ids.push(r.get(0).map_err(es)?);
                vecs.extend(b.iter().map(|&x| x as i8));
            }
        }
        let ix = Arc::new(Index { ids, vecs });
        *self.index.lock().unwrap() = Some(ix.clone());
        Ok(ix)
    }

    /// Photos ranked by how well they match `q`, best first, with a relevance cut-off.
    pub fn search(&self, c: &Connection, q: &str) -> Result<Vec<(i64, f32)>, String> {
        if !self.search_on() {
            return Err("Search by meaning is off.".into());
        }
        let ix = self.load_index(c)?;
        let t = self.embed_text(q)?;
        let mut scored: Vec<(i64, f32)> = ix
            .ids
            .iter()
            .enumerate()
            .map(|(i, &id)| {
                let v = &ix.vecs[i * clip::DIM..(i + 1) * clip::DIM];
                (id, v.iter().zip(&t).map(|(&a, &b)| a as f32 * b).sum::<f32>() / 127.0)
            })
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        let best = scored.first().map(|x| x.1).unwrap_or(0.0);
        // CLIP's image-text similarities are compressed: unrelated photos sit around 0.20 ± 0.015 and real matches
        // from about 0.25 up. Keep confident matches near the best one (calibrated on a 6k-photo library).
        let floor = (best - 0.05).max(0.245);
        scored.retain(|x| x.1 >= floor);
        scored.truncate(3000);
        Ok(scored)
    }
}

// ---------- indexing pass (runs on the warmer thread) ----------

fn pending_sql(search: bool, people: bool, count: bool) -> String {
    let mut need = vec![];
    if search {
        need.push("COALESCE(d.clip,0)=0");
    }
    if people {
        need.push("(COALESCE(d.faces,0)=0 AND m.kind=0)");
    }
    format!(
        "SELECT {} FROM media m LEFT JOIN ai_done d ON d.media_id=m.id WHERE m.trashed=0 AND m.thumb=1 AND ({}) {}",
        if count { "COUNT(*)" } else { "m.id, m.path, m.ext, m.kind" },
        need.join(" OR "),
        if count { "" } else { "ORDER BY m.taken DESC LIMIT 24" }
    )
}

/// Pixels to learn from: the original (≤1600 px, upright) for photos, the cached frame for videos.
fn learn_image(cache: &Path, id: i64, path: &str, ext: &str, kind: i64) -> Option<RgbImage> {
    let img: DynamicImage = if kind == db::VIDEO {
        image::load_from_memory(&std::fs::read(thumbs::cache_file(cache, id, thumbs::Mode::Thumb)).ok()?).ok()?
    } else if thumbs::rust_decodable(ext) {
        thumbs::decode(Path::new(path)).ok()?
    } else {
        let b = thumbs::ensure(cache, id, Path::new(path), ext, false, thumbs::Mode::Preview).ok()?;
        image::load_from_memory(&b).ok()?
    };
    Some(thumbs::fit(img.to_rgb8(), 1600))
}

/// Learn from every photo that hasn't been seen yet. Returns how many were processed.
pub fn index_pending(ai: &Ai, cache: &Path, conn: &Connection, pool: &rayon::ThreadPool, mut report: impl FnMut(u64)) -> usize {
    use rayon::prelude::*;
    let (search, people) = (ai.search_on(), ai.people_on());
    if !search && !people {
        return 0;
    }
    ai.working.store(true, Ordering::Relaxed);
    let mut total = 0;
    'outer: loop {
        let pending: u64 = conn.query_row(&pending_sql(search, people, true), [], |r| r.get::<_, i64>(0)).unwrap_or(0) as u64;
        report(pending);
        if pending == 0 {
            break;
        }
        let batch: Vec<(i64, String, String, i64)> = (|| -> rusqlite::Result<_> {
            let mut st = conn.prepare(&pending_sql(search, people, false))?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect()
        })()
        .unwrap_or_default();
        if batch.is_empty() {
            break;
        }
        let imgs: Vec<Option<RgbImage>> = pool.install(|| batch.par_iter().map(|(id, p, e, k)| learn_image(cache, *id, p, e, *k)).collect());
        let ok: Vec<(usize, &RgbImage)> = imgs.iter().enumerate().filter_map(|(i, m)| m.as_ref().map(|m| (i, m))).collect();
        let embeds = if search && !ok.is_empty() {
            match ai.embed_images(&ok.iter().map(|x| x.1).collect::<Vec<_>>()) {
                Ok(v) => Some(v),
                Err(e) => {
                    eprintln!("clip: {e}");
                    break 'outer;
                }
            }
        } else {
            None
        };
        let mut found: Vec<(i64, Vec<(faces::Det, Vec<f32>)>, (u32, u32))> = vec![];
        if people {
            for (i, img) in &ok {
                let (id, _, _, kind) = &batch[*i];
                if *kind != db::PHOTO {
                    continue;
                }
                match ai.faces(img) {
                    Ok(f) => found.push((*id, f, img.dimensions())),
                    Err(e) => {
                        eprintln!("faces: {e}");
                        break 'outer;
                    }
                }
            }
        }
        let res = (|| -> rusqlite::Result<()> {
            let tx = conn.unchecked_transaction()?;
            {
                let mut mark = tx.prepare_cached(
                    "INSERT INTO ai_done(media_id, clip, faces) VALUES(?1, ?2, ?3)
                 ON CONFLICT(media_id) DO UPDATE SET clip=MAX(clip, excluded.clip), faces=MAX(faces, excluded.faces)",
                )?;
                // unreadable files are marked done too, so they aren't retried forever
                for (id, ..) in &batch {
                    mark.execute(params![id, search as i64, people as i64])?;
                }
                if let Some(embeds) = &embeds {
                    let mut ins = tx.prepare_cached("INSERT OR REPLACE INTO clip(media_id, vec) VALUES(?1, ?2)")?;
                    for ((i, _), v) in ok.iter().zip(embeds) {
                        ins.execute(params![batch[*i].0, clip::quantize(v)])?;
                    }
                }
                let mut del = tx.prepare_cached("DELETE FROM faces WHERE media_id=?1")?;
                let mut ins = tx.prepare_cached("INSERT INTO faces(media_id, x, y, w, h, score, vec) VALUES(?1,?2,?3,?4,?5,?6,?7)")?;
                for (id, fs, (w, h)) in &found {
                    del.execute([id])?;
                    for (d, v) in fs {
                        let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
                        ins.execute(params![id, d.x / *w as f32, d.y / *h as f32, d.w / *w as f32, d.h / *h as f32, d.score, bytes])?;
                    }
                }
            }
            tx.commit()
        })();
        if let Err(e) = res {
            eprintln!("ai: {e}");
            break;
        }
        total += batch.len();
    }
    if people && total > 0 {
        if let Err(e) = people::assign(conn) {
            eprintln!("people: {e}");
        }
    }
    ai.idle();
    ai.working.store(false, Ordering::Relaxed);
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end with the real runtime and models: `SITARA_MODELS=<dir> SITARA_FACES=<dir> cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn models_end_to_end() {
        let (Ok(m), Ok(f)) = (std::env::var("SITARA_MODELS"), std::env::var("SITARA_FACES")) else { return };
        let ai = Ai::new(PathBuf::from(m));
        assert!(ai.search_on() && ai.people_on());
        let tok = ai.tokenizer().unwrap();
        assert_eq!(tok.encode("a photo of a dog."), vec![49406, 320, 1125, 539, 320, 1929, 269, 49407]);
        let names = ["obama1", "obama2", "biden1", "biden2", "family"];
        let imgs: Vec<RgbImage> = names.iter().map(|n| thumbs::decode(&Path::new(&f).join(format!("{n}.jpg"))).unwrap().to_rgb8()).collect();
        let t = std::time::Instant::now();
        let embeds = ai.embed_images(&imgs.iter().collect::<Vec<_>>()).unwrap();
        println!("clip: {} images in {:?}", imgs.len(), t.elapsed());
        for q in ["a man in a suit", "a family", "a dog on the beach"] {
            let v = ai.embed_text(q).unwrap();
            let s: Vec<String> = embeds.iter().zip(&names).map(|(e, n)| format!("{n}={:.3}", e.iter().zip(&v).map(|(a, b)| a * b).sum::<f32>())).collect();
            println!("{q:24} {}", s.join(" "));
        }
        let mut all = vec![];
        for (img, n) in imgs.iter().zip(&names) {
            let t = std::time::Instant::now();
            let fs = ai.faces(img).unwrap();
            println!("{n}: {} faces in {:?} {:?}", fs.len(), t.elapsed(), fs.iter().map(|(d, _)| (d.w as i32, d.score)).collect::<Vec<_>>());
            for (_, v) in fs {
                all.push((*n, v));
            }
        }
        for i in 0..all.len() {
            for j in i + 1..all.len() {
                println!("  {} ~ {}: {:.3}", all[i].0, all[j].0, faces::cosine(&all[i].1, &all[j].1));
            }
        }
    }
}

/// Delete layer files that no saved edit stack mentions.
pub fn gc_layers(db_path: &Path, layers: &Path) {
    let Ok(c) = db::open(db_path) else { return };
    let Ok(stacks) = (|| -> rusqlite::Result<Vec<String>> {
        let mut st = c.prepare("SELECT stack FROM edits")?;
        let rows = st.query_map([], |r| r.get(0))?;
        rows.collect()
    })() else {
        return;
    };
    let all = stacks.join("\n");
    let Ok(dir) = std::fs::read_dir(layers) else { return };
    for e in dir.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(hash) = name.strip_suffix(".png") {
            if !all.contains(hash) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}
