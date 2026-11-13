//! Graphics Studio services — templates + brand kits (ADR-027).
//!
//! Templates are canonical `Clip` JSON (self-contained: style, keyframes,
//! shape, text_fx) stored under `app_data/templates/*.json`. Brand kits
//! under `app_data/brandkits/*.json`; projects embed a snapshot so they
//! survive kit deletion. Import/export = the same JSON at a user path.
//! All local files — no network, no external services.

use crate::error::CmdResult;
use crate::project::document::{BrandKit, Clip};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub name: String,
    /// "title" | "lowerThird" | "callout" | "badge" | "intro" | "outro" | "shape" | free-form
    #[serde(default)]
    pub category: String,
    /// Canonical clip payload — style + keyframes + shape + text_fx.
    /// Timeline placement (startMs/track) is re-decided at apply time.
    pub clip: Clip,
    #[serde(default)]
    pub brand_kit_id: Option<String>,
}

fn dir(app: &AppHandle, sub: &str) -> PathBuf {
    let d = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(sub);
    let _ = std::fs::create_dir_all(&d);
    d
}

fn read_all<T: for<'de> Deserialize<'de>>(dir: &Path) -> Vec<T> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.path().extension().is_some_and(|x| x == "json") {
                if let Ok(txt) = std::fs::read_to_string(e.path()) {
                    if let Ok(v) = serde_json::from_str(&txt) {
                        out.push(v);
                    }
                }
            }
        }
    }
    out
}

fn write_json(dir: &Path, id: &str, v: &impl Serialize) -> CmdResult<()> {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let p = dir.join(format!("{safe}.json"));
    let tmp = dir.join(format!("{safe}.json.part"));
    std::fs::write(
        &tmp,
        serde_json::to_string_pretty(v).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_json(dir: &Path, id: &str) -> CmdResult<()> {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let p = dir.join(format!("{safe}.json"));
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- templates ----------

#[tauri::command]
pub fn list_templates(app: AppHandle) -> CmdResult<Vec<Template>> {
    let mut v: Vec<Template> = read_all(&dir(&app, "templates"));
    v.sort_by(|a, b| a.category.cmp(&b.category).then(a.name.cmp(&b.name)));
    Ok(v)
}

#[tauri::command]
pub fn save_template(app: AppHandle, template: Template) -> CmdResult<()> {
    write_json(&dir(&app, "templates"), &template.id, &template)
}

#[tauri::command]
pub fn delete_template(app: AppHandle, id: String) -> CmdResult<()> {
    delete_json(&dir(&app, "templates"), &id)
}

#[tauri::command]
pub fn export_template(app: AppHandle, id: String, out_path: String) -> CmdResult<()> {
    let d = dir(&app, "templates");
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let src = d.join(format!("{safe}.json"));
    std::fs::copy(&src, &out_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn import_template(app: AppHandle, path: String) -> CmdResult<Template> {
    let txt = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let t: Template = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    write_json(&dir(&app, "templates"), &t.id, &t)?;
    Ok(t)
}

// ---------- brand kits ----------

#[tauri::command]
pub fn list_brand_kits(app: AppHandle) -> CmdResult<Vec<BrandKit>> {
    let mut v: Vec<BrandKit> = read_all(&dir(&app, "brandkits"));
    v.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(v)
}

#[tauri::command]
pub fn save_brand_kit(app: AppHandle, kit: BrandKit) -> CmdResult<()> {
    write_json(&dir(&app, "brandkits"), &kit.id, &kit)
}

#[tauri::command]
pub fn delete_brand_kit(app: AppHandle, id: String) -> CmdResult<()> {
    delete_json(&dir(&app, "brandkits"), &id)
}

#[tauri::command]
pub fn export_brand_kit(app: AppHandle, id: String, out_path: String) -> CmdResult<()> {
    let d = dir(&app, "brandkits");
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    std::fs::copy(d.join(format!("{safe}.json")), &out_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn import_brand_kit(app: AppHandle, path: String) -> CmdResult<BrandKit> {
    let txt = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let k: BrandKit = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    write_json(&dir(&app, "brandkits"), &k.id, &k)?;
    Ok(k)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::document::{BrandBindings, ShapeSpec, TextFx};

    /// Template payload round-trips through JSON with all graphics fields
    /// — the store is plain files, so serde fidelity IS the persistence
    /// contract (save/open on other projects = same JSON).
    #[test]
    fn template_clip_roundtrips_graphics_fields() {
        let clip = Clip {
            id: "c1".into(),
            media_ref: None,
            start_ms: 0,
            duration_ms: 3000,
            source_in_ms: 0,
            source_out_ms: None,
            source_duration_ms: None,
            transform: Default::default(),
            effects: vec![],
            volume: 1.0,
            pan: 0.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
            speed: 1.0,
            text: Some("Sale!".into()),
            text_style: Some(crate::project::document::TextStyle {
                shadow_color: Some("#000000CC".into()),
                shadow_x: 4.0,
                shadow_y: 4.0,
                ..Default::default()
            }),
            keyframes: Default::default(),
            shape: Some(ShapeSpec {
                kind: "rect".into(),
                fill: "#FF0000".into(),
                outline_color: Some("#000000".into()),
                outline_width: 2.0,
                width_px: 200.0,
                height_px: 80.0,
            }),
            text_fx: Some(TextFx {
                kind: "wipe".into(),
                rate: 0.0,
                direction: "ltr".into(),
                duration_ms: 800,
                out: true,
            }),
            hidden: true,
            brand_bindings: Some(BrandBindings {
                color_slot: Some(2),
                font_slot: None,
            }),
        };
        let t = Template {
            id: "tpl1".into(),
            name: "Badge".into(),
            category: "badge".into(),
            clip,
            brand_kit_id: Some("k1".into()),
        };
        let json = serde_json::to_string(&t).unwrap();
        let rt: Template = serde_json::from_str(&json).unwrap();
        assert_eq!(rt.category, "badge");
        assert_eq!(rt.clip.shape.as_ref().unwrap().outline_width, 2.0);
        assert!(rt.clip.text_fx.as_ref().unwrap().out);
        assert!(rt.clip.hidden);
        assert_eq!(rt.clip.brand_bindings.unwrap().color_slot, Some(2));
        assert_eq!(rt.brand_kit_id.as_deref(), Some("k1"));
    }

    #[test]
    fn brandkit_roundtrips() {
        let k = BrandKit {
            id: "k1".into(),
            name: "Acme".into(),
            colors: vec!["#FF0000".into()],
            fonts: vec![crate::project::document::BrandFont {
                name: "Body".into(),
                path: "C:/f.ttf".into(),
            }],
            logos: vec![crate::project::document::BrandLogo {
                name: "Mark".into(),
                path: "C:/logo.png".into(),
                role: "primary".into(),
            }],
            title_style: Default::default(),
        };
        let json = serde_json::to_string(&k).unwrap();
        let rt: BrandKit = serde_json::from_str(&json).unwrap();
        assert_eq!(rt.logos[0].role, "primary");
        assert_eq!(rt.fonts[0].path, "C:/f.ttf");
    }
}
