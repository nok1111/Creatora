//! Mocked-HTTP adapter tests (Phase 9 §12 — Phase 8 debt).
//!
//! A raw-TcpListener mock serves canned responses; `ep()` overrides
//! point adapters at it. Tests are serialized by MOCK_LOCK because
//! endpoint overrides are process-global. Nothing here touches the
//! network or real credentials.

use super::http;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

static MOCK_LOCK: Mutex<()> = Mutex::new(());

pub struct Mock {
    pub url: String,
    hits: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

pub type Handler = Box<dyn Fn(&str, &str) -> (u16, Vec<(String, String)>, String) + Send>;

impl Mock {
    /// Serve until `stop()`. `handler` gets (request line, body) and
    /// returns (status, extra headers, body).
    pub fn start(handler: Handler) -> Mock {
        Self::start_with_close(handler, false)
    }

    /// `close_early` — the server kills the socket mid-body
    /// ("conexión interrumpida" case).
    pub fn start_with_close(handler: Handler, close_early: bool) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let h2 = hits.clone();
        let s2 = stop.clone();
        let join = std::thread::spawn(move || {
            listener.set_nonblocking(true).ok();
            while !s2.load(Ordering::Relaxed) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    continue;
                };
                stream.set_nonblocking(false).ok();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                    .ok();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut head = String::new();
                let mut line = String::new();
                let mut content_len = 0usize;
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            head.push_str(&line);
                            let l = line.trim().to_lowercase();
                            if let Some(rest) = l.strip_prefix("content-length:") {
                                content_len = rest.trim().parse().unwrap_or(0);
                            }
                            if line.trim().is_empty() {
                                break;
                            }
                        }
                    }
                }
                let mut body = vec![0u8; content_len.min(64 << 20)];
                let _ = reader.read_exact(&mut body);
                h2.lock().unwrap().push(head.clone());
                let request_line = head.lines().next().unwrap_or("").to_string();
                let (status, headers, resp) =
                    handler(&request_line, &String::from_utf8_lossy(&body));
                let reason = match status {
                    200 | 201 => "OK",
                    308 => "Permanent Redirect",
                    400 => "Bad Request",
                    401 => "Unauthorized",
                    403 => "Forbidden",
                    404 => "Not Found",
                    429 => "Too Many Requests",
                    _ => "Error",
                };
                if close_early {
                    let mut out = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\n",
                        resp.len() * 2 // lie about length then drop
                    );
                    for (k, v) in &headers {
                        out.push_str(&format!("{k}: {v}\r\n"));
                    }
                    out.push_str("\r\n");
                    out.push_str(&resp[..resp.len().min(8)]);
                    let _ = stream.write_all(out.as_bytes());
                    // drop socket — client sees truncated body
                    continue;
                }
                let mut out = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n",
                    resp.len()
                );
                for (k, v) in &headers {
                    out.push_str(&format!("{k}: {v}\r\n"));
                }
                out.push_str("\r\n");
                out.push_str(&resp);
                let _ = stream.write_all(out.as_bytes());
            }
        });
        Mock {
            url: format!("http://127.0.0.1:{port}"),
            hits,
            stop,
            join: Some(join),
        }
    }

    pub fn hits(&self) -> Vec<String> {
        self.hits.lock().unwrap().clone()
    }

    pub fn stop(self) {
        self.stop.store(true, Ordering::Relaxed);
        // nudge the listener so the accept loop wakes
        let _ = std::net::TcpStream::connect(self.url.trim_start_matches("http://"));
        if let Some(j) = self.join {
            let _ = j.join();
        }
    }
}

fn json_handler<'a>(
    status: u16,
    body: &'a str,
) -> impl Fn(&str, &str) -> (u16, Vec<(String, String)>, String) + 'a {
    move |_, _| {
        (
            status,
            vec![("Content-Type".into(), "application/json".into())],
            body.into(),
        )
    }
}

// ---------------------------------------------------------- http layer

#[test]
fn get_json_success() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(json_handler(200, r#"{"ok":true}"#)));
    let r = http::get_json(&format!("{}/x", m.url), "tok").unwrap();
    assert_eq!(r["ok"], true);
    assert!(m.hits()[0]
        .to_lowercase()
        .contains("authorization: bearer tok"));
    m.stop();
}

#[test]
fn get_json_400_surfaces_provider_message() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(json_handler(
        400,
        r#"{"error":{"message":"bad field 'foo'"}}"#,
    )));
    let e = http::get_json(&format!("{}/x", m.url), "tok").unwrap_err();
    assert_eq!(e.status, Some(400));
    assert!(e.message.contains("bad field 'foo'"), "{}", e.message);
    assert!(!e.is_retryable());
    m.stop();
}

#[test]
fn get_json_401_unauthorized() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(json_handler(
        401,
        r#"{"error":{"message":"invalid_token"}}"#,
    )));
    let e = http::get_json(&format!("{}/x", m.url), "tok").unwrap_err();
    assert!(e.is_unauthorized());
    m.stop();
}

#[test]
fn get_json_403_forbidden() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(json_handler(
        403,
        r#"{"error":{"message":"insufficient_scope"}}"#,
    )));
    let e = http::get_json(&format!("{}/x", m.url), "tok").unwrap_err();
    assert!(e.is_forbidden());
    assert!(!e.is_retryable());
    m.stop();
}

#[test]
fn get_json_429_retry_after() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(|_, _| {
        (
            429,
            vec![
                ("Content-Type".into(), "application/json".into()),
                ("Retry-After".into(), "42".into()),
            ],
            r#"{"error":{"message":"quota"}}"#.into(),
        )
    }));
    let e = http::get_json(&format!("{}/x", m.url), "tok").unwrap_err();
    assert!(e.is_rate_limited());
    assert_eq!(e.retry_after, Some(42));
    assert!(e.is_retryable());
    m.stop();
}

#[test]
fn get_json_500_retryable() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(json_handler(
        500,
        r#"{"error":{"message":"boom"}}"#,
    )));
    let e = http::get_json(&format!("{}/x", m.url), "tok").unwrap_err();
    assert_eq!(e.status, Some(500));
    assert!(e.is_retryable());
    m.stop();
}

#[test]
fn get_json_malformed_body() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(json_handler(200, "not json at all")));
    let e = http::get_json(&format!("{}/x", m.url), "tok").unwrap_err();
    assert!(e.message.contains("expected JSON"), "{}", e.message);
    m.stop();
}

#[test]
fn get_json_incomplete_body_connection_dropped() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start_with_close(
        Box::new(json_handler(200, r#"{"ok":true,"more":"data"}"#)),
        true,
    );
    let e = http::get_json(&format!("{}/x", m.url), "tok").unwrap_err();
    // Truncated stream → error surfaced, never a silent empty Ok.
    m.stop();
    assert!(
        e.message.contains("body read")
            || e.status.is_none()
            || e.message.contains("expected JSON")
    );
}

#[test]
fn get_json_unreachable_host() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l); // port now refuses
    let e = http::get_json(&format!("http://127.0.0.1:{port}/x"), "t").unwrap_err();
    assert!(e.status.is_none());
    assert!(e.is_retryable());
}

// ---------------------------------------------------------- adapters

#[test]
fn youtube_stats_parses_counts_and_reports_unavailable() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(|line, _| {
        if line.contains("/youtube/v3/videos") {
            (
                200,
                vec![("Content-Type".into(), "application/json".into())],
                r#"{"items":[{"statistics":{"viewCount":"1200","likeCount":"34","commentCount":"5"}}]}"#.into(),
            )
        } else if line.contains("/youtube/analytics") {
            (
                403,
                vec![("Content-Type".into(), "application/json".into())],
                r#"{"error":{"message":"insufficient permissions"}}"#.into(),
            )
        } else {
            (404, vec![], "{}".into())
        }
    }));
    http::set_endpoint_override("youtube.api", &m.url);
    http::set_endpoint_override("youtube.analytics", &m.url);
    let r = crate::social::stats::youtube::stats("tok", "vid1");
    http::clear_endpoint_overrides();
    let s = r.unwrap();
    assert_eq!(s.metrics.len(), 3);
    assert!(s.unavailable.iter().any(|u| u.key == "watch_time_minutes"));
    m.stop();
}

#[test]
fn tiktok_stats_error_inside_200() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(json_handler(
        200,
        r#"{"error":{"code":"scope_permissionDenied","message":"video.list scope missing"},"data":{}}"#,
    )));
    http::set_endpoint_override("tiktok.api", &m.url);
    let r = crate::social::stats::tiktok::stats("tok", "vid123");
    http::clear_endpoint_overrides();
    let e = r.unwrap_err();
    assert!(
        e.message.contains("scope_permissionDenied"),
        "{}",
        e.message
    );
    m.stop();
}

#[test]
fn tiktok_stats_success() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(json_handler(
        200,
        r#"{"error":{"code":"ok"},"data":{"videos":[{"id":"v1","view_count":10,"like_count":2,"comment_count":1,"share_count":3}]}}"#,
    )));
    http::set_endpoint_override("tiktok.api", &m.url);
    let s = crate::social::stats::tiktok::stats("tok", "v1").unwrap();
    http::clear_endpoint_overrides();
    assert_eq!(s.metrics.len(), 4);
    assert!(s
        .metrics
        .iter()
        .any(|x| x.key == "views" && x.value == 10.0));
    m.stop();
}

#[test]
fn facebook_stats_marks_missing_metrics_unavailable() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(json_handler(
        200,
        r#"{"data":[
            {"name":"post_impressions","values":[{"value":500}]},
            {"name":"post_video_views","values":[{"value":300}]}
        ]}"#,
    )));
    http::set_endpoint_override("fb.graph", &m.url);
    let s = crate::social::stats::facebook::stats("tok", "post1", &serde_json::json!({})).unwrap();
    http::clear_endpoint_overrides();
    assert_eq!(s.metrics.len(), 2);
    // The other 4 WANTED metrics were not served → unavailable, not 0.
    assert_eq!(s.unavailable.len(), 4);
    assert!(s.unavailable.iter().any(|u| u.key == "reach"));
    m.stop();
}

#[test]
fn instagram_stats_parses_values() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(json_handler(
        200,
        r#"{"data":[
            {"name":"reach","values":[{"value":900}]},
            {"name":"saved","values":[{"value":12}]},
            {"name":"plays","values":[{"value":1000}]}
        ]}"#,
    )));
    http::set_endpoint_override("fb.graph", &m.url);
    let s = crate::social::stats::instagram::stats("tok", "m1").unwrap();
    http::clear_endpoint_overrides();
    assert_eq!(s.metrics.len(), 3);
    assert!(s
        .metrics
        .iter()
        .any(|x| x.key == "saves" && x.value == 12.0));
    assert!(s
        .metrics
        .iter()
        .any(|x| x.key == "views" && x.value == 1000.0));
    m.stop();
}

#[test]
fn youtube_publish_end_to_end_mocked() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = std::env::temp_dir().join(format!("cr_pub_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("v.mp4");
    std::fs::write(&file, vec![7u8; 2048]).unwrap();
    // The resumable upload URL comes from the initiate response's
    // Location header — the mock hands back its own URL so the PUT
    // lands on the same server.
    let upload_url_holder = Arc::new(Mutex::new(String::new()));
    let h2 = upload_url_holder.clone();
    let m2 = Mock::start(Box::new(move |line, _| {
        if line.starts_with("POST /upload/youtube/v3/videos") {
            (
                200,
                vec![(
                    "Location".into(),
                    format!("{}/upload/session1", h2.lock().unwrap()),
                )],
                "".into(),
            )
        } else if line.starts_with("PUT /upload/session1") {
            (
                201,
                vec![("Content-Type".into(), "application/json".into())],
                r#"{"id":"ytvid42","snippet":{"title":"t"}}"#.into(),
            )
        } else {
            (404, vec![], "{}".into())
        }
    }));
    *upload_url_holder.lock().unwrap() = m2.url.clone();
    http::set_endpoint_override("youtube.upload", &m2.url);
    let input = super::PublishInput {
        file_path: Some(file.clone()),
        title: "t".into(),
        description: "d".into(),
        tags: vec![],
        meta: serde_json::json!({}),
        hosted_url: None,
    };
    let out = super::youtube::publish("tok", &input, &|_, _| {}, &|| false).unwrap();
    http::clear_endpoint_overrides();
    assert_eq!(out.platform_post_id.as_deref(), Some("ytvid42"));
    assert!(out.url.unwrap().contains("ytvid42"));
    m2.stop();
}

#[test]
fn youtube_publish_401_surfaces() {
    let _g = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let m = Mock::start(Box::new(json_handler(
        401,
        r#"{"error":{"message":"invalid credentials"}}"#,
    )));
    http::set_endpoint_override("youtube.upload", &m.url);
    let dir = std::env::temp_dir().join(format!("cr_pub2_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("v.mp4");
    std::fs::write(&file, vec![7u8; 128]).unwrap();
    let input = super::PublishInput {
        file_path: Some(file),
        title: "t".into(),
        description: String::new(),
        tags: vec![],
        meta: serde_json::json!({}),
        hosted_url: None,
    };
    let e = super::youtube::publish("tok", &input, &|_, _| {}, &|| false).unwrap_err();
    http::clear_endpoint_overrides();
    assert!(e.contains("initiate upload"), "{e}");
    m.stop();
}

#[test]
fn instagram_publish_requires_public_url_honest() {
    // No mock needed — the honest gate fires before any HTTP.
    let input = super::PublishInput {
        file_path: None,
        title: "t".into(),
        description: String::new(),
        tags: vec![],
        meta: serde_json::json!({}),
        hosted_url: None,
    };
    let e = super::instagram::publish("tok", &input, &|_, _| {}, &|| false).unwrap_err();
    assert!(e.contains("public video URL"), "{e}");
}
