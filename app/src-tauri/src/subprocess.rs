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
//! - Tauri never drops a running command's future on its own (a window close
//!   or webview reload doesn't cancel it), so the only thing that stops a child
//!   is Footlight quitting: [`stop_all`], called from `RunEvent::Exit`.
//! - Each child runs in its own process group (Unix) and is stopped by killing
//!   the whole group, then reaped. The group matters for the footlight CLI: a
//!   render's ffmpeg inherits node's stdio and ignores SIGPIPE, so killing node
//!   alone would leave that ffmpeg encoding to its output file. On Windows the
//!   tree is killed with `taskkill /T /F`.
//! - A render is never stopped silently. [`Kind::Render`] work is counted, and
//!   main.rs asks before quitting while a render runs ("Quit" / "Keep
//!   Rendering"). `stop_all(true)` (a confirmed quit) stops renders too;
//!   `stop_all(false)` (an OS-initiated terminate nobody confirmed, e.g. Dock >
//!   Quit or logout) leaves a running render alone, as before #262. Analysis
//!   (frame, probe, scenes, loudness, cover, track) only matters to the window
//!   waiting on it, so any quit stops it without asking.
//! - A command whose child uses a temp file holds a [`hold`] guard declared
//!   BEFORE the `tempfile::TempPath`, so the file is deleted before `stop_all`
//!   stops waiting for that command.
//! - Every child also has `kill_on_drop(true)` as a backstop for any other
//!   path that drops a run.

use std::io;
use std::process::{Output, Stdio};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::watch;

/// What a subprocess is for, which decides whether quitting has to ask first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Work whose result only matters to the caller awaiting it. Quitting
    /// stops it without asking.
    Analysis,
    /// A render the user started. Quitting while one runs asks first, and only
    /// a confirmed quit stops it.
    Render,
}

impl Kind {
    fn index(self) -> usize {
        match self {
            Kind::Analysis => 0,
            Kind::Render => 1,
        }
    }

    /// The stop level at which work of this kind is stopped.
    fn stopped_at(self) -> Stop {
        match self {
            Kind::Analysis => Stop::Analysis,
            Kind::Render => Stop::All,
        }
    }
}

/// How much `stop_all` has asked to stop. Only ever raised.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Stop {
    Nothing,
    Analysis,
    All,
}

/// In-flight work bookkeeping: how many guards of each kind are live (so the
/// quit path can wait for them), and the stop signal every run listens for.
pub struct Registry {
    live: Mutex<[usize; 2]>,
    idle: Condvar,
    stop: watch::Sender<Stop>,
}

/// Counts work of one kind as live for as long as it exists. Inside a run it
/// is dropped after the child is reaped; a command's [`hold`] is dropped after
/// its temp file.
pub struct Live<'a> {
    reg: &'a Registry,
    kind: Kind,
}

impl Drop for Live<'_> {
    fn drop(&mut self) {
        let mut live = self.reg.lock_live();
        live[self.kind.index()] -= 1;
        self.reg.idle.notify_all();
    }
}

impl Registry {
    pub fn new() -> Self {
        Registry {
            live: Mutex::new([0, 0]),
            idle: Condvar::new(),
            stop: watch::channel(Stop::Nothing).0,
        }
    }

    fn lock_live(&self) -> MutexGuard<'_, [usize; 2]> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Count work of `kind` as live until the returned guard drops.
    pub fn hold(&self, kind: Kind) -> Live<'_> {
        self.lock_live()[kind.index()] += 1;
        Live { reg: self, kind }
    }

    /// Run `cmd` to completion and collect its output, like
    /// `std::process::Command::output()` but awaited. `what` names the
    /// program in error messages ("ffmpeg", "node CLI"). A non-zero exit is
    /// NOT an error here (callers inspect `status`), only a failed spawn or a
    /// quit.
    pub async fn run(&self, mut cmd: Command, what: &str, kind: Kind) -> Result<Output, String> {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        // Count the run as live BEFORE checking the stop signal, so `stop_all`
        // either sees this run (and waits for it) or this run sees the signal.
        let _live = self.hold(kind);
        let mut stop = self.stop.subscribe();
        let stopped_at = kind.stopped_at();
        if *stop.borrow_and_update() >= stopped_at {
            return Err(format!("{what} not started: Footlight is quitting"));
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn {what}: {e}"))?;
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let mut stderr = child.stderr.take().expect("stderr is piped");
        {
            let finished = async {
                let (status, stdout, stderr) =
                    tokio::try_join!(child.wait(), read_all(&mut stdout), read_all(&mut stderr))?;
                Ok::<_, io::Error>(Output {
                    status,
                    stdout,
                    stderr,
                })
            };
            tokio::select! {
                out = finished => return out.map_err(|e| format!("{what} failed: {e}")),
                _ = stop.wait_for(|s| *s >= stopped_at) => {}
            }
        }
        // Stopped: kill the child's whole tree, then reap it before `_live`
        // drops, so `stop_all` only returns once the child is really gone.
        kill_tree(&mut child).await;
        let _ = child.wait().await;
        Err(format!("{what} stopped: Footlight is quitting"))
    }

    /// Whether a render is running right now.
    pub fn render_running(&self) -> bool {
        self.lock_live()[Kind::Render.index()] > 0
    }

    /// Stop in-flight work and wait up to `grace` for it to go: all analysis,
    /// plus renders when `include_renders` (the user confirmed quitting during
    /// a render). Returns whether everything stopped. Work of a stopped kind
    /// started afterwards fails fast.
    pub fn stop_all(&self, include_renders: bool, grace: Duration) -> bool {
        let level = if include_renders {
            Stop::All
        } else {
            Stop::Analysis
        };
        self.stop.send_if_modified(|s| {
            let raise = level > *s;
            if raise {
                *s = level;
            }
            raise
        });
        let live = self.lock_live();
        let (live, _) = self
            .idle
            .wait_timeout_while(live, grace, |n| {
                n[Kind::Analysis.index()] > 0 || (include_renders && n[Kind::Render.index()] > 0)
            })
            .unwrap_or_else(|e| e.into_inner());
        live[Kind::Analysis.index()] == 0 && (!include_renders || live[Kind::Render.index()] == 0)
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

async fn read_all(pipe: &mut (impl AsyncRead + Unpin)) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    pipe.read_to_end(&mut buf).await?;
    Ok(buf)
}

/// Kill `child` and everything it started. Unix: the child leads its own
/// process group (`process_group(0)`), so SIGKILL the group. Windows:
/// `taskkill /T /F` walks the tree from the child's pid.
async fn kill_tree(child: &mut Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        // SAFETY: killpg only sends a signal; `pid` is our live, unreaped child,
        // which leads its own group, so the group id can't have been reused.
        unsafe {
            libc::killpg(pid as libc::pid_t, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .await;
        }
    }
    let _ = child.start_kill();
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

/// [`Registry::hold`] on the app-wide registry. A command whose child uses a
/// temp file declares this BEFORE the `TempPath`, so quitting waits for the
/// file to be deleted.
pub fn hold(kind: Kind) -> Live<'static> {
    registry().hold(kind)
}

/// Whether a render is running in the app (asked before quitting).
pub fn render_running() -> bool {
    registry().render_running()
}

/// Stop the subprocesses the app started; called once Footlight is exiting.
/// Renders are stopped only when `include_renders` (the user confirmed).
pub fn stop_all(include_renders: bool) -> bool {
    registry().stop_all(include_renders, Duration::from_secs(3))
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

    /// Block until `count(kind)` live guards exist (the spawned runs started).
    fn wait_live(reg: &Registry, kind: Kind, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while reg.lock_live()[kind.index()] < count {
            assert!(Instant::now() < deadline, "runs never started");
            std::thread::sleep(Duration::from_millis(10));
        }
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
        assert!(reg.stop_all(true, Duration::from_millis(10))); // nothing left live
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
    fn confirmed_stop_kills_live_children_and_rejects_new_runs() {
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
        wait_live(&reg, Kind::Render, 1);
        wait_live(&reg, Kind::Analysis, 1);
        assert!(reg.render_running());

        let start = Instant::now();
        assert!(reg.stop_all(true, Duration::from_secs(5)));
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

    #[test]
    fn unconfirmed_stop_leaves_a_render_running() {
        let reg = Arc::new(Registry::new());
        let rt = rt();
        let render = {
            let reg = reg.clone();
            rt.spawn(async move { reg.run(sh("sleep 0.5"), "node CLI", Kind::Render).await })
        };
        let probe = {
            let reg = reg.clone();
            rt.spawn(async move { reg.run(sh("sleep 30"), "ffprobe", Kind::Analysis).await })
        };
        wait_live(&reg, Kind::Render, 1);
        wait_live(&reg, Kind::Analysis, 1);

        // Returns once the analysis is gone, without waiting on the render.
        assert!(reg.stop_all(false, Duration::from_secs(5)));
        assert!(reg.render_running());
        assert!(rt.block_on(probe).unwrap().is_err());
        // The render runs to completion.
        assert!(rt.block_on(render).unwrap().unwrap().status.success());
    }

    #[test]
    fn stop_all_waits_for_a_hold() {
        // A command's hold (declared before its temp file) keeps quit waiting
        // until the command has deleted the file and dropped the hold.
        let reg = Arc::new(Registry::new());
        let held = Arc::new(std::sync::Barrier::new(2));
        let worker = {
            let (reg, held) = (reg.clone(), held.clone());
            std::thread::spawn(move || {
                let _hold = reg.hold(Kind::Analysis);
                held.wait();
                std::thread::sleep(Duration::from_millis(200));
            })
        };
        held.wait();
        let start = Instant::now();
        assert!(reg.stop_all(false, Duration::from_secs(5)));
        assert!(start.elapsed() >= Duration::from_millis(150));
        worker.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stop_kills_grandchildren_too() {
        // Like the CLI's render ffmpeg: a grandchild that outlives a killed
        // parent unless the whole process group is killed.
        fn alive(pid: libc::pid_t) -> bool {
            // SAFETY: signal 0 only checks that the process exists.
            unsafe { libc::kill(pid, 0) == 0 }
        }
        let pid_file = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        let script = format!("sleep 30 & echo $! > '{}'; wait", pid_file.display());
        let reg = Arc::new(Registry::new());
        let rt = rt();
        let render = {
            let reg = reg.clone();
            rt.spawn(async move { reg.run(sh(&script), "node CLI", Kind::Render).await })
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let grandchild: libc::pid_t = loop {
            if let Ok(pid) = std::fs::read_to_string(&pid_file).unwrap().trim().parse() {
                break pid;
            }
            assert!(Instant::now() < deadline, "grandchild never started");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(alive(grandchild));

        assert!(reg.stop_all(true, Duration::from_secs(5)));
        assert!(rt.block_on(render).unwrap().is_err());
        // Killed; give init a moment to reap the orphaned zombie.
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(grandchild) {
            assert!(Instant::now() < deadline, "grandchild outlived the stop");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
