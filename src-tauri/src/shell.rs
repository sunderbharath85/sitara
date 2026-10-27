//! Windows Shell thumbnails (IShellItemImageFactory): video, HEIC, RAW and anything else
//! the user has a thumbnail handler for, served from the system thumbnail cache when warm.

use image::RgbImage;
use std::ffi::c_void;
use std::path::Path;
use windows::core::HSTRING;
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};
use windows::Win32::System::Com::{CoInitializeEx, IBindCtx, COINIT_MULTITHREADED};
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_THUMBNAILONLY,
};

thread_local! {
    static COM: () = unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    };
}

pub fn thumbnail(path: &Path, size: i32) -> Result<RgbImage, String> {
    COM.with(|_| {});
    unsafe {
        let wide = HSTRING::from(path.as_os_str());
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(&wide, None::<&IBindCtx>).map_err(|e| e.to_string())?;
        let hbmp = factory
            .GetImage(SIZE { cx: size, cy: size }, SIIGBF_BIGGERSIZEOK | SIIGBF_THUMBNAILONLY)
            .map_err(|e| e.to_string())?;
        let res = read_bitmap(hbmp);
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        res
    }
}

unsafe fn read_bitmap(hbmp: HBITMAP) -> Result<RgbImage, String> {
    unsafe {
        let mut bm = BITMAP::default();
        if GetObjectW(HGDIOBJ(hbmp.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void)) == 0
        {
            return Err("GetObject failed".into());
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
        if w <= 0 || h <= 0 {
            return Err("empty bitmap".into());
        }
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        let hdc = CreateCompatibleDC(None);
        let lines = GetDIBits(hdc, hbmp, 0, h as u32, Some(bgra.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS);
        let _ = DeleteDC(hdc);
        if lines == 0 {
            return Err("GetDIBits failed".into());
        }
        // Shell bitmaps are premultiplied BGRA; many have no alpha at all (all zero).
        let has_alpha = bgra.chunks_exact(4).any(|p| p[3] != 0);
        let bg = 11u16; // composite transparent areas onto the app canvas (#0b0b0e-ish)
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for p in bgra.chunks_exact(4) {
            let (b, g, r, a) = (p[0] as u16, p[1] as u16, p[2] as u16, p[3] as u16);
            if has_alpha && a < 255 {
                let k = 255 - a;
                rgb.extend_from_slice(&[(r + bg * k / 255).min(255) as u8, (g + bg * k / 255).min(255) as u8, (b + bg * k / 255).min(255) as u8]);
            } else {
                rgb.extend_from_slice(&[r as u8, g as u8, b as u8]);
            }
        }
        RgbImage::from_raw(w as u32, h as u32, rgb).ok_or_else(|| "bitmap buffer".to_string())
    }
}
