#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Markline SMTP Bridge - 本地桥接程序
====================================
Chrome MV3 扩展不支持 chrome.sockets.tcp，无法直连 SMTP 服务器。
本程序在本地监听 HTTP 端口，接收插件的发邮件请求，通过 SMTP 协议转发到邮件服务器。

使用方法：
  1. 安装 Python 3.7+（Windows/Mac/Linux 均可）
  2. 命令行运行：python smtp_bridge.py
  3. 程序监听 http://127.0.0.1:7821
  4. 在 Markline 设置页选 SMTP 模式，配置服务商后即可发送

安全说明：
  - 仅监听 127.0.0.1，不暴露到外网
  - 授权码由插件加密存储，调用时临时解密通过 HTTP 传给本程序
  - 本程序不持久化任何凭证，发送完即丢弃
  - 日志文件中不会记录授权码原文（仅记录长度）

日志说明：
  - 控制台实时输出（彩色高亮）
  - 自动写入日志文件 logs/bridge_YYYY-MM-DD.log（按天滚动）
  - 日志级别：INFO（常规流程）/ WARNING（可恢复异常）/ ERROR（发送失败）
  - 支持命令行参数：--log-level debug|info|warning|error 控制输出级别

API:
  GET  /health        → 健康检查
  POST /send          → 发送邮件
       body: {
         host: "smtp.163.com",
         port: 465,
         tls: "ssl" | "starttls" | "none",
         username: "user@163.com",
         password: "授权码",
         from: "user@163.com",
         fromName: "Markline",
         to: "recipient@example.com",
         subject: "邮件主题",
         html: "<p>邮件内容</p>"
       }
       response: { ok: true, id: "..." } | { ok: false, error: "..." }
"""

import json
import sys
import os
import traceback
import argparse
import logging
import logging.handlers
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formataddr, formatdate, make_msgid
import datetime

# ===== 配置 =====
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 7821
VERSION = "1.1.0"

# ===== 日志系统 =====
# 脱敏标记：授权码/密码字段在日志中只记录长度，不记录原文
_SENSITIVE_FIELDS = {"password", "apiKey", "authCode"}

# 日志级别映射
_LEVEL_MAP = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warning": logging.WARNING,
    "error": logging.ERROR,
}

# ANSI 颜色码（控制台彩色输出）
_COLORS = {
    "DEBUG": "\033[90m",     # 灰
    "INFO": "\033[36m",      # 青
    "WARNING": "\033[33m",   # 黄
    "ERROR": "\033[31m",     # 红
    "RESET": "\033[0m",
}

# Windows 控制台兼容颜色（启用 ANSI 转义）
if sys.platform == "win32":
    try:
        os.system("")  # 激活 ANSI 转义支持
    except Exception:
        pass


class ColoredFormatter(logging.Formatter):
    """带时间戳和颜色的日志格式化器"""

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


def setup_logger(level_name="info"):
    """初始化日志系统：控制台 + 文件双输出"""
    level = _LEVEL_MAP.get(level_name.lower(), logging.INFO)

    logger = logging.getLogger("bridge")
    logger.setLevel(level)
    # 清除已有 handler（避免重复初始化）
    logger.handlers.clear()

    # ===== 控制台 handler（彩色） =====
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_handler.setFormatter(ColoredFormatter(use_color=True))
    logger.addHandler(console_handler)

    # ===== 文件 handler（按天滚动） =====
    log_dir = _get_log_dir()
    log_file = os.path.join(log_dir, "bridge.log")
    file_handler = logging.handlers.TimedRotatingFileHandler(
        log_file,
        when="midnight",       # 每天午夜滚动
        interval=1,
        backupCount=30,        # 保留 30 天日志
        encoding="utf-8"
    )
    file_handler.setLevel(logging.DEBUG)  # 文件记录全部级别
    file_handler.setFormatter(ColoredFormatter(use_color=False))
    logger.addHandler(file_handler)

    # 文件滚动时自动加日期后缀
    file_handler.suffix = "%Y-%m-%d"

    return logger


def _get_log_dir():
    """获取日志目录路径（bridge/logs/），不存在则创建"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    log_dir = os.path.join(script_dir, "logs")
    if not os.path.exists(log_dir):
        try:
            os.makedirs(log_dir)
        except Exception:
            pass
    return log_dir


# 全局 logger（在 main 中初始化）
_logger = None


def log(level, msg, *args, **kwargs):
    """统一日志入口"""
    global _logger
    if _logger is None:
        _logger = logging.getLogger("bridge")
    getattr(_logger, level)(msg, *args, **kwargs)


def _sanitize_request(req):
    """脱敏请求体：敏感字段只记录长度，不记录原文"""
    safe = {}
    for k, v in req.items():
        if k in _SENSITIVE_FIELDS:
            safe[k] = f"<len={len(str(v))}>"
        else:
            safe[k] = v
    return safe


class BridgeHandler(BaseHTTPRequestHandler):
    """HTTP 请求处理器"""

    def _send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # 允许 Chrome 扩展跨域请求
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self):
        """处理 CORS 预检请求"""
        self._send_json(200, {"ok": True})

    def do_GET(self):
        if self.path == "/health":
            log("debug", f"GET /health from {self.address_string()}")
            self._send_json(200, {
                "ok": True,
                "version": VERSION,
                "service": "markline-smtp-bridge"
            })
        else:
            log("warning", f"GET {self.path} - 未知路径")
            self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        if self.path != "/send":
            log("warning", f"POST {self.path} - 未知路径")
            self._send_json(404, {"ok": False, "error": "not_found"})
            return

        import time
        t0 = time.time()
        server = None  # SMTP 连接实例，用于 finally 清理
        try:
            req = self._read_body()

            # 记录请求（脱敏）
            log("info", f"━━━━━━━━━━ 发信请求开始 ━━━━━━━━━━")
            log("info", f"收到发信请求 from {self.address_string()}")
            log("debug", f"请求参数: {json.dumps(_sanitize_request(req), ensure_ascii=False)}")

            # 必填字段校验
            required = ["host", "port", "from", "to", "subject"]
            for field in required:
                if not req.get(field):
                    log("error", f"字段校验失败: 缺少 {field}")
                    self._send_json(400, {"ok": False, "error": f"missing_field:{field}"})
                    return

            host = req["host"]
            port = int(req["port"])
            tls = req.get("tls", "ssl")
            username = req.get("username", "")
            password = req.get("password", "")
            from_addr = req["from"]
            from_name = req.get("fromName", "")
            to_addr = req["to"]
            subject = req["subject"]
            html = req.get("html", "")

            log("info", f"发件人: {username or from_addr} → 收件人: {to_addr}")
            log("info", f"SMTP 服务器: {host}:{port} (TLS={tls})")
            log("info", f"邮件主题: {subject}")
            if username:
                log("info", f"登录账号: {username} (授权码长度={len(password)})")

            # 构造 MIME 邮件
            msg = MIMEMultipart("alternative")
            msg["From"] = formataddr((from_name, from_addr)) if from_name else from_addr
            msg["To"] = to_addr
            msg["Subject"] = subject
            msg["Date"] = formatdate(localtime=True)
            msg["Message-ID"] = make_msgid(domain="markline.local")

            # HTML 内容
            msg.attach(MIMEText(html, "html", "utf-8"))
            log("debug", f"MIME 邮件构造完成，HTML 长度={len(html)}")

            # 连接 SMTP 服务器并发送
            log("info", f"正在连接 SMTP 服务器 {host}:{port} ...")
            connect_t0 = time.time()
            if tls == "ssl":
                # 隐式 SSL（465 端口）
                server = smtplib.SMTP_SSL(host, port, timeout=20)
            else:
                # 明文或 STARTTLS（587 端口）
                server = smtplib.SMTP(host, port, timeout=20)
                server.ehlo()
                if tls == "starttls":
                    log("debug", "启动 STARTTLS 升级...")
                    server.starttls()
                    server.ehlo()
            connect_ms = int((time.time() - connect_t0) * 1000)
            log("info", f"SMTP 服务器连接成功 (耗时 {connect_ms}ms)")

            # 启用 SMTP 调试日志（debug 级别时）
            if _logger and _logger.isEnabledFor(logging.DEBUG):
                server.set_debuglevel(1)

            # 登录鉴权
            if username and password:
                log("info", f"正在登录: {username} ...")
                login_t0 = time.time()
                try:
                    server.login(username, password)
                except smtplib.SMTPAuthenticationError as e:
                    login_ms = int((time.time() - login_t0) * 1000)
                    log("error", f"认证失败 (耗时 {login_ms}ms): {e}")
                    self._send_json(200, {"ok": False, "error": f"smtp_auth_failed: {e}"})
                    return  # finally 会关闭连接
                login_ms = int((time.time() - login_t0) * 1000)
                log("info", f"登录成功 (耗时 {login_ms}ms)")

            # 发送邮件
            log("info", f"正在发送邮件: {from_addr} → {to_addr}")
            send_t0 = time.time()
            server.sendmail(from_addr, [to_addr], msg.as_string())
            send_ms = int((time.time() - send_t0) * 1000)
            log("info", f"邮件发送完成 (耗时 {send_ms}ms)")

            # 正常退出：发送 QUIT 命令
            try:
                server.quit()
            except Exception:
                pass
            server = None  # 标记已正常关闭，finally 不再处理

            elapsed = int((time.time() - t0) * 1000)
            log("info", f"━━━━━━━━━━ 发信请求成功 (总耗时 {elapsed}ms) ━━━━━━━━━━")

            msg_id = f"smtp-{int(time.time() * 1000)}"
            self._send_json(200, {"ok": True, "id": msg_id})

        except smtplib.SMTPConnectError as e:
            elapsed = int((time.time() - t0) * 1000)
            log("error", f"SMTP 连接失败 (耗时 {elapsed}ms): {e}")
            log("error", f"请检查: 1) 网络 2) {host}:{port} 是否可达 3) 防火墙是否拦截")
            self._send_json(200, {"ok": False, "error": f"smtp_connect_failed: {e}"})
        except smtplib.SMTPException as e:
            elapsed = int((time.time() - t0) * 1000)
            log("error", f"SMTP 协议错误 (耗时 {elapsed}ms): {e}")
            self._send_json(200, {"ok": False, "error": f"smtp_error: {e}"})
        except ConnectionRefusedError as e:
            elapsed = int((time.time() - t0) * 1000)
            log("error", f"连接被拒 (耗时 {elapsed}ms): {e}")
            log("error", f"请检查 SMTP 服务器地址和端口是否正确: {host}:{port}")
            self._send_json(200, {"ok": False, "error": "smtp_connect_refused"})
        except json.JSONDecodeError as e:
            log("error", f"请求体 JSON 解析失败: {e}")
            self._send_json(400, {"ok": False, "error": f"invalid_json: {e}"})
        except Exception as e:
            elapsed = int((time.time() - t0) * 1000)
            log("error", f"未知异常 (耗时 {elapsed}ms): {e}")
            log("error", traceback.format_exc())
            self._send_json(200, {"ok": False, "error": str(e)})
        finally:
            # 确保异常情况下 SMTP 连接被强制关闭
            # 注意：不用 server.quit()，因为服务器可能已断开，quit 会卡住等待响应
            # server.close() 只关闭本地 socket，不发送命令，不会阻塞
            if server is not None:
                log("debug", "强制关闭 SMTP 连接（异常清理）")
                try:
                    server.close()
                except Exception as e:
                    log("debug", f"关闭连接时异常（可忽略）: {e}")

    def log_message(self, format, *args):
        """覆盖默认的 HTTP 访问日志（已在 do_GET/do_POST 中详细记录）"""
        pass


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    """多线程 HTTP 服务器，避免单请求阻塞"""
    daemon_threads = True


def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser(
        description="Markline SMTP Bridge - 本地 SMTP 桥接程序",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python smtp_bridge.py                     # 默认 info 级别
  python smtp_bridge.py --log-level debug   # 调试模式（输出 SMTP 协议细节）
  python smtp_bridge.py --port 8080         # 自定义端口
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

    # 初始化日志系统
    _logger = setup_logger(args.log_level)
    log_dir = _get_log_dir()

    print(f"""
╔══════════════════════════════════════════════╗
║   Markline SMTP Bridge v{VERSION}               ║
║   本地 SMTP 桥接服务                          ║
╚══════════════════════════════════════════════╝

  监听地址: http://{LISTEN_HOST}:{LISTEN_PORT}
  状态检查: http://{LISTEN_HOST}:{LISTEN_PORT}/health
  日志级别: {args.log_level.upper()}
  日志目录: {log_dir}

  使用方法:
    1. 保持本程序运行
    2. 在 Markline 设置页选择 SMTP 模式
    3. 配置邮箱服务商和授权码
    4. 点击"测试发送邮件"

  按 Ctrl+C 退出
""")
    log("info", f"Markline SMTP Bridge v{VERSION} 启动")
    log("info", f"监听地址: http://{LISTEN_HOST}:{LISTEN_PORT}")
    log("info", f"日志级别: {args.log_level.upper()}")
    log("info", f"日志文件: {os.path.join(log_dir, 'bridge.log')}")

    try:
        server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), BridgeHandler)
        log("info", f"服务已启动，等待请求...")
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
            log("error", f"端口 {LISTEN_PORT} 已被占用，请先关闭占用进程或用 --port 指定其他端口")
        else:
            log("error", f"启动失败: {e}")
        sys.exit(1)
    except Exception as e:
        log("error", f"启动失败: {e}")
        log("error", traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
