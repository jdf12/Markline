#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Markline Voice Bridge - 本地语音合成桥接程序
================================================
Chrome MV3 扩展无法直接调用 edge-tts（基于 asyncio 的 Python 库）。
本程序在本地监听 HTTP 端口，接收插件的语音合成请求，调用 edge-tts 合成 MP3 音频流。

使用方法：
  1. 安装 Python 3.8+
  2. 安装依赖：pip install edge-tts aiohttp
  3. 命令行运行：python voice_bridge.py
  4. 程序监听 http://127.0.0.1:7822
  5. 在 Markline 设置页"语音"面板配置后即可朗读 MDI 窗口中的网页

安全说明：
  - 仅监听 127.0.0.1，不暴露到外网
  - 不持久化任何文本或音频（任务文件 30 分钟自动清理）
  - 日志中只记录文本长度和前 50 字摘要，不记录全文

日志说明：
  - 控制台实时输出（彩色高亮）
  - 自动写入日志文件 logs/voice_bridge_YYYY-MM-DD.log（按天滚动，保留 30 天）
  - 日志级别：INFO / WARNING / ERROR
  - 支持命令行参数：--log-level debug|info|warning|error

API:
  GET  /health            → 健康检查
  GET  /voices?locale=xx  → 获取可用语音列表（带内存缓存）
  POST /synthesize        → 同步合成（短文本），直接流式返回 audio/mpeg
  POST /synthesize-with-subtitles → 同步合成+字幕时间戳（混合流：音频+WordBoundary）
  POST /synthesize-async  → 异步合成长文本，返回 taskId
  GET  /stream/<taskId>   → 流式获取异步合成结果（支持 Range）
  DELETE /task/<taskId>   → 清理任务及临时文件
  OPTIONS *               → CORS 预检
"""

import json
import sys
import os
import io
import re
import time
import uuid
import struct
import asyncio
import argparse
import logging
import logging.handlers
import threading
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs
import datetime

# ===== 依赖检测 =====
try:
    import edge_tts
except ImportError:
    print("[FATAL] 未安装 edge-tts，请先执行: pip install edge-tts aiohttp")
    sys.exit(1)

# ===== 配置 =====
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 7822
VERSION = "1.0.0"

# 默认语音（中文晓晓）
DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"

# 任务缓存目录
CACHE_DIR_NAME = "voice_cache"

# 任务保留时长（秒）：30 分钟后自动清理
TASK_TTL_SECONDS = 30 * 60

# 异步任务最大合成时长（秒）：避免无限挂起
ASYNC_TIMEOUT_SECONDS = 120

# 同步合成文本上限（字符数）：超过则强制要求走异步
SYNC_TEXT_LIMIT = 3000

# 单次合成总文本上限（字符数）：防止超大请求拖垮服务
MAX_TEXT_LIMIT = 30000

# ===== 日志系统 =====
_LEVEL_MAP = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warning": logging.WARNING,
    "error": logging.ERROR,
}

_COLORS = {
    "DEBUG": "\033[90m",
    "INFO": "\033[36m",
    "WARNING": "\033[33m",
    "ERROR": "\033[31m",
    "RESET": "\033[0m",
}

# Windows 控制台兼容颜色
if sys.platform == "win32":
    try:
        os.system("")
    except Exception:
        pass


class ColoredFormatter(logging.Formatter):
    def __init__(self, use_color=True):
        super().__init__()
        self.use_color = use_color

    def format(self, record):
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        level = record.levelname
        msg = record.getMessage()
        if self.use_color:
            color = _COLORS.get(level, "")
            reset = _COLORS["RESET"]
            return f"[{ts}] {color}[{level:<7}]{reset} {msg}"
        return f"[{ts}] [{level:<7}] {msg}"


def _get_log_dir():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    log_dir = os.path.join(script_dir, "logs")
    if not os.path.exists(log_dir):
        try:
            os.makedirs(log_dir)
        except Exception:
            pass
    return log_dir


def setup_logger(level_name="info"):
    level = _LEVEL_MAP.get(level_name.lower(), logging.INFO)
    logger = logging.getLogger("voice_bridge")
    logger.setLevel(level)
    logger.handlers.clear()

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_handler.setFormatter(ColoredFormatter(use_color=True))
    logger.addHandler(console_handler)

    log_dir = _get_log_dir()
    log_file = os.path.join(log_dir, "voice_bridge.log")
    file_handler = logging.handlers.TimedRotatingFileHandler(
        log_file,
        when="midnight",
        interval=1,
        backupCount=30,
        encoding="utf-8"
    )
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(ColoredFormatter(use_color=False))
    logger.addHandler(file_handler)
    file_handler.suffix = "%Y-%m-%d"
    return logger


_logger = None


def log(level, msg, *args, **kwargs):
    global _logger
    if _logger is None:
        _logger = logging.getLogger("voice_bridge")
    getattr(_logger, level)(msg, *args, **kwargs)


# ===== 缓存目录与任务管理 =====
def _get_cache_dir():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    cache_dir = os.path.join(script_dir, CACHE_DIR_NAME)
    if not os.path.exists(cache_dir):
        try:
            os.makedirs(cache_dir)
        except Exception:
            pass
    return cache_dir


# 任务状态：{ taskId: { status, file_path, created_at, text_len, voice } }
# status: pending | ready | failed
_tasks = {}
_tasks_lock = threading.Lock()


def _create_task(text_len, voice):
    task_id = "voice-" + uuid.uuid4().hex[:16]
    file_path = os.path.join(_get_cache_dir(), f"{task_id}.mp3")
    with _tasks_lock:
        _tasks[task_id] = {
            "status": "pending",
            "file_path": file_path,
            "created_at": time.time(),
            "text_len": text_len,
            "voice": voice,
            "error": None,
        }
    return task_id


def _get_task(task_id):
    with _tasks_lock:
        return _tasks.get(task_id)


def _set_task_status(task_id, status, error=None):
    with _tasks_lock:
        t = _tasks.get(task_id)
        if t:
            t["status"] = status
            if error is not None:
                t["error"] = error


def _delete_task(task_id):
    with _tasks_lock:
        t = _tasks.pop(task_id, None)
    if t and os.path.exists(t["file_path"]):
        try:
            os.remove(t["file_path"])
        except Exception:
            pass


def _cleanup_expired_tasks():
    """清理过期任务（调用方在请求时顺手清理，避免单独线程）"""
    now = time.time()
    expired = []
    with _tasks_lock:
        for tid, t in list(_tasks.items()):
            if now - t["created_at"] > TASK_TTL_SECONDS:
                expired.append(tid)
                _tasks.pop(tid, None)
    for tid in expired:
        # 重新拿到 file_path（已从 _tasks 移除，按命名规则推算）
        fpath = os.path.join(_get_cache_dir(), f"{tid}.mp3")
        if os.path.exists(fpath):
            try:
                os.remove(fpath)
            except Exception:
                pass


# ===== 语音列表缓存 =====
_voices_cache = {}  # locale -> [voice_dict, ...]
_voices_cache_time = 0
_voices_lock = threading.Lock()
_VOICES_CACHE_TTL = 3600  # 1 小时


def _get_voices(locale=None):
    """同步接口：从缓存或调用 edge-tts 拿语音列表"""
    global _voices_cache_time
    now = time.time()
    with _voices_lock:
        need_refresh = (now - _voices_cache_time) > _VOICES_CACHE_TTL or not _voices_cache
    if need_refresh:
        try:
            all_voices = asyncio.run(edge_tts.list_voices())
            with _voices_lock:
                _voices_cache.clear()
                # 按 locale 分组
                for v in all_voices:
                    loc = v.get("Locale", "unknown")
                    _voices_cache.setdefault(loc, []).append(v)
                # 同时存一份 "all"
                _voices_cache["all"] = all_voices
                _voices_cache_time = now
            log("info", f"语音列表已刷新: 共 {len(all_voices)} 个语音")
        except Exception as e:
            log("error", f"获取语音列表失败: {e}")
            return []
    with _voices_lock:
        if locale and locale in _voices_cache:
            return _voices_cache[locale]
        return _voices_cache.get("all", [])


# ===== 文本预处理 =====
def _preprocess_text(text):
    """
    清理文本：去除多余空白、Markdown 残留、代码块标记。
    保留段落结构，便于 edge-tts 自然停顿。

    重要：edge-tts 通过 WebSocket 向微软服务端发送文本，服务端会解析 SSML。
    若文本中含有 <、>、& 等字符，会被误认为是 SSML 标签，导致 NoAudioReceived 错误。
    因此必须对这些字符进行转义或清除。
    """
    if not text:
        return ""
    # 去除代码块
    text = re.sub(r"```[\s\S]*?```", "（代码块）", text)
    text = re.sub(r"`[^`]+`", "", text)
    # 去除 Markdown 标题标记
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    # 去除图片/链接标记，保留文本
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    # 去除 HTML 标签残留
    text = re.sub(r"<[^>]+>", "", text)
    # 清除 SSML 特殊字符（关键修复：避免 edge-tts 误解析为 SSML 标签）
    # edge-tts 内部会构造 SSML，文本中的 < > & 会破坏 SSML 结构，导致服务端不返回音频
    text = text.replace("&", "和")
    text = text.replace("<", " ")
    text = text.replace(">", " ")
    # 清除其他可能导致问题的字符：零宽字符、BOM、控制字符（保留换行和空格）
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\ufeff]", "", text)
    # 合并多余空白
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ===== edge-tts 合成 =====
# NoAudioReceived 错误重试配置
RETRY_MAX = 2
RETRY_DELAY = 1.0  # 秒


def _synthesize_to_file(text, voice, rate, pitch, volume, output_path):
    """同步调用 edge-tts 合成到文件，返回 True/False。带重试机制。"""
    last_err = None
    for attempt in range(1, RETRY_MAX + 2):  # 首次 + 重试次数
        try:
            communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
            asyncio.run(communicate.save(output_path))
            if attempt > 1:
                log("info", f"第 {attempt} 次尝试合成成功")
            return True
        except Exception as e:
            last_err = e
            err_name = type(e).__name__
            log("warning", f"合成失败 (第 {attempt}/{RETRY_MAX + 1} 次): {err_name}: {e}")
            if attempt <= RETRY_MAX:
                time.sleep(RETRY_DELAY)
            else:
                log("error", f"edge-tts 合成最终失败（已重试 {RETRY_MAX} 次）: {e}")
                log("error", traceback.format_exc())
    return False


def _async_synthesize_worker(task_id, text, voice, rate, pitch, volume):
    """后台线程：异步合成并写入文件"""
    t = _get_task(task_id)
    if not t:
        return
    output_path = t["file_path"]
    log("info", f"异步合成开始: task={task_id} voice={voice} len={len(text)}")
    start_t = time.time()
    ok = _synthesize_to_file(text, voice, rate, pitch, volume, output_path)
    elapsed = int((time.time() - start_t) * 1000)
    if ok:
        _set_task_status(task_id, "ready")
        log("info", f"异步合成完成: task={task_id} (耗时 {elapsed}ms)")
    else:
        _set_task_status(task_id, "failed", error="edge_tts_failed")
        log("error", f"异步合成失败: task={task_id} (耗时 {elapsed}ms)")


# ===== HTTP Handler =====
class VoiceBridgeHandler(BaseHTTPRequestHandler):

    def _send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _send_cors_preflight(self):
        self.send_response(200)
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_OPTIONS(self):
        self._send_cors_preflight()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/health":
            log("debug", f"GET /health from {self.address_string()}")
            self._send_json(200, {
                "ok": True,
                "version": VERSION,
                "service": "markline-voice-bridge"
            })
            return

        if path == "/voices":
            locale = query.get("locale", [None])[0]
            log("debug", f"GET /voices locale={locale} from {self.address_string()}")
            voices = _get_voices(locale)
            # 精简字段
            simplified = []
            for v in voices:
                simplified.append({
                    "ShortName": v.get("ShortName", ""),
                    "Gender": v.get("Gender", ""),
                    "Locale": v.get("Locale", ""),
                    "FriendlyName": v.get("FriendlyName", ""),
                })
            self._send_json(200, {"ok": True, "voices": simplified, "count": len(simplified)})
            return

        if path.startswith("/stream/"):
            task_id = path[len("/stream/"):]
            self._handle_stream(task_id)
            return

        log("warning", f"GET {self.path} - 未知路径")
        self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/synthesize":
            self._handle_synthesize_sync()
            return

        if path == "/synthesize-with-subtitles":
            self._handle_synthesize_with_subtitles()
            return

        if path == "/synthesize-async":
            self._handle_synthesize_async()
            return

        log("warning", f"POST {self.path} - 未知路径")
        self._send_json(404, {"ok": False, "error": "not_found"})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/task/"):
            task_id = path[len("/task/"):]
            _delete_task(task_id)
            log("info", f"任务已清理: {task_id}")
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"ok": False, "error": "not_found"})

    # ----- 同步合成 -----
    def _handle_synthesize_sync(self):
        t0 = time.time()
        try:
            req = self._read_body()
            text = req.get("text", "")
            voice = req.get("voice") or DEFAULT_VOICE
            rate = req.get("rate", "+0%")
            pitch = req.get("pitch", "+0Hz")
            volume = req.get("volume", "+0%")

            log("info", f"━━━━━━━━━━ 同步合成请求 ━━━━━━━━━━")
            log("info", f"voice={voice} len={len(text)} rate={rate} pitch={pitch} volume={volume}")
            if text:
                preview = text[:50].replace("\n", " ")
                log("debug", f"文本预览: {preview}{'...' if len(text) > 50 else ''}")

            if not text:
                self._send_json(400, {"ok": False, "error": "empty_text"})
                return

            if len(text) > MAX_TEXT_LIMIT:
                self._send_json(400, {"ok": False, "error": f"text_too_long: max {MAX_TEXT_LIMIT}"})
                return

            if len(text) > SYNC_TEXT_LIMIT:
                self._send_json(400, {
                    "ok": False,
                    "error": f"text_exceeds_sync_limit: please use /synthesize-async (limit={SYNC_TEXT_LIMIT})"
                })
                return

            text = _preprocess_text(text)

            # 预处理后再次检查（文本可能全是 HTML 标签/代码块，清理后变空）
            if not text:
                log("warning", "预处理后文本为空（原文本可能全是 HTML 标签或代码块）")
                self._send_json(400, {"ok": False, "error": "empty_text_after_preprocess"})
                return

            log("info", f"预处理后长度: {len(text)}")
            if text:
                preview = text[:50].replace("\n", " ")
                log("debug", f"清理后文本预览: {preview}{'...' if len(text) > 50 else ''}")

            # 同步合成：chunked encoding 流式输出（边合成边发送，降低首字节延迟）
            # 带重试机制：先尝试获取第一个音频 chunk，失败则重试
            # 关键：响应头在获取到第一个 chunk 后才发送，失败时仍可返回 JSON 错误
            last_err = None
            headers_sent = False  # 跟踪响应头是否已发送（防止重试时重复发送）
            for attempt in range(1, RETRY_MAX + 2):  # 首次 + 重试次数
                try:
                    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)

                    async def _stream_to_client():
                        nonlocal headers_sent
                        gen = communicate.stream()
                        total = 0

                        # 先尝试获取第一个音频 chunk（不发送响应头）
                        # 如果 NoAudioReceived 发生在此处，响应头尚未发送，可返回 JSON 错误
                        first_chunk = None
                        async for chunk in gen:
                            if chunk["type"] == "audio":
                                first_chunk = chunk
                                break

                        if first_chunk is None:
                            raise RuntimeError("no_audio_chunk")

                        # 获取到第一个 chunk，发送响应头
                        self.send_response(200)
                        self.send_header("Content-Type", "audio/mpeg")
                        self.send_header("Transfer-Encoding", "chunked")
                        self.send_header("Cache-Control", "no-cache")
                        origin = self.headers.get("Origin", "*")
                        self.send_header("Access-Control-Allow-Origin", origin)
                        self.send_header("Access-Control-Expose-Headers", "Content-Length")
                        self.end_headers()
                        headers_sent = True

                        # 发送第一个 chunk
                        data = first_chunk["data"]
                        ttfb = int((time.time() - t0) * 1000)
                        log("info", f"首字节延迟 (TTFB): {ttfb}ms")
                        self.wfile.write(f"{len(data):X}\r\n".encode("ascii"))
                        self.wfile.write(data)
                        self.wfile.write(b"\r\n")
                        self.wfile.flush()
                        total += len(data)

                        # 继续遍历剩余的 chunk
                        async for chunk in gen:
                            if chunk["type"] == "audio":
                                data = chunk["data"]
                                self.wfile.write(f"{len(data):X}\r\n".encode("ascii"))
                                self.wfile.write(data)
                                self.wfile.write(b"\r\n")
                                self.wfile.flush()
                                total += len(data)

                        # 结束 chunk
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                        return total

                    total_bytes = asyncio.run(_stream_to_client())
                    elapsed = int((time.time() - t0) * 1000)
                    log("info", f"流式合成完成: {total_bytes} bytes (总耗时 {elapsed}ms)")
                    if attempt > 1:
                        log("info", f"第 {attempt} 次尝试合成成功")
                    log("info", f"━━━━━━━━━━ 同步合成成功 ━━━━━━━━━━")
                    last_err = None
                    break  # 成功，退出重试循环

                except Exception as e:
                    last_err = e
                    err_name = type(e).__name__
                    log("warning", f"流式合成失败 (第 {attempt}/{RETRY_MAX + 1} 次): {err_name}: {e}")
                    # 如果响应头已发送，不能重试（无法返回 JSON 错误）
                    if headers_sent:
                        log("error", "响应头已发送，无法重试，断开连接")
                        try:
                            self.wfile.write(b"0\r\n\r\n")
                            self.wfile.flush()
                        except Exception:
                            pass
                        last_err = None  # 避免后续再次尝试发送 JSON
                        break
                    if attempt <= RETRY_MAX:
                        time.sleep(RETRY_DELAY)
                    else:
                        log("error", f"流式合成最终失败（已重试 {RETRY_MAX} 次）: {e}")
                        log("error", traceback.format_exc())

            # 如果重试后仍失败且响应头未发送，返回 JSON 错误
            if last_err is not None:
                try:
                    self._send_json(200, {"ok": False, "error": f"synth_failed: {type(last_err).__name__}: {last_err}"})
                except Exception:
                    try:
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                    except Exception:
                        pass

        except json.JSONDecodeError as e:
            log("error", f"JSON 解析失败: {e}")
            self._send_json(400, {"ok": False, "error": f"invalid_json: {e}"})
        except Exception as e:
            log("error", f"同步合成异常: {e}")
            log("error", traceback.format_exc())
            try:
                self._send_json(200, {"ok": False, "error": str(e)})
            except Exception:
                pass

    # ----- 同步合成 + 字幕时间戳（混合流） -----
    def _handle_synthesize_with_subtitles(self):
        """
        同时输出音频流和 WordBoundary 字幕时间戳。
        使用自定义二进制分帧协议（在 HTTP chunked encoding 之上）：
          每帧结构: [1字节类型][4字节大端长度][N字节载荷]
          类型 A (0x41): 音频字节（MP3 data）
          类型 M (0x4D): 元数据 JSON {offset, duration, text}（WordBoundary 事件，时间戳单位 100ns）
          类型 E (0x45): 结束标记
        """
        t0 = time.time()
        try:
            req = self._read_body()
            text = req.get("text", "")
            voice = req.get("voice") or DEFAULT_VOICE
            rate = req.get("rate", "+0%")
            pitch = req.get("pitch", "+0Hz")
            volume = req.get("volume", "+0%")

            log("info", f"━━━━━━━━━━ 同步合成+字幕请求 ━━━━━━━━━━")
            log("info", f"voice={voice} len={len(text)} rate={rate}")

            if not text:
                self._send_json(400, {"ok": False, "error": "empty_text"})
                return

            if len(text) > MAX_TEXT_LIMIT:
                self._send_json(400, {"ok": False, "error": f"text_too_long: max {MAX_TEXT_LIMIT}"})
                return

            text = _preprocess_text(text)
            if not text:
                self._send_json(400, {"ok": False, "error": "empty_text_after_preprocess"})
                return

            log("info", f"预处理后长度: {len(text)}")

            last_err = None
            headers_sent = False
            for attempt in range(1, RETRY_MAX + 2):
                try:
                    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)

                    async def _stream_mixed():
                        nonlocal headers_sent
                        gen = communicate.stream()
                        total_audio = 0
                        word_count = 0

                        # 先尝试获取第一个音频 chunk，同时收集此前的 WordBoundary 事件
                        # edge-tts 的 WordBoundary 事件通常在音频数据之前到达
                        first_audio = None
                        pending_words = []
                        seen_types = set()  # 调试：记录见过的 chunk 类型
                        async for chunk in gen:
                            ctype = chunk.get("type", "")
                            seen_types.add(ctype)
                            if ctype == "audio":
                                first_audio = chunk
                                break
                            elif ctype == "WordBoundary":
                                pending_words.append(chunk)

                        if first_audio is None:
                            raise RuntimeError("no_audio_chunk")

                        log("debug", f"首音频前收集到 {len(pending_words)} 个 WordBoundary, 见过类型: {seen_types}")

                        # 发送响应头
                        self.send_response(200)
                        self.send_header("Content-Type", "application/x-multipart-streamed")
                        self.send_header("Transfer-Encoding", "chunked")
                        self.send_header("Cache-Control", "no-cache")
                        origin = self.headers.get("Origin", "*")
                        self.send_header("Access-Control-Allow-Origin", origin)
                        self.send_header("Access-Control-Expose-Headers", "Content-Length")
                        self.end_headers()
                        headers_sent = True

                        # 写入首音频前的 WordBoundary 事件
                        for w in pending_words:
                            meta = json.dumps({
                                "offset": w.get("offset", 0),
                                "duration": w.get("duration", 0),
                                "text": w.get("text", "")
                            }, ensure_ascii=False).encode("utf-8")
                            self._write_mixed_frame(b'M', meta)
                            word_count += 1

                        # 写入第一个音频帧
                        data = first_audio["data"]
                        ttfb = int((time.time() - t0) * 1000)
                        log("info", f"首字节延迟 (TTFB): {ttfb}ms")
                        self._write_mixed_frame(b'A', data)
                        total_audio += len(data)

                        # 继续遍历剩余 chunk
                        async for chunk in gen:
                            ctype = chunk.get("type", "")
                            if ctype == "audio":
                                self._write_mixed_frame(b'A', chunk["data"])
                                total_audio += len(chunk["data"])
                            elif ctype == "WordBoundary":
                                meta = json.dumps({
                                    "offset": chunk.get("offset", 0),
                                    "duration": chunk.get("duration", 0),
                                    "text": chunk.get("text", "")
                                }, ensure_ascii=False).encode("utf-8")
                                self._write_mixed_frame(b'M', meta)
                                word_count += 1

                        # 写入结束帧
                        self._write_mixed_frame(b'E', b'')
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                        log("info", f"混合流合成完成: {total_audio} bytes, {word_count} 词边界 (总耗时 {int((time.time()-t0)*1000)}ms)")
                        return total_audio

                    asyncio.run(_stream_mixed())
                    last_err = None
                    break

                except Exception as e:
                    last_err = e
                    err_name = type(e).__name__
                    log("warning", f"混合流合成失败 (第 {attempt}/{RETRY_MAX + 1} 次): {err_name}: {e}")
                    if headers_sent:
                        log("error", "响应头已发送，无法重试")
                        try:
                            self.wfile.write(b"0\r\n\r\n")
                            self.wfile.flush()
                        except Exception:
                            pass
                        last_err = None
                        break
                    if attempt <= RETRY_MAX:
                        time.sleep(RETRY_DELAY)
                    else:
                        log("error", f"混合流合成最终失败: {e}")
                        log("error", traceback.format_exc())

            if last_err is not None:
                try:
                    self._send_json(200, {"ok": False, "error": f"synth_failed: {type(last_err).__name__}: {last_err}"})
                except Exception:
                    try:
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                    except Exception:
                        pass

        except json.JSONDecodeError as e:
            log("error", f"JSON 解析失败: {e}")
            self._send_json(400, {"ok": False, "error": f"invalid_json: {e}"})
        except Exception as e:
            log("error", f"混合流合成异常: {e}")
            log("error", traceback.format_exc())
            try:
                self._send_json(200, {"ok": False, "error": str(e)})
            except Exception:
                pass

    def _write_mixed_frame(self, frame_type, payload):
        """
        写入一个混合流帧（在 HTTP chunked encoding 之上）
        帧结构: [1字节类型][4字节大端长度][N字节载荷]
        然后包装为 HTTP chunk: {hex长度}\r\n{帧数据}\r\n
        """
        frame = struct.pack('>BI', frame_type[0], len(payload)) + payload
        chunk_header = f"{len(frame):X}\r\n".encode("ascii")
        self.wfile.write(chunk_header)
        self.wfile.write(frame)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    # ----- 异步合成 -----
    def _handle_synthesize_async(self):
        t0 = time.time()
        try:
            req = self._read_body()
            text = req.get("text", "")
            voice = req.get("voice") or DEFAULT_VOICE
            rate = req.get("rate", "+0%")
            pitch = req.get("pitch", "+0Hz")
            volume = req.get("volume", "+0%")

            log("info", f"━━━━━━━━━━ 异步合成请求 ━━━━━━━━━━")
            log("info", f"voice={voice} len={len(text)} rate={rate}")

            if not text:
                self._send_json(400, {"ok": False, "error": "empty_text"})
                return

            if len(text) > MAX_TEXT_LIMIT:
                self._send_json(400, {"ok": False, "error": f"text_too_long: max {MAX_TEXT_LIMIT}"})
                return

            text = _preprocess_text(text)

            # 预处理后再次检查
            if not text:
                log("warning", "预处理后文本为空（原文本可能全是 HTML 标签或代码块）")
                self._send_json(400, {"ok": False, "error": "empty_text_after_preprocess"})
                return

            log("info", f"预处理后长度: {len(text)}")

            # 创建任务
            task_id = _create_task(len(text), voice)

            # 启动后台线程合成
            worker = threading.Thread(
                target=_async_synthesize_worker,
                args=(task_id, text, voice, rate, pitch, volume),
                daemon=True
            )
            worker.start()

            # 顺手清理过期任务
            _cleanup_expired_tasks()

            log("info", f"异步任务已创建: {task_id}")
            self._send_json(200, {"ok": True, "taskId": task_id})

        except json.JSONDecodeError as e:
            log("error", f"JSON 解析失败: {e}")
            self._send_json(400, {"ok": False, "error": f"invalid_json: {e}"})
        except Exception as e:
            log("error", f"异步合成请求异常: {e}")
            log("error", traceback.format_exc())
            self._send_json(200, {"ok": False, "error": str(e)})

    # ----- 流式获取异步任务结果 -----
    def _handle_stream(self, task_id):
        t = _get_task(task_id)
        if not t:
            self._send_json(404, {"ok": False, "error": "task_not_found"})
            return

        # 等待任务完成（轮询，最多等 60 秒）
        waited = 0
        while t["status"] == "pending":
            if waited >= 60:
                self._send_json(425, {"ok": False, "error": "task_still_pending"})
                return
            time.sleep(0.5)
            waited += 0.5
            t = _get_task(task_id)
            if not t:
                self._send_json(404, {"ok": False, "error": "task_not_found"})
                return

        if t["status"] == "failed":
            self._send_json(200, {"ok": False, "error": t.get("error") or "synth_failed"})
            return

        file_path = t["file_path"]
        if not os.path.exists(file_path):
            self._send_json(404, {"ok": False, "error": "file_missing"})
            return

        # 处理 Range 请求
        file_size = os.path.getsize(file_path)
        range_header = self.headers.get("Range")
        start = 0
        end = file_size - 1

        if range_header:
            # 解析 "bytes=start-end"
            m = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if m:
                s = m.group(1)
                e = m.group(2)
                if s:
                    start = int(s)
                if e:
                    end = int(e)
                if end >= file_size:
                    end = file_size - 1

        content_length = end - start + 1
        status_code = 206 if range_header else 200

        self.send_response(status_code)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(content_length))
        self.send_header("Accept-Ranges", "bytes")
        if range_header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length")
        self.end_headers()

        # 流式写入文件内容
        try:
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except Exception as e:
            log("error", f"流式输出失败: task={task_id} err={e}")

        log("debug", f"流式输出完成: task={task_id} bytes={content_length}")

    def log_message(self, format, *args):
        """覆盖默认 HTTP 访问日志"""
        pass


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


# 关键：设置 HTTP/1.1 协议版本，否则默认 HTTP/1.0 不支持 Transfer-Encoding: chunked
# 也不支持 keep-alive，导致 fetch 无法正确解析响应体
VoiceBridgeHandler.protocol_version = "HTTP/1.1"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Markline Voice Bridge - 本地语音合成桥接程序",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python voice_bridge.py                     # 默认 info 级别
  python voice_bridge.py --log-level debug   # 调试模式
  python voice_bridge.py --port 8080         # 自定义端口
        """
    )
    parser.add_argument(
        "--log-level",
        choices=["debug", "info", "warning", "error"],
        default="info",
        help="日志级别（默认: info）"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=LISTEN_PORT,
        help=f"监听端口（默认: {LISTEN_PORT}）"
    )
    return parser.parse_args()


def main():
    global _logger, LISTEN_PORT

    args = parse_args()
    LISTEN_PORT = args.port

    _logger = setup_logger(args.log_level)
    cache_dir = _get_cache_dir()

    print(f"""
╔══════════════════════════════════════════════╗
║   Markline Voice Bridge v{VERSION}              ║
║   本地 edge-tts 语音合成桥接服务              ║
╚══════════════════════════════════════════════╝

  监听地址: http://{LISTEN_HOST}:{LISTEN_PORT}
  健康检查: http://{LISTEN_HOST}:{LISTEN_PORT}/health
  日志级别: {args.log_level.upper()}
  日志目录: {_get_log_dir()}
  缓存目录: {cache_dir}

  依赖:
    - edge-tts (pip install edge-tts)
    - aiohttp  (pip install aiohttp)

  使用方法:
    1. 保持本程序运行
    2. 在 Markline 独立窗口的 MDI 窗口点击朗读按钮
    3. 在设置页"语音"面板配置默认音色

  按 Ctrl+C 退出
""")
    log("info", f"Markline Voice Bridge v{VERSION} 启动")
    log("info", f"监听地址: http://{LISTEN_HOST}:{LISTEN_PORT}")
    log("info", f"日志级别: {args.log_level.upper()}")

    try:
        server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), VoiceBridgeHandler)
        log("info", "服务已启动，等待请求...")
        server.serve_forever()
    except KeyboardInterrupt:
        log("info", "收到 Ctrl+C，正在关闭...")
        try:
            server.shutdown()
        except Exception:
            pass
        log("info", "服务已关闭")
    except OSError as e:
        if "Address already in use" in str(e) or "10048" in str(e):
            log("error", f"端口 {LISTEN_PORT} 已被占用，请用 --port 指定其他端口")
        else:
            log("error", f"启动失败: {e}")
        sys.exit(1)
    except Exception as e:
        log("error", f"启动失败: {e}")
        log("error", traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
