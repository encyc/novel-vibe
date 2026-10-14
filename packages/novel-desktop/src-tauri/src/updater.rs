//! Auto-update. Mirrors the Electron updater contract: stable packaged
//! builds only, first check 30s after launch, then every 6 hours, and the
//! user always chooses whether to restart. The release channel and the
//! minisign pubkey are compiled in at packaging time (CI env), so preview
//! builds carry no updater at all.

use std::time::Duration;

use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

use crate::logging;

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);

/// Compiled in by the packaging pipeline; matches the Electron release
/// channel contract (`stable` | `preview-unsigned`).
pub fn release_channel() -> &'static str {
    match option_env!("NOVEL_VIBE_RELEASE_CHANNEL") {
        Some("stable") => "stable",
        Some("preview-unsigned") | None => "preview-unsigned",
        Some(other) => panic!("Unsupported desktop release channel: {other}"),
    }
}

/// The updater plugin for stable builds; `None` (nothing registered at all)
/// for preview builds or when no pubkey was compiled in. The feed endpoint
/// itself is public and lives in tauri.conf.json (`plugins.updater`).
pub fn build_updater_plugin() -> Option<impl tauri::plugin::Plugin<tauri::Wry>> {
    if release_channel() != "stable" {
        return None;
    }
    let pubkey = option_env!("NOVEL_VIBE_UPDATER_PUBKEY")?;
    Some(tauri_plugin_updater::Builder::new().pubkey(pubkey).build())
}

pub fn schedule_update_check(app: AppHandle) {
    if release_channel() != "stable" {
        return;
    }
    std::thread::Builder::new()
        .name("update-check".to_string())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK_DELAY);
            loop {
                check_and_prompt(&app);
                std::thread::sleep(CHECK_INTERVAL);
            }
        })
        .expect("failed to spawn update check thread");
}

fn check_and_prompt(app: &AppHandle) {
    let available = tauri::async_runtime::block_on(async { app.updater()?.check().await });
    let Ok(Some(update)) = available else {
        if available.is_err() {
            // Never log raw transport errors — they can embed URLs.
            logging::log_event(
                log::Level::Warn,
                "update-check-failed",
                json!({"status": "error"}),
            );
        }
        return;
    };
    logging::log_event(
        log::Level::Info,
        "update-available",
        json!({"version": update.version}),
    );
    let accepted = app
        .dialog()
        .message(format!(
            "发现新版本 {}。是否立即下载并重启安装?",
            update.version
        ))
        .title("灵器 AI 更新")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "立即更新".to_string(),
            "稍后".to_string(),
        ))
        .blocking_show();
    if !accepted {
        return;
    }
    logging::log_event(
        log::Level::Info,
        "update-install",
        json!({"version": update.version}),
    );
    let installed =
        tauri::async_runtime::block_on(update.download_and_install(|_chunk, _total| {}, || {}));
    if installed.is_ok() {
        app.restart();
    } else {
        logging::log_event(
            log::Level::Error,
            "update-install-failed",
            json!({"status": "error"}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_channel_is_preview_unsigned() {
        // Test builds compile without channel env: updates stay off.
        assert_eq!(release_channel(), "preview-unsigned");
    }

    #[test]
    fn preview_builds_register_no_updater() {
        assert!(build_updater_plugin().is_none());
    }
}
