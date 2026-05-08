use crate::models::{EncodeRule, Settings};
use std::path::PathBuf;
use tauri::Manager;

fn app_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn load_settings(app: &tauri::AppHandle) -> Settings {
    let path = app_data_dir(app).join("settings.json");
    if path.exists() {
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(settings) = serde_json::from_str::<Settings>(&data) {
                return settings;
            }
        }
    }
    Settings::default()
}

pub fn save_settings(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let dir = app_data_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create config dir failed: {}", e))?;
    let path = dir.join("settings.json");
    let data =
        serde_json::to_string_pretty(settings).map_err(|e| format!("serialize settings failed: {}", e))?;
    std::fs::write(&path, data).map_err(|e| format!("write settings failed: {}", e))?;
    Ok(())
}

pub fn load_rules(app: &tauri::AppHandle) -> Vec<EncodeRule> {
    let path = app_data_dir(app).join("rules.json");
    if path.exists() {
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(rules) = serde_json::from_str::<Vec<EncodeRule>>(&data) {
                if !rules.is_empty() {
                    return rules;
                }
            }
        }
    }
    crate::rules::default_rules()
}

pub fn save_rules(app: &tauri::AppHandle, rules: &[EncodeRule]) -> Result<(), String> {
    let dir = app_data_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create config dir failed: {}", e))?;
    let path = dir.join("rules.json");
    let data =
        serde_json::to_string_pretty(rules).map_err(|e| format!("serialize rules failed: {}", e))?;
    std::fs::write(&path, data).map_err(|e| format!("write rules failed: {}", e))?;
    Ok(())
}
