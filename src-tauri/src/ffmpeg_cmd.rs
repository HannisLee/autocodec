use crate::models::{EncodeTask, Settings};
use std::path::PathBuf;

pub fn output_path(input: &PathBuf, suffix: &str) -> PathBuf {
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

    let replace_placeholders = |s: &str| -> String {
        s.replace("{encoder}", encoder)
         .replace("{bitrate}", &bitrate.to_string())
         .replace("{maxrate}", &maxrate.to_string())
         .replace("{bufsize}", &bufsize.to_string())
    };

    let video_params = replace_placeholders(&settings.video_encode_template);
    let extra_params = replace_placeholders(&settings.extra_args_template);

    let mut args = vec![
        "-hide_banner".to_string(),
        "-y".to_string(),
        "-i".to_string(),
        input,
    ];
    args.extend(split_args(&video_params));

    // Resource-level dependent args
    let level = settings.resource_level.as_str();
    let is_nvenc = encoder.contains("nvenc");
    let is_qsv = encoder.contains("qsv");
    let is_amf = encoder.contains("amf");
    let is_hw = is_nvenc || is_qsv || is_amf;

    if !is_hw && level == "low" {
        args.extend_from_slice(&["-threads".to_string(), "2".to_string()]);
    }

    if is_nvenc {
        let preset = match level {
            "low" => "p1",
            "high" => "p7",
            _ => "p4",
        };
        args.extend_from_slice(&["-preset".to_string(), preset.to_string()]);
    }

    args.extend(split_args(&extra_params));
    args.extend_from_slice(&[
        "-progress".to_string(),
        "pipe:1".to_string(),
        output,
    ]);

    Ok(args)
}

fn split_args(s: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut quote_char = '"';

    for ch in s.chars() {
        if in_quotes {
            if ch == quote_char {
                in_quotes = false;
            } else {
                current.push(ch);
            }
        } else if ch == '"' || ch == '\'' {
            in_quotes = true;
            quote_char = ch;
        } else if ch.is_whitespace() {
            if !current.is_empty() {
                args.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}
