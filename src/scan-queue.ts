import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

interface VideoInfo {
  path: string;
  filename: string;
  width: number;
  height: number;
  bitrate_kbps: number;
  codec: string;
  container: string;
  duration_s: number;
}

type Resolution = "P720" | "P1080" | "P2160" | { Custom: { width: number; height: number } };
type EncoderPref = "Auto" | { Specific: string };

interface EncodeRule {
  id: string;
  resolution: Resolution;
  bitrate_threshold_kbps: number;
  target_codec: string;
  target_bitrate_kbps: number;
  preferred_encoder: EncoderPref;
  maxrate_multiplier: number;
  bufsize_multiplier: number;
}

interface EncodeTask {
  id: string;
  video: VideoInfo;
  rule: EncodeRule;
  encoder: string;
  status: string;
  progress: number;
  fps: number;
  eta_seconds: number;
}

interface ProgressPayload {
  task_id: string;
  progress: number;
  fps: number;
  eta_seconds: number;
}

class ScanQueueTab {
  static videos: VideoInfo[] = [];
  static rules: EncodeRule[] = [];
  static tasks: Map<string, EncodeTask> = new Map();
  static pathToTaskId: Map<string, string> = new Map();
  static encoding = false;
  static paused = false;
  static scanning = false;
  static selectedQueue: Set<string> = new Set();
  static folderPath = "";
  static listenersInitialized = false;

  static render(): string {
    return `
      <div class="toolbar">
        <input type="text" id="folder-path" placeholder="输入或粘贴视频文件夹路径..." />
        <button class="btn btn-primary" id="btn-select-folder">选择文件夹</button>
        <button class="btn btn-secondary" id="btn-scan">扫描</button>
        <button class="btn btn-danger btn-sm" id="btn-stop-scan" style="display:none;">停止扫描</button>
        <span id="scan-progress-text" style="font-size:11px;color:var(--text-secondary);"></span>
      </div>
      <div class="split-panels">
        <div class="panel panel-scan">
          <div class="panel-header">
            <h3>扫描结果</h3>
            <span id="scan-count" class="panel-count"></span>
          </div>
          <div class="panel-body">
            <table>
              <thead>
                <tr>
                  <th>文件名</th>
                  <th>分辨率</th>
                  <th>码率</th>
                  <th>编码</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody id="scan-tbody"></tbody>
            </table>
            <div id="no-files-msg" class="empty-msg">请选择文件夹并扫描</div>
          </div>
        </div>
        <div class="panel panel-queue">
          <div class="panel-header">
            <h3>转码队列</h3>
            <span id="queue-count" class="panel-count"></span>
            <div class="panel-actions">
              <input type="checkbox" id="select-all-queue" title="全选" />
              <button class="btn btn-danger btn-sm" id="btn-delete-queue" disabled>删除选中</button>
            </div>
          </div>
          <div class="panel-body">
            <table>
              <thead>
                <tr>
                  <th style="width:30px;"></th>
                  <th>文件名</th>
                  <th>编码器</th>
                  <th>目标码率</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody id="queue-tbody"></tbody>
            </table>
            <div id="no-queue-msg" class="empty-msg">无转码任务</div>
          </div>
          <div class="queue-actions">
            <button class="btn btn-primary" id="btn-start-encode" disabled>开始编码</button>
            <button class="btn btn-secondary" id="btn-pause-encode" disabled>暂停</button>
            <button class="btn btn-danger" id="btn-stop-encode" disabled>停止</button>
          </div>
        </div>
      </div>
    `;
  }

  static async init(): Promise<void> {
    const folderInput = document.getElementById("folder-path") as HTMLInputElement;
    folderInput.value = this.folderPath;

    document.getElementById("btn-select-folder")!.addEventListener("click", async () => {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        folderInput.value = selected as string;
        this.scan(selected as string);
      }
    });

    document.getElementById("btn-scan")!.addEventListener("click", () => {
      if (folderInput.value) this.scan(folderInput.value);
    });

    document.getElementById("btn-stop-scan")!.addEventListener("click", () => this.stopScan());
    document.getElementById("btn-start-encode")!.addEventListener("click", () => this.startEncode());
    document.getElementById("btn-stop-encode")!.addEventListener("click", () => this.stopEncode());
    document.getElementById("btn-pause-encode")!.addEventListener("click", () => this.togglePause());
    document.getElementById("btn-delete-queue")!.addEventListener("click", () => this.deleteSelectedQueue());

    this.initCheckboxes();

    try {
      this.rules = await invoke<EncodeRule[]>("load_rules");
    } catch (e) {
      console.error("load rules failed:", e);
    }

    if (!this.listenersInitialized) {
      this.listenersInitialized = true;

      await listen<{ current: number; total: number; file: string }>("scan-progress", (event) => {
        const p = event.payload;
        const el = document.getElementById("scan-progress-text");
        if (el) el.textContent = `扫描中 ${p.current}/${p.total}: ${p.file}`;
      });

      await listen<ProgressPayload>("progress-changed", (event) => {
        const task = this.tasks.get(event.payload.task_id);
        if (task) {
          task.progress = event.payload.progress;
          task.fps = event.payload.fps;
          task.eta_seconds = event.payload.eta_seconds;
          this.renderQueueList();
        }
      });

      await listen<string>("task-started", (event) => {
        const task = this.tasks.get(event.payload);
        if (task) {
          task.status = "Encoding";
          this.renderBoth();
        }
      });

      await listen<string>("task-completed", (event) => {
        const task = this.tasks.get(event.payload);
        if (task) {
          task.status = "Completed";
          task.progress = 100;
          this.renderBoth();
        }
      });

      await listen<{ task_id: string; error: string }>("task-failed", (event) => {
        const task = this.tasks.get(event.payload.task_id);
        if (task) {
          task.status = `Failed(${event.payload.error})`;
          this.renderBoth();
        }
      });
    }

    if (this.videos.length > 0) {
      this.renderScanList();
      this.renderQueueList();
      this.updateQueueActions();
    }
  }

  private static renderBoth(): void {
    this.renderScanList();
    this.renderQueueList();
    this.updateQueueActions();
  }

  static async scan(folderPath: string): Promise<void> {
    this.folderPath = folderPath;
    const btnScan = document.getElementById("btn-scan") as HTMLButtonElement;
    const btnStop = document.getElementById("btn-stop-scan")!;
    btnScan.disabled = true;
    btnStop.style.display = "inline-block";
    this.scanning = true;

    try {
      this.videos = await invoke<VideoInfo[]>("scan_folder", { path: folderPath });
      this.buildQueue();
    } catch (e) {
      alert(`扫描失败: ${e}`);
    } finally {
      btnScan.disabled = false;
      btnStop.style.display = "none";
      this.scanning = false;
      const progEl = document.getElementById("scan-progress-text");
      if (progEl) progEl.textContent = "";
    }
  }

  static async stopScan(): Promise<void> {
    try {
      await invoke("cancel_scan");
    } catch (e) {
      console.error("cancel scan failed:", e);
    }
  }

  static getVideoMatch(video: VideoInfo): { match: { rule: EncodeRule; encoder: string } | null; status: string } {
    for (const rule of this.rules) {
      const res = rule.resolution;
      let resMatch = false;
      if (res === "P720") resMatch = video.width === 1280 && video.height === 720;
      else if (res === "P1080") resMatch = video.width === 1920 && video.height === 1080;
      else if (res === "P2160") resMatch = video.width === 3840 && video.height === 2160;
      else if (typeof res === "object" && "Custom" in res) resMatch = video.width === res.Custom.width && video.height === res.Custom.height;

      if (!resMatch) continue;

      if (video.bitrate_kbps <= rule.bitrate_threshold_kbps) {
        return { match: null, status: "码率已达标" };
      }

      const targetSuffixes = rule.target_codec.toLowerCase() === "hevc"
        ? ["hevc", "h265", "x265"]
        : ["h264", "avc", "x264"];
      if (targetSuffixes.some(s => video.codec.toLowerCase().includes(s))) {
        return { match: null, status: "已转码" };
      }

      let encoder = "libx265";
      if (rule.preferred_encoder === "Auto") {
        encoder = "hevc_nvenc";
      } else if (typeof rule.preferred_encoder === "object" && "Specific" in rule.preferred_encoder) {
        encoder = rule.preferred_encoder.Specific;
      }

      return { match: { rule, encoder }, status: "需转码" };
    }
    return {
      match: {
        rule: {
          id: "", resolution: "P1080", bitrate_threshold_kbps: 0,
          target_codec: "hevc", target_bitrate_kbps: 5000,
          preferred_encoder: "Auto", maxrate_multiplier: 1.5, bufsize_multiplier: 2.0,
        },
        encoder: "hevc_nvenc",
      },
      status: "需转码",
    };
  }

  static buildQueue(): void {
    this.tasks.clear();
    this.pathToTaskId.clear();
    this.selectedQueue.clear();

    for (const video of this.videos) {
      const { match } = this.getVideoMatch(video);
      if (match) {
        const task: EncodeTask = {
          id: crypto.randomUUID(),
          video,
          rule: match.rule,
          encoder: match.encoder,
          status: "Pending",
          progress: 0,
          fps: 0,
          eta_seconds: 0,
        };
        this.tasks.set(task.id, task);
        this.pathToTaskId.set(video.path, task.id);
      }
    }

    this.renderScanList();
    this.renderQueueList();
    this.updateQueueActions();
  }

  static renderScanList(): void {
    const tbody = document.getElementById("scan-tbody")!;
    const noFiles = document.getElementById("no-files-msg")!;
    const countEl = document.getElementById("scan-count")!;

    if (this.videos.length === 0) {
      tbody.innerHTML = "";
      noFiles.style.display = "block";
      countEl.textContent = "";
      return;
    }

    noFiles.style.display = "none";
    countEl.textContent = `(${this.videos.length} 个文件)`;

    let html = "";
    for (const video of this.videos) {
      const isInQueue = this.pathToTaskId.has(video.path);
      const task = isInQueue ? this.tasks.get(this.pathToTaskId.get(video.path)!) : null;
      const bitrateStr = video.bitrate_kbps >= 1000 ? `${(video.bitrate_kbps / 1000).toFixed(1)}M` : `${video.bitrate_kbps}K`;

      let statusBadge: string;
      if (isInQueue && task) {
        if (task.status === "Pending") statusBadge = `<span class="status status-pending">队列中</span>`;
        else if (task.status === "Encoding") statusBadge = `<span class="status status-encoding">编码中</span>`;
        else if (task.status === "Completed") statusBadge = `<span class="status status-completed">已完成</span>`;
        else if (task.status.startsWith("Failed")) statusBadge = `<span class="status status-failed">失败</span>`;
        else statusBadge = `<span class="status status-pending">队列中</span>`;
      } else {
        const { status } = this.getVideoMatch(video);
        const cls = status === "需转码" ? "pending" : "skipped";
        statusBadge = `<span class="status status-${cls}">${status}</span>`;
      }

      html += `<tr>
        <td>${this.escape(video.filename)}</td>
        <td>${video.width}x${video.height}</td>
        <td>${bitrateStr}</td>
        <td>${this.escape(video.codec)}</td>
        <td>${statusBadge}</td>
      </tr>`;
    }
    tbody.innerHTML = html;
  }

  static renderQueueList(): void {
    const tbody = document.getElementById("queue-tbody")!;
    const noQueue = document.getElementById("no-queue-msg")!;
    const countEl = document.getElementById("queue-count")!;

    // Only show pending and encoding tasks
    const visibleTasks = Array.from(this.tasks.values()).filter(
      (t) => t.status === "Pending" || t.status === "Encoding"
    );

    if (visibleTasks.length === 0) {
      tbody.innerHTML = "";
      noQueue.style.display = "block";
      countEl.textContent = "";
      return;
    }

    noQueue.style.display = "none";
    countEl.textContent = `(${visibleTasks.length} 个任务)`;

    let html = "";
    for (const task of visibleTasks) {
      const v = task.video;
      const bitrateStr = task.rule.target_bitrate_kbps >= 1000
        ? `${(task.rule.target_bitrate_kbps / 1000).toFixed(1)}M`
        : `${task.rule.target_bitrate_kbps}K`;
      const statusText = task.status === "Pending" ? "待转" : "编码中";
      const statusClass = this.statusClass(task.status);
      const isEncoding = task.status === "Encoding";
      const selChecked = this.selectedQueue.has(task.id) ? "checked" : "";
      const selDisabled = isEncoding ? "disabled" : "";

      html += `<tr data-task-id="${task.id}">
        <td><input type="checkbox" class="queue-check" data-task-id="${task.id}" ${selChecked} ${selDisabled} /></td>
        <td>${this.escape(v.filename)}</td>
        <td>${this.escape(task.encoder)}</td>
        <td>${bitrateStr}</td>
        <td><span class="status status-${statusClass}">${statusText}</span></td>
      </tr>`;

      if (isEncoding) {
        html += this.progressRow(task);
      }
    }
    tbody.innerHTML = html;
    this.updateSelectAllQueue();
    this.updateDeleteBtn();
  }

  static progressRow(task: EncodeTask): string {
    const eta = task.eta_seconds > 0 ? `${Math.ceil(task.eta_seconds / 60)}分` : "--";
    return `<tr class="progress-row" data-task-id="${task.id}-prog">
      <td colspan="5">
        <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${task.progress.toFixed(1)}%"></div></div>
        <div class="progress-details">
          <span>${task.progress.toFixed(1)}%</span>
          <span>${task.fps.toFixed(1)} fps</span>
          <span>剩余 ${eta}</span>
        </div>
      </td>
    </tr>`;
  }

  static initCheckboxes(): void {
    const selectAllQueue = document.getElementById("select-all-queue") as HTMLInputElement;
    selectAllQueue.addEventListener("change", () => {
      const checked = selectAllQueue.checked;
      this.tasks.forEach((task) => {
        if (task.status === "Pending") {
          if (checked) this.selectedQueue.add(task.id);
          else this.selectedQueue.delete(task.id);
        }
      });
      this.renderQueueList();
    });

    document.getElementById("queue-tbody")!.addEventListener("change", (e) => {
      const target = e.target as HTMLInputElement;
      if (target.classList.contains("queue-check")) {
        const taskId = target.dataset.taskId!;
        if (target.checked) this.selectedQueue.add(taskId);
        else this.selectedQueue.delete(taskId);
        this.updateSelectAllQueue();
        this.updateDeleteBtn();
      }
    });
  }

  static updateSelectAllQueue(): void {
    const el = document.getElementById("select-all-queue") as HTMLInputElement;
    if (!el) return;
    const selectable = Array.from(this.tasks.values()).filter((t) => t.status === "Pending");
    if (selectable.length === 0) { el.checked = false; el.indeterminate = false; return; }
    const cnt = selectable.filter((t) => this.selectedQueue.has(t.id)).length;
    el.checked = cnt === selectable.length;
    el.indeterminate = cnt > 0 && cnt < selectable.length;
  }

  static updateDeleteBtn(): void {
    const btn = document.getElementById("btn-delete-queue") as HTMLButtonElement;
    if (btn) btn.disabled = this.selectedQueue.size === 0;
  }

  static deleteSelectedQueue(): void {
    for (const taskId of this.selectedQueue) {
      const task = this.tasks.get(taskId);
      if (task) {
        this.pathToTaskId.delete(task.video.path);
        this.tasks.delete(taskId);
      }
    }
    this.selectedQueue.clear();
    this.renderScanList();
    this.renderQueueList();
    this.updateQueueActions();
  }

  static updateQueueActions(): void {
    const btnStart = document.getElementById("btn-start-encode") as HTMLButtonElement;
    const btnStop = document.getElementById("btn-stop-encode") as HTMLButtonElement;
    const btnPause = document.getElementById("btn-pause-encode") as HTMLButtonElement;
    const hasEncoding = Array.from(this.tasks.values()).some((t) => t.status === "Encoding");
    const hasPending = Array.from(this.tasks.values()).some((t) => t.status === "Pending");

    btnStart.disabled = (!hasPending && !hasEncoding) || this.encoding;
    btnStop.disabled = !this.encoding;
    btnPause.disabled = !this.encoding;
    btnPause.textContent = this.paused ? "继续" : "暂停";
  }

  static async startEncode(): Promise<void> {
    this.encoding = true;
    this.paused = false;
    this.updateQueueActions();

    const pendingTasks = Array.from(this.tasks.values()).filter((t) => t.status === "Pending");
    const tasksToSend = pendingTasks.map((t) => ({
      id: t.id,
      video: t.video,
      rule: t.rule,
      encoder: t.encoder,
    }));
    try {
      await invoke("start_encoding", { tasks: tasksToSend });
    } catch (e) {
      alert(`编码启动失败: ${e}`);
    }

    this.encoding = false;
    this.updateQueueActions();
  }

  static async stopEncode(): Promise<void> {
    try {
      await invoke("stop_encoding");
      this.encoding = false;
      this.paused = false;

      // Reset encoding tasks back to Pending
      this.tasks.forEach((task) => {
        if (task.status === "Encoding") {
          task.status = "Pending";
          task.progress = 0;
          task.fps = 0;
          task.eta_seconds = 0;
        }
      });

      this.renderBoth();
    } catch (e) {
      alert(`停止失败: ${e}`);
    }
  }

  static async togglePause(): Promise<void> {
    try {
      if (this.paused) {
        await invoke("resume_encoding");
        this.paused = false;
      } else {
        await invoke("pause_encoding");
        this.paused = true;
      }
    } catch (e) {
      alert(`暂停/继续失败: ${e}`);
    }
    this.updateQueueActions();
  }

  static statusClass(status: string): string {
    if (status === "Pending") return "pending";
    if (status === "Encoding") return "encoding";
    if (status === "Completed") return "completed";
    if (status.startsWith("Failed")) return "failed";
    return "pending";
  }

  static escape(s: string): string {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }
}

export { ScanQueueTab };
