#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 灵器 AI desktop shell: a hardened single-window browser for the remote
//! web app, plus offline recovery. Previously the Electron main process
//! (packages/novel-desktop/src/*.ts); now a Tauri 2 shell.

mod bridge;
mod logging;
mod policy;
mod recovery;
mod updater;

use serde_json::json;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// Response CSP injected on the two product origins (ported from the
/// Electron session security).
const CSP_DIRECTIVES: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

fn main() {
    let application_url = resolve_startup_url();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_existing_window(app);
        }))
        .plugin(build_log_plugin());
    if let Some(updater_plugin) = updater::build_updater_plugin() {
        builder = builder.plugin(updater_plugin);
    }
    builder
        .setup(move |app| {
            create_main_window(app.handle(), application_url.clone())?;
            updater::schedule_update_check(app.handle().clone());
            logging::log_event(
                log::Level::Info,
                "desktop-started",
                json!({
                    "version": app.package_info().version.to_string(),
                    "platform": std::env::consts::OS,
                    "arch": std::env::consts::ARCH,
                }),
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn resolve_startup_url() -> Url {
    let env_override = std::env::var("NOVEL_DESKTOP_APP_URL").ok();
    match policy::resolve_application_url(cfg!(debug_assertions), env_override.as_deref()) {
        Ok(url) => url,
        Err(message) => {
            eprintln!("desktop config error: {message}");
            std::process::exit(1);
        }
    }
}

fn focus_existing_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::LogDir {
                file_name: Some("desktop".to_string()),
            }),
            Target::new(TargetKind::Stdout),
        ])
        .level(log::LevelFilter::Info)
        .max_file_size(1_048_576)
        .rotation_strategy(RotationStrategy::KeepOne)
        .build()
}

fn create_main_window(
    app: &AppHandle,
    application_url: Url,
) -> Result<(), Box<dyn std::error::Error>> {
    let navigation_policy = policy::NavigationPolicy::new(&application_url);
    let watchdog = recovery::spawn_recovery_watchdog(app.clone(), application_url.clone());
    let bridge_script =
        bridge::bridge_initialization_script(app.package_info().version.to_string().as_str())?;
    let app_origin = application_url.origin();
    let csp_watch_origins = [
        app_origin.ascii_serialization(),
        policy::PUBLIC_ORIGIN.to_string(),
    ];

    let builder =
        WebviewWindowBuilder::new(app, "main", WebviewUrl::External(application_url.clone()))
            .title("灵器 AI")
            .inner_size(1440.0, 960.0)
            .min_inner_size(1024.0, 720.0)
            .resizable(true)
            .visible(false)
            .initialization_script(&bridge_script)
            .on_navigation({
                let app = app.clone();
                let watchdog = watchdog.clone();
                move |url| match navigation_policy.decide(url) {
                    policy::NavigationDecision::Allow => {
                        // Arm/disarm at navigation-request time: a failed
                        // connection never reaches the page-load events.
                        let _ = watchdog.send(recovery::LoadEvent::NavigationStarted {
                            is_app_origin: navigation_policy.is_app_origin(url),
                        });
                        true
                    }
                    policy::NavigationDecision::External => {
                        let blocked = policy::sanitize_navigation_log(url.as_str());
                        logging::log_event(
                            log::Level::Warn,
                            "navigation-external",
                            json!({"origin": blocked.origin, "path": blocked.path}),
                        );
                        let target = url.clone();
                        let nav_app = app.clone();
                        let opener_app = nav_app.clone();
                        let _ = nav_app.run_on_main_thread(move || {
                            let _ = opener_app.opener().open_url(target.as_str(), None::<&str>);
                        });
                        false
                    }
                    policy::NavigationDecision::Deny => {
                        let blocked = policy::sanitize_navigation_log(url.as_str());
                        logging::log_event(
                            log::Level::Warn,
                            "navigation-blocked",
                            json!({"origin": blocked.origin, "path": blocked.path}),
                        );
                        false
                    }
                }
            })
            .on_page_load({
                let app = app.clone();
                let watchdog = watchdog.clone();
                move |_webview, payload| match payload.event() {
                    tauri::webview::PageLoadEvent::Started => {
                        let is_app_origin = Url::parse(payload.url().as_str())
                            .map(|url| url.origin() == app_origin)
                            .unwrap_or(false);
                        let _ =
                            watchdog.send(recovery::LoadEvent::NavigationStarted { is_app_origin });
                    }
                    tauri::webview::PageLoadEvent::Finished => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                        }
                        let _ = watchdog.send(recovery::LoadEvent::LoadFinished);
                    }
                }
            })
            .on_web_resource_request({
                move |request, response| {
                    let Some(origin) = request_origin(request.uri()) else {
                        return;
                    };
                    if !csp_watch_origins.contains(&origin) {
                        return;
                    }
                    if let Ok(value) = tauri::http::HeaderValue::from_str(CSP_DIRECTIVES) {
                        response
                            .headers_mut()
                            .insert("Content-Security-Policy", value);
                    }
                }
            });
    builder.build()?;
    Ok(())
}

fn request_origin(uri: &tauri::http::Uri) -> Option<String> {
    let scheme = uri.scheme_str()?;
    if scheme != "https" {
        return None;
    }
    let host = uri.host()?;
    match uri.port_u16() {
        Some(port) => Some(format!("{scheme}://{host}:{port}")),
        None => Some(format!("{scheme}://{host}")),
    }
}
