use crate::detector::find_ffmpeg_path;
use crate::encoder;
use crate::models::{EncodeTask, ProgressPayload, Settings, TaskStatus};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tokio::task::JoinHandle;

pub struct Scheduler {
    tasks: Arc<Mutex<Vec<EncodeTask>>>,
    cancel: Arc<Mutex<bool>>,
    handles: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(Mutex::new(Vec::new())),
            cancel: Arc::new(Mutex::new(false)),
            handles: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn run(
        &self,
        tasks: Vec<EncodeTask>,
        settings: Settings,
        progress_tx: mpsc::UnboundedSender<ProgressPayload>,
        status_tx: mpsc::UnboundedSender<(String, TaskStatus)>,
    ) {
        *self.tasks.lock().await = tasks;
        *self.cancel.lock().await = false;
        self.handles.lock().await.clear();

        let semaphore = Arc::new(Semaphore::new(settings.max_concurrent.max(1).min(8)));
        let ffmpeg_path = find_ffmpeg_path(&settings.ffmpeg_path).unwrap_or_else(|| "ffmpeg".into());
        let tasks_arc = self.tasks.clone();
        let cancel_arc = self.cancel.clone();
        let handles_arc = self.handles.clone();

        let total = tasks_arc.lock().await.len();

        for i in 0..total {
            if *cancel_arc.lock().await {
                break;
            }

            let permit = semaphore.clone().acquire_owned().await.unwrap();
            let task = tasks_arc.lock().await[i].clone();
            let progress_tx = progress_tx.clone();
            let status_tx = status_tx.clone();
            let ffmpeg_path = ffmpeg_path.clone();
            let settings = settings.clone();
            let tasks_arc = tasks_arc.clone();

            let handle = tokio::spawn(async move {
                let _permit = permit;
                let task_id = task.id.clone();

                let _ = status_tx.send((task_id.clone(), TaskStatus::Encoding));

                let mut task = task;
                match encoder::run_encode(&mut task, &settings, &ffmpeg_path, progress_tx.clone()).await {
                    Ok(()) => {
                        let _ = status_tx.send((task_id.clone(), TaskStatus::Completed));
                    }
                    Err(e) => {
                        let _ = status_tx.send((task_id.clone(), TaskStatus::Failed(e)));
                    }
                }

                let mut tasks = tasks_arc.lock().await;
                if let Some(t) = tasks.iter_mut().find(|t| t.id == task_id) {
                    t.status = task.status.clone();
                    t.progress = task.progress;
                }
            });

            handles_arc.lock().await.push(handle);
        }
    }

    pub async fn cancel_all(&self) {
        *self.cancel.lock().await = true;
        let mut handles = self.handles.lock().await;
        for h in handles.drain(..) {
            h.abort();
        }
    }

    pub async fn retry_task(
        &self,
        task_id: &str,
        settings: Settings,
        progress_tx: mpsc::UnboundedSender<ProgressPayload>,
        status_tx: mpsc::UnboundedSender<(String, TaskStatus)>,
    ) {
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) {
            let task_status = task.status.clone();
            if let TaskStatus::Failed(_) = task_status {
                task.status = TaskStatus::Pending;
                task.progress = 0.0;
                let task = task.clone();
                drop(tasks);

                let ffmpeg_path =
                    find_ffmpeg_path(&settings.ffmpeg_path).unwrap_or_else(|| "ffmpeg".into());
                let task_id = task.id.clone();
                let _ = status_tx.send((task_id.clone(), TaskStatus::Encoding));

                tokio::spawn(async move {
                    let mut task = task;
                    match encoder::run_encode(&mut task, &settings, &ffmpeg_path, progress_tx.clone())
                        .await
                    {
                        Ok(()) => {
                            let _ = status_tx.send((task_id, TaskStatus::Completed));
                        }
                        Err(e) => {
                            let _ = status_tx.send((task_id, TaskStatus::Failed(e)));
                        }
                    }
                });
            }
        }
    }
}
