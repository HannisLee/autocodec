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

interface EncodeRule {
  id: string;
  resolution: { P720: null } | { P1080: null } | { P2160: null } | { Custom: { width: number; height: number } };
  bitrate_threshold_kbps: number;
  target_codec: string;
  target_bitrate_kbps: number;
  preferred_encoder: { Auto: null } | { Specific: string };
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
  static encoding = false;
  static scanning = false;

  static render(): string {
    return `
      <div class="toolbar">
        <input type="text" id="folder-path" placeholder="选择视频文件夹..." readonly />
        <button class="btn btn-primary" id="btn-select-folder">选择文件夹</button>
        <button class="btn btn-secondary" id="btn-scan" disabled>扫描</button>
        <button class="btn btn-danger btn-sm" id="btn-stop-scan" style="display:none;">停止扫描</button>
        <span id="scan-progress-text" style="font-size:11px;color:var(--text-secondary);"></span>
      </div>
      <div id="scan-table-wrap">
        <table>
          <thead>
            <tr>
              <th>文件名</th>
              <th>分辨率</th>
              <th>码率</th>
              <th>编码格式</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody id="scan-tbody"></tbody>
        </table>
        <div id="no-files-msg" style="padding:40px;text-align:center;color:var(--text-secondary);">请选择文件夹并扫描</div>
      </div>
      <div class="summary-bar">
        <div class="summary-stats" id="summary-stats"></div>
        <div class="summary-actions">
          <button class="btn btn-primary" id="btn-start-encode" disabled>开始编码</button>
          <button class="btn btn-danger" id="btn-cancel-encode" disabled>取消</button>
        </div>
      </div>
    `;
  }

  static async init(): Promise<void> {
    const folderInput = document.getElementById("folder-path") as HTMLInputElement;
    const btnSelect = document.getElementById("btn-select-folder")!;
    const btnScan = document.getElementById("btn-scan")!;
    const btnStart = document.getElementById("btn-start-encode")!;
    const btnCancel = document.getElementById("btn-cancel-encode")!;

    btnSelect.addEventListener("click", async () => {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        folderInput.value = selected as string;
        (btnScan as HTMLButtonElement).disabled = false;
      }
    });

    btnScan.addEventListener("click", () => this.scan(folderInput.value));
    btnStart.addEventListener("click", () => this.startEncode());
    btnCancel.addEventListener("click", () => this.cancelEncode());

    const btnStopScan = document.getElementById("btn-stop-scan")!;
    btnStopScan.addEventListener("click", () => this.stopScan());

    // Listen for scan progress
    await listen<{ current: number; total: number; file: string }>("scan-progress", (event) => {
      const p = event.payload;
      const el = document.getElementById("scan-progress-text");
      if (el) el.textContent = `扫描中 ${p.current}/${p.total}: ${p.file}`;
    });

    // Load rules for summary display
    try {
      this.rules = await invoke<EncodeRule[]>("load_rules");
    } catch (e) {
      console.error("load rules failed:", e);
    }

    // Listen for progress events
    await listen<ProgressPayload>("progress-changed", (event) => {
      const p = event.payload;
      const task = this.tasks.get(p.task_id);
      if (task) {
        task.progress = p.progress;
        task.fps = p.fps;
        task.eta_seconds = p.eta_seconds;
        this.updateTableRow(task);
      }
    });

    await listen<string>("task-started", (event) => {
      const task = this.tasks.get(event.payload);
      if (task) {
        task.status = "Encoding";
        this.updateTableRow(task);
      }
    });

    await listen<string>("task-completed", (event) => {
      const task = this.tasks.get(event.payload);
      if (task) {
        task.status = "Completed";
        this.updateTableRow(task);
        this.updateButtons();
      }
    });

    await listen<{ task_id: string; error: string }>("task-failed", (event) => {
      const task = this.tasks.get(event.payload.task_id);
      if (task) {
        task.status = `Failed(${event.payload.error})`;
        this.updateTableRow(task);
        this.updateButtons();
      }
    });
  }

  static async scan(folderPath: string): Promise<void> {
    const btnScan = document.getElementById("btn-scan") as HTMLButtonElement;
    const btnStop = document.getElementById("btn-stop-scan")!;
    btnScan.disabled = true;
    btnScan.textContent = "扫描中...";
    btnStop.style.display = "inline-block";
    this.scanning = true;

    try {
      this.videos = await invoke<VideoInfo[]>("scan_folder", { path: folderPath });
      // Even if cancelled mid-scan, we get partial results — show them
      this.buildTasksFromVideos();
    } catch (e) {
      alert(`扫描失败: ${e}`);
    } finally {
      btnScan.disabled = false;
      btnScan.textContent = "扫描";
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

  static buildTasksFromVideos(): void {
    const rules = this.rules;
    this.tasks.clear();
    for (const video of this.videos) {
      const matched = this.matchRule(video, rules);
      const task: EncodeTask = {
        id: crypto.randomUUID(),
        video,
        rule: matched?.rule ?? { id: "", resolution: { P1080: null }, bitrate_threshold_kbps: 0, target_codec: "", target_bitrate_kbps: 0, preferred_encoder: { Auto: null }, maxrate_multiplier: 1.5, bufsize_multiplier: 2.0 },
        encoder: matched?.encoder ?? "",
        status: matched ? "Pending" : "Skipped(no matching rule or already encoded)",
        progress: 0,
        fps: 0,
        eta_seconds: 0,
      };
      this.tasks.set(task.id, task);
    }
    this.renderTable();
    this.updateSummary();
    this.updateButtons();
  }

  static matchRule(video: VideoInfo, rules: EncodeRule[]): { rule: EncodeRule; encoder: string } | null {
    for (const rule of rules) {
      const res = rule.resolution;
      let resMatch = false;
      if ("P720" in res) resMatch = video.width === 1280 && video.height === 720;
      else if ("P1080" in res) resMatch = video.width === 1920 && video.height === 1080;
      else if ("P2160" in res) resMatch = video.width === 3840 && video.height === 2160;
      else if ("Custom" in res) resMatch = video.width === res.Custom.width && video.height === res.Custom.height;

      if (!resMatch) continue;
      if (video.bitrate_kbps <= rule.bitrate_threshold_kbps) continue;

      const targetSuffixes = rule.target_codec.toLowerCase() === "hevc"
        ? ["hevc", "h265", "x265"]
        : ["h264", "avc", "x264"];
      if (targetSuffixes.some(s => video.codec.toLowerCase().includes(s))) continue;

      // Determine encoder
      let encoder = "libx265";
      if ("Auto" in rule.preferred_encoder) {
        encoder = "hevc_nvenc";
      } else if ("Specific" in rule.preferred_encoder) {
        encoder = rule.preferred_encoder.Specific;
      }

      return { rule, encoder };
    }
    return null;
  }

  static renderTable(): void {
    const tbody = document.getElementById("scan-tbody")!;
    const noFiles = document.getElementById("no-files-msg")!;

    if (this.tasks.size === 0) {
      tbody.innerHTML = "";
      noFiles.style.display = "block";
      return;
    }

    noFiles.style.display = "none";
    let html = "";
    this.tasks.forEach((task) => {
      const v = task.video;
      const statusClass = this.statusClass(task.status);
      const statusText = task.status.startsWith("Failed") ? "失败" :
        task.status.startsWith("Skipped") ? "跳过" :
        task.status === "Pending" ? "待转" :
        task.status === "Encoding" ? "编码中" :
        task.status === "Completed" ? "已完成" : task.status;
      const bitrateStr = v.bitrate_kbps >= 1000 ? `${(v.bitrate_kbps / 1000).toFixed(1)}M` : `${v.bitrate_kbps}K`;

      html += `<tr data-task-id="${task.id}">
        <td>${this.escape(v.filename)}</td>
        <td>${v.width}x${v.height}</td>
        <td>${bitrateStr}</td>
        <td>${this.escape(v.codec)}</td>
        <td><span class="status status-${statusClass}">${statusText}</span></td>
      </tr>`;

      if (task.status === "Encoding") {
        html += this.progressRow(task);
      }
    });
    tbody.innerHTML = html;
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

  static updateTableRow(_task: EncodeTask): void {
    this.renderTable();
    this.updateSummary();
  }

  static updateSummary(): void {
    const stats = document.getElementById("summary-stats")!;
    const total = this.tasks.size;
    let pending = 0, encoding = 0, completed = 0, failed = 0, skipped = 0;
    this.tasks.forEach((t) => {
      if (t.status === "Pending") pending++;
      else if (t.status === "Encoding") encoding++;
      else if (t.status === "Completed") completed++;
      else if (t.status.startsWith("Failed")) failed++;
      else if (t.status.startsWith("Skipped")) skipped++;
    });

    stats.innerHTML = `
      共 <span>${total}</span> 个文件 |
      待转 <span>${pending}</span> |
      编码中 <span>${encoding}</span> |
      已完成 <span>${completed}</span> |
      失败 <span>${failed}</span> |
      跳过 <span>${skipped}</span>
    `;
  }

  static updateButtons(): void {
    const btnStart = document.getElementById("btn-start-encode") as HTMLButtonElement;
    const btnCancel = document.getElementById("btn-cancel-encode") as HTMLButtonElement;
    const hasPending = Array.from(this.tasks.values()).some((t) => t.status === "Pending");

    btnStart.disabled = !hasPending || this.encoding;
    btnCancel.disabled = !this.encoding;
  }

  static async startEncode(): Promise<void> {
    this.encoding = true;
    this.updateButtons();

    const pendingTasks = Array.from(this.tasks.values()).filter((t) => t.status === "Pending");
    // Only send id/video/rule/encoder — status/progress are set by backend defaults
    const tasksToSend = pendingTasks.map((t) => ({
      id: t.id,
      video: t.video,
      rule: t.rule,
      encoder: t.encoder,
    }));
    try {
      await invoke("start_encoding", { tasks: tasksToSend });
    } catch (e) {
      alert(`encoding start failed: ${e}`);
    }

    this.encoding = false;
    this.updateButtons();
  }

  static async cancelEncode(): Promise<void> {
    try {
      await invoke("cancel_encoding");
      this.encoding = false;
      this.updateButtons();
    } catch (e) {
      alert(`cancel failed: ${e}`);
    }
  }

  static statusClass(status: string): string {
    if (status === "Pending") return "pending";
    if (status === "Encoding") return "encoding";
    if (status === "Completed") return "completed";
    if (status.startsWith("Failed")) return "failed";
    if (status.startsWith("Skipped")) return "skipped";
    return "pending";
  }

  static escape(s: string): string {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }
}

export { ScanQueueTab };
