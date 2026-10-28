//! Running models on the graphics card: DirectML on Windows (any DirectX 12 GPU: NVIDIA, AMD, Intel, Qualcomm),
//! Core ML on Apple silicon. A model the GPU can't take runs on the CPU instead, and parts of a model the GPU
//! doesn't support run on the CPU within it.

use super::es;
use ort::environment::Environment;
use ort::session::Session;
use std::path::Path;

/// Models kept on the CPU. CLIP is int8-quantized: quick on the CPU already, and the image model crashes
/// DirectML outright (measured on an RTX 3060). LaMa and DDColor fail inside DirectML; they would fall back on
/// their own, and this skips the failed attempt.
#[cfg(windows)]
pub const CPU_ONLY: &[&str] = &["clip-vision.onnx", "clip-text.onnx", "lama.onnx", "ddcolor.onnx"];
#[cfg(not(windows))]
pub const CPU_ONLY: &[&str] = &["clip-vision.onnx", "clip-text.onnx"];

/// The graphics card models would run on, if this computer has one Sitara can use.
#[cfg(windows)]
pub fn name() -> Option<String> {
    use windows::Win32::Graphics::Dxgi::*;
    // the same adapter DirectML picks with the high-performance preference (the discrete GPU on a laptop)
    unsafe {
        let f: IDXGIFactory6 = CreateDXGIFactory1().ok()?;
        let a: IDXGIAdapter1 = f.EnumAdapterByGpuPreference(0, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE).ok()?;
        let d = a.GetDesc1().ok()?;
        if d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
            return None; // Microsoft Basic Render Driver: slower than the CPU path
        }
        let n = d.Description.iter().position(|&c| c == 0).unwrap_or(d.Description.len());
        Some(String::from_utf16_lossy(&d.Description[..n]).trim().to_string())
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn name() -> Option<String> {
    let out = std::process::Command::new("sysctl").args(["-n", "machdep.cpu.brand_string"]).output().ok()?;
    let chip = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(if chip.is_empty() { "Apple GPU".into() } else { format!("{chip} GPU") })
}

#[cfg(not(any(windows, all(target_os = "macos", target_arch = "aarch64"))))]
pub fn name() -> Option<String> {
    None
}

/// ONNX Runtime asks Windows for DirectML.dll by name, and System32 has an older copy; loading the one next to
/// the runtime first makes it the one ONNX Runtime gets.
#[cfg(windows)]
pub fn preload(lib: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::System::LibraryLoader::LoadLibraryW;
    let w: Vec<u16> = lib.as_os_str().encode_wide().chain(Some(0)).collect();
    // stays loaded for the life of the process, like the runtime itself
    let _ = unsafe { LoadLibraryW(windows::core::PCWSTR(w.as_ptr())) };
}

#[cfg(windows)]
pub fn session(env: &Environment, model: &Path, threads: usize) -> Result<Session, String> {
    use ort::ep::directml::{DeviceFilter, PerformancePreference};
    let dml = ort::ep::DirectML::default().with_performance_preference(PerformancePreference::HighPerformance).with_device_filter(DeviceFilter::Gpu);
    Session::builder(env)
        .map_err(es)?
        // DirectML runs one graph at a time and plans its own memory
        .with_memory_pattern(false)
        .map_err(es)?
        .with_parallel_execution(false)
        .map_err(es)?
        .with_intra_threads(threads)
        .map_err(es)?
        .with_execution_providers([dml.build().error_on_failure()])
        .map_err(es)?
        .commit_from_file(model)
        .map_err(es)
}

#[cfg(target_os = "macos")]
pub fn session(env: &Environment, model: &Path, threads: usize) -> Result<Session, String> {
    use ort::ep::coreml::{ComputeUnits, ModelFormat};
    let cml = ort::ep::CoreML::default().with_model_format(ModelFormat::MLProgram).with_compute_units(ComputeUnits::All);
    Session::builder(env)
        .map_err(es)?
        .with_intra_threads(threads)
        .map_err(es)?
        .with_execution_providers([cml.build().error_on_failure()])
        .map_err(es)?
        .commit_from_file(model)
        .map_err(es)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn session(_env: &Environment, _model: &Path, _threads: usize) -> Result<Session, String> {
    Err("no GPU support on this platform".into())
}
