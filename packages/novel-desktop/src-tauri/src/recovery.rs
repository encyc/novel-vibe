//! Offline recovery. Tauri has no direct equivalent of Electron's
//! `did-fail-load`, so a watchdog thread arms itself whenever the main-frame
//! navigates to the app origin; if the page never reports a finished load
//! within the timeout, the webview is swapped to the bundled recovery page,
//! whose retry button returns to the stalled origin (passed in the URL
//! fragment).

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Manager};
use url::Url;

use crate::logging;
use crate::policy;

pub const LOAD_TIMEOUT: Duration = Duration::from_secs(15);

/// Long poll while disarmed; the channel reconnect wakes us instantly.
const IDLE_POLL: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadEvent {
    NavigationStarted { is_app_origin: bool },
    LoadFinished,
}

/// Pure decision core: tracks whether a main-frame load is in flight.
#[derive(Debug)]
pub struct RecoveryMonitor {
    timeout: Duration,
    load_deadline: Option<Instant>,
}

impl RecoveryMonitor {
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            load_deadline: None,
        }
    }

    /// Arms (or re-arms, for redirect chains) the watchdog when the main
    /// frame starts loading the app origin; disarms for any other target.
    pub fn on_navigation_started(&mut self, is_app_origin: bool, now: Instant) -> Option<Instant> {
        if !is_app_origin {
            self.load_deadline = None;
            return None;
        }
        let deadline = now + self.timeout;
        self.load_deadline = Some(deadline);
        Some(deadline)
    }

    pub fn on_load_finished(&mut self) {
        self.load_deadline = None;
    }

    pub fn on_deadline(&mut self, now: Instant) -> bool {
        match self.load_deadline {
            Some(deadline) if now >= deadline => {
                self.load_deadline = None;
                true
            }
            _ => false,
        }
    }
}

pub fn spawn_recovery_watchdog(app: AppHandle, application_url: Url) -> Sender<LoadEvent> {
    let (sender, receiver) = mpsc::channel::<LoadEvent>();
    std::thread::Builder::new()
        .name("recovery-watchdog".to_string())
        .spawn(move || run_watchdog(app, application_url, receiver))
        .expect("failed to spawn recovery watchdog thread");
    sender
}

fn run_watchdog(app: AppHandle, application_url: Url, receiver: Receiver<LoadEvent>) {
    let mut monitor = RecoveryMonitor::new(LOAD_TIMEOUT);
    // The initial load targets the app origin, but a connection failure
    // (DNS, TLS reset) never reaches the page-load events — so the watchdog
    // is armed from startup, exactly as if the first navigation requested.
    let mut deadline = monitor.on_navigation_started(true, Instant::now());
    loop {
        let wait = deadline.map_or(IDLE_POLL, |d| d.saturating_duration_since(Instant::now()));
        match receiver.recv_timeout(wait) {
            Ok(LoadEvent::NavigationStarted { is_app_origin }) => {
                deadline = monitor.on_navigation_started(is_app_origin, Instant::now());
            }
            Ok(LoadEvent::LoadFinished) => {
                monitor.on_load_finished();
                deadline = None;
            }
            Err(RecvTimeoutError::Timeout) => {
                deadline = None;
                if monitor.on_deadline(Instant::now()) {
                    swap_to_recovery_page(&app, &application_url);
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn swap_to_recovery_page(app: &AppHandle, application_url: &Url) {
    let stalled = policy::sanitize_navigation_log(application_url.as_str());
    logging::log_event(
        log::Level::Warn,
        "load-watchdog-timeout",
        json!({
            "origin": stalled.origin,
            "path": stalled.path,
        }),
    );
    if let Some(window) = app.get_webview_window("main") {
        let target = format!(
            "{}/offline.html#{}",
            policy::INTERNAL_ORIGIN,
            application_url
        );
        // Navigate directly. `eval` needs a live document to execute in, and a
        // failed load leaves none — which is precisely the situation this
        // recovery page exists for. Found live: the watchdog fired on time and
        // logged `recovery-page-shown`, but `window.location.replace` never
        // ran, so the window stayed blank for as long as it was open.
        match Url::parse(&target)
            .map_err(|error| error.to_string())
            .and_then(|url| window.navigate(url).map_err(|error| error.to_string()))
        {
            Ok(()) => {
                // Show even though navigation is synchronous from our side: the
                // window may still be hidden pending the first paint.
                let _ = window.show();
                let _ = window.set_focus();
                logging::log_event(log::Level::Info, "recovery-page-shown", json!({}));
            }
            Err(error) => {
                log::error!("recovery page navigation failed: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arms_on_app_origin_navigation_and_fires_on_timeout() {
        let mut monitor = RecoveryMonitor::new(LOAD_TIMEOUT);
        let start = Instant::now();
        assert!(monitor.on_navigation_started(true, start).is_some());
        assert!(!monitor.on_deadline(start + LOAD_TIMEOUT - Duration::from_secs(1)));
        assert!(monitor.on_deadline(start + LOAD_TIMEOUT));
        // Firing once disarms; a second deadline tick is a no-op.
        assert!(!monitor.on_deadline(start + LOAD_TIMEOUT + Duration::from_secs(1)));
    }

    #[test]
    fn finished_load_disarms() {
        let mut monitor = RecoveryMonitor::new(LOAD_TIMEOUT);
        let start = Instant::now();
        monitor.on_navigation_started(true, start);
        monitor.on_load_finished();
        assert!(!monitor.on_deadline(start + LOAD_TIMEOUT + Duration::from_secs(1)));
    }

    #[test]
    fn navigating_away_disarms() {
        let mut monitor = RecoveryMonitor::new(LOAD_TIMEOUT);
        let start = Instant::now();
        monitor.on_navigation_started(true, start);
        assert!(monitor.on_navigation_started(false, start).is_none());
        assert!(!monitor.on_deadline(start + LOAD_TIMEOUT + Duration::from_secs(1)));
    }

    #[test]
    fn redirect_chain_rearms_the_deadline() {
        let mut monitor = RecoveryMonitor::new(LOAD_TIMEOUT);
        let start = Instant::now();
        monitor.on_navigation_started(true, start);
        let second = start + Duration::from_secs(10);
        let rearmed = monitor.on_navigation_started(true, second).unwrap();
        assert_eq!(rearmed, second + LOAD_TIMEOUT);
        // The original deadline must no longer fire.
        assert!(!monitor.on_deadline(start + LOAD_TIMEOUT));
        assert!(monitor.on_deadline(second + LOAD_TIMEOUT));
    }

    #[test]
    fn non_app_origin_navigation_never_arms() {
        let mut monitor = RecoveryMonitor::new(LOAD_TIMEOUT);
        let start = Instant::now();
        assert!(monitor.on_navigation_started(false, start).is_none());
        assert!(!monitor.on_deadline(start + LOAD_TIMEOUT));
    }
}
