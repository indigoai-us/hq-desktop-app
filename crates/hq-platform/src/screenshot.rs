//! Region screen capture + frontmost-window provenance (US-004).
//!
//! This module is deliberately **dependency-light**: it returns raw, tightly
//! packed RGBA8 and never touches the `image` crate, so the app layer owns
//! encoding (and so this file can be compiled standalone against nothing but
//! the `windows` crate to prove the Win32 path builds — see the story's
//! cross-compile scratch-crate check).
//!
//! Platform paths:
//!
//! * **macOS** — `CGWindowListCreateImage` with
//!   `kCGWindowListOptionOnScreenBelowWindow` relative to the capture
//!   overlay's own window number. That excludes the dimmed overlay from the
//!   shot *without* waiting for it to hide, which is what makes the
//!   release→PNG budget reachable. When the caller can't supply a window
//!   number we fall back to `CGDisplayCreateImageForRect`.
//! * **Windows** — GDI (`GetDC(NULL)` → `CreateCompatibleDC` → `BitBlt` →
//!   `GetDIBits`). GDI is the always-available path on every supported
//!   Windows build and needs no capture-session lifetime.
//!   **Follow-up:** `Windows.Graphics.Capture` (WinRT) would give us
//!   HDR/DirectComposition-correct frames and per-window exclusion on Win10
//!   2004+, at the cost of a WinRT capture session and a graphics device. It
//!   is the eventual upgrade; GDI is what ships here.
//! * **Other** — `ScreenshotError::Unsupported`.
//!
//! Coordinates in [`CaptureRegion`] are **global logical points, top-left
//! origin** (the same space `commands::capture::DisplayRect` uses). The
//! returned buffer is in *device pixels*, so it may be larger than the
//! requested region on a Retina/scaled display; callers should use
//! [`RegionCapture::width`]/[`RegionCapture::height`] and never assume the
//! logical size.

use std::fmt;

/// A captured region, tightly packed RGBA8 (`rgba.len() == width*height*4`).
#[derive(Clone, PartialEq, Eq)]
pub struct RegionCapture {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl fmt::Debug for RegionCapture {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegionCapture")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("rgba_len", &self.rgba.len())
            .finish()
    }
}

/// A rectangle in global logical points, top-left origin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CaptureRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Why a capture could not be produced. No `thiserror` on purpose (see the
/// module docs: this file must compile with zero non-platform deps).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScreenshotError {
    /// Degenerate rectangle (sub-pixel drag / plain click).
    EmptyRegion,
    /// The OS returned no image (permission denied, display gone, …).
    CaptureFailed(String),
    /// No capture backend on this platform.
    Unsupported,
}

impl fmt::Display for ScreenshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScreenshotError::EmptyRegion => write!(f, "empty capture region"),
            ScreenshotError::CaptureFailed(m) => write!(f, "screen capture failed: {m}"),
            ScreenshotError::Unsupported => write!(f, "screen capture unsupported on this platform"),
        }
    }
}

impl std::error::Error for ScreenshotError {}

/// Frontmost-application provenance, read **before** the overlay is shown
/// (once the overlay is up it is itself frontmost).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FrontmostInfo {
    pub app: String,
    pub window_title: String,
    pub url: Option<String>,
}

/// In-memory byte order of a source pixel buffer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelOrder {
    /// Blue, Green, Red, Alpha — CoreGraphics 32Little / GDI DIB.
    Bgra,
    /// Red, Green, Blue, Alpha — CoreGraphics 32Big.
    Rgba,
}

/// Convert a tightly packed BGRA8 buffer to RGBA8, forcing alpha to 255.
///
/// Alpha is forced rather than carried through because both backends hand us
/// *premultiplied* alpha; un-premultiplying a screen grab is pointless work
/// (screen content is opaque) and would darken edges if skipped.
pub fn bgra_to_rgba(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len());
    for px in src.chunks_exact(4) {
        out.extend_from_slice(&[px[2], px[1], px[0], 255]);
    }
    out
}

/// Unpack a strided source buffer into tightly packed RGBA8.
///
/// `bytes_per_row` is the source stride, which is routinely larger than
/// `width * 4` (CoreGraphics pads rows to 16/32/64-byte boundaries). Ignoring
/// the stride is the classic "image comes out sheared" bug, so it is handled
/// here and unit-tested.
///
/// Returns `None` when the source is too short for the claimed geometry.
pub fn unpack_rows(
    src: &[u8],
    width: u32,
    height: u32,
    bytes_per_row: usize,
    order: PixelOrder,
) -> Option<Vec<u8>> {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return None;
    }
    let row_bytes = w.checked_mul(4)?;
    if bytes_per_row < row_bytes || src.len() < bytes_per_row.checked_mul(h)? {
        return None;
    }
    let mut out = Vec::with_capacity(row_bytes * h);
    for row in 0..h {
        let start = row * bytes_per_row;
        let line = &src[start..start + row_bytes];
        match order {
            PixelOrder::Bgra => out.extend_from_slice(&bgra_to_rgba(line)),
            PixelOrder::Rgba => {
                for px in line.chunks_exact(4) {
                    out.extend_from_slice(&[px[0], px[1], px[2], 255]);
                }
            }
        }
    }
    Some(out)
}

/// Extract the first `http(s)://` token from a window title.
///
/// Firefox and several Chromium forks expose no accessibility document URL,
/// but many window titles still carry the URL verbatim; this is the cheap
/// fallback for those. Pure so it can be unit-tested on any platform.
pub fn derive_url_from_title(title: &str) -> Option<String> {
    for token in title.split(|c: char| c.is_whitespace()) {
        let t = token.trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | '"' | '\'' | ',' | ';'));
        if t.starts_with("http://") || t.starts_with("https://") {
            let t = t.trim_end_matches('.');
            if t.len() > "https://".len() {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// True when a bundle id / process path looks like a web browser, i.e. the
/// frontmost app plausibly has a document URL worth asking for.
pub fn looks_like_browser(identifier: &str) -> bool {
    let id = identifier.to_ascii_lowercase();
    ["safari", "chrome", "chromium", "arc", "thebrowser", "brave", "edge", "firefox", "vivaldi", "opera"]
        .iter()
        .any(|b| id.contains(b))
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::ffi::{c_void, CStr};
    use std::os::raw::c_char;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    type CGImageRef = *mut c_void;
    type CFTypeRef = *const c_void;

    // Window-list options.
    const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
    const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_BELOW_WINDOW: u32 = 1 << 3;
    const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
    // Image options: best (native/Retina) resolution.
    const K_CG_WINDOW_IMAGE_BEST_RESOLUTION: u32 = 1 << 3;

    // Bitmap info masks (CGImage).
    const K_CG_BITMAP_BYTE_ORDER_MASK: u32 = 0x7000;
    const K_CG_BITMAP_BYTE_ORDER_32_LITTLE: u32 = 2 << 12;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCreateImage(
            screen_bounds: CGRect,
            list_option: u32,
            window_id: u32,
            image_option: u32,
        ) -> CGImageRef;
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFTypeRef;
        fn CGDisplayCreateImageForRect(display: u32, rect: CGRect) -> CGImageRef;
        fn CGGetDisplaysWithPoint(
            point: CGPoint,
            max_displays: u32,
            displays: *mut u32,
            matching_count: *mut u32,
        ) -> i32;
        fn CGMainDisplayID() -> u32;
        fn CGImageGetWidth(image: CGImageRef) -> usize;
        fn CGImageGetHeight(image: CGImageRef) -> usize;
        fn CGImageGetBytesPerRow(image: CGImageRef) -> usize;
        fn CGImageGetBitsPerPixel(image: CGImageRef) -> usize;
        fn CGImageGetBitmapInfo(image: CGImageRef) -> u32;
        fn CGImageGetDataProvider(image: CGImageRef) -> *mut c_void;
        fn CGImageRelease(image: CGImageRef);
        fn CGDataProviderCopyData(provider: *mut c_void) -> CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDataGetBytePtr(data: CFTypeRef) -> *const u8;
        fn CFDataGetLength(data: CFTypeRef) -> isize;
        fn CFRelease(cf: CFTypeRef);
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(
            element: CFTypeRef,
            attribute: CFTypeRef,
            value: *mut CFTypeRef,
        ) -> i32;
    }

    /// Autoreleased `NSString*` (toll-free bridged to `CFStringRef`).
    fn ns_string(s: &str) -> *mut objc2::runtime::AnyObject {
        use objc2::{class, msg_send};
        let c = std::ffi::CString::new(s).unwrap_or_default();
        // SAFETY: NSString always exists; the selector is public and returns
        // an autoreleased object we only use within the current scope.
        unsafe { msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()] }
    }

    /// Copy an `NSString*` (or toll-free `CFStringRef`) into a Rust `String`.
    fn ns_string_to_rust(obj: *mut objc2::runtime::AnyObject) -> String {
        use objc2::msg_send;
        if obj.is_null() {
            return String::new();
        }
        // SAFETY: caller guarantees `obj` is an NSString/CFString; `UTF8String`
        // returns a pointer valid until the autorelease pool drains, which is
        // strictly after this copy.
        unsafe {
            let c: *const c_char = msg_send![obj, UTF8String];
            if c.is_null() {
                return String::new();
            }
            CStr::from_ptr(c).to_string_lossy().into_owned()
        }
    }

    fn cg_image_to_rgba(image: CGImageRef) -> Result<RegionCapture, ScreenshotError> {
        if image.is_null() {
            return Err(ScreenshotError::CaptureFailed(
                "CoreGraphics returned a null image (Screen Recording permission?)".into(),
            ));
        }
        // SAFETY: `image` is a live CGImageRef we own; every accessor below is
        // a documented pure getter, and the CFData copy is released before we
        // return. The byte pointer is only read while the CFData is alive.
        unsafe {
            let width = CGImageGetWidth(image) as u32;
            let height = CGImageGetHeight(image) as u32;
            let stride = CGImageGetBytesPerRow(image);
            let bpp = CGImageGetBitsPerPixel(image);
            let info = CGImageGetBitmapInfo(image);
            if bpp != 32 {
                CGImageRelease(image);
                return Err(ScreenshotError::CaptureFailed(format!(
                    "unsupported bits-per-pixel {bpp}"
                )));
            }
            let order = if info & K_CG_BITMAP_BYTE_ORDER_MASK == K_CG_BITMAP_BYTE_ORDER_32_LITTLE {
                PixelOrder::Bgra
            } else {
                PixelOrder::Rgba
            };
            let provider = CGImageGetDataProvider(image);
            if provider.is_null() {
                CGImageRelease(image);
                return Err(ScreenshotError::CaptureFailed("image has no data provider".into()));
            }
            let data = CGDataProviderCopyData(provider);
            if data.is_null() {
                CGImageRelease(image);
                return Err(ScreenshotError::CaptureFailed("CGDataProviderCopyData failed".into()));
            }
            let ptr = CFDataGetBytePtr(data);
            let len = CFDataGetLength(data).max(0) as usize;
            let slice = std::slice::from_raw_parts(ptr, len);
            let rgba = unpack_rows(slice, width, height, stride, order);
            CFRelease(data);
            CGImageRelease(image);
            match rgba {
                Some(rgba) => Ok(RegionCapture { width, height, rgba }),
                None => Err(ScreenshotError::CaptureFailed(format!(
                    "pixel buffer too small: {len} bytes for {width}x{height} stride {stride}"
                ))),
            }
        }
    }

    pub fn capture_region(
        region: &CaptureRegion,
        exclude_window: Option<u32>,
    ) -> Result<RegionCapture, ScreenshotError> {
        let rect = CGRect {
            origin: CGPoint { x: region.x, y: region.y },
            size: CGSize { width: region.w, height: region.h },
        };
        // SAFETY: both calls take a plain-old-data rect and return an owned
        // CGImageRef (or null), which `cg_image_to_rgba` releases.
        let image = unsafe {
            match exclude_window {
                Some(win) if win > 0 => CGWindowListCreateImage(
                    rect,
                    K_CG_WINDOW_LIST_OPTION_ON_SCREEN_BELOW_WINDOW,
                    win,
                    K_CG_WINDOW_IMAGE_BEST_RESOLUTION,
                ),
                // No overlay window number available: fall back to the whole
                // display. The overlay must already be hidden in that case.
                _ => {
                    let display = super::display_id_for_point(region.x, region.y);
                    CGDisplayCreateImageForRect(display, rect)
                }
            }
        };
        cg_image_to_rgba(image)
    }

    pub fn display_id_for_point(x: f64, y: f64) -> u32 {
        let mut ids = [0u32; 8];
        let mut count = 0u32;
        // SAFETY: out-params are stack arrays sized by the `max` argument.
        unsafe {
            let err = CGGetDisplaysWithPoint(CGPoint { x, y }, 8, ids.as_mut_ptr(), &mut count);
            if err == 0 && count > 0 {
                ids[0]
            } else {
                CGMainDisplayID()
            }
        }
    }

    /// The frontmost app's on-screen, layer-0 window title (the user's
    /// document window; menus and panels live on higher layers).
    fn window_title_for_pid(pid: i32) -> String {
        use objc2::{msg_send, runtime::AnyObject};
        // SAFETY: the CFArray is toll-free bridged to NSArray; every value we
        // read is a documented key of the window-info dictionary. The array is
        // released before returning.
        unsafe {
            let arr = CGWindowListCopyWindowInfo(
                K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
                0,
            );
            if arr.is_null() {
                return String::new();
            }
            let array = arr as *mut AnyObject;
            let count: usize = msg_send![array, count];
            let mut title = String::new();
            for i in 0..count {
                let dict: *mut AnyObject = msg_send![array, objectAtIndex: i];
                if dict.is_null() {
                    continue;
                }
                let owner: *mut AnyObject = msg_send![dict, objectForKey: ns_string("kCGWindowOwnerPID")];
                if owner.is_null() {
                    continue;
                }
                let owner_pid: i32 = msg_send![owner, intValue];
                if owner_pid != pid {
                    continue;
                }
                let layer_obj: *mut AnyObject = msg_send![dict, objectForKey: ns_string("kCGWindowLayer")];
                let layer: i32 = if layer_obj.is_null() { -1 } else { msg_send![layer_obj, intValue] };
                if layer != 0 {
                    continue;
                }
                let name: *mut AnyObject = msg_send![dict, objectForKey: ns_string("kCGWindowName")];
                let s = ns_string_to_rust(name);
                if !s.is_empty() {
                    title = s;
                    break;
                }
            }
            CFRelease(arr);
            title
        }
    }

    /// Ask the accessibility API for the focused window's document URL.
    /// Returns `None` when AX is not trusted or the app exposes no document.
    fn ax_document_url(pid: i32) -> Option<String> {
        use objc2::runtime::AnyObject;
        // SAFETY: AXUIElement values are CFTypes we own and release; a non-zero
        // AXError leaves `value` untouched, which we check for null first.
        unsafe {
            let app = AXUIElementCreateApplication(pid);
            if app.is_null() {
                return None;
            }
            let mut window: CFTypeRef = std::ptr::null();
            let attr_focused = ns_string("AXFocusedWindow") as CFTypeRef;
            let err = AXUIElementCopyAttributeValue(app, attr_focused, &mut window);
            if err != 0 || window.is_null() {
                CFRelease(app);
                return None;
            }
            let mut doc: CFTypeRef = std::ptr::null();
            let attr_doc = ns_string("AXDocument") as CFTypeRef;
            let err = AXUIElementCopyAttributeValue(window, attr_doc, &mut doc);
            let out = if err == 0 && !doc.is_null() {
                let s = ns_string_to_rust(doc as *mut AnyObject);
                CFRelease(doc);
                if s.starts_with("http://") || s.starts_with("https://") {
                    Some(s)
                } else {
                    None
                }
            } else {
                None
            };
            CFRelease(window);
            CFRelease(app);
            out
        }
    }

    pub fn frontmost_window_info() -> FrontmostInfo {
        use objc2::{class, msg_send, runtime::AnyObject};
        // SAFETY: NSWorkspace is a singleton; all selectors are public AppKit
        // API returning autoreleased objects read within this scope.
        unsafe {
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return FrontmostInfo::default();
            }
            let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
            if app.is_null() {
                return FrontmostInfo::default();
            }
            let name: *mut AnyObject = msg_send![app, localizedName];
            let bundle: *mut AnyObject = msg_send![app, bundleIdentifier];
            let pid: i32 = msg_send![app, processIdentifier];
            let app_name = ns_string_to_rust(name);
            let bundle_id = ns_string_to_rust(bundle);
            let window_title = window_title_for_pid(pid);
            let url = if looks_like_browser(&bundle_id) || looks_like_browser(&app_name) {
                ax_document_url(pid).or_else(|| derive_url_from_title(&window_title))
            } else {
                derive_url_from_title(&window_title)
            };
            FrontmostInfo { app: app_name, window_title, url }
        }
    }
}

// ---------------------------------------------------------------------------
// Windows (GDI)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use windows::Win32::Foundation::{CloseHandle, HWND, POINT};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS, MONITOR_DEFAULTTONEAREST, SRCCOPY,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    pub fn capture_region(
        region: &CaptureRegion,
        _exclude_window: Option<u32>,
    ) -> Result<RegionCapture, ScreenshotError> {
        // GDI cannot exclude a window from a screen blit; the caller hides the
        // overlay before dispatching the capture on Windows.
        let x = region.x.round() as i32;
        let y = region.y.round() as i32;
        let w = region.w.round() as i32;
        let h = region.h.round() as i32;
        if w < 1 || h < 1 {
            return Err(ScreenshotError::EmptyRegion);
        }
        // SAFETY: every GDI handle created below is released on all paths; the
        // DIB buffer is sized exactly `w*h*4` as required by the 32bpp BI_RGB
        // header we pass to GetDIBits.
        unsafe {
            let screen = GetDC(HWND(std::ptr::null_mut()));
            if screen.is_invalid() {
                return Err(ScreenshotError::CaptureFailed("GetDC(NULL) failed".into()));
            }
            let mem = CreateCompatibleDC(screen);
            if mem.is_invalid() {
                ReleaseDC(HWND(std::ptr::null_mut()), screen);
                return Err(ScreenshotError::CaptureFailed("CreateCompatibleDC failed".into()));
            }
            let bitmap = CreateCompatibleBitmap(screen, w, h);
            if bitmap.is_invalid() {
                let _ = DeleteDC(mem);
                ReleaseDC(HWND(std::ptr::null_mut()), screen);
                return Err(ScreenshotError::CaptureFailed("CreateCompatibleBitmap failed".into()));
            }
            let old = SelectObject(mem, bitmap);
            let blit = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY);

            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    // Negative height = top-down rows, matching our RGBA order.
                    biHeight: -h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
            let lines = if blit.is_ok() {
                GetDIBits(
                    mem,
                    bitmap,
                    0,
                    h as u32,
                    Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut info,
                    DIB_RGB_COLORS,
                )
            } else {
                0
            };

            SelectObject(mem, old);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(mem);
            ReleaseDC(HWND(std::ptr::null_mut()), screen);

            if let Err(e) = blit {
                return Err(ScreenshotError::CaptureFailed(format!("BitBlt failed: {e}")));
            }
            if lines == 0 {
                return Err(ScreenshotError::CaptureFailed("GetDIBits returned 0 lines".into()));
            }
            // GDI 32bpp DIBs are BGRX with an undefined 4th byte; force alpha.
            let rgba = unpack_rows(&buf, w as u32, h as u32, (w as usize) * 4, PixelOrder::Bgra)
                .ok_or_else(|| ScreenshotError::CaptureFailed("short DIB buffer".into()))?;
            Ok(RegionCapture { width: w as u32, height: h as u32, rgba })
        }
    }

    pub fn display_id_for_point(x: f64, y: f64) -> u32 {
        // SAFETY: MonitorFromPoint takes a POD point and never fails.
        unsafe {
            let m = MonitorFromPoint(
                POINT { x: x.round() as i32, y: y.round() as i32 },
                MONITOR_DEFAULTTONEAREST,
            );
            // The HMONITOR handle is process-stable; truncating to u32 keeps
            // the record schema platform-neutral and is unique in practice.
            (m.0 as usize as u64 & 0xFFFF_FFFF) as u32
        }
    }

    pub fn frontmost_window_info() -> FrontmostInfo {
        // SAFETY: all calls are read-only Win32 queries; the process handle is
        // closed on every path.
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return FrontmostInfo::default();
            }
            let mut title_buf = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut title_buf);
            let window_title = if len > 0 {
                String::from_utf16_lossy(&title_buf[..len as usize])
            } else {
                String::new()
            };

            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let mut app = String::new();
            if pid != 0 {
                if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                    let mut buf = [0u16; 520];
                    let mut size = buf.len() as u32;
                    if QueryFullProcessImageNameW(
                        handle,
                        PROCESS_NAME_FORMAT(0),
                        windows::core::PWSTR(buf.as_mut_ptr()),
                        &mut size,
                    )
                    .is_ok()
                    {
                        let full = String::from_utf16_lossy(&buf[..size as usize]);
                        app = full
                            .rsplit(['\\', '/'])
                            .next()
                            .unwrap_or(&full)
                            .trim_end_matches(".exe")
                            .to_string();
                    }
                    let _ = CloseHandle(handle);
                }
            }
            let url = derive_url_from_title(&window_title);
            FrontmostInfo { app, window_title, url }
        }
    }
}

// ---------------------------------------------------------------------------
// Other platforms
// ---------------------------------------------------------------------------

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use super::*;

    pub fn capture_region(
        _region: &CaptureRegion,
        _exclude_window: Option<u32>,
    ) -> Result<RegionCapture, ScreenshotError> {
        Err(ScreenshotError::Unsupported)
    }

    pub fn display_id_for_point(_x: f64, _y: f64) -> u32 {
        0
    }

    pub fn frontmost_window_info() -> FrontmostInfo {
        FrontmostInfo::default()
    }
}

/// Capture `region` as tightly packed RGBA8.
///
/// `exclude_window` is the native window number of a window to keep *out* of
/// the shot (macOS only — the capture overlay). Pass `None` when there is no
/// such window; the platform then captures whatever is on screen.
pub fn capture_region(
    region: &CaptureRegion,
    exclude_window: Option<u32>,
) -> Result<RegionCapture, ScreenshotError> {
    if region.w < 1.0 || region.h < 1.0 {
        return Err(ScreenshotError::EmptyRegion);
    }
    imp::capture_region(region, exclude_window)
}

/// Provenance for the app that is frontmost **right now**. Call this before
/// showing the capture overlay.
pub fn frontmost_window_info() -> FrontmostInfo {
    imp::frontmost_window_info()
}

/// Stable-per-session display identifier for the display containing the point.
pub fn display_id_for_point(x: f64, y: f64) -> u32 {
    imp::display_id_for_point(x, y)
}

#[cfg(test)]
mod hq_idea_board_screenshot_tests {
    use super::*;

    #[test]
    fn hq_idea_board_bgra_becomes_rgba_with_opaque_alpha() {
        // B, G, R, A(premultiplied/garbage) -> R, G, B, 255
        let src = [10u8, 20, 30, 0, 40, 50, 60, 7];
        assert_eq!(bgra_to_rgba(&src), vec![30, 20, 10, 255, 60, 50, 40, 255]);
    }

    #[test]
    fn hq_idea_board_unpack_rows_honors_stride() {
        // 2x2 image, stride 12 (4 bytes of row padding).
        let mut src = Vec::new();
        for row in 0..2u8 {
            src.extend_from_slice(&[row, 0, 1, 0, row, 0, 2, 0]); // 2 BGRA px
            src.extend_from_slice(&[0xEE, 0xEE, 0xEE, 0xEE]); // padding
        }
        let out = unpack_rows(&src, 2, 2, 12, PixelOrder::Bgra).expect("unpacked");
        assert_eq!(out.len(), 2 * 2 * 4);
        assert!(!out.contains(&0xEE), "row padding leaked into the output");
        // First pixel: BGRA(0,0,1,0) -> RGBA(1,0,0,255)
        assert_eq!(&out[0..4], &[1, 0, 0, 255]);
    }

    #[test]
    fn hq_idea_board_unpack_rows_rgba_order_is_passthrough_with_forced_alpha() {
        let src = [1u8, 2, 3, 0];
        let out = unpack_rows(&src, 1, 1, 4, PixelOrder::Rgba).expect("unpacked");
        assert_eq!(out, vec![1, 2, 3, 255]);
    }

    #[test]
    fn hq_idea_board_unpack_rows_rejects_short_or_degenerate_buffers() {
        assert!(unpack_rows(&[0u8; 4], 2, 2, 8, PixelOrder::Bgra).is_none());
        assert!(unpack_rows(&[0u8; 16], 0, 2, 8, PixelOrder::Bgra).is_none());
        // Stride smaller than a row is nonsense and must not be read.
        assert!(unpack_rows(&[0u8; 32], 4, 2, 8, PixelOrder::Bgra).is_none());
    }

    #[test]
    fn hq_idea_board_derive_url_from_title_finds_first_http_token() {
        assert_eq!(
            derive_url_from_title("Docs — https://example.com/a?b=1 — Firefox").as_deref(),
            Some("https://example.com/a?b=1")
        );
        assert_eq!(
            derive_url_from_title("(http://localhost:3000)").as_deref(),
            Some("http://localhost:3000")
        );
        assert_eq!(derive_url_from_title("Untitled — TextEdit"), None);
        assert_eq!(derive_url_from_title("https://"), None);
    }

    #[test]
    fn hq_idea_board_browser_detection_covers_shipped_browsers() {
        for id in [
            "com.apple.Safari",
            "com.google.Chrome",
            "company.thebrowser.Browser",
            "com.brave.Browser",
            "com.microsoft.edgemac",
            "org.mozilla.firefox",
        ] {
            assert!(looks_like_browser(id), "{id} should look like a browser");
        }
        assert!(!looks_like_browser("com.apple.TextEdit"));
        assert!(!looks_like_browser("com.figma.Desktop"));
    }

    #[test]
    fn hq_idea_board_capture_region_rejects_empty_rect_before_touching_the_os() {
        let empty = CaptureRegion { x: 0.0, y: 0.0, w: 0.4, h: 10.0 };
        assert_eq!(capture_region(&empty, None), Err(ScreenshotError::EmptyRegion));
        let empty = CaptureRegion { x: 0.0, y: 0.0, w: 10.0, h: 0.0 };
        assert_eq!(capture_region(&empty, None), Err(ScreenshotError::EmptyRegion));
    }
}
