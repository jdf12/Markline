<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<div align="center">

# ⏱️ Markline — 书签时间线

**在可视化时间线上查看、搜索、整理你的 Chrome 书签。**
一键搜索、同步与整理。

[![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4?logo=chromewebstore&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Version](https://img.shields.io/badge/version-1.0.0-34A853)](./manifest.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)
[![Languages](https://img.shields.io/badge/i18n-EN%20%7C%20简体中文-EA4335)](#语言支持)

</div>

---

Markline（取自 **Mark** + **Book** + time**line**）是一款 Manifest V3 的 Chrome 扩展，它将书签管理器重新构想为一个**可视化时间线**。在原生管理器缺失的层面做了大量增强：带命令面板的模糊搜索、规则引擎 + 可选 AI 自动打标签、知识图谱、失效链接检查、间隔重复复习、基于 Mozilla Readability 的悬浮预览，以及统计与健康分仪表盘。

无需构建、无依赖、无框架 —— 纯原生 JS / HTML / CSS。直接加载为未打包扩展即可使用。

---

## ✨ 功能特性

### 📅 时间线浏览
- 按日期分组（今天 / 昨天 / N 天前 / 月-日）的可视化时间线，带垂直轨道和每条书签的 favicon。
- 排序模式：**最新 · 最旧 · 最热 · 最冷**（按点击次数）。
- **热度配色** —— 背景从淡橙色渐变到深 "Inferno"（暖 → 热 → 燃 → 烈 → 焰），依据访问频率。
- 视图标签：**全部 / 已置顶 / 重复项**。
- 重复项检测，URL 归一化（自动剔除 UTM/追踪参数与尾部斜杠）。

### 🔍 搜索
- 模糊子序列 + 子串匹配，带权重打分（标题 100 · 标签 60 · URL 40 · 域名 30 · 文件夹 20）。
- 匹配高亮、最近搜索历史、可键盘导航的关键词建议下拉框。
- **命令面板**（`Ctrl/⌘+Shift+E`）模糊搜索。
- **地址栏（Omnibox）** —— 在地址栏输入 `mk <关键词>` 即可搜索。

### 🏷️ 智能打标签（核心特性）
- 多信号规则引擎，内置 **200+ 域名规则**，覆盖开发、文档、设计、学习、视频、阅读、新闻、购物等。
- 综合域名规则、关键词规则、停用词、TF-IDF 统计信号与文件夹路径信号。
- **主动学习队列** —— 低置信度书签会浮出，一键确认/修改/忽略，并反哺训练引擎。
- 动态规则（域名规则、关键词规则、停用词、已学习映射）可在设置中编辑。

### 🤖 可选 AI 集成
- 支持供应商：**智谱 GLM-4-Flash（免费）、DeepSeek、Google Gemini、OpenAI、阿里通义、自定义**。
- 兼容 OpenAI Chat Completions、Anthropic Messages、Google Gemini，或全 URL 端点。
- **隐私优先** —— 仅发送标题与 URL；页面内容**绝不**发送给 AI。API Key 本地存储，绝不同步。

### 🔗 失效书签检查器
- HEAD → GET，带重试、指数退避 + 抖动。
- 结果分类为 **正常 / 失效（4xx、404、DNS）/ 警告（超时、网络）**。
- 可配置并发、超时、重试、退避，以及定时检查（每日/每周/每月）。
- 可选自动删除失效书签，带桌面通知。

### 🧠 知识图谱 + 间隔重复
- Cytoscape.js 可视化；按域名 / 标签 / 文件夹聚类；按域名、标签、相似标题连边。
- 缩放、重新布局、搜索、导出控件，背景为粒子画布。
- **间隔重复复习**（再来 / 困难 / 良好 / 简单），用于回顾已收藏的文章。

### 📊 统计与健康分
- 总数、标签、独立域名、文件夹、收藏趋势（按日/周/月）。
- 图表：热门标签、热门域名、活跃时段、文件夹分布、自动标签准确率趋势。
- 一个可收藏的**健康分**（最多收藏 50 条，每个分数每天限一次）。
- 导出报告为 **CSV** 或可打印的 **PDF**。

### 🪶 链接预览
- 悬停任意书签 → 紧凑预览卡片（图片 + 标题 + 描述 + 站点）。
- 基于 Mozilla **Readability**；提取 `og:image`、`twitter:image`、首张有意义图片、视频封面与 apple-touch-icon 兜底。
- 会话缓存 + 持久化缓存，可配置 TTL 与最大条数。

### 🗂️ 书签管理
- 一键**同步** Chrome 原生书签树（重新同步时保留你的标签 / 置顶 / 点击数）。
- 编辑弹窗：标题、URL、标签（带自动补全）、文件夹选择器（树形）、智能文件夹建议。
- 置顶/取消置顶，批量选择/置顶/打标签/删除。
- **最近删除**，带墓碑记录和可配置保留期（7/15/30/60 天）。

### ⚡ 快速收藏
- **快速书签**（`Alt+Shift+D`）—— 一键完成，自动建议文件夹 + 自动打标签。
- 右键上下文菜单：**"将此页加入书签" / "移除此页书签"**。
- 保存时桌面通知。

### 💾 导入 / 导出
- **JSON**（完整数据）与 **Netscape HTML**（浏览器兼容）两种格式。

### 📖 独立阅读窗口
- 一个专注的**阅读窗口**（从弹窗右上角 ⋮ 菜单 → "打开面板" 打开），把 Markline 变成沉浸式阅读器。
- **MDI 桌面** —— 在一个窗口内打开多个网页为可拖动悬浮子窗口，并排阅读多篇文章。
- 每个子窗口都带**朗读**按钮、**收藏**按钮与悬停**预览**卡片。
- 内置 **RSS** 标签页，无需离开窗口即可阅读已订阅的资讯。

### 🔊 语音朗读（文字转语音）
- 通过 **edge-tts**（微软免费神经网络语音）把任意 MDI 网页朗读出来。
- 由一个轻量**本地桥接程序**（`bridge/voice_bridge.py`，`127.0.0.1:7822`）提供支持 —— 唯一的对外流量是发给微软 TTS 服务，其余数据绝不离开本机。
- **真正的流式播放**：音频在合成完成前就开始播放（MediaSource API），并配合 edge-tts 的 `WordBoundary` 时间戳生成**逐字字幕**轨道，随朗读实时滚动。
- 基于 Web Audio API 分析节点的**波形可视化**。
- 可配置**音色、语速、音调、音量**；自动用 Readability 提取正文，跳过导航与广告。
- 长文会分段并**异步合成**，且**预合成**下一段以保证播放连贯。
- 在**设置 → 语音**中配置。需先运行本地语音桥接（见[本地桥接程序](#本地桥接程序可选)）。

### 📰 RSS 订阅与阅读
- 订阅 RSS/Atom 源，在独立窗口的 RSS 面板或弹窗中阅读。
- 按可配置间隔轮询；**未读角标**、标记已读、**加星**、**存为书签**（自动打标签）。
- 在访问的页面上**自动发现** feed（右键菜单 / 当前页检测）。
- 可选的**新文章桌面通知**。
- 针对网络不可达的源提供**代理兜底**（rss2json 风格或原始 XML 代理）。
- 在**设置 → RSS** 中配置。

### 📧 邮箱推送（RSS → 收件箱）
- 把 RSS 新文章推送到你的邮箱，再也不错过更新。
- 两种策略：**即时**（新闻出现即按源发一封）或**每日摘要**（在设定时间合并为一封）。
- **服务商**：HTTP API（Resend / SendGrid / Mailgun / 自定义）或经由本地桥接的 **SMTP**（`bridge/smtp_bridge.py`，`127.0.0.1:7821`）—— 支持 Gmail、QQ、163、Outlook 等。
- **AI 每日早报**（可选）：配置 AI 供应商后，每日摘要会由所选模型重写为分类的科技资讯早报（要点 + 主题分组）。
- **静默时段**、跨源**去重**、关键词**包含/排除**过滤。
- API Key 与 SMTP 授权码**加密存储**，仅在发送时于内存中解密。
- 在**设置 → 推送**中配置。

---

## 🖥️ 本地桥接程序（可选）

Markline 本身是纯客户端，但受 MV3 Service Worker 限制（无法运行 Python、无法直连 TCP 套接字），有两个功能需要本地小程序辅助：

| 桥接程序 | 端口 | 用途 | 启动命令 |
| --- | --- | --- | --- |
| `bridge/voice_bridge.py` | `127.0.0.1:7822` | edge-tts 语音合成 | `pip install -r bridge/requirements-voice.txt && python bridge/voice_bridge.py` |
| `bridge/smtp_bridge.py` | `127.0.0.1:7821` | 邮件推送的 SMTP 中继 | `python bridge/smtp_bridge.py` |

两者都**只监听 `127.0.0.1`** —— 绝不会暴露到外网。桥接程序不持久化任何文本、音频或凭证；SMTP 授权码仅在发送期间暂存于内存。

环境要求：语音桥接需 Python 3.8+，SMTP 桥接需 Python 3.7+；语音桥接另需 `edge-tts` + `aiohttp`，无其他依赖。

---

## 🚀 安装方式

无需构建，也没有 `package.json`。

1. **下载 / 克隆** 本仓库。
2. 在 Chrome（或任意 Chromium 浏览器）中打开 `chrome://extensions`。
3. 开启右上角的**开发者模式**。
4. 点击 **"加载已解压的扩展程序"**，选择 `chrome-bookmark-timeline` 文件夹。
5. 工具栏出现 Markline 图标 —— 建议固定以便访问。

> 要求 Chrome 102+（Manifest V3、`chrome.scripting`、`chrome.alarms`）。

> **语音与邮箱推送（可选）：** 这两项功能需要本地 Python 桥接程序。一行命令即可启动，详见[本地桥接程序](#本地桥接程序可选)。

---

## ⌨️ 快捷键

| 操作 | 默认 | Mac |
| --- | --- | --- |
| 打开命令面板 | `Ctrl+Shift+E` | `⌘+Shift+E` |
| 打开弹窗 | `Alt+Shift+B` | `Alt+Shift+B` |
| 快速收藏当前页 | `Alt+Shift+D` | `Alt+Shift+D` |
| 地址栏搜索 | `mk <关键词>` | `mk <关键词>` |

可在 `chrome://extensions/shortcuts` 中自定义。

---

## 🗺️ 项目结构

```
chrome-bookmark-timeline/
├── manifest.json              # MV3 清单
├── rules/
│   └── frame_allow.json       # declarativeNetRequest：允许在 MDI 中嵌入页面
├── icons/                     # 16 / 48 / 128 PNG
├── _locales/
│   ├── en/messages.json       # 英文
│   └── zh_CN/messages.json    # 简体中文
├── bridge/                    # 本地 Python 桥接程序（可选）
│   ├── voice_bridge.py        # edge-tts 语音合成服务（127.0.0.1:7822）
│   ├── smtp_bridge.py         # SMTP 中继服务（127.0.0.1:7821）
│   └── requirements-voice.txt # edge-tts + aiohttp
├── background/
│   ├── background.js          # Service Worker（同步、增删改、检查、闹钟、Omnibox、RSS、推送）
│   ├── voice-bridge-client.js # 语音桥接 HTTP 客户端
│   ├── push-channel.js        # RSS → 邮箱推送（即时 / 每日，AI 早报）
│   ├── feed-fetcher.js        # RSS 轮询调度
│   ├── feed-notifier.js       # 新文章通知
│   ├── feed-discover.js       # 访问页面时自动发现 feed
│   ├── preview-extractor.js   # Readability 预览抓取与缓存
│   └── vendor/
│       ├── Readability.js      # Mozilla Readability
│       └── cytoscape.min.js   # 图谱库
├── content/
│   └── content-extractor.js   # 按需内容提取（ISOLATED 世界）
├── shared/
│   ├── i18n.js                # 运行时 i18n（en + zh_CN，可实时切换）
│   ├── smart-tagger.js        # 规则引擎标签器（200+ 规则）
│   ├── ai-tagger.js           # 可选云端 AI 层
│   ├── ai-logger.js           # AI 分类日志
│   ├── bookmark-stats.js      # 统计与健康分
│   ├── simple-charts.js       # 手写 SVG 图表
│   ├── rss-parser.js          # RSS/Atom 解析
│   ├── feed-store.js          # RSS 源/文章存储
│   └── voice-store.js         # 语音设置存储
└── pages/
    ├── popup/                 # 主时间线弹窗
    ├── settings/              # 多面板设置页（含 RSS / 推送 / 语音）
    ├── checker/               # 失效书签检查页
    ├── graph/                # 知识图谱 + 复习
    └── standalone/            # 独立阅读窗口（MDI + RSS + 语音播放器）
```

---

## 🔐 权限说明

| 权限 | 用途 |
| --- | --- |
| `bookmarks` | 读取并同步你的 Chrome 书签树 |
| `storage` | 持久化书签、标签、设置、缓存 |
| `contextMenus` | 右键"加入书签"菜单 |
| `activeTab` | 抓取当前页用于快速收藏 |
| `alarms` | 定时失效链接检查 |
| `tabs` | 打开书签、监听导航以统计点击数 |
| `history` | 补充点击数统计 |
| `notifications` | 保存/检查的桌面通知 |
| `scripting` | 注入 Readability 用于预览与打标签 |
| `declarativeNetRequest` | 移除 `X-Frame-Options`/CSP，使页面可在 MDI 阅读窗口中加载 |
| `<all_urls>`（host） | 在任意站点抓取预览、检查链接、轮询 RSS 源 |

所有数据都**本地**保存在你的设备上。除非你显式启用并配置 AI 供应商，否则不会上传任何内容 —— 即使启用，也仅发送标题与 URL。

---

## <a name="语言支持"></a>🌍 语言支持

| 语言 | 代码 | 状态 |
| --- | --- | --- |
| English | `en` | 默认 |
| 简体中文 | `zh_CN` | 完整 |

显示语言可在**设置 → 外观**中实时切换（系统 / English / 简体中文）—— 无需重新加载。

---

## 🛠️ 技术栈

- **Chrome 扩展** —— Manifest V3，Service Worker 后台
- **原生 JavaScript**（ES2020+），HTML5，CSS3 设计令牌
- **Vendored 库**（无 npm）：
  - [Mozilla Readability](https://github.com/mozilla/readability) —— 文章提取
  - [Cytoscape.js](https://js.cytoscape.org/) —— 知识图谱
- **自研模块** —— i18n、smart-tagger、ai-tagger、ai-logger、bookmark-stats、simple-charts
- **可选 AI 供应商** —— 智谱 GLM-4-Flash、DeepSeek、Google Gemini、OpenAI、阿里通义、自定义
- **本地桥接程序**（可选 Python 小程序，除 `edge-tts`/`aiohttp` 外无需其他依赖）：
  - `bridge/voice_bridge.py` —— edge-tts 神经网络语音合成（文字转语音）
  - `bridge/smtp_bridge.py` —— 邮件推送的 SMTP 中继

---

## 🧪 开发调试

无测试套件，也无打包器。二次开发步骤：

1. 按上文[安装方式](#-安装方式)加载为未打包扩展。
2. 编辑 `chrome-bookmark-timeline/` 下任意文件。
3. 进入 `chrome://extensions`，点击 Markline 卡片上的**重新加载** ↻ 图标。
4. 通过 **"检查视图：service worker"** 链接检查后台脚本，查看 `console.*` 日志。

> 小贴士：开发时把 `chrome://extensions` 标签页留着，方便一键重载。

---

## 📦 发布 / 打包

要打包一个无需 CRX 的 sideload ZIP：

1. 压缩 `chrome-bookmark-timeline/` 的内容（包含 `manifest.json` 的文件夹应作为顶层，或直接压缩其内容）。
2. 分发 `.zip`。用户解压后通过"加载已解压的扩展程序"加载，或通过企业策略部署。

若提交至 Chrome 应用商店，通过 [开发者控制台](https://chrome.google.com/webstore/devconsole/) 上传同一 zip 即可。

---

## 🗒️ 隐私

- 所有书签数据、标签、设置与缓存均本地存储于 `chrome.storage.local`。
- 本扩展**不**收集任何分析或遥测数据。
- **AI 功能完全可选。** 启用时，仅向所选供应商发送书签**标题与 URL** —— 绝不发送页面内容。API Key 本地存储，绝不同步。
- **语音朗读**会把你选择朗读的页面文本，经由本地 `127.0.0.1` 上的 `voice_bridge.py` 发送给微软 edge-tts 服务。桥接程序不持久化任何内容 —— 文本与音频都不会写入磁盘。
- **邮箱推送（SMTP）**通过本地 `127.0.0.1` 上的 `smtp_bridge.py` 中转邮件；SMTP 凭证加密存储，仅在发送期间暂存于内存。
- Readability 提取**在本地浏览器内**完成，用于打标签和生成预览；提取的文本不会离开你的设备，除非你自行粘贴到别处。

---

## <a name="license"></a>📄 许可证

本项目基于 **MIT 协议**发布。详见 [LICENSE](./LICENSE)。

Vendored 库保留各自许可证：
- `Readability.js` —— Apache-2.0（Mozilla）
- `cytoscape.min.js` —— MIT（Cytoscape.js）

---

<div align="center">

**Markline** —— 给你的书签一条时间线。⏱️

用原生 JS 与 ☕ 制作。

</div>
