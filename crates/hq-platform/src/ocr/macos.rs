//! Apple Vision text recognition (macOS).
//!
//! A thin `objc2` bridge over `VNImageRequestHandler` +
//! `VNRecognizeTextRequest`, matching the raw `class!` / `msg_send!` style
//! already used in [`crate::permissions`] — no `objc2-vision` dependency, and
//! nothing crosses the FFI boundary that isn't a plain pointer or scalar.
//!
//! Vision runs entirely on-device: no network, no API key, no per-call cost.

#![cfg(target_os = "macos")]

use std::path::Path;

use objc2::encode::{Encode, Encoding};
use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{class, msg_send};

use super::{BBox, OcrBackend, OcrError, OcrLine, OcrResult};

// Link Vision so the VN* classes are present in the image at load time; the
// calls themselves go through the Objective-C runtime below.
#[link(name = "Vision", kind = "framework")]
extern "C" {}

/// `VNRequestTextRecognitionLevelAccurate` — slower, markedly better on the
/// small, dense text screenshots produce.
const RECOGNITION_LEVEL_ACCURATE: i64 = 0;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct CgPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct CgSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct CgRect {
    origin: CgPoint,
    size: CgSize,
}

// SAFETY: these mirror the CoreGraphics layouts exactly (two/four packed
// CGFloats, which are f64 on every 64-bit Apple platform we build for), and
// the encodings match what the Objective-C runtime reports for them.
unsafe impl Encode for CgPoint {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for CgSize {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for CgRect {
    const ENCODING: Encoding = Encoding::Struct("CGRect", &[CgPoint::ENCODING, CgSize::ENCODING]);
}

/// Apple Vision backend.
pub struct VisionOcr;

impl OcrBackend for VisionOcr {
    fn name(&self) -> &'static str {
        "vision"
    }

    fn recognize(&self, image_path: &Path) -> Result<OcrResult, OcrError> {
        // Vision reports "unable to open" for a missing file, but a clear
        // typed Io error beats a backend string, so check first.
        let meta = std::fs::metadata(image_path).map_err(|e| OcrError::io(image_path, e))?;
        if !meta.is_file() {
            return Err(OcrError::Backend(format!(
                "{} is not a file",
                image_path.display()
            )));
        }
        autoreleasepool(|_| unsafe { recognize_inner(image_path) })
    }
}

/// SAFETY: every pointer below is either checked for null before use or comes
/// straight back from the runtime; `alloc`ed objects are released on all exit
/// paths; all NSString reads happen while the autorelease pool is alive.
unsafe fn recognize_inner(image_path: &Path) -> Result<OcrResult, OcrError> {
    let path_str = image_path.to_string_lossy().into_owned();
    let c_path = std::ffi::CString::new(path_str)
        .map_err(|_| OcrError::Backend("image path contains a NUL byte".into()))?;

    let ns_string_cls: &AnyClass = class!(NSString);
    let ns_path: *mut AnyObject = msg_send![ns_string_cls, stringWithUTF8String: c_path.as_ptr()];
    if ns_path.is_null() {
        return Err(OcrError::Backend("could not build NSString path".into()));
    }

    let ns_url_cls: &AnyClass = class!(NSURL);
    let url: *mut AnyObject = msg_send![ns_url_cls, fileURLWithPath: ns_path];
    if url.is_null() {
        return Err(OcrError::Backend("could not build file NSURL".into()));
    }

    let ns_dict_cls: &AnyClass = class!(NSDictionary);
    let options: *mut AnyObject = msg_send![ns_dict_cls, dictionary];

    // VNImageRequestHandler — owns the decoded image for the duration.
    let handler_cls: &AnyClass = class!(VNImageRequestHandler);
    let handler: *mut AnyObject = msg_send![handler_cls, alloc];
    let handler: *mut AnyObject = msg_send![handler, initWithURL: url, options: options];
    if handler.is_null() {
        return Err(OcrError::Backend(
            "VNImageRequestHandler init returned nil".into(),
        ));
    }

    let request_cls: &AnyClass = class!(VNRecognizeTextRequest);
    let request: *mut AnyObject = msg_send![request_cls, alloc];
    let request: *mut AnyObject = msg_send![request, init];
    if request.is_null() {
        let _: () = msg_send![handler, release];
        return Err(OcrError::Backend(
            "VNRecognizeTextRequest init returned nil".into(),
        ));
    }
    let _: () = msg_send![request, setRecognitionLevel: RECOGNITION_LEVEL_ACCURATE];
    let _: () = msg_send![request, setUsesLanguageCorrection: true];

    let ns_array_cls: &AnyClass = class!(NSArray);
    let requests: *mut AnyObject = msg_send![ns_array_cls, arrayWithObject: request];

    let mut error: *mut AnyObject = std::ptr::null_mut();
    let ok: bool = msg_send![handler, performRequests: requests, error: &mut error];

    let outcome = if ok {
        Ok(collect_lines(request))
    } else {
        Err(OcrError::Backend(ns_error_message(error)))
    };

    let _: () = msg_send![request, release];
    let _: () = msg_send![handler, release];
    outcome.map(OcrResult::from_lines)
}

/// Walk `request.results` → `topCandidates:1` → (`string`, `confidence`) and
/// pair each with its flipped bounding box.
unsafe fn collect_lines(request: *mut AnyObject) -> Vec<OcrLine> {
    let results: *mut AnyObject = msg_send![request, results];
    if results.is_null() {
        return Vec::new();
    }
    let count: usize = msg_send![results, count];
    let mut lines = Vec::with_capacity(count);

    for index in 0..count {
        let observation: *mut AnyObject = msg_send![results, objectAtIndex: index];
        if observation.is_null() {
            continue;
        }
        let candidates: *mut AnyObject = msg_send![observation, topCandidates: 1usize];
        if candidates.is_null() {
            continue;
        }
        let candidate_count: usize = msg_send![candidates, count];
        if candidate_count == 0 {
            continue;
        }
        let candidate: *mut AnyObject = msg_send![candidates, objectAtIndex: 0usize];
        if candidate.is_null() {
            continue;
        }
        let text = match ns_string_to_rust(msg_send![candidate, string]) {
            Some(text) if !text.is_empty() => text,
            _ => continue,
        };
        // VNConfidence is a float in 0..=1; clamp defensively so the value we
        // publish always satisfies the documented range.
        let confidence: f32 = msg_send![candidate, confidence];
        let rect: CgRect = msg_send![observation, boundingBox];

        lines.push(OcrLine {
            text,
            bbox: flip_to_top_left(rect),
            confidence: confidence.clamp(0.0, 1.0),
        });
    }
    lines
}

/// Vision reports normalized rects with the origin at the bottom-left; the
/// crate contract is top-left (see [`super`]).
fn flip_to_top_left(rect: CgRect) -> BBox {
    BBox {
        x: rect.origin.x as f32,
        y: (1.0 - (rect.origin.y + rect.size.height)) as f32,
        width: rect.size.width as f32,
        height: rect.size.height as f32,
    }
}

/// Copy an `NSString*` into an owned Rust `String`. Returns `None` for nil or
/// a null UTF-8 buffer.
unsafe fn ns_string_to_rust(ns_string: *mut AnyObject) -> Option<String> {
    if ns_string.is_null() {
        return None;
    }
    let utf8: *const std::os::raw::c_char = msg_send![ns_string, UTF8String];
    if utf8.is_null() {
        return None;
    }
    Some(
        std::ffi::CStr::from_ptr(utf8)
            .to_string_lossy()
            .into_owned(),
    )
}

/// Best-effort `localizedDescription` of an `NSError*`.
unsafe fn ns_error_message(error: *mut AnyObject) -> String {
    if error.is_null() {
        return "Vision performRequests failed".to_string();
    }
    let description: *mut AnyObject = msg_send![error, localizedDescription];
    ns_string_to_rust(description).unwrap_or_else(|| "Vision performRequests failed".to_string())
}
