//! Platform seams for OS-specific desktop integration behind `cfg(target_os)`.

pub mod autostart;
pub mod intro_window;
pub mod launchagent;
pub mod notifications;
pub mod permissions;
pub mod tray_geometry;
pub mod window_effects;
