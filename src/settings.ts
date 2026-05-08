import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface Settings {
  ffmpeg_path: string | null;
  max_concurrent: number;
  output_suffix: string;
  preferred_encoder_order: string[];
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
          <label>输出后缀</label>
          <input type="text" id="output-suffix" value="_HEVC" style="max-width:150px;" />
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

    // CPU suggestion
    const cores = navigator.hardwareConcurrency ?? 4;
    const suggested = Math.min(cores, 8);
    document.getElementById("cpu-suggestion")!.textContent = String(suggested);

    maxConcurrent.addEventListener("input", () => {
      document.getElementById("concurrent-val")!.textContent = maxConcurrent.value;
    });

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

  static async save(): Promise<void> {
    this.settings.ffmpeg_path = (document.getElementById("ffmpeg-path") as HTMLInputElement).value || null;
    this.settings.max_concurrent = parseInt((document.getElementById("max-concurrent") as HTMLInputElement).value);
    this.settings.output_suffix = (document.getElementById("output-suffix") as HTMLInputElement).value;

    try {
      await invoke("save_settings", { settings: this.settings });
      alert("设置已保存");
    } catch (e) {
      alert(`save failed: ${e}`);
    }
  }
}

export { SettingsTab };
