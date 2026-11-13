//! Versioned platform rules — single source of truth (ADR-028).
//!
//! The ruleset ships embedded (`RULES_JSON`, `rules_version`) so the app
//! works offline; a newer ruleset can replace it from app_data
//! (`platform_rules.json`) without touching code. Never trust these as
//! permanent — platform limits change; `updated` tells the user how old
//! the baked-in knowledge is.
//!
//! Severity policy (mirrors the spec):
//!   error          → blocks publish (empty title, over max duration…)
//!   warning        → publishable but probably wrong (no audio…)
//!   recommendation → quality guidance (below recommended resolution…)
//!   info           → notes (account-dependent limits, API requirements)

use serde::{Deserialize, Serialize};

/// Bump when RULES_JSON changes meaningfully.
pub const RULES_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AspectRule {
    pub w: u32,
    pub h: u32,
    /// Human label, e.g. "16:9", "9:16", "Reels 9:16".
    #[serde(default)]
    pub label: String,
    /// True = required for this placement (error); false = accepted w/ warning.
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoRules {
    /// Accepted aspect ratios; empty = no constraint enforced.
    #[serde(default)]
    pub aspect_ratios: Vec<AspectRule>,
    /// Recommended resolutions (w×h). Below min → recommendation.
    #[serde(default)]
    pub recommended: Vec<(u32, u32)>,
    #[serde(default)]
    pub min_width: u32,
    #[serde(default)]
    pub min_height: u32,
    /// Duration bounds, ms. 0 = unbounded / undocumented.
    #[serde(default)]
    pub min_duration_ms: i64,
    #[serde(default)]
    pub max_duration_ms: i64,
    /// Separate cap for the "short" placement (Shorts/Reels/Clips).
    #[serde(default)]
    pub short_max_ms: i64,
    #[serde(default)]
    pub max_file_bytes: i64,
    #[serde(default)]
    pub codecs: Vec<String>,
    #[serde(default)]
    pub containers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataRules {
    #[serde(default)]
    pub title_max_chars: usize,
    #[serde(default)]
    pub title_required: bool,
    #[serde(default)]
    pub caption_max_chars: usize,
    /// More than this → all hashtags ignored (YT) or trimmed.
    #[serde(default)]
    pub hashtag_max: usize,
    #[serde(default)]
    pub thumbnail_required: bool,
    #[serde(default)]
    pub thumbnail_max_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthRules {
    pub auth_url: String,
    pub token_url: String,
    pub scopes: Vec<String>,
    /// Extra query params for the authorize call.
    #[serde(default)]
    pub extra_auth_params: Vec<(String, String)>,
    /// true = provider supports PKCE.
    #[serde(default)]
    pub pkce: bool,
    /// Field name carrying the app id ("client_id" vs TikTok "client_key").
    #[serde(default = "default_client_param")]
    pub client_id_param: String,
}

fn default_client_param() -> String {
    "client_id".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRules {
    /// Loopback OAuth flow implemented and provider-supported.
    #[serde(default)]
    pub oauth_loopback: bool,
    /// Publishing code path implemented (API call is real).
    #[serde(default)]
    pub publish: bool,
    /// Needs an approved/reviewed developer app to work for end users.
    #[serde(default)]
    pub requires_app_review: bool,
    /// Platform API can't ingest a local file (e.g. IG needs public URL).
    #[serde(default)]
    pub requires_hosted_media: bool,
    /// Plain-language statement of what actually works today.
    #[serde(default)]
    pub status_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformRules {
    pub platform: String,
    pub display_name: String,
    pub video: VideoRules,
    pub metadata: MetadataRules,
    pub capabilities: CapabilityRules,
    pub oauth: OauthRules,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ruleset {
    pub version: u32,
    pub updated: String,
    pub platforms: std::collections::BTreeMap<String, PlatformRules>,
}

/// Embedded ruleset — facts reflect public platform docs as of `updated`.
/// Deliberately conservative: undocumented numbers are omitted, not guessed.
pub const RULES_JSON: &str = r##"{
  "version": 1,
  "updated": "2026-11",
  "platforms": {
    "youtube": {
      "platform": "youtube",
      "displayName": "YouTube",
      "video": {
        "aspectRatios": [
          {"w":16,"h":9,"label":"16:9","required":false},
          {"w":9,"h":16,"label":"9:16 (Shorts)","required":false},
          {"w":1,"h":1,"label":"1:1","required":false},
          {"w":4,"h":3,"label":"4:3","required":false}
        ],
        "recommended": [[1920,1080],[3840,2160],[2560,1440],[1280,720],[1080,1920]],
        "minWidth": 0, "minHeight": 0,
        "minDurationMs": 0,
        "maxDurationMs": 43200000,
        "shortMaxMs": 180000,
        "maxFileBytes": 274877906944,
        "codecs": ["h264","hevc","vp9","av1"],
        "containers": ["mp4","mov","mkv","webm","avi"]
      },
      "metadata": {
        "titleMaxChars": 100, "titleRequired": true,
        "captionMaxChars": 5000, "hashtagMax": 15,
        "thumbnailRequired": false, "thumbnailMaxBytes": 2097152
      },
      "capabilities": {
        "oauthLoopback": true, "publish": true,
        "requiresAppReview": false, "requiresHostedMedia": false,
        "statusNote": "Fully implemented: OAuth + resumable upload + status. Unverified Google apps are limited to test users and uploads default private."
      },
      "oauth": {
        "authUrl": "https://accounts.google.com/o/oauth2/v2/auth",
        "tokenUrl": "https://oauth2.googleapis.com/token",
        "scopes": ["https://www.googleapis.com/auth/youtube.upload","https://www.googleapis.com/auth/youtube.readonly"],
        "pkce": true,
        "extraAuthParams": [["access_type","offline"],["prompt","consent"]]
      }
    },
    "tiktok": {
      "platform": "tiktok",
      "displayName": "TikTok",
      "video": {
        "aspectRatios": [
          {"w":9,"h":16,"label":"9:16","required":false},
          {"w":1,"h":1,"label":"1:1","required":false},
          {"w":16,"h":9,"label":"16:9","required":false}
        ],
        "recommended": [[1080,1920]],
        "minWidth": 540, "minHeight": 960,
        "minDurationMs": 3000,
        "maxDurationMs": 600000,
        "shortMaxMs": 0,
        "maxFileBytes": 4294967296,
        "codecs": ["h264","hevc"],
        "containers": ["mp4","mov","webm"]
      },
      "metadata": {
        "titleMaxChars": 2200, "titleRequired": false,
        "captionMaxChars": 2200, "hashtagMax": 0,
        "thumbnailRequired": false, "thumbnailMaxBytes": 0
      },
      "capabilities": {
        "oauthLoopback": true, "publish": true,
        "requiresAppReview": true, "requiresHostedMedia": false,
        "statusNote": "OAuth + Content Posting API implemented. Production posting needs an audited TikTok app (video.publish); unapproved apps can only push to drafts (video.upload scope)."
      },
      "oauth": {
        "authUrl": "https://www.tiktok.com/v2/auth/authorize/",
        "tokenUrl": "https://open.tiktokapis.com/v2/oauth/token/",
        "scopes": ["user.info.basic","video.upload","video.publish"],
        "pkce": true,
        "clientIdParam": "client_key",
        "extraAuthParams": []
      }
    },
    "instagram": {
      "platform": "instagram",
      "displayName": "Instagram",
      "video": {
        "aspectRatios": [
          {"w":9,"h":16,"label":"Reels 9:16","required":false},
          {"w":1,"h":1,"label":"Feed 1:1","required":false},
          {"w":4,"h":5,"label":"Feed 4:5","required":false}
        ],
        "recommended": [[1080,1920],[1080,1350],[1080,1080]],
        "minWidth": 0, "minHeight": 0,
        "minDurationMs": 0,
        "maxDurationMs": 900000,
        "shortMaxMs": 90000,
        "maxFileBytes": 4294967296,
        "codecs": ["h264","hevc"],
        "containers": ["mp4","mov"]
      },
      "metadata": {
        "titleMaxChars": 0, "titleRequired": false,
        "captionMaxChars": 2200, "hashtagMax": 30,
        "thumbnailRequired": false, "thumbnailMaxBytes": 0
      },
      "capabilities": {
        "oauthLoopback": true, "publish": true,
        "requiresAppReview": true, "requiresHostedMedia": true,
        "statusNote": "Graph API content publishing requires a professional account linked to a Page, an approved Meta app (instagram_content_publish), AND a publicly reachable video URL — the API cannot ingest local files. Implemented for users who host their own file."
      },
      "oauth": {
        "authUrl": "https://www.facebook.com/dialog/oauth",
        "tokenUrl": "https://graph.facebook.com/v21.0/oauth/access_token",
        "scopes": ["instagram_basic","instagram_content_publish","pages_show_list","pages_read_engagement","business_management"],
        "pkce": false,
        "extraAuthParams": [["response_type","code"]]
      }
    },
    "facebook": {
      "platform": "facebook",
      "displayName": "Facebook",
      "video": {
        "aspectRatios": [
          {"w":16,"h":9,"label":"16:9","required":false},
          {"w":9,"h":16,"label":"9:16 (Reels)","required":false},
          {"w":1,"h":1,"label":"1:1","required":false},
          {"w":4,"h":5,"label":"4:5","required":false}
        ],
        "recommended": [[1920,1080],[1080,1920],[1080,1350]],
        "minWidth": 0, "minHeight": 0,
        "minDurationMs": 0,
        "maxDurationMs": 14400000,
        "shortMaxMs": 0,
        "maxFileBytes": 10737418240,
        "codecs": ["h264","hevc","vp9","av1"],
        "containers": ["mp4","mov","mkv","webm"]
      },
      "metadata": {
        "titleMaxChars": 255, "titleRequired": false,
        "captionMaxChars": 63206, "hashtagMax": 0,
        "thumbnailRequired": false, "thumbnailMaxBytes": 10485760
      },
      "capabilities": {
        "oauthLoopback": true, "publish": true,
        "requiresAppReview": true, "requiresHostedMedia": false,
        "statusNote": "Page video upload implemented (resumable session). Posting needs pages_manage_posts etc. — works for app-role users without review, public users need approved Meta app."
      },
      "oauth": {
        "authUrl": "https://www.facebook.com/dialog/oauth",
        "tokenUrl": "https://graph.facebook.com/v21.0/oauth/access_token",
        "scopes": ["pages_manage_posts","pages_read_engagement","pages_show_list","publish_video"],
        "pkce": false,
        "extraAuthParams": [["response_type","code"]]
      }
    }
  }
}"##;

pub fn builtin() -> Ruleset {
    serde_json::from_str(RULES_JSON).expect("embedded ruleset is valid JSON")
}

/// Load rules: app_data override if present (newer version wins), else builtin.
pub fn load(app_data: &std::path::Path) -> Ruleset {
    let custom = app_data.join("platform_rules.json");
    if let Ok(text) = std::fs::read_to_string(&custom) {
        if let Ok(r) = serde_json::from_str::<Ruleset>(&text) {
            if r.version >= RULES_VERSION {
                return r;
            }
        }
    }
    builtin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_ruleset_parses_and_covers_four_platforms() {
        let r = builtin();
        for p in ["youtube", "tiktok", "instagram", "facebook"] {
            assert!(r.platforms.contains_key(p), "missing {p}");
        }
        assert_eq!(r.version, RULES_VERSION);
    }

    #[test]
    fn youtube_metadata_limits_are_real() {
        let r = builtin();
        let yt = &r.platforms["youtube"];
        assert_eq!(yt.metadata.title_max_chars, 100);
        assert_eq!(yt.video.short_max_ms, 180_000);
        assert!(yt.capabilities.publish);
    }
}
