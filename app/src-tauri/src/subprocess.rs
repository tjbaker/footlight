// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The one async subprocess runner behind every native command (#262).
//!
//! Every `#[tauri::command]` that shells out to ffmpeg / ffprobe / the footlight
//! CLI goes through [`run_output`]. It uses `tokio::process`, so a long render,
//! track, loudness or scenes pass awaits its child instead of parking a tokio
//! worker thread in a blocking `wait()`; the other IPC (`get_secret`,
//! `save_session`, …) stays responsive while those jobs run.
//!
//! Lifetime policy (who may stop a child):
//! - Every child is spawned with `kill_on_drop(true)`. Tauri never drops a
//!   running command's future on its own (a window close or webview reload
//!   doesn't cancel it), so in practice the only thing that drops one is the
//!   quit path below. That's also where the temp file each command holds
//!   (`tempfile::TempPath`) gets deleted, alongside its child.
//! - When Footlight quits, [`stop_all`] (called from `RunEvent::Exit`) signals
//!   every in-flight run, which drops its child (SIGKILL) and waits briefly
//!   for them to go, so no ffmpeg or node outlives the app. A footlight CLI
//!   child (track / render) leaves its own ffmpeg grandchild without a reader
//!   on its stdout/stderr pipes, so that ffmpeg exits on its next write
//!   (render ffmpeg runs with `-stats`, writing progress about twice a second).
//! - A render is never stopped silently. [`Kind::Render`] runs are counted, and
//!   main.rs asks before quitting while one runs ("Quit" / "Keep Rendering");
//!   only a confirmed quit reaches `stop_all`. Analysis runs (frame, probe,
//!   scenes, loudness, cover, track) only matter to the window waiting on them,
//!   so quitting stops them without asking.

use std::process::{Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::watch;

/// What a subprocess is for, which decides whether quitting has to ask first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Work whose result only matters to the caller awaiting it. Quitting
    /// stops it without asking.
    Analysis,
    /// A render the user started. Quitting while one runs asks first.
    Render,
}

/// In-flight subprocess bookkeeping: how many runs are live (so the quit path
/// can wait for them to stop), how many of those are renders, and the
/// "quitting" signal every run listens for.
pub struct Registry {
    live: Mutex<usize>,
    idle: Condvar,
    renders: AtomicUsize,
    quitting: watch::Sender<bool>,
}

/// Counts one run as live for as long as it exists. Dropped AFTER the run's
/// child (declared before it), so `stop_all` only sees zero once the children
/// are gone.
struct Live<'a> {
    reg: &'a Registry,
    kind: Kind,
}

impl Drop for Live<'_> {
    fn drop(&mut self) {
        if self.kind == Kind::Render {
            self.reg.renders.fetch_sub(1, Ordering::SeqCst);
        }
        let mut live = self.reg.lock_live();
        *live -= 1;
        if *live == 0 {
            self.reg.idle.notify_all();
        }
    }
}

impl Registry {
    pub fn new() -> Self {
        Registry {
            live: Mutex::new(0),
            idle: Condvar::new(),
            renders: AtomicUsize::new(0),
            quitting: watch::channel(false).0,
        }
    }

    fn lock_live(&self) -> MutexGuard<'_, usize> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn enter(&self, kind: Kind) -> Live<'_> {
        *self.lock_live() += 1;
        if kind == Kind::Render {
            self.renders.fetch_add(1, Ordering::SeqCst);
        }
        Live { reg: self, kind }
    }

    /// Run `cmd` to completion and collect its output, like
    /// `std::process::Command::output()` but awaited. `what` names the
    /// program in error messages ("ffmpeg", "node CLI"). A non-zero exit is
    /// NOT an error here (callers inspect `status`), only a failed spawn or a
    /// quit.
    pub async fn run(&self, cmd: Command, what: &str, kind: Kind) -> Result<Output, String> {
        let mut stdout = Vec::new();
        let mut out = self
            .run_streaming(cmd, what, kind, |chunk| stdout.extend_from_slice(chunk))
            .await?;
        out.stdout = stdout;
        Ok(out)
    }

    /// [`Registry::run`], but stdout is handed to `on_stdout` chunk by chunk
    /// as the child writes it instead of being collected (the returned
    /// `Output::stdout` is empty), for output too large to hold, like the
    /// loudness pass's PCM (#277). stderr is still collected. Same lifetime
    /// policy: the run is registered, `kill_on_drop` holds, and quitting stops
    /// it.
    pub async fn run_streaming(
        &self,
        mut cmd: Command,
        what: &str,
        kind: Kind,
        mut on_stdout: impl FnMut(&[u8]),
    ) -> Result<Output, String> {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Count the run as live BEFORE checking the quit signal, so `stop_all`
        // either sees this run (and waits for it) or this run sees the signal.
        let _live = self.enter(kind);
        let mut quitting = self.quitting.subscribe();
        if *quitting.borrow_and_update() {
            return Err(format!("{what} not started: Footlight is quitting"));
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn {what}: {e}"))?;
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let mut stderr = child.stderr.take().expect("stderr is piped");
        let work = async {
            // Drain both pipes concurrently (a child blocked on a full stderr
            // pipe would never finish its stdout), then reap it.
            let read_stdout = async {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    let n = stdout.read(&mut buf).await?;
                    if n == 0 {
                        return Ok::<(), std::io::Error>(());
                    }
                    on_stdout(&buf[..n]);
                }
            };
            let mut err = Vec::new();
            let (out_res, err_res) = tokio::join!(read_stdout, stderr.read_to_end(&mut err));
            out_res?;
            err_res?;
            let status = child.wait().await?;
            Ok::<Output, std::io::Error>(Output {
                status,
                stdout: Vec::new(),
                stderr: err,
            })
        };
        tokio::select! {
            out = work => out.map_err(|e| format!("{what} failed: {e}")),
            // Losing this race drops `work`; the child drops when this function
            // returns, and `kill_on_drop` kills it.
            _ = quitting.wait_for(|q| *q) => Err(format!("{what} stopped: Footlight is quitting")),
        }
    }

    /// Whether a render is running right now.
    pub fn render_running(&self) -> bool {
        self.renders.load(Ordering::SeqCst) > 0
    }

    /// Stop every in-flight run and wait up to `grace` for them to go. Returns
    /// whether they all did. Runs started afterwards fail fast.
    pub fn stop_all(&self, grace: Duration) -> bool {
        self.quitting.send_replace(true);
        let live = self.lock_live();
        let (live, _) = self
            .idle
            .wait_timeout_while(live, grace, |n| *n > 0)
            .unwrap_or_else(|e| e.into_inner());
        *live == 0
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

/// The app-wide registry the commands and the quit path share.
fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::new)
}

/// [`Registry::run`] on the app-wide registry. Every native command's
/// subprocess goes through here.
pub async fn run_output(cmd: Command, what: &str, kind: Kind) -> Result<Output, String> {
    registry().run(cmd, what, kind).await
}

/// [`Registry::run_streaming`] on the app-wide registry.
pub async fn run_streaming(
    cmd: Command,
    what: &str,
    kind: Kind,
    on_stdout: impl FnMut(&[u8]),
) -> Result<Output, String> {
    registry().run_streaming(cmd, what, kind, on_stdout).await
}

/// Whether a render is running in the app (asked before quitting).
pub fn render_running() -> bool {
    registry().render_running()
}

/// Stop every subprocess the app started; called once Footlight is exiting.
pub fn stop_all() -> bool {
    registry().stop_all(Duration::from_secs(3))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    }

    fn sh(script: &str) -> Command {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script);
        cmd
    }

    #[test]
    fn run_collects_stdout_stderr_and_a_failing_status() {
        let reg = Registry::new();
        let out = rt()
            .block_on(reg.run(
                sh("printf out; printf err >&2; exit 3"),
                "sh",
                Kind::Analysis,
            ))
            .unwrap();
        assert_eq!(out.stdout, b"out");
        assert_eq!(out.stderr, b"err");
        assert_eq!(out.status.code(), Some(3)); // non-zero is the caller's call
        assert!(!reg.render_running());
        assert!(reg.stop_all(Duration::from_millis(10))); // nothing left live
    }

    #[test]
    fn run_streaming_hands_over_stdout_without_collecting_it() {
        // ~1 MiB of stdout across many reads, plus stderr, without deadlock.
        let reg = Registry::new();
        let mut seen = 0usize;
        let mut chunks = 0usize;
        let out = rt()
            .block_on(reg.run_streaming(
                sh("head -c 1048576 /dev/zero; printf err >&2; exit 2"),
                "sh",
                Kind::Analysis,
                |chunk| {
                    assert!(chunk.iter().all(|&b| b == 0));
                    seen += chunk.len();
                    chunks += 1;
                },
            ))
            .unwrap();
        assert_eq!(seen, 1 << 20);
        assert!(chunks > 1, "stdout arrived in one piece");
        assert!(out.stdout.is_empty()); // handed over, not collected
        assert_eq!(out.stderr, b"err");
        assert_eq!(out.status.code(), Some(2));
        assert!(reg.stop_all(Duration::from_millis(10))); // nothing left live
    }

    #[test]
    fn spawn_failure_names_the_program() {
        let reg = Registry::new();
        let err = rt()
            .block_on(reg.run(
                Command::new("footlight-no-such-binary"),
                "ffmpeg",
                Kind::Analysis,
            ))
            .unwrap_err();
        assert!(err.starts_with("failed to spawn ffmpeg: "), "{err}");
    }

    #[test]
    fn runs_do_not_block_worker_threads() {
        // Two 1s children on a 2-worker runtime, plus a third task: with a
        // blocking wait both workers would be parked and the third task would
        // wait the full second. Awaiting the children leaves the workers free.
        let reg = Arc::new(Registry::new());
        let rt = rt();
        let start = Instant::now();
        let slow: Vec<_> = (0..2)
            .map(|_| {
                let reg = reg.clone();
                rt.spawn(async move { reg.run(sh("sleep 1"), "sh", Kind::Analysis).await })
            })
            .collect();
        let quick = rt.block_on(async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            rt.spawn(async { Instant::now() }).await.unwrap()
        });
        assert!(quick.duration_since(start) < Duration::from_millis(800));
        for h in slow {
            assert!(rt.block_on(h).unwrap().unwrap().status.success());
        }
    }

    #[test]
    fn stop_all_kills_live_children_and_rejects_new_runs() {
        let reg = Arc::new(Registry::new());
        let rt = rt();
        let render = {
            let reg = reg.clone();
            rt.spawn(async move { reg.run(sh("sleep 30"), "node CLI", Kind::Render).await })
        };
        let probe = {
            let reg = reg.clone();
            rt.spawn(async move { reg.run(sh("sleep 30"), "ffprobe", Kind::Analysis).await })
        };
        // Wait until both are live, and the render is counted.
        let deadline = Instant::now() + Duration::from_secs(5);
        while *reg.lock_live() < 2 {
            assert!(Instant::now() < deadline, "children never started");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(reg.render_running());

        let start = Instant::now();
        assert!(reg.stop_all(Duration::from_secs(5)));
        assert!(start.elapsed() < Duration::from_secs(5)); // killed, not waited out
        assert!(!reg.render_running());
        let err = rt.block_on(render).unwrap().unwrap_err();
        assert_eq!(err, "node CLI stopped: Footlight is quitting");
        assert!(rt.block_on(probe).unwrap().is_err());

        let late = rt
            .block_on(reg.run(sh("true"), "ffmpeg", Kind::Analysis))
            .unwrap_err();
        assert_eq!(late, "ffmpeg not started: Footlight is quitting");
    }
}
