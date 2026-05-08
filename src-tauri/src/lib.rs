mod detector;
mod encoder;
mod ffmpeg_cmd;
mod models;
mod persistence;
mod rules;
mod scanner;
mod scheduler;

use models::*;
use scheduler::Scheduler;
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::sync::mpsc;

struct AppState {
    scheduler: Scheduler,
}

#[tauri::command]
async fn scan_folder(
    path: String,
    ffmpeg_path: Option<String>,
    _app: tauri::AppHandle,
) -> Result<Vec<VideoInfo>, String> {
    let ffmpeg = detector::find_ffmpeg_path(&ffmpeg_path)
        .ok_or("FFmpeg not found, please specify path in Settings")?;

    let files = scanner::scan_folder(std::path::Path::new(&path));
    if files.is_empty() {
        return Err("no video files found".into());
    }

    let mut videos = Vec::new();
    for file in &files {
        match scanner::probe_video(&ffmpeg, file) {
            Ok(info) => videos.push(info),
            Err(e) => {
                eprintln!("skip {}: {}", file.display(), e);
            }
        }
    }
    Ok(videos)
}

#[tauri::command]
async fn load_rules(app: tauri::AppHandle) -> Result<Vec<EncodeRule>, String> {
    Ok(persistence::load_rules(&app))
}

#[tauri::command]
async fn save_rules(app: tauri::AppHandle, rules: Vec<EncodeRule>) -> Result<(), String> {
    persistence::save_rules(&app, &rules)
}

#[tauri::command]
async fn load_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    Ok(persistence::load_settings(&app))
}

#[tauri::command]
async fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    persistence::save_settings(&app, &settings)
}

#[tauri::command]
async fn detect_encoders(ffmpeg_path: Option<String>) -> Result<Vec<EncoderInfo>, String> {
    if detector::find_ffmpeg_path(&ffmpeg_path).is_none() {
        return Err("FFmpeg not found".into());
    }
    Ok(detector::detect_encoders(&ffmpeg_path))
}

#[tauri::command]
async fn start_encoding(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    tasks: Vec<EncodeTask>,
) -> Result<(), String> {
    let settings = persistence::load_settings(&app);
    let available_encoders = detector::detect_encoders(&settings.ffmpeg_path);
    let available_names: Vec<&str> = available_encoders.iter().map(|e| e.name.as_str()).collect();

    // Resolve Auto encoder choices based on available encoders
    let tasks: Vec<EncodeTask> = tasks
        .into_iter()
        .map(|mut task| {
            if let EncoderChoice::Auto = &task.rule.preferred_encoder {
                let target_is_hevc = task.rule.target_codec.eq_ignore_ascii_case("hevc");
                // Iterate preferred order, pick first available that matches codec type
                let mut resolved = None;
                for pref in &settings.preferred_encoder_order {
                    if available_names.contains(&pref.as_str()) {
                        let is_hevc = pref.contains("265") || pref.contains("hevc");
                        let is_h264 = pref.contains("264");
                        if (target_is_hevc && is_hevc) || (!target_is_hevc && is_h264) {
                            resolved = Some(pref.clone());
                            break;
                        }
                    }
                }
                // Fallback
                task.encoder = resolved.unwrap_or_else(|| {
                    if target_is_hevc {
                        "libx265".into()
                    } else {
                        "libx264".into()
                    }
                });
            }
            task
        })
        .collect();

    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<ProgressPayload>();
    let (status_tx, mut status_rx) = mpsc::unbounded_channel::<(String, TaskStatus)>();

    // Forward progress events to frontend
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(payload) = progress_rx.recv().await {
            let _ = app_clone.emit("progress-changed", &payload);
        }
    });

    // Forward status events to frontend
    let app_clone2 = app.clone();
    tokio::spawn(async move {
        while let Some((task_id, status)) = status_rx.recv().await {
            match &status {
                TaskStatus::Encoding => {
                    let _ = app_clone2.emit("task-started", &task_id);
                }
                TaskStatus::Completed => {
                    let _ = app_clone2.emit("task-completed", &task_id);
                }
                TaskStatus::Failed(err) => {
                    let _ = app_clone2.emit("task-failed", &serde_json::json!({
                        "task_id": task_id,
                        "error": err,
                    }));
                }
                _ => {}
            }
        }
    });

    let scheduler = &state.scheduler;
    scheduler.run(tasks, settings, progress_tx, status_tx).await;

    Ok(())
}

#[tauri::command]
async fn cancel_encoding(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.scheduler.cancel_all().await;
    Ok(())
}

#[tauri::command]
async fn retry_task(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    task_id: String,
) -> Result<(), String> {
    let settings = persistence::load_settings(&app);

    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<ProgressPayload>();
    let (status_tx, mut status_rx) = mpsc::unbounded_channel::<(String, TaskStatus)>();

    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(payload) = progress_rx.recv().await {
            let _ = app_clone.emit("progress-changed", &payload);
        }
    });

    let app_clone2 = app.clone();
    tokio::spawn(async move {
        while let Some((tid, status)) = status_rx.recv().await {
            match &status {
                TaskStatus::Encoding => {
                    let _ = app_clone2.emit("task-started", &tid);
                }
                TaskStatus::Completed => {
                    let _ = app_clone2.emit("task-completed", &tid);
                }
                TaskStatus::Failed(err) => {
                    let _ = app_clone2.emit("task-failed", &serde_json::json!({
                        "task_id": tid,
                        "error": err,
                    }));
                }
                _ => {}
            }
        }
    });

    state
        .scheduler
        .retry_task(&task_id, settings, progress_tx, status_tx)
        .await;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Arc::new(AppState {
            scheduler: Scheduler::new(),
        }))
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            load_rules,
            save_rules,
            load_settings,
            save_settings,
            detect_encoders,
            start_encoding,
            cancel_encoding,
            retry_task,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
