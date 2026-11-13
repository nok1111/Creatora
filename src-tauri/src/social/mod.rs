//! Social Studio (Phase 8, ADR-028): local-first post management with
//! optional real publishing via official platform APIs.
//!
//! Split: `model` types + `store` CRUD, `rules` versioned platform
//! knowledge, `validate` pre-flight findings, `oauth` loopback+PKCE flow,
//! `vault` OS-credential token store, `platforms` API adapters,
//! `publish` job + attempt log, `scheduler` local due-post ticker.

pub mod analytics;
pub mod import;
pub mod model;
pub mod oauth;
pub mod packets;
pub mod platforms;
pub mod posts;
pub mod publish;
pub mod rules;
pub mod scheduler;
pub mod stats;
pub mod validate;
pub mod vault;
