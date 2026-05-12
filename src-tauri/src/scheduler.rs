use crate::detector::find_ffmpeg_path;
use crate::encoder;
use crate::ffmpeg_cmd::output_path;
use crate::models::{EncodeTask, ProgressPayload, Settings, TaskStatus};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

pub struct Scheduler {
    tasks: Arc<Mutex<Vec<EncodeTask>>>,
    cancel: Arc<Mutex<bool>>,
    paused: Arc<Mutex<bool>>,
    handles: Arc<Mutex<Vec<JoinHandle<()>>>>,
    pids: Arc<Mutex<Vec<u32>>>,
    max_concurrent: Arc<AtomicUsize>,
    running_count: Arc<AtomicUsize>,
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(Mutex::new(Vec::new())),
            cancel: Arc::new(Mutex::new(false)),
            paused: Arc::new(Mutex::new(false)),
            handles: Arc::new(Mutex::new(Vec::new())),
            pids: Arc::new(Mutex::new(Vec::new())),
            max_concurrent: Arc::new(AtomicUsize::new(1)),
            running_count: Arc::new(AtomicUsize::new(0)),
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
        *self.paused.lock().await = false;
        self.handles.lock().await.clear();
        self.pids.lock().await.clear();
        self.max_concurrent
            .store(settings.max_concurrent.max(1).min(8), Ordering::SeqCst);
        self.running_count.store(0, Ordering::SeqCst);

        let ffmpeg_path = find_ffmpeg_path(&settings.ffmpeg_path).unwrap_or_else(|| "ffmpeg".into());
        let tasks_arc = self.tasks.clone();
        let cancel_arc = self.cancel.clone();
        let paused_arc = self.paused.clone();
        let handles_arc = self.handles.clone();
        let pids_arc = self.pids.clone();
        let max_concurrent = self.max_concurrent.clone();
        let running_count = self.running_count.clone();

        let total = tasks_arc.lock().await.len();

        for i in 0..total {
            // Wait until a slot is available
            loop {
                if *cancel_arc.lock().await {
                    return;
                }
                let running = running_count.load(Ordering::SeqCst);
                let max = max_concurrent.load(Ordering::SeqCst);
                if running < max {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }

            while *paused_arc.lock().await {
                if *cancel_arc.lock().await {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }

            if *cancel_arc.lock().await {
                break;
            }

            running_count.fetch_add(1, Ordering::SeqCst);

            let task = tasks_arc.lock().await[i].clone();
            let progress_tx = progress_tx.clone();
            let status_tx = status_tx.clone();
            let ffmpeg_path = ffmpeg_path.clone();
            let settings = settings.clone();
            let tasks_arc_i = tasks_arc.clone();
            let pids_arc_i = pids_arc.clone();
            let running_count_i = running_count.clone();
            let cancel_arc_i = cancel_arc.clone();

            let handle = tokio::spawn(async move {
                let task_id = task.id.clone();

                // Check if cancelled before starting FFmpeg
                if *cancel_arc_i.lock().await {
                    running_count_i.fetch_sub(1, Ordering::SeqCst);
                    return;
                }

                let _ = status_tx.send((task_id.clone(), TaskStatus::Encoding));

                let mut task = task;
                let result = encoder::run_encode(
                    &mut task,
                    &settings,
                    &ffmpeg_path,
                    progress_tx.clone(),
                    Some(pids_arc_i),
                )
                .await;

                match result {
                    Ok(()) => {
                        let _ = status_tx.send((task_id.clone(), TaskStatus::Completed));
                    }
                    Err(e) => {
                        let _ = status_tx.send((task_id.clone(), TaskStatus::Failed(e)));
                    }
                }

                let mut tasks = tasks_arc_i.lock().await;
                if let Some(t) = tasks.iter_mut().find(|t| t.id == task_id) {
                    t.status = task.status.clone();
                    t.progress = task.progress;
                }

                running_count_i.fetch_sub(1, Ordering::SeqCst);
            });

            handles_arc.lock().await.push(handle);
        }
    }

    pub async fn set_max_concurrent(&self, count: usize) {
        self.max_concurrent
            .store(count.max(1).min(8), Ordering::SeqCst);
    }

    pub async fn stop_and_cleanup(&self, output_suffix: &str) {
        *self.cancel.lock().await = true;
        *self.paused.lock().await = false;
        self.kill_processes().await;
        let mut handles = self.handles.lock().await;
        for h in handles.drain(..) {
            h.abort();
        }
        self.running_count.store(0, Ordering::SeqCst);

        let tasks = self.tasks.lock().await;
        for task in tasks.iter() {
            if matches!(task.status, TaskStatus::Encoding) {
                let out = output_path(&task.video.path, output_suffix);
                let _ = std::fs::remove_file(&out);
            }
        }
    }

    pub async fn cancel_all(&self) {
        *self.cancel.lock().await = true;
        *self.paused.lock().await = false;
        self.kill_processes().await;
        let mut handles = self.handles.lock().await;
        for h in handles.drain(..) {
            h.abort();
        }
        self.running_count.store(0, Ordering::SeqCst);
    }

    pub async fn pause(&self) {
        *self.paused.lock().await = true;
        self.suspend_processes().await;
    }

    pub async fn resume(&self) {
        *self.paused.lock().await = false;
        self.resume_processes().await;
    }

    pub async fn is_paused(&self) -> bool {
        *self.paused.lock().await
    }

    pub async fn set_resource_level(&self, level: &str) {
        let pids = self.pids.lock().await;
        for &pid in pids.iter() {
            match level {
                "low" => set_priority_low(pid),
                _ => set_priority_normal(pid),
            }
        }
    }

    async fn suspend_processes(&self) {
        let pids = self.pids.lock().await;
        for &pid in pids.iter() {
            suspend_pid(pid);
        }
    }

    async fn resume_processes(&self) {
        let pids = self.pids.lock().await;
        for &pid in pids.iter() {
            resume_pid(pid);
        }
    }

    async fn kill_processes(&self) {
        let mut pids = self.pids.lock().await;
        for &pid in pids.iter() {
            kill_pid(pid);
        }
        pids.clear();
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
                    match encoder::run_encode(&mut task, &settings, &ffmpeg_path, progress_tx.clone(), None)
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

#[cfg(target_os = "windows")]
fn suspend_pid(pid: u32) {
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> isize;
            fn CloseHandle(hObject: isize) -> i32;
        }
        #[link(name = "ntdll")]
        extern "system" {
            fn NtSuspendProcess(ProcessHandle: isize) -> i32;
        }
        const PROCESS_SUSPEND_RESUME: u32 = 0x0800;
        let handle = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
        if handle != 0 {
            NtSuspendProcess(handle);
            CloseHandle(handle);
        }
    }
}

#[cfg(target_os = "windows")]
fn set_priority_low(pid: u32) {
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> isize;
            fn SetPriorityClass(hProcess: isize, dwPriorityClass: u32) -> i32;
            fn CloseHandle(hObject: isize) -> i32;
        }
        const PROCESS_SET_INFORMATION: u32 = 0x0200;
        const IDLE_PRIORITY_CLASS: u32 = 0x40;
        let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
        if handle != 0 {
            SetPriorityClass(handle, IDLE_PRIORITY_CLASS);
            CloseHandle(handle);
        }
    }
}

#[cfg(target_os = "windows")]
fn set_priority_normal(pid: u32) {
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> isize;
            fn SetPriorityClass(hProcess: isize, dwPriorityClass: u32) -> i32;
            fn CloseHandle(hObject: isize) -> i32;
        }
        const PROCESS_SET_INFORMATION: u32 = 0x0200;
        const NORMAL_PRIORITY_CLASS: u32 = 0x20;
        let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
        if handle != 0 {
            SetPriorityClass(handle, NORMAL_PRIORITY_CLASS);
            CloseHandle(handle);
        }
    }
}

#[cfg(target_os = "windows")]
fn resume_pid(pid: u32) {
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> isize;
            fn CloseHandle(hObject: isize) -> i32;
        }
        #[link(name = "ntdll")]
        extern "system" {
            fn NtResumeProcess(ProcessHandle: isize) -> i32;
        }
        const PROCESS_SUSPEND_RESUME: u32 = 0x0800;
        let handle = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
        if handle != 0 {
            NtResumeProcess(handle);
            CloseHandle(handle);
        }
    }
}

#[cfg(target_os = "windows")]
fn kill_pid(pid: u32) {
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> isize;
            fn TerminateProcess(hProcess: isize, uExitCode: u32) -> i32;
            fn CloseHandle(hObject: isize) -> i32;
        }
        const PROCESS_TERMINATE: u32 = 0x0001;
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle != 0 {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn suspend_pid(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-STOP", &pid.to_string()])
        .spawn();
}

#[cfg(not(target_os = "windows"))]
fn resume_pid(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-CONT", &pid.to_string()])
        .spawn();
}

#[cfg(not(target_os = "windows"))]
fn kill_pid(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .spawn();
}

#[cfg(not(target_os = "windows"))]
fn set_priority_low(pid: u32) {
    let _ = std::process::Command::new("renice")
        .args(["-n", "19", "-p", &pid.to_string()])
        .spawn();
}

#[cfg(not(target_os = "windows"))]
fn set_priority_normal(pid: u32) {
    let _ = std::process::Command::new("renice")
        .args(["-n", "0", "-p", &pid.to_string()])
        .spawn();
}
