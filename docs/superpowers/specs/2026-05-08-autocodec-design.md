# AutoCodec — FFmpeg GUI 编码工具设计

## Context

面向半技术用户分发的 Windows 桌面视频编码工具。用户选择文件夹后自动扫描视频，根据可配置的编码规则（分辨率+码率阈值）批量转码为 HEVC VBR 格式，降低文件体积。外部依赖 FFmpeg，用户自行安装。

## 技术栈

- Tauri v2（Rust 后端 + WebView 前端）
- 前端：Vanilla TypeScript + CSS，无框架
- 外部依赖：ffmpeg/ffprobe（从系统 PATH 检测或用户手动指定）
- 异步运行时：tokio

## 架构

```
Frontend (Vanilla TS/CSS)
  ├── Tab 1: 扫描与队列
  ├── Tab 2: 编码规则
  └── Tab 3: 设置
        │ Tauri Commands / Events
Rust Backend
  ├── scanner.rs      — 文件递归扫描 + ffprobe 解析
  ├── encoder.rs      — ffmpeg 进程管理 + 进度追踪
  ├── scheduler.rs    — tokio semaphore 并发调度
  ├── rules.rs        — 规则 CRUD + 匹配逻辑
  ├── detector.rs     — 本机编码器检测
  ├── ffmpeg_cmd.rs   — 按编码器构建命令行参数
  └── models.rs       — 数据结构
```

数据流：选文件夹 → 递归扫描视频 → ffprobe 获取元数据 → 规则匹配 → 加入编码队列 → ffmpeg 并发编码 → 进度实时推送前端。

## 界面设计

### Tab 1：扫描与队列

- 顶部：文件夹路径 + [选择文件夹] 按钮
- 表格列：文件名 | 分辨率 | 码率 | 编码格式 | 状态
- 状态：待转 / 编码中 / 已完成 / 失败 / 跳过
- 编码中的行展开显示：进度条 + 百分比 + fps + 剩余时间 + 编码参数摘要
- 底部：匹配规则摘要 + 文件统计 + [开始编码] [取消]

### Tab 2：编码规则

- 可编辑规则表，列：分辨率 | 码率阈值 | 目标编码 | 目标码率 | 编码器 | maxrate 倍率 | bufsize 倍率
- 分辨率下拉：720p / 1080p / 2160p / 自定义
- 编码器下拉：自动 / 手动选择具体编码器
- 底部：[+添加规则] [删除选中]
- 规则按列表顺序匹配，第一条命中即停止

### Tab 3：设置

- FFmpeg 路径（可浏览选择，默认从 PATH 自动检测）
- 并发数滑块（1-8，显示机器建议值）
- 本机可用编码器列表（名称 + 类型 + 可用状态 ✓/✗）
- 输出文件后缀输入框
- [检测编码器] [保存设置]

## 数据模型

```rust
struct VideoInfo {
    path: PathBuf,
    filename: String,
    width: u32,
    height: u32,
    bitrate_kbps: u64,
    codec: String,
    container: String,
}

struct EncodeRule {
    id: String,
    resolution: ResolutionThreshold,    // P720 / P1080 / P2160 / Custom
    bitrate_threshold_kbps: u64,
    target_codec: String,
    target_bitrate_kbps: u64,
    preferred_encoder: EncoderChoice,    // Auto / Specific(name)
    maxrate_multiplier: f64,             // 默认 1.5
    bufsize_multiplier: f64,             // 默认 2.0
}

struct EncodeTask {
    video: VideoInfo,
    rule: EncodeRule,
    encoder: String,
    status: TaskStatus,
    progress: f64,
    fps: f64,
    eta_seconds: u64,
}
```

## 规则匹配逻辑

对每个视频：
1. 根据 width×height 确定分辨率档位
2. 按顺序遍历规则表，匹配第一条满足：分辨率匹配 + 当前码率 > 阈值 + 当前编码 != 目标编码
3. 匹配 → 加入编码队列；无匹配 → 标记跳过

## VBR 编码策略

目标：总体平均码率符合规则要求，允许复杂场景上浮。

ffmpeg 命令模板：
```
ffmpeg -i <input> -c:v <encoder> <encoder_params> -b:v <bitrate>k -maxrate:v <bitrate*maxrate_mul>k -bufsize:v <bitrate*bufsize_mul>k -c:a copy -map 0 -progress pipe:1 <output>
```

按编码器适配参数：
- **NVENC**: `-rc vbr -b:v X -maxrate:v Y -bufsize:v Z`
- **QSV**: `-look_ahead 1 -b:v X -maxrate:v Y`
- **AMF**: `-rc vbr_peak -b:v X -maxrate:v Y -bufsize:v Z`
- **libx265**: `-b:v X -maxrate:v Y -bufsize:v Z` (ABR)

编码器自动选择优先级：NVENC > QSV > AMF > libx265（用户可在设置中调整）。

## 并发与进度

- tokio semaphore 控制 `max_concurrent`（默认 1，范围 1-8）
- 每个 ffmpeg 进程独立 tokio task，通过 `-progress pipe:1` 获取结构化输出
- 解析 `out_time_us`/总时长 → 百分比；`fps` → 编码速度；推算 ETA
- 通过 Tauri `emit` 推送事件到前端：ProgressChanged / TaskStarted / TaskCompleted / TaskFailed / QueueProgress

## 错误处理

- ffmpeg 异常退出 → 捕获 stderr 末尾作为错误信息，标记失败
- 失败不阻塞队列，继续下一个
- 支持单个任务重试
- 全局取消：终止所有 ffmpeg 子进程

## 输出文件

- 同目录输出，文件名加后缀（默认 `_HEVC`）
- 例：`video.mkv` → `video_HEVC.mkv`

## 持久化

Tauri app data 目录下两个 JSON 文件：

**settings.json**: ffmpeg_path, max_concurrent, output_suffix, preferred_encoder_order

**rules.json**: 默认包含两组规则（1080p >3.5M → HEVC 3.4M；2160p >8.8M → HEVC 8.5M），用户可增删改。

## 项目结构

```
autocodec/
├── src-tauri/
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs / lib.rs
│       ├── scanner.rs
│       ├── encoder.rs
│       ├── scheduler.rs
│       ├── rules.rs
│       ├── detector.rs
│       ├── ffmpeg_cmd.rs
│       └── models.rs
├── src/
│   ├── main.ts
│   ├── app.ts
│   ├── scan-queue.ts
│   ├── rules.ts
│   ├── settings.ts
│   └── styles.css
├── index.html
├── package.json
├── tsconfig.json
└── tauri.conf.json
```
