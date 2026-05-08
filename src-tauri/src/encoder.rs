use crate::ffmpeg_cmd::build_ffmpeg_args;
use crate::models::{EncodeTask, ProgressPayload, Settings};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

pub async fn run_encode(
    task: &mut EncodeTask,
    settings: &Settings,
    ffmpeg_path: &str,
    progress_tx: mpsc::UnboundedSender<ProgressPayload>,
) -> Result<(), String> {
    let args = build_ffmpeg_args(task, settings)?;
    let mut child = Command::new(ffmpeg_path)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to start ffmpeg: {}", e))?;

    let stdout = child.stdout.take().ok_or("cannot read stdout")?;
    let stderr = child.stderr.take().ok_or("cannot read stderr")?;

    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    let duration_us = (task.video.duration_s * 1_000_000.0) as u64;
    let task_id = task.id.clone();

    let progress_handle = tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let out_time_us: u64 = parse_key(trimmed, "out_time_us=").unwrap_or(0);
            let fps: f64 = parse_key(trimmed, "fps=").unwrap_or(0.0);
            let speed: f64 = parse_speed(trimmed).unwrap_or(0.0);

            let progress = if duration_us > 0 {
                (out_time_us as f64 / duration_us as f64 * 100.0).min(100.0).max(0.0)
            } else {
                0.0
            };

            // speed= is a multiplier: 1.5x means 1.5 seconds of video per second of wall time
            let eta_seconds = if speed > 0.0 && duration_us > 0 {
                let remaining_us = duration_us.saturating_sub(out_time_us);
                ((remaining_us as f64 / 1_000_000.0) / speed as f64) as u64
            } else {
                0
            };

            let _ = progress_tx.send(ProgressPayload {
                task_id: task_id.clone(),
                progress,
                fps,
                eta_seconds,
            });
        }
    });

    let stderr_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        let mut last_lines: Vec<String> = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            last_lines.push(line);
            if last_lines.len() > 5 {
                last_lines.remove(0);
            }
        }
        last_lines.join("\n")
    });

    let status = child.wait().await.map_err(|e| format!("ffmpeg process error: {}", e))?;
    progress_handle.await.ok();
    let stderr_tail = stderr_handle.await.unwrap_or_default();

    if status.success() {
        task.status = crate::models::TaskStatus::Completed;
        task.progress = 100.0;
        Ok(())
    } else {
        let err_msg = format!("ffmpeg exit code {}: {}", status.code().unwrap_or(-1), stderr_tail);
        task.status = crate::models::TaskStatus::Failed(err_msg.clone());
        Err(err_msg)
    }
}

fn parse_key<T: std::str::FromStr>(line: &str, key: &str) -> Option<T> {
    let rest = line.strip_prefix(key)?;
    rest.trim().parse().ok()
}

fn parse_speed(line: &str) -> Option<f64> {
    let rest = line.strip_prefix("speed=")?;
    let num = rest.trim().strip_suffix('x')?;
    num.parse().ok()
}
