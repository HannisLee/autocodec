use crate::models::EncoderInfo;
use std::process::Command;

fn run_ffmpeg_detect(ffmpeg_path: &str) -> Result<Vec<EncoderInfo>, String> {
    let output = Command::new(ffmpeg_path)
        .args(["-hide_banner", "-encoders"])
        .output()
        .map_err(|e| format!("ffmpeg execution failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut encoders: Vec<EncoderInfo> = Vec::new();

    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with("V") {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() >= 3 {
            let name = parts[1].to_string();
            let enc_type = parts[2].to_string();
            if name.contains("264") || name.contains("265") || name.contains("hevc") {
                encoders.push(EncoderInfo {
                    name,
                    encoder_type: enc_type,
                    available: true,
                });
            }
        }
    }
    Ok(encoders)
}

pub fn detect_encoders(ffmpeg_path: &Option<String>) -> Vec<EncoderInfo> {
    let mut paths = vec!["ffmpeg".to_string()];
    if let Some(p) = ffmpeg_path {
        paths.insert(0, p.clone());
    }

    for path in &paths {
        if let Ok(encoders) = run_ffmpeg_detect(path) {
            if !encoders.is_empty() {
                return encoders;
            }
        }
    }
    Vec::new()
}

pub fn find_ffmpeg_path(custom_path: &Option<String>) -> Option<String> {
    if let Some(p) = custom_path {
        if Command::new(p).arg("-version").output().is_ok() {
            return Some(p.clone());
        }
    }
    if Command::new("ffmpeg").arg("-version").output().is_ok() {
        return Some("ffmpeg".into());
    }
    None
}
