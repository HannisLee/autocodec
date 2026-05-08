use crate::models::{EncodeTask, Settings};
use std::path::PathBuf;

fn output_path(input: &PathBuf, suffix: &str) -> PathBuf {
    let stem = input.file_stem().unwrap_or_default().to_string_lossy();
    let ext = input.extension().unwrap_or_default().to_string_lossy();
    let mut out = input.clone();
    out.set_file_name(format!("{}{}.{}", stem, suffix, ext));
    out
}

pub fn build_ffmpeg_args(task: &EncodeTask, settings: &Settings) -> Result<Vec<String>, String> {
    let output = output_path(&task.video.path, &settings.output_suffix);
    if output == task.video.path {
        return Err("output suffix cannot be empty (would overwrite source)".into());
    }

    let input = task.video.path.to_string_lossy().to_string();
    let output = output.to_string_lossy().to_string();
    let bitrate = task.rule.target_bitrate_kbps;
    let maxrate = (bitrate as f64 * task.rule.maxrate_multiplier) as u64;
    let bufsize = (bitrate as f64 * task.rule.bufsize_multiplier) as u64;

    let encoder = task.encoder.as_str();
    let encoder_params = match encoder {
        e if e.contains("nvenc") => vec![
            "-rc".to_string(), "vbr".to_string(),
            "-b:v".to_string(), format!("{}k", bitrate),
            "-maxrate:v".to_string(), format!("{}k", maxrate),
            "-bufsize:v".to_string(), format!("{}k", bufsize),
        ],
        e if e.contains("qsv") => vec![
            "-look_ahead".to_string(), "1".to_string(),
            "-b:v".to_string(), format!("{}k", bitrate),
            "-maxrate:v".to_string(), format!("{}k", maxrate),
        ],
        e if e.contains("amf") => vec![
            "-rc".to_string(), "vbr_peak".to_string(),
            "-b:v".to_string(), format!("{}k", bitrate),
            "-maxrate:v".to_string(), format!("{}k", maxrate),
            "-bufsize:v".to_string(), format!("{}k", bufsize),
        ],
        _ => vec![
            "-b:v".to_string(), format!("{}k", bitrate),
            "-maxrate:v".to_string(), format!("{}k", maxrate),
            "-bufsize:v".to_string(), format!("{}k", bufsize),
        ],
    };

    let mut args = vec![
        "-hide_banner".to_string(),
        "-y".to_string(),
        "-i".to_string(), input,
        "-c:v".to_string(), encoder.to_string(),
    ];
    args.extend(encoder_params);
    args.extend_from_slice(&[
        "-c:a".to_string(), "copy".to_string(),
        "-map".to_string(), "0".to_string(),
        "-progress".to_string(), "pipe:1".to_string(),
        output,
    ]);

    Ok(args)
}
