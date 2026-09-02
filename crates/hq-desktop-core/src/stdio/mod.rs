//! Bounded stdio child processes: NDJSON in, NDJSON out.
//!
//! # What this module is
//!
//! A [`StdioChild`] is one subprocess speaking newline-delimited JSON over its
//! stdin/stdout. It is deliberately **protocol-agnostic**: it frames, bounds,
//! and contains: it does not interpret. Drivers layer meaning on top —
//! a Claude `stream-json` driver reads a frame stream with
//! [`StdioChild::next_frame`]; a Codex JSON-RPC driver pairs ids with
//! [`StdioChild::send_request`]. Both get the same containment for free, and
//! there is one place to fix when a vendor CLI misbehaves.
//!
//! # The three guarantees
//!
//! **Everything is bounded.** No unbounded read, no unbounded write, no
//! unbounded wait. Reads are capped at [`MAX_LINE_SIZE`] *by the codec*, so a
//! child that writes forever without a newline cannot grow the decode buffer
//! past the cap. Reads also carry two deadlines: an idle timeout that resets on
//! any byte of wire activity (a noisy child is not a silent one), and an
//! absolute hard deadline checked *before* each select so a child that chatters
//! flat out cannot starve the timer arm. Writes are capped by
//! [`child::WRITE_TIMEOUT`], and a blocked write is classified as crash-class:
//! a child that has stopped draining its own stdin cannot serve another turn.
//! Reaps are capped by [`child::REAP_TIMEOUT`].
//!
//! **Nothing is orphaned.** The child leads its own process group on Unix
//! (`process_group(0)`), so teardown signals the negated pid and takes the MCP
//! servers and tool processes it spawned with it. Windows has no process
//! groups, so the equivalent is a Job Object with `KILL_ON_JOB_CLOSE` created
//! at spawn. [`StdioChild::shutdown`] is the guaranteed path; `Drop` is a
//! best-effort net behind it.
//!
//! **Children join the host's exit drain.** [`StdioProcessRegistrar`] is a seam,
//! not a registry: the host app installs one implementation
//! ([`set_process_registrar`]) that forwards into whatever process registry it
//! already drains at quit, and `hq-desktop-core` stays free of Tauri. With no
//! registrar installed — unit tests, headless tooling — everything still works;
//! the children are simply invisible to a drain that does not exist.
//!
//! A reap that times out deliberately **keeps** its registry entry: that is
//! precisely the case where the process is most likely still alive, so the
//! app's exit drain should get a second pass at it.
//!
//! # Flapping
//!
//! [`SlotCircuit`] is the crash breaker a supervisor wraps around all of this.
//! A child that dies on startup dies on every restart; without a breaker that
//! is a spin loop. Classify a failure with [`StdioError::is_crash_class`], feed
//! it to [`SlotCircuit::record_crash`], and respect the [`CrashVerdict`].

pub mod child;
pub mod circuit;
pub mod registrar;

pub use child::{StdioChild, StdioError, StdioLaunch, MAX_LINE_SIZE};
pub use circuit::{CrashVerdict, SlotCircuit};
pub use registrar::{set_process_registrar, StdioProcessRegistrar};
