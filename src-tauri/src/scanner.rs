use crate::models::VideoInfo;
use std::path::{Path, PathBuf};
use std::process::Command;

const VIDEO_EXTENSIONS: &[&str] = &["mkv", "mp4", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts"];

/// Derive ffprobe path from ffmpeg path by replacing the binary name
pub fn ffprobe_path(ffmpeg_path: &str) -> String {
    if ffmpeg_path.ends_with("ffmpeg") {
        ffmpeg_path.replace("ffmpeg", "ffprobe")
    } else if ffmpeg_path.ends_with("ffmpeg.exe") {
        ffmpeg_path.replace("ffmpeg.exe", "ffprobe.exe")
    } else {
        // Unknown pattern, try replacing any "ffmpeg" substring
        ffmpeg_path.replace("ffmpeg", "ffprobe")
    }
}

pub fn scan_folder(folder: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(folder) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                files.extend(scan_folder(&path));
            } else if let Some(ext) = path.extension() {
                let ext_lower = ext.to_string_lossy().to_lowercase();
                if VIDEO_EXTENSIONS.contains(&ext_lower.as_str()) {
                    files.push(path);
                }
            }
        }
    }
    files
}

pub fn probe_video(ffmpeg_path: &str, file: &Path) -> Result<VideoInfo, String> {
    let path_str = file.to_string_lossy().to_string();
    let probe = ffprobe_path(ffmpeg_path);
    let output = Command::new(&probe)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            &path_str,
        ])
        .output()
        .map_err(|e| format!("ffprobe execution failed {}: {}", path_str, e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("ffprobe JSON parse failed: {}", e))?;

    let format = &json["format"];
    let streams = json["streams"].as_array().ok_or("no streams")?;

    let video_stream = streams
        .iter()
        .find(|s| s["codec_type"].as_str() == Some("video"))
        .ok_or("no video stream found")?;

    let width = video_stream["width"].as_u64().unwrap_or(0) as u32;
    let height = video_stream["height"].as_u64().unwrap_or(0) as u32;
    let codec = video_stream["codec_name"].as_str().unwrap_or("unknown").to_string();
    let duration_s = format["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    let bitrate_bps = format["bit_rate"]
        .as_str()
        .and_then(|b| b.parse::<u64>().ok())
        .unwrap_or(0);
    let bitrate_kbps = bitrate_bps / 1000;
    let container = format["format_name"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let filename = file
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    Ok(VideoInfo {
        path: file.to_path_buf(),
        filename,
        width,
        height,
        bitrate_kbps,
        codec,
        container,
        duration_s,
    })
}
