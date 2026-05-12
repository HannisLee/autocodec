import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface Settings {
  ffmpeg_path: string | null;
  max_concurrent: number;
  output_suffix: string;
  preferred_encoder_order: string[];
  video_encode_template: string;
  extra_args_template: string;
  resource_level: string;
}

interface EncoderInfo {
  name: string;
  encoder_type: string;
  available: boolean;
}

class SettingsTab {
  static settings: Settings = {
    ffmpeg_path: null,
    max_concurrent: 1,
    output_suffix: "_HEVC",
    preferred_encoder_order: [],
    video_encode_template: "-c:v {encoder} -b:v {bitrate}k -maxrate:v {maxrate}k -bufsize:v {bufsize}k",
    extra_args_template: "-c:a copy -map 0",
    resource_level: "medium",
  };
  static encoders: EncoderInfo[] = [];

  static render(): string {
    return `
      <div class="settings-section">
        <h3>FFmpeg 路径</h3>
        <div class="setting-row">
          <input type="text" id="ffmpeg-path" placeholder="留空则自动从系统 PATH 检测..." />
          <button class="btn btn-secondary btn-sm" id="btn-browse-ffmpeg">浏览...</button>
        </div>
        <div class="setting-row" style="margin-bottom:0;">
          <label></label>
          <span id="ffmpeg-status" style="font-size:12px;color:var(--text-secondary);">检测中...</span>
          <button class="btn btn-secondary btn-sm" id="btn-detect-encoders">检测可用编码器</button>
        </div>
      </div>

      <div class="settings-section">
        <h3>编码设置</h3>
        <div class="setting-row">
          <label>并发数</label>
          <input type="range" id="max-concurrent" min="1" max="8" value="1" />
          <span class="setting-value" id="concurrent-val">1</span>
          <span style="color:var(--text-secondary);font-size:11px;">(机器建议: <span id="cpu-suggestion">--</span>)</span>
        </div>
        <div class="setting-row">
          <label>资源强度</label>
          <input type="range" id="resource-level" min="0" max="2" step="1" value="1" />
          <span class="setting-value" id="resource-level-val">中</span>
          <span style="color:var(--text-secondary);font-size:11px;">低=后台编码不卡顿，高=全速</span>
        </div>
        <div class="setting-row">
          <label>输出后缀</label>
          <input type="text" id="output-suffix" value="_HEVC" style="max-width:150px;" />
        </div>
        <div class="setting-row">
          <label>视频编码参数</label>
          <input type="text" id="video-encode-template" style="max-width:600px;font-size:12px;font-family:monospace;" />
        </div>
        <div class="setting-row">
          <label>附加参数</label>
          <input type="text" id="extra-args-template" style="max-width:600px;font-size:12px;font-family:monospace;" />
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:12px;padding-left:112px;">
          可用占位符: {encoder} {bitrate} {maxrate} {bufsize}
        </div>
        <div class="setting-row" style="align-items:flex-start;">
          <label>命令预览</label>
          <code id="command-preview" style="flex:1;max-width:600px;font-size:11px;font-family:monospace;color:var(--text-secondary);word-break:break-all;background:var(--bg-primary);padding:8px;border-radius:4px;border:1px solid var(--border);line-height:1.4;"></code>
        </div>
      </div>

      <div class="settings-section">
        <h3>本机编码器</h3>
        <div class="encoder-list" id="encoder-list">
          <span style="color:var(--text-secondary);">点击"检测编码器"查看</span>
        </div>
      </div>

      <div class="toolbar" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-save-settings">保存设置</button>
      </div>
    `;
  }

  static async init(): Promise<void> {
    try {
      this.settings = await invoke<Settings>("load_settings");
    } catch (e) {
      console.error("load settings failed:", e);
    }

    const ffmpegPath = document.getElementById("ffmpeg-path") as HTMLInputElement;
    ffmpegPath.value = this.settings.ffmpeg_path ?? "";

    // Auto-detect ffmpeg status on load
    this.updateFfmpegStatus();

    const maxConcurrent = document.getElementById("max-concurrent") as HTMLInputElement;
    maxConcurrent.value = String(this.settings.max_concurrent);
    document.getElementById("concurrent-val")!.textContent = String(this.settings.max_concurrent);

    const outputSuffix = document.getElementById("output-suffix") as HTMLInputElement;
    outputSuffix.value = this.settings.output_suffix;

    const videoTemplate = document.getElementById("video-encode-template") as HTMLInputElement;
    videoTemplate.value = this.settings.video_encode_template;

    const extraTemplate = document.getElementById("extra-args-template") as HTMLInputElement;
    extraTemplate.value = this.settings.extra_args_template;

    // CPU suggestion
    const cores = navigator.hardwareConcurrency ?? 4;
    const suggested = Math.min(cores, 8);
    document.getElementById("cpu-suggestion")!.textContent = String(suggested);

    maxConcurrent.addEventListener("input", () => {
      const val = parseInt(maxConcurrent.value);
      document.getElementById("concurrent-val")!.textContent = String(val);
      this.settings.max_concurrent = val;
      invoke("save_settings", { settings: this.settings }).catch(() => {});
      invoke("update_concurrency", { count: val }).catch(() => {});
    });

    const resourceLevel = document.getElementById("resource-level") as HTMLInputElement;
    const levelLabels = ["低", "中", "高"];
    const levelValues = ["low", "medium", "high"];
    const initialLevel = levelValues.indexOf(this.settings.resource_level);
    resourceLevel.value = String(initialLevel >= 0 ? initialLevel : 1);
    document.getElementById("resource-level-val")!.textContent = levelLabels[parseInt(resourceLevel.value)];

    resourceLevel.addEventListener("input", () => {
      const idx = parseInt(resourceLevel.value);
      const label = levelLabels[idx];
      const value = levelValues[idx];
      document.getElementById("resource-level-val")!.textContent = label;
      this.settings.resource_level = value;
      invoke("update_resource_level", { level: value }).catch(() => {});
    });

    videoTemplate.addEventListener("input", () => this.updateCommandPreview());
    extraTemplate.addEventListener("input", () => this.updateCommandPreview());
    outputSuffix.addEventListener("input", () => this.updateCommandPreview());
    resourceLevel.addEventListener("input", () => this.updateCommandPreview());
    this.updateCommandPreview();

    document.getElementById("btn-browse-ffmpeg")!.addEventListener("click", async () => {
      const selected = await open({ multiple: false, filters: [{ name: "可执行文件", extensions: ["exe", "bat", "cmd"] }] });
      if (selected) {
        ffmpegPath.value = selected as string;
        this.updateFfmpegStatus();
      }
    });

    document.getElementById("btn-detect-encoders")!.addEventListener("click", () => this.detectEncoders());
    document.getElementById("btn-save-settings")!.addEventListener("click", () => this.save());
  }

  static async updateFfmpegStatus(): Promise<void> {
    const statusEl = document.getElementById("ffmpeg-status");
    if (!statusEl) return;
    const ffmpegPath = (document.getElementById("ffmpeg-path") as HTMLInputElement).value || null;
    try {
      const encoders = await invoke<EncoderInfo[]>("detect_encoders", { ffmpegPath });
      if (encoders.length > 0) {
        const path = ffmpegPath ?? "系统 PATH";
        statusEl.innerHTML = `<span style="color:var(--success);">✓ FFmpeg 已检测到</span> <span style="color:var(--text-secondary);font-size:11px;">(${path})</span>`;
      } else {
        statusEl.innerHTML = `<span style="color:var(--error);">✗ 未检测到可用编码器</span>`;
      }
    } catch (e) {
      statusEl.innerHTML = `<span style="color:var(--error);">✗ FFmpeg 未找到 (${e})</span>`;
    }
  }

  static async detectEncoders(): Promise<void> {
    const ffmpegPath = (document.getElementById("ffmpeg-path") as HTMLInputElement).value || null;
    try {
      this.encoders = await invoke<EncoderInfo[]>("detect_encoders", { ffmpegPath });
    } catch (e) {
      this.encoders = [];
      alert(`detect failed: ${e}`);
    }

    const list = document.getElementById("encoder-list")!;
    if (this.encoders.length === 0) {
      list.innerHTML = '<span style="color:var(--text-secondary);">未检测到编码器</span>';
      return;
    }
    list.innerHTML = this.encoders
      .map(
        (enc) => `
      <div class="encoder-item">
        <span class="dot ${enc.available ? "available" : "unavailable"}"></span>
        <span>${enc.name}</span>
        <span style="color:var(--text-secondary);font-size:11px;">${enc.encoder_type}</span>
        <span style="margin-left:auto;font-size:11px;color:${enc.available ? "var(--success)" : "var(--error)"}">${enc.available ? "✓" : "✗"}</span>
      </div>`
      )
      .join("");
  }

  static updateCommandPreview(): void {
    const el = document.getElementById("command-preview");
    if (!el) return;
    const videoTemplate = (document.getElementById("video-encode-template") as HTMLInputElement).value;
    const extraTemplate = (document.getElementById("extra-args-template") as HTMLInputElement).value;
    const suffix = (document.getElementById("output-suffix") as HTMLInputElement).value || "_HEVC";
    const resourceIdx = parseInt((document.getElementById("resource-level") as HTMLInputElement).value);
    const level = ["low", "medium", "high"][resourceIdx] || "medium";

    const encoder = "hevc_nvenc";
    const replace = (s: string) => s
      .replace(/\{encoder\}/g, encoder)
      .replace(/\{bitrate\}/g, "5000")
      .replace(/\{maxrate\}/g, "7500")
      .replace(/\{bufsize\}/g, "10000");

    const videoPart = replace(videoTemplate);
    const extraPart = replace(extraTemplate);

    let extra = "";
    if (level === "low") extra += " -threads 2";
    const preset = level === "low" ? "p1" : level === "high" ? "p7" : "p4";
    extra += ` -preset ${preset}`;

    el.textContent = `ffmpeg -hide_banner -y -i test.mp4 ${videoPart}${extra} ${extraPart} -progress pipe:1 test${suffix}.mp4`;
  }

  static async save(): Promise<void> {
    this.settings.ffmpeg_path = (document.getElementById("ffmpeg-path") as HTMLInputElement).value || null;
    this.settings.max_concurrent = parseInt((document.getElementById("max-concurrent") as HTMLInputElement).value);
    this.settings.output_suffix = (document.getElementById("output-suffix") as HTMLInputElement).value;
    this.settings.video_encode_template = (document.getElementById("video-encode-template") as HTMLInputElement).value;
    this.settings.extra_args_template = (document.getElementById("extra-args-template") as HTMLInputElement).value;
    const resourceIdx = parseInt((document.getElementById("resource-level") as HTMLInputElement).value);
    this.settings.resource_level = ["low", "medium", "high"][resourceIdx] || "medium";

    try {
      await invoke("save_settings", { settings: this.settings });
      alert("设置已保存");
    } catch (e) {
      alert(`save failed: ${e}`);
    }
  }
}

export { SettingsTab };
