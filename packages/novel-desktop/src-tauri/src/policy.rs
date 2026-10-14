//! Navigation policy: which URLs the shell webview may load. Mirrors the
//! Electron security model — allow the app origin, the public community
//! pages, and the shell's own internal pages; send other https links to the
//! OS browser; deny everything else.

use url::Url;

pub const APP_ORIGIN: &str = "https://app.lingqiai.art";
pub const PUBLIC_ORIGIN: &str = "https://lingqiai.art";

/// Origin serving the shell's bundled pages (the offline recovery page).
#[cfg(target_os = "windows")]
pub const INTERNAL_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(target_os = "windows"))]
pub const INTERNAL_ORIGIN: &str = "tauri://localhost";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
    /// Load inside the shell webview.
    Allow,
    /// Not an approved page, but safe to hand to the OS browser.
    External,
    /// Refuse entirely.
    Deny,
}

/// URLs that embed credentials are never parsed as usable — the caller must
/// treat them like unparseable input.
pub fn parse_safe_url(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    Some(url)
}

#[derive(Debug, Clone)]
pub struct NavigationPolicy {
    app_origin: url::Origin,
}

impl NavigationPolicy {
    pub fn new(application_url: &Url) -> Self {
        Self {
            app_origin: application_url.origin(),
        }
    }

    pub fn is_app_origin(&self, url: &Url) -> bool {
        url.origin() == self.app_origin
    }

    pub fn is_approved_product_url(&self, url: &Url) -> bool {
        if url.origin() == self.app_origin {
            return true;
        }
        // The public site is only reachable when the app itself is served
        // from the production origin; a dev server gets no site escalation.
        if self.app_origin != production_app_origin() || url.origin() != public_site_origin() {
            return false;
        }
        url.path() == "/community" || url.path().starts_with("/community/")
    }

    pub fn decide(&self, url: &Url) -> NavigationDecision {
        if !url.username().is_empty() || url.password().is_some() {
            return NavigationDecision::Deny;
        }
        if is_internal_webview_url(url) || self.is_approved_product_url(url) {
            return NavigationDecision::Allow;
        }
        if url.scheme() == "https" {
            NavigationDecision::External
        } else {
            NavigationDecision::Deny
        }
    }
}

pub fn is_internal_webview_url(url: &Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        || url.as_str() == "about:blank"
}

/// Log-safe coordinate of a navigation target: origin + path only, never
/// query strings or user content.
#[derive(Debug, PartialEq, Eq)]
pub struct NavigationLog {
    pub origin: String,
    pub path: String,
}

pub fn sanitize_navigation_log(raw: &str) -> NavigationLog {
    match parse_safe_url(raw) {
        Some(url) => NavigationLog {
            origin: url.origin().ascii_serialization(),
            path: url.path().to_string(),
        },
        None => NavigationLog {
            origin: "invalid".to_string(),
            path: String::new(),
        },
    }
}

/// Packaged builds always target the production origin; dev builds may
/// override with a localhost HTTP(S) URL.
pub fn resolve_application_url(is_dev: bool, env_override: Option<&str>) -> Result<Url, String> {
    if !is_dev || env_override.is_none() {
        return Ok(production_app_url());
    }
    let raw = env_override.expect("checked above");
    let candidate = Url::parse(raw).map_err(|_| format!("Invalid NOVEL_DESKTOP_APP_URL: {raw}"))?;
    let is_local = matches!(candidate.host_str(), Some("127.0.0.1") | Some("localhost"));
    let is_http = matches!(candidate.scheme(), "http" | "https");
    if !is_local || !is_http {
        return Err("Development URL must use localhost over HTTP(S)".to_string());
    }
    Ok(candidate)
}

fn production_app_url() -> Url {
    Url::parse(APP_ORIGIN).expect("APP_ORIGIN is a valid URL")
}

fn production_app_origin() -> url::Origin {
    production_app_url().origin()
}

fn public_site_origin() -> url::Origin {
    Url::parse(PUBLIC_ORIGIN)
        .expect("PUBLIC_ORIGIN is a valid URL")
        .origin()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn production() -> NavigationPolicy {
        NavigationPolicy::new(&Url::parse(APP_ORIGIN).unwrap())
    }

    fn dev(port: u16) -> NavigationPolicy {
        NavigationPolicy::new(&Url::parse(&format!("http://127.0.0.1:{port}")).unwrap())
    }

    #[test]
    fn app_origin_is_approved_including_deep_paths() {
        let policy = production();
        for raw in [
            "https://app.lingqiai.art",
            "https://app.lingqiai.art/",
            "https://app.lingqiai.art/login?next=/workspace",
            "https://app.lingqiai.art/projects/abc/documents/x",
        ] {
            let url = parse_safe_url(raw).unwrap();
            assert!(policy.is_approved_product_url(&url), "{raw}");
            assert_eq!(policy.decide(&url), NavigationDecision::Allow, "{raw}");
        }
    }

    #[test]
    fn community_pages_are_approved_in_production() {
        let policy = production();
        for raw in [
            "https://lingqiai.art/community",
            "https://lingqiai.art/community/",
            "https://lingqiai.art/community/t/123",
        ] {
            let url = parse_safe_url(raw).unwrap();
            assert!(policy.is_approved_product_url(&url), "{raw}");
        }
        for raw in [
            "https://lingqiai.art/",
            "https://lingqiai.art/pricing",
            "https://lingqiai.art/community-evil",
        ] {
            let url = parse_safe_url(raw).unwrap();
            assert!(!policy.is_approved_product_url(&url), "{raw}");
            assert_eq!(policy.decide(&url), NavigationDecision::External, "{raw}");
        }
    }

    #[test]
    fn dev_server_gets_no_community_escalation() {
        let policy = dev(5173);
        let community = parse_safe_url("https://lingqiai.art/community").unwrap();
        assert!(!policy.is_approved_product_url(&community));
        assert_eq!(policy.decide(&community), NavigationDecision::External);
    }

    #[test]
    fn subdomain_lookalikes_are_not_approved_but_classified_external() {
        let policy = production();
        let url = parse_safe_url("https://app.lingqiai.art.evil.com/login").unwrap();
        assert!(!policy.is_approved_product_url(&url));
        assert_eq!(policy.decide(&url), NavigationDecision::External);
    }

    #[test]
    fn credentialed_urls_are_denied_entirely() {
        let policy = production();
        assert_eq!(parse_safe_url("https://user:pass@app.lingqiai.art/"), None);
        assert_eq!(parse_safe_url("https://user@app.lingqiai.art/"), None);
        let url = Url::parse("https://user:pass@app.lingqiai.art/steal").unwrap();
        assert_eq!(policy.decide(&url), NavigationDecision::Deny);
    }

    #[test]
    fn internal_shell_pages_are_allowed() {
        let policy = production();
        for raw in [
            "tauri://localhost/offline.html",
            "tauri://localhost/",
            "http://tauri.localhost/offline.html",
            "about:blank",
        ] {
            let url = parse_safe_url(raw).unwrap();
            assert!(is_internal_webview_url(&url), "{raw}");
            assert_eq!(policy.decide(&url), NavigationDecision::Allow, "{raw}");
        }
    }

    #[test]
    fn plain_http_is_denied_and_https_is_external() {
        let policy = production();
        let http = parse_safe_url("http://example.com/").unwrap();
        let https = parse_safe_url("https://example.com/").unwrap();
        assert_eq!(policy.decide(&http), NavigationDecision::Deny);
        assert_eq!(policy.decide(&https), NavigationDecision::External);
    }

    #[test]
    fn non_http_schemes_are_denied() {
        let policy = production();
        for raw in [
            "devtools://devtools/bundled",
            "file:///etc/passwd",
            "ftp://x/",
        ] {
            let url = Url::parse(raw).unwrap();
            assert_eq!(policy.decide(&url), NavigationDecision::Deny, "{raw}");
        }
    }

    #[test]
    fn navigation_log_keeps_only_origin_and_path() {
        assert_eq!(
            sanitize_navigation_log("https://app.lingqiai.art/a/b?secret=1#frag"),
            NavigationLog {
                origin: "https://app.lingqiai.art".to_string(),
                path: "/a/b".to_string(),
            }
        );
        assert_eq!(
            sanitize_navigation_log("not a url"),
            NavigationLog {
                origin: "invalid".to_string(),
                path: String::new(),
            }
        );
        assert_eq!(
            sanitize_navigation_log("https://u:p@app.lingqiai.art/steal"),
            NavigationLog {
                origin: "invalid".to_string(),
                path: String::new(),
            }
        );
    }

    #[test]
    fn resolve_application_url_matrix() {
        // Packaged builds ignore the override entirely.
        assert_eq!(
            resolve_application_url(false, Some("http://localhost:5173")).unwrap(),
            Url::parse(APP_ORIGIN).unwrap()
        );
        // Dev builds without override go to production.
        assert_eq!(
            resolve_application_url(true, None).unwrap(),
            Url::parse(APP_ORIGIN).unwrap()
        );
        // Dev builds allow localhost HTTP(S) only.
        assert_eq!(
            resolve_application_url(true, Some("http://127.0.0.1:5173")).unwrap(),
            Url::parse("http://127.0.0.1:5173").unwrap()
        );
        assert_eq!(
            resolve_application_url(true, Some("https://localhost:5173")).unwrap(),
            Url::parse("https://localhost:5173").unwrap()
        );
        assert!(resolve_application_url(true, Some("https://evil.example.com")).is_err());
        assert!(resolve_application_url(true, Some("http://192.168.1.9:5173")).is_err());
        assert!(resolve_application_url(true, Some("ftp://localhost")).is_err());
        assert!(resolve_application_url(true, Some("not a url")).is_err());
    }
}
