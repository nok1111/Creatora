pub mod audio;
mod commands;
pub mod db;
pub mod error;
mod external_drop;
pub mod graphics;
pub mod jobs;
pub mod media;
pub mod project;
pub mod render;
pub mod repurpose;
pub mod social;
pub mod subtitles;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .level_for("creatora_lib", log::LevelFilter::Debug)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("creatora".into()),
                    }),
                ])
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = Arc::new(
                db::Db::open(&data_dir).map_err(|e| format!("open catalog database: {e}"))?,
            );
            log::info!("catalog ready at {}", data_dir.display());
            // Asset protocol starts with $APPDATA/** only (no arbitrary disk).
            // Re-authorize every directory that holds a registered media file
            // so existing projects keep previewing after the restriction.
            {
                let scope = app.asset_protocol_scope();
                let _ = db.with(|c| {
                    let mut stmt =
                        c.prepare("SELECT DISTINCT file_path FROM media_assets")?;
                    let paths = stmt
                        .query_map([], |r| r.get::<_, String>(0))?
                        .filter_map(|r| r.ok())
                        .collect::<Vec<_>>();
                    for p in paths {
                        let dir = std::path::Path::new(&p)
                            .parent()
                            .map(|d| d.to_path_buf());
                        if let Some(d) = dir.filter(|d| d.is_dir()) {
                            let _ = scope.allow_directory(d, true);
                        }
                    }
                    Ok(())
                });
            }
            let removed = media::commands::sweep_orphan_media(&data_dir, &db);
            if removed > 0 {
                log::info!("orphan media cleanup removed {removed} file(s)");
            }
            let jobs = jobs::JobManager::default();
            jobs.attach_db(db.clone());
            jobs.sweep_interrupted();
            app.manage(jobs);
            social::scheduler::start(app.handle().clone(), db.clone());
            app.manage(db);
            if let Err(e) = external_drop::install(app.handle()) {
                log::warn!("external drop bridge not installed: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::set_setting,
            project::commands::list_projects,
            project::commands::create_project,
            project::commands::open_project,
            project::commands::save_project,
            project::commands::autosave_project,
            project::commands::recover_project,
            project::commands::discard_recovery,
            project::commands::set_project_flag,
            project::commands::duplicate_project,
            project::commands::delete_project,
            project::commands::export_project_bundle,
            media::commands::import_media,
            media::commands::cancel_job,
            media::commands::list_jobs,
            media::commands::regenerate_thumbnail,
            media::commands::list_assets,
            media::commands::scan_missing_assets,
            media::commands::relink_asset,
            media::commands::delete_asset,
            media::commands::sweep_orphan_files,
            media::commands::set_asset_favorite,
            media::commands::list_collections,
            media::commands::create_collection,
            media::commands::delete_collection,
            media::commands::assign_asset_to_collection,
            media::commands::remove_asset_from_collection,
            media::commands::list_tags,
            media::commands::tag_asset,
            media::commands::untag_asset,
            media::commands::generate_proxies,
            media::commands::delete_proxy,
            render::commands::export_project,
            render::commands::export_versions,
            render::commands::analyze_subject,
            subtitles::commands::list_models,
            subtitles::commands::download_model,
            subtitles::commands::transcribe_media,
            subtitles::commands::export_subtitles,
            audio::commands::generate_waveform,
            audio::commands::read_waveform,
            media::commands::generate_filmstrip,
            media::commands::read_filmstrip,
            audio::commands::analyze_loudness,
            audio::commands::detect_silence,
            audio::commands::suggest_normalize,
            audio::commands::analyze_beats,
            graphics::list_templates,
            graphics::save_template,
            graphics::delete_template,
            graphics::export_template,
            graphics::import_template,
            graphics::list_brand_kits,
            graphics::save_brand_kit,
            graphics::delete_brand_kit,
            graphics::export_brand_kit,
            graphics::import_brand_kit,
            render::commands::preview_render_plan,
            social::posts::create_social_post,
            social::posts::update_social_post,
            social::posts::save_social_post,
            social::posts::social_post_previews,
            repurpose::commands::repurpose_analyze,
            repurpose::commands::repurpose_probe,
            social::posts::open_external_url,
            social::posts::get_social_post,
            social::posts::list_social_posts,
            social::posts::delete_social_post,
            social::posts::duplicate_social_post,
            social::posts::upsert_post_target,
            social::posts::delete_post_target,
            social::posts::set_target_status,
            social::posts::schedule_post_target,
            social::posts::link_target_media,
            social::posts::list_caption_templates,
            social::posts::save_caption_template,
            social::posts::delete_caption_template,
            social::posts::list_hashtag_history,
            social::posts::list_social_accounts,
            social::posts::disconnect_social_account,
            social::posts::list_publication_attempts,
            social::posts::publication_history,
            social::posts::list_scheduled,
            social::posts::reveal_path,
            social::validate::validate_social_post,
            social::oauth::social_oauth_begin,
            social::publish::publish_post_target,
            social::publish::export_for_target,
            social::publish::platform_capabilities,
            social::publish::platform_ruleset,
            social::publish::save_oauth_client,
            social::publish::oauth_client_status,
            social::analytics::analytics_sync,
            social::analytics::analytics_sync_runs,
            social::analytics::analytics_sync_status,
            social::analytics::analytics_set_sync_interval,
            social::analytics::analytics_target_history,
            social::analytics::analytics_dashboard,
            social::analytics::analytics_compare,
            social::analytics::analytics_insights,
            social::analytics::analytics_platform_stats_info,
            social::analytics::analytics_account_history,
            social::import::analytics_import_preview,
            social::import::analytics_import_commit,
            social::import::analytics_import_batches,
            social::packets::export_publish_packet,
            social::packets::export_publish_packets,
            social::packets::list_publish_packets,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
