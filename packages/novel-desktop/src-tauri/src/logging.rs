//! Structured shell logging. Only a fixed allowlist of detail keys can ever
//! reach the log file, so user content and secrets cannot leak through
//! ad-hoc fields (ported from the Electron shell's logging.ts).

use serde_json::{Map, Value};

const ALLOWED_KEYS: [&str; 7] = [
    "arch",
    "errorCode",
    "origin",
    "path",
    "platform",
    "status",
    "version",
];

pub fn sanitize_log_value(value: Map<String, Value>) -> Map<String, Value> {
    value
        .into_iter()
        .filter(|(key, item)| {
            ALLOWED_KEYS.contains(&key.as_str())
                && matches!(item, Value::String(_) | Value::Number(_) | Value::Bool(_))
        })
        .collect()
}

pub fn log_event(level: log::Level, event: &str, details: Value) {
    let sanitized = sanitize_log_value(details.as_object().cloned().unwrap_or_default());
    let rendered = serde_json::to_string(&Value::Object(sanitized)).unwrap_or_default();
    log::log!(level, "{event} {rendered}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_only_allowed_scalar_keys() {
        let clean = sanitize_log_value(
            json!({
                "origin": "https://app.lingqiai.art",
                "path": "/login",
                "status": 200,
                "version": "0.2.0",
                "nested": {"secret": "x"},
                "list": [1, 2],
                "query": "?token=abc",
                "user": "someone",
                "flag": true,
                "nothing": null
            })
            .as_object()
            .cloned()
            .unwrap(),
        );
        assert_eq!(
            Value::Object(clean),
            json!({
                "origin": "https://app.lingqiai.art",
                "path": "/login",
                "status": 200,
                "version": "0.2.0"
            })
        );
    }

    #[test]
    fn empty_and_non_object_details_render_as_empty() {
        assert_eq!(
            serde_json::to_string(&Value::Object(sanitize_log_value(Map::new()))).unwrap(),
            "{}"
        );
    }
}
