#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LayerDeck - 透過PNG リアルタイム重ね合わせプレビュー

パーツごとに別キャンバスで描いた透過PNGを、フォルダに書き出すだけで
自動的に重ね合わせてプレビューするためのローカルツール。
Python 標準ライブラリのみで動作する（pip install 不要）。

大きな絵（A2/350dpi = 5787x8185px など）を原寸で拡大しても軽いように、
各PNGはブラウザ側の Web Worker が「タイル」に切り分けて保持する。
このサーバはディスクにキャッシュを作らない。空き物理メモリだけを実測して
返し、ブラウザ側がタイルの保持量をそれに合わせて自動調整する。
"""
from __future__ import annotations

import argparse
import re
import shutil
import json
import mimetypes
import os
import socket
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

APP_DIR = Path(__file__).resolve().parent
IMAGE_EXTS = {".png", ".webp", ".jpg", ".jpeg", ".gif", ".bmp"}
PROJECT_NAME = "layerdeck.project.json"
EXPORT_DIR = "_export"
# アプリ全体の設定（デスクトップ版では %APPDATA%\com.layerdeck.desktop\settings.json）。開発用は手元に置く
SETTINGS_FILE = APP_DIR / ".dev-settings.json"
# 履歴（デスクトップ版では %LOCALAPPDATA%\com.layerdeck.desktop\history）。開発用は手元に置く
HIST_ROOT = APP_DIR / ".dev-history"
_HIST_OK = re.compile(r"^[A-Za-z0-9._/-]+$")


def hist_path(rel):
    """履歴の中の場所。外へ出られないようにする"""
    if not rel or rel.startswith("/") or ".." in rel or not _HIST_OK.match(rel):
        return None
    return HIST_ROOT / rel


def dir_size(p):
    total = 0
    for root, _dirs, files in os.walk(p):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total

UI_DIR = APP_DIR / "ui"
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/backend.js": ("backend.js", "text/javascript; charset=utf-8"),
    "/tiler.js": ("tiler.js", "text/javascript; charset=utf-8"),
    "/edger.js": ("edger.js", "text/javascript; charset=utf-8"),
    "/differ.js": ("differ.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/licenses.txt": ("licenses.txt", "text/plain; charset=utf-8"),
}

_lock = threading.Lock()
_watch_dir = None  # type: Path | None


# ---------------------------------------------------------------------
# 監視フォルダ
# ---------------------------------------------------------------------
def set_dir(p):
    global _watch_dir
    with _lock:
        _watch_dir = Path(p).resolve() if p else None
        return _watch_dir


def get_dir():
    with _lock:
        return _watch_dir


def list_images(d):
    """監視フォルダ直下の画像を (name, mtime, size) で返す。名前順。"""
    out = []
    try:
        entries = list(os.scandir(d))
    except OSError:
        return []
    for e in entries:
        try:
            if not e.is_file():
                continue
            if Path(e.name).suffix.lower() not in IMAGE_EXTS:
                continue
            st = e.stat()
        except OSError:
            continue
        out.append({
            "name": e.name,
            "mtime": int(st.st_mtime_ns // 1_000_000),
            "size": st.st_size,
        })
    out.sort(key=lambda x: x["name"].lower())
    return out


# ---------------------------------------------------------------------
# 空き物理メモリの実測（タイルキャッシュ量の自動調整に使う）
# ---------------------------------------------------------------------
def mem_status():
    """{'total': bytes, 'avail': bytes} を返す。取得できなければ None。"""
    if os.name == "nt":
        try:
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            m = MEMORYSTATUSEX()
            m.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
                return {"total": int(m.ullTotalPhys), "avail": int(m.ullAvailPhys)}
        except Exception:
            pass
    else:
        try:  # Linux
            info = {}
            for line in Path("/proc/meminfo").read_text().splitlines():
                k, _, v = line.partition(":")
                info[k] = int(v.strip().split()[0]) * 1024
            if "MemTotal" in info:
                avail = info.get("MemAvailable", info.get("MemFree", 0))
                return {"total": info["MemTotal"], "avail": avail}
        except Exception:
            pass
        try:  # macOS
            total = int(subprocess.run(["sysctl", "-n", "hw.memsize"],
                                       capture_output=True, text=True).stdout.strip())
            return {"total": total, "avail": total // 2}
        except Exception:
            pass
    return None


# ---------------------------------------------------------------------
# フォルダ選択ダイアログ
# ---------------------------------------------------------------------
def pick_folder(initial):
    """別プロセスで tkinter のダイアログを出す（tkinter はメインスレッド必須のため）。"""
    code = (
        "import sys, tkinter as tk\n"
        "from tkinter import filedialog\n"
        "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)\n"
        "init = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None\n"
        "p = filedialog.askdirectory(title='パーツPNGの入ったフォルダを選択', initialdir=init)\n"
        "r.destroy()\n"
        "sys.stdout.write(p or '')\n"
    )
    try:
        r = subprocess.run(
            [sys.executable, "-c", code, initial or ""],
            capture_output=True, text=True, encoding="utf-8", timeout=600,
        )
        return (r.stdout or "").strip() or None
    except Exception:
        return None


# ---------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "LayerDeck/2.0"
    protocol_version = "HTTP/1.1"

    # ---- helpers ----------------------------------------------------
    def _send(self, code, body=b"", ctype="application/json; charset=utf-8", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _err(self, msg, code=400):
        self._json({"ok": False, "error": msg}, code)

    def _body(self, limit=None):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return b""
        if limit and n > limit:
            return b""
        buf = bytearray()
        while len(buf) < n:
            chunk = self.rfile.read(min(1 << 20, n - len(buf)))
            if not chunk:
                break
            buf += chunk
        return bytes(buf)

    def _safe_file(self, name):
        """監視フォルダ直下のファイルだけを許可（パストラバーサル対策）。"""
        d = get_dir()
        if not d or not name:
            return None
        if name != os.path.basename(name) or name in (".", ".."):
            return None
        try:
            p = (d / name).resolve()
            if p.parent != d or not p.is_file():
                return None
        except OSError:
            return None
        return p

    def _read_project(self):
        d = get_dir()
        if not d:
            return None
        f = d / PROJECT_NAME
        if not f.is_file():
            return None
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            return None

    def log_message(self, fmt, *args):
        pass  # アクセスログは出さない

    # ---- GET --------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = u.path

        if path in STATIC:
            fn, ctype = STATIC[path]
            f = UI_DIR / fn
            if not f.is_file():
                return self._err("missing " + fn, 404)
            return self._send(200, f.read_bytes(), ctype, {"Cache-Control": "no-store"})

        if path == "/api/state":
            d = get_dir()
            return self._json({
                "ok": True,
                "dir": str(d) if d else None,
                "files": list_images(d) if d else [],
                "project": self._read_project(),
                "mem": mem_status(),
            })

        if path == "/api/files":
            d = get_dir()
            if not d:
                return self._json({"ok": True, "dir": None, "files": []})
            return self._json({"ok": True, "dir": str(d), "files": list_images(d)})

        if path == "/api/mem":
            return self._json({"ok": True, "mem": mem_status()})

        if path == "/api/hist/read":
            p = hist_path((q.get("rel") or [""])[0])
            if not p or not p.is_file():
                # 無いのは普通のこと（初めて開いたフォルダなど）。エラー扱いにしない
                self.send_response(204)
                self.end_headers()
                return
            data = p.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return

        if path == "/api/hist/list":
            HIST_ROOT.mkdir(exist_ok=True)
            dirs = [{"id": d.name, "bytes": dir_size(d)} for d in HIST_ROOT.iterdir() if d.is_dir()]
            return self._json({"ok": True, "dirs": dirs})

        if path == "/api/hist/stats":
            HIST_ROOT.mkdir(exist_ok=True)
            return self._json({"ok": True, "used": dir_size(HIST_ROOT),
                               "free": shutil.disk_usage(HIST_ROOT).free})

        if path == "/api/settings":
            try:
                settings = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                settings = None
            return self._json({"ok": True, "settings": settings})

        if path == "/file":
            name = (q.get("name") or [""])[0]
            p = self._safe_file(name)
            if not p:
                return self._err("not found", 404)
            ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
            try:
                data = p.read_bytes()
            except OSError as e:
                return self._err(str(e), 503)
            # URL に ?v=<mtime>_<size> を付けているので長期キャッシュしてよい
            return self._send(200, data, ctype,
                              {"Cache-Control": "public, max-age=31536000, immutable"})

        return self._err("not found", 404)

    def do_HEAD(self):
        self.do_GET()

    # ---- POST -------------------------------------------------------
    def do_POST(self):
        u = urlparse(self.path)
        path = u.path
        q = parse_qs(u.query)

        if path in ("/api/hist/write", "/api/hist/remove"):
            p = hist_path((q.get("rel") or [""])[0])
            if not p:
                return self._err("bad path")
            try:
                if path == "/api/hist/write":
                    body = self._body()
                    p.parent.mkdir(parents=True, exist_ok=True)
                    tmp = p.with_suffix(".tmp")
                    tmp.write_bytes(body)
                    os.replace(tmp, p)
                elif p.is_dir():
                    shutil.rmtree(p)
                elif p.exists():
                    p.unlink()
            except OSError as e:
                return self._err(str(e), 500)
            return self._json({"ok": True})

        if path == "/api/settings":
            try:
                body = self._body().decode("utf-8")
                json.loads(body)
            except Exception:
                return self._err("bad json")
            tmp = SETTINGS_FILE.with_suffix(".tmp")
            try:
                tmp.write_text(body, encoding="utf-8")
                os.replace(tmp, SETTINGS_FILE)
            except OSError as e:
                return self._err(str(e), 500)
            return self._json({"ok": True})

        if path == "/api/pick":
            cur = get_dir()
            chosen = pick_folder(str(cur) if cur else None)
            if not chosen:
                return self._json({"ok": False, "cancelled": True})
            d = set_dir(chosen)
            return self._json({"ok": True, "dir": str(d), "files": list_images(d),
                               "project": self._read_project(), "mem": mem_status()})

        if path == "/api/setdir":
            try:
                body = json.loads(self._body() or b"{}")
            except Exception:
                return self._err("bad json")
            p = Path(str(body.get("dir", ""))).expanduser()
            if not p.is_dir():
                return self._err("フォルダが見つかりません: %s" % p)
            d = set_dir(p)
            return self._json({"ok": True, "dir": str(d), "files": list_images(d),
                               "project": self._read_project(), "mem": mem_status()})

        if path == "/api/project":
            d = get_dir()
            if not d:
                return self._err("フォルダ未選択")
            # サーバーを別のフォルダで起動し直したとき、前から開いたままの古い画面が
            # 自分の設定を新しいフォルダへ上書きしてしまう（実際に起きた）。画面が見ている
            # フォルダと食い違ったら断る。
            sent = self.headers.get("X-Layerdeck-Dir")
            if sent and Path(unquote(sent)).resolve() != d:
                return self._err("別のフォルダを開いていた画面からの保存なので止めました。画面を読み込み直してください", 409)
            try:
                body = self._body().decode("utf-8")
                json.loads(body)
            except Exception:
                return self._err("bad json")
            tmp = d / (PROJECT_NAME + ".tmp")
            try:
                tmp.write_text(body, encoding="utf-8")
                os.replace(tmp, d / PROJECT_NAME)
            except OSError as e:
                return self._err(str(e), 500)
            return self._json({"ok": True})

        if path == "/api/export":
            d = get_dir()
            if not d:
                return self._err("フォルダ未選択")
            name = os.path.basename(self.headers.get("X-Layerdeck-Name") or "") or "composite.png"
            data = self._body()
            if not data:
                return self._err("空のデータ")
            out = d / EXPORT_DIR
            try:
                out.mkdir(exist_ok=True)
                dest = out / name
                dest.write_bytes(data)
            except OSError as e:
                return self._err(str(e), 500)
            return self._json({"ok": True, "path": str(dest), "size": len(data)})

        if path == "/api/reveal":
            d = get_dir()
            if not d:
                return self._err("フォルダ未選択")
            try:
                body = json.loads(self._body() or b"{}")
            except Exception:
                body = {}
            target = d / str(body["sub"]) if body.get("sub") else d
            if not target.exists():
                target = d
            try:
                os.startfile(str(target))  # Windows のみ
            except Exception as e:
                return self._err(str(e), 500)
            return self._json({"ok": True})

        return self._err("not found", 404)


def free_port(start, tries=40):
    for p in range(start, start + tries):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SystemExit("空きポートが見つかりませんでした")


def main():
    ap = argparse.ArgumentParser(description="LayerDeck - 透過PNG重ね合わせプレビュー")
    ap.add_argument("dir", nargs="?", help="監視するフォルダ（省略時はブラウザ側で選択）")
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()

    if a.dir:
        p = Path(a.dir).expanduser()
        if not p.is_dir():
            raise SystemExit("フォルダが見つかりません: %s" % p)
        set_dir(p)

    port = free_port(a.port)
    url = "http://127.0.0.1:%d/" % port
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True

    m = mem_status()
    print("=" * 60)
    print("  LayerDeck  -  透過PNG 重ね合わせプレビュー")
    print("  " + url)
    print("  監視フォルダ: %s" % (get_dir() or "(ブラウザ画面から選択してください)"))
    if m:
        print("  メモリ: %.1f GB 中 %.1f GB 空き" % (m["total"] / 2**30, m["avail"] / 2**30))
    print("")
    print("  終了: この黒い窓で Ctrl+C / または窓を閉じる")
    print("=" * 60)

    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n終了しました。")


if __name__ == "__main__":
    main()
