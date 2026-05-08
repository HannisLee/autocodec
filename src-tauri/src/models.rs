use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub path: PathBuf,
    pub filename: String,
    pub width: u32,
    pub height: u32,
    pub bitrate_kbps: u64,
    pub codec: String,
    pub container: String,
    pub duration_s: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ResolutionThreshold {
    P720,
    P1080,
    P2160,
    Custom { width: u32, height: u32 },
}

impl ResolutionThreshold {
    pub fn label(&self) -> String {
        match self {
            ResolutionThreshold::P720 => "720p".into(),
            ResolutionThreshold::P1080 => "1080p".into(),
            ResolutionThreshold::P2160 => "2160p".into(),
            ResolutionThreshold::Custom { width, height } => format!("{}x{}", width, height),
        }
    }

    pub fn matches(&self, width: u32, height: u32) -> bool {
        let (tw, th) = match self {
            ResolutionThreshold::P720 => (1280, 720),
            ResolutionThreshold::P1080 => (1920, 1080),
            ResolutionThreshold::P2160 => (3840, 2160),
            ResolutionThreshold::Custom {
                width: w,
                height: h,
            } => (*w, *h),
        };
        width == tw && height == th
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EncoderChoice {
    Auto,
    Specific(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncodeRule {
    pub id: String,
    pub resolution: ResolutionThreshold,
    pub bitrate_threshold_kbps: u64,
    pub target_codec: String,
    pub target_bitrate_kbps: u64,
    pub preferred_encoder: EncoderChoice,
    pub maxrate_multiplier: f64,
    pub bufsize_multiplier: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TaskStatus {
    Pending,
    Encoding,
    Completed,
    Failed(String),
    Skipped(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncodeTask {
    pub id: String,
    pub video: VideoInfo,
    pub rule: EncodeRule,
    pub encoder: String,
    #[serde(default = "default_status")]
    pub status: TaskStatus,
    #[serde(default)]
    pub progress: f64,
    #[serde(default)]
    pub fps: f64,
    #[serde(default)]
    pub eta_seconds: u64,
}

fn default_status() -> TaskStatus {
    TaskStatus::Pending
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub ffmpeg_path: Option<String>,
    pub max_concurrent: usize,
    pub output_suffix: String,
    pub preferred_encoder_order: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ffmpeg_path: None,
            max_concurrent: 1,
            output_suffix: "_HEVC".into(),
            preferred_encoder_order: vec![
                "h264_nvenc".into(),
                "hevc_nvenc".into(),
                "h264_qsv".into(),
                "hevc_qsv".into(),
                "h264_amf".into(),
                "hevc_amf".into(),
                "libx265".into(),
            ],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderInfo {
    pub name: String,
    pub encoder_type: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressPayload {
    pub task_id: String,
    pub progress: f64,
    pub fps: f64,
    pub eta_seconds: u64,
}
