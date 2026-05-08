import { invoke } from "@tauri-apps/api/core";

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

class RulesTab {
  static rules: EncodeRule[] = [];

  static render(): string {
    return `
      <div class="toolbar">
        <span style="color:var(--text-secondary);font-size:12px;">规则按顺序匹配，第一条命中即停止</span>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th style="width:30px;"><input type="checkbox" id="rules-select-all" /></th>
              <th>分辨率</th>
              <th>码率阈值 (Kbps)</th>
              <th>目标编码</th>
              <th>目标码率 (Kbps)</th>
              <th>编码器</th>
              <th>maxrate 倍率</th>
              <th>bufsize 倍率</th>
            </tr>
          </thead>
          <tbody id="rules-tbody"></tbody>
        </table>
      </div>
      <div class="toolbar" style="margin-top:16px;">
        <button class="btn btn-secondary" id="btn-add-rule">+ 添加规则</button>
        <button class="btn btn-danger btn-sm" id="btn-delete-rules">删除选中</button>
      </div>
    `;
  }

  static async init(): Promise<void> {
    try {
      this.rules = await invoke<EncodeRule[]>("load_rules");
    } catch (e) {
      console.error("load rules failed:", e);
    }
    this.renderTable();

    document.getElementById("btn-add-rule")!.addEventListener("click", () => this.addRule());
    document.getElementById("btn-delete-rules")!.addEventListener("click", () => this.deleteSelected());
    document.getElementById("rules-select-all")!.addEventListener("change", (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      document.querySelectorAll<HTMLInputElement>(".rule-checkbox").forEach((cb) => {
        cb.checked = checked;
      });
    });
  }

  static renderTable(): void {
    const tbody = document.getElementById("rules-tbody")!;
    let html = "";
    this.rules.forEach((rule) => {
      const res = rule.resolution;
      let resVal = "";
      if ("P720" in res) resVal = "720p";
      else if ("P1080" in res) resVal = "1080p";
      else if ("P2160" in res) resVal = "2160p";
      else if ("Custom" in res) resVal = `${res.Custom.width}x${res.Custom.height}`;

      const enc = rule.preferred_encoder;
      let encVal = "自动";
      if ("Specific" in enc) encVal = enc.Specific;

      html += `<tr>
        <td><input type="checkbox" class="rule-checkbox" data-id="${rule.id}" /></td>
        <td>
          <select class="rule-select" data-id="${rule.id}" data-field="resolution">
            <option value="720p" ${resVal === "720p" ? "selected" : ""}>720p</option>
            <option value="1080p" ${resVal === "1080p" ? "selected" : ""}>1080p</option>
            <option value="2160p" ${resVal === "2160p" ? "selected" : ""}>2160p</option>
            <option value="custom" ${resVal.includes("x") ? "selected" : ""}>自定义</option>
          </select>
        </td>
        <td><input type="number" class="rule-input" data-id="${rule.id}" data-field="bitrate_threshold_kbps" value="${rule.bitrate_threshold_kbps}" /></td>
        <td><input type="text" class="rule-input" data-id="${rule.id}" data-field="target_codec" value="${rule.target_codec}" /></td>
        <td><input type="number" class="rule-input" data-id="${rule.id}" data-field="target_bitrate_kbps" value="${rule.target_bitrate_kbps}" /></td>
        <td>
          <select class="rule-select" data-id="${rule.id}" data-field="preferred_encoder">
            <option value="auto" ${"Auto" in enc ? "selected" : ""}>自动</option>
            <option value="hevc_nvenc" ${encVal === "hevc_nvenc" ? "selected" : ""}>hevc_nvenc</option>
            <option value="hevc_qsv" ${encVal === "hevc_qsv" ? "selected" : ""}>hevc_qsv</option>
            <option value="hevc_amf" ${encVal === "hevc_amf" ? "selected" : ""}>hevc_amf</option>
            <option value="libx265" ${encVal === "libx265" ? "selected" : ""}>libx265</option>
          </select>
        </td>
        <td><input type="number" step="0.1" class="rule-input" data-id="${rule.id}" data-field="maxrate_multiplier" value="${rule.maxrate_multiplier}" style="width:60px;" /></td>
        <td><input type="number" step="0.1" class="rule-input" data-id="${rule.id}" data-field="bufsize_multiplier" value="${rule.bufsize_multiplier}" style="width:60px;" /></td>
      </tr>`;
    });
    tbody.innerHTML = html;

    // Bind change handlers
    tbody.querySelectorAll("input, select").forEach((el) => {
      el.addEventListener("change", () => this.onFieldChange(el as HTMLElement));
    });
  }

  static onFieldChange(el: HTMLElement): void {
    const id = el.dataset.id!;
    const field = el.dataset.field!;
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return;

    if (el instanceof HTMLSelectElement) {
      const val = el.value;
      if (field === "resolution") {
        if (val === "720p") rule.resolution = { P720: null };
        else if (val === "1080p") rule.resolution = { P1080: null };
        else if (val === "2160p") rule.resolution = { P2160: null };
        else if (val === "custom") {
          const w = parseInt(prompt("宽度?", "1920") ?? "1920");
          const h = parseInt(prompt("高度?", "1080") ?? "1080");
          rule.resolution = { Custom: { width: w, height: h } };
          this.renderTable();
          return;
        }
      } else if (field === "preferred_encoder") {
        rule.preferred_encoder = val === "auto" ? { Auto: null } : { Specific: val };
      }
    } else if (el instanceof HTMLInputElement) {
      const numFields = ["bitrate_threshold_kbps", "target_bitrate_kbps", "maxrate_multiplier", "bufsize_multiplier"];
      if (numFields.includes(field)) {
        (rule as any)[field] = parseFloat(el.value) || 0;
      } else {
        (rule as any)[field] = el.value;
      }
    }

    this.saveRules();
  }

  static addRule(): void {
    const newRule: EncodeRule = {
      id: crypto.randomUUID(),
      resolution: { P1080: null },
      bitrate_threshold_kbps: 5000,
      target_codec: "hevc",
      target_bitrate_kbps: 4000,
      preferred_encoder: { Auto: null },
      maxrate_multiplier: 1.5,
      bufsize_multiplier: 2.0,
    };
    this.rules.push(newRule);
    this.renderTable();
    this.saveRules();
  }

  static deleteSelected(): void {
    const checked = document.querySelectorAll<HTMLInputElement>(".rule-checkbox:checked");
    const ids = new Set(Array.from(checked).map((cb) => cb.dataset.id));
    this.rules = this.rules.filter((r) => !ids.has(r.id));
    this.renderTable();
    this.saveRules();
  }

  static async saveRules(): Promise<void> {
    try {
      await invoke("save_rules", { rules: this.rules });
    } catch (e) {
      console.error("save rules failed:", e);
    }
  }
}

export { RulesTab };
