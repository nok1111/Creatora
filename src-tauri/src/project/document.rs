//! `.creatora` project document — format_version 1.
//!
//! The file is a single JSON document: portable, diffable, recoverable.
//! Media is referenced by path+hash, never embedded (ADR-005).
//! `format_version` bumps are explicit migrations in `migrate()`.

use crate::error::AppError;
use serde::{Deserialize, Serialize};

pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDoc {
    pub format_version: u32,
    pub meta: Meta,
    pub canvas: Canvas,
    pub timeline: Timeline,
    /// Derived-format overrides keyed by format id ("shorts-9x16", ...). Phase 4.
    #[serde(default)]
    pub formats: serde_json::Map<String, serde_json::Value>,
    /// Subtitle cues. Phase 5 — schema defined now so v1 files round-trip.
    #[serde(default)]
    pub subtitles: Vec<SubtitleCue>,
    #[serde(default)]
    pub brand_kit_id: Option<String>,
    #[serde(default)]
    pub export_profiles: Vec<serde_json::Value>,
    /// Media referenced by this project (asset ids; resolved via catalog).
    #[serde(default)]
    pub media_refs: Vec<MediaRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub modified_at: String,
    pub creatora_version: String,
    /// Optional: id of the master project this derives from (multi-format).
    #[serde(default)]
    pub source_project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    #[serde(default = "default_bg")]
    pub background: String,
}

fn default_bg() -> String {
    "#000000".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    #[serde(default)]
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub markers: Vec<Marker>,
    // Playhead/undo are session state — not persisted.
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    pub name: String,
    #[serde(default)]
    pub clips: Vec<Clip>,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub visible: bool,
    #[serde(default)]
    pub muted: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
    Image,
    Text,
    Graphics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    /// Asset id into media_refs, or null for generated clips (text/solid).
    #[serde(default)]
    pub media_ref: Option<String>,
    /// Timeline placement in milliseconds.
    pub start_ms: i64,
    pub duration_ms: i64,
    /// Source-media in/out for trimmed clips.
    #[serde(default)]
    pub source_in_ms: i64,
    #[serde(default)]
    pub source_out_ms: Option<i64>,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default)]
    pub effects: Vec<serde_json::Value>,
    #[serde(default)]
    pub volume: f32,
    #[serde(default)]
    pub speed: f32,
    /// Text content for text clips.
    #[serde(default)]
    pub text: Option<String>,
    /// Keyframes: property path → animated values. Phase 3.
    #[serde(default)]
    pub keyframes: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub x: f32,
    pub y: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    pub rotation_deg: f32,
    pub opacity: f32,
    pub crop_top: f32,
    pub crop_right: f32,
    pub crop_bottom: f32,
    pub crop_left: f32,
}

impl Default for Transform {
    fn default() -> Self {
        Transform {
            x: 0.0,
            y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation_deg: 0.0,
            opacity: 1.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
            crop_left: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub time_ms: i64,
    pub label: String,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleCue {
    pub id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    /// Style preset id into brand kit / subtitle styles.
    #[serde(default)]
    pub style_id: Option<String>,
    /// Per-word timing for karaoke. Phase 5.
    #[serde(default)]
    pub words: Vec<WordTiming>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordTiming {
    pub word: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRef {
    /// Asset id in the catalog (media_assets.id).
    pub asset_id: String,
    /// Absolute path at save time — used for missing-media detection.
    pub path: String,
    #[serde(default)]
    pub hash: Option<String>,
}

impl ProjectDoc {
    pub fn new(name: &str, canvas: Canvas) -> Self {
        let now = now_iso();
        ProjectDoc {
            format_version: FORMAT_VERSION,
            meta: Meta {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.to_string(),
                created_at: now.clone(),
                modified_at: now,
                creatora_version: env!("CARGO_PKG_VERSION").into(),
                source_project_id: None,
            },
            canvas,
            timeline: Timeline::default(),
            formats: serde_json::Map::new(),
            subtitles: Vec::new(),
            brand_kit_id: None,
            export_profiles: Vec::new(),
            media_refs: Vec::new(),
        }
    }

    /// Parse + migrate a document. Errors on unsupported future versions.
    pub fn parse(json: &str) -> Result<Self, AppError> {
        let raw: serde_json::Value = serde_json::from_str(json)
            .map_err(|e| AppError::InvalidInput(format!("corrupt project file: {e}")))?;
        let version = raw
            .get("format_version")
            .or_else(|| raw.get("formatVersion"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        if version > FORMAT_VERSION as u64 {
            return Err(AppError::InvalidInput(format!(
                "project was created by a newer Creatora (format v{version}, this build reads up to v{FORMAT_VERSION})"
            )));
        }
        let migrated = migrate(raw, version as u32)?;
        serde_json::from_value(migrated)
            .map_err(|e| AppError::InvalidInput(format!("invalid project document: {e}")))
    }
}

/// Upgrade a raw document to FORMAT_VERSION. v1 is current — no-op today,
/// but the chain exists so v2+ never silently corrupts older files.
fn migrate(mut doc: serde_json::Value, mut version: u32) -> Result<serde_json::Value, AppError> {
    while version < FORMAT_VERSION {
        version += 1;
        match version {
            // example: 2 => { /* transform v1 -> v2 */ }
            _ => {}
        }
        doc["format_version"] = serde_json::json!(version);
    }
    Ok(doc)
}

/// ISO-8601 UTC timestamp without pulling in chrono: civil-from-days math.
pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = (secs / 86400) as i64;
    let sod = secs % 86400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    // Howard Hinnant's algorithm.
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> ProjectDoc {
        ProjectDoc::new(
            "test",
            Canvas {
                width: 1920,
                height: 1080,
                fps_num: 30,
                fps_den: 1,
                background: "#000000".into(),
            },
        )
    }

    #[test]
    fn round_trip() {
        let d = doc();
        let json = serde_json::to_string(&d).unwrap();
        let parsed = ProjectDoc::parse(&json).unwrap();
        assert_eq!(parsed.meta.name, "test");
        assert_eq!(parsed.canvas.width, 1920);
        assert_eq!(parsed.format_version, FORMAT_VERSION);
    }

    #[test]
    fn rejects_newer_version() {
        let bad = r#"{"formatVersion": 99, "meta": {}, "canvas": {}, "timeline": {}}"#;
        assert!(ProjectDoc::parse(bad).is_err());
    }

    #[test]
    fn rejects_corrupt() {
        assert!(ProjectDoc::parse("{not json").is_err());
    }

    #[test]
    fn tolerates_missing_optional_sections() {
        let minimal = r#"{
            "formatVersion": 1,
            "meta": {"id":"x","name":"n","createdAt":"t","modifiedAt":"t","creatoraVersion":"0"},
            "canvas": {"width":1,"height":1,"fpsNum":1,"fpsDen":1},
            "timeline": {}
        }"#;
        let parsed = ProjectDoc::parse(minimal).unwrap();
        assert!(parsed.subtitles.is_empty() && parsed.media_refs.is_empty());
    }
}
