//! The renderer bridge. A frozen `window.novelDesktop` is injected into the
//! main frame before any page script runs; its payload is static per build,
//! so the bridge resolves without any IPC surface at all.

/// Mirrors the Electron `createRuntimeInfo` contract: only the two shipped
/// desktop platforms are supported.
pub fn runtime_info_for(os: &str, app_version: &str) -> Result<String, String> {
    let platform = match os {
        "macos" => "macos",
        "windows" => "windows",
        other => return Err(format!("Unsupported desktop platform: {other}")),
    };
    let version = serde_json::to_string(app_version).expect("app version serializes");
    Ok(format!(
        r#"{{"platform":"{platform}","appVersion":{version},"capabilities":[]}}"#
    ))
}

/// Script injected via `initialization_script`. Runs before page scripts in
/// every frame; the `window.top` guard keeps the bridge main-frame only.
pub fn bridge_initialization_script(app_version: &str) -> Result<String, String> {
    bridge_initialization_script_for(std::env::consts::OS, app_version)
}

/// Pure variant taking the platform explicitly, so tests run on any host.
pub fn bridge_initialization_script_for(os: &str, app_version: &str) -> Result<String, String> {
    let info = runtime_info_for(os, app_version)?;
    Ok(format!(
        "(function () {{\n\
         \x20 if (window.top !== window) {{ return; }}\n\
         \x20 var info = {info};\n\
         \x20 window.novelDesktop = Object.freeze({{\n\
         \x20   apiVersion: 1,\n\
         \x20   getRuntimeInfo: function () {{ return Promise.resolve(info); }}\n\
         \x20 }});\n\
         }})();"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_info_serializes_the_contract() {
        let info: serde_json::Value =
            serde_json::from_str(&runtime_info_for("macos", "0.2.0").unwrap()).unwrap();
        assert_eq!(info["platform"], "macos");
        assert_eq!(info["appVersion"], "0.2.0");
        assert_eq!(info["capabilities"], serde_json::json!([]));
        let info: serde_json::Value =
            serde_json::from_str(&runtime_info_for("windows", "1.0.0").unwrap()).unwrap();
        assert_eq!(info["platform"], "windows");
    }

    #[test]
    fn unsupported_platforms_are_rejected() {
        assert!(runtime_info_for("linux", "0.2.0").is_err());
    }

    #[test]
    fn script_exposes_a_frozen_main_frame_bridge() {
        let script = bridge_initialization_script_for("macos", "0.2.0").unwrap();
        assert!(script.contains("if (window.top !== window)"), "{script}");
        assert!(script.contains("Object.freeze"), "{script}");
        assert!(script.contains("apiVersion: 1"), "{script}");
        assert!(script.contains("getRuntimeInfo"), "{script}");
        assert!(script.contains(r#""platform":"macos""#), "{script}");
        let script = bridge_initialization_script_for("windows", "0.2.0").unwrap();
        assert!(script.contains(r#""platform":"windows""#), "{script}");
    }

    #[test]
    fn script_version_is_json_escaped() {
        let script = bridge_initialization_script_for("macos", "0.2.0-rc\"1").unwrap();
        assert!(script.contains(r#""appVersion":"0.2.0-rc\"1""#), "{script}");
    }
}
