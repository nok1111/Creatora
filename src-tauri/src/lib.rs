mod commands;
pub mod db;
pub mod error;
pub mod jobs;
pub mod media;
pub mod project;
pub mod render;

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
            let jobs = jobs::JobManager::default();
            jobs.attach_db(db.clone());
            app.manage(jobs);
            app.manage(db);
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
            media::commands::list_assets,
            media::commands::scan_missing_assets,
            media::commands::relink_asset,
            media::commands::delete_asset,
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
            render::commands::preview_render_plan,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
