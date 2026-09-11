//! Platform seams for OS-specific desktop integration behind `cfg(target_os)`.

pub mod autostart;
pub mod launchagent;
pub mod notifications;
pub mod ocr;
pub mod permissions;
pub mod screenshot;
pub mod tray_geometry;
pub mod window_effects;
