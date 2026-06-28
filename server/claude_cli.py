"""
Lớp tương tác với Claude Code CLI đã cài trên máy.
Dùng subprocess.Popen + thread thay vì asyncio.create_subprocess_exec
=> Tương thích với mọi event loop (Selector/Proactor) trên Windows.
"""
import asyncio
import json
import os
import sys
import shutil
import subprocess
import threading
import traceback
from pathlib import Path
from typing import AsyncIterator, Optional


# Registry các tiến trình Claude đang chạy — để ngắt giữa chừng
_ACTIVE_PROCS = set()
_PROC_LOCK = threading.Lock()

def cancel_all():
    """Ngắt mọi tiến trình Claude đang chạy (nút Stop)."""
    with _PROC_LOCK:
        procs = list(_ACTIVE_PROCS)
    for p in procs:
        try:
            if os.name == "nt":
                # Kill cả cây tiến trình (claude spawn node con)
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                               capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                p.terminate()
        except Exception:
            pass
    return len(procs)


def find_claude_cli() -> Optional[str]:
    """Tìm claude CLI trên máy."""
    cli = shutil.which("claude")
    if cli:
        return cli
    if os.name == "nt":
        candidates = [
            Path(os.environ.get("USERPROFILE", "")) / ".local" / "bin" / "claude.EXE",
            Path(os.environ.get("USERPROFILE", "")) / ".local" / "bin" / "claude.exe",
            Path(os.environ.get("APPDATA", "")) / "npm" / "claude.cmd",
            Path(os.environ.get("APPDATA", "")) / "npm" / "claude.exe",
        ]
        for p in candidates:
            if p.exists():
                return str(p)
    for p in ("/usr/local/bin/claude", "~/.local/bin/claude", "~/.npm-global/bin/claude"):
        path = Path(p).expanduser()
        if path.exists():
            return str(path)
    return None


class ClaudeCLI:
    def __init__(self, system_prompt: Optional[str] = None, cwd: Optional[str] = None):
        self.cli_path = find_claude_cli()
        self.system_prompt = system_prompt
        self.cwd = cwd or os.getcwd()
        self.session_id: Optional[str] = None

    def is_available(self) -> bool:
        return self.cli_path is not None

    async def query(self, prompt: str) -> AsyncIterator[dict]:
        if not self.cli_path:
            yield {"type": "error", "content": "Không tìm thấy Claude Code CLI."}
            return

        args = [
            self.cli_path,
            "-p", prompt,
            "--output-format", "stream-json",
            "--verbose",
            "--dangerously-skip-permissions",
        ]
        if self.system_prompt:
            args.extend(["--append-system-prompt", self.system_prompt])
        if self.session_id:
            args.extend(["--resume", self.session_id])

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        SENTINEL = object()

        def reader_thread():
            """Chạy subprocess trong thread, đẩy từng dòng vào queue."""
            proc = None
            try:
                # CREATE_NO_WINDOW để không pop cửa sổ cmd trên Windows
                creationflags = 0
                if os.name == "nt":
                    creationflags = subprocess.CREATE_NO_WINDOW

                proc = subprocess.Popen(
                    args,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=self.cwd,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    creationflags=creationflags,
                )
                with _PROC_LOCK:
                    _ACTIVE_PROCS.add(proc)

                # Đọc stderr riêng trong thread phụ
                stderr_lines = []
                def read_stderr():
                    for line in proc.stderr:
                        line = line.rstrip()
                        if line:
                            stderr_lines.append(line)
                            print(f"[claude-cli stderr] {line}", file=sys.stderr)
                stderr_thread = threading.Thread(target=read_stderr, daemon=True)
                stderr_thread.start()

                # Đọc stdout dòng-dòng, đẩy vào queue
                for line in proc.stdout:
                    line = line.strip()
                    if line:
                        asyncio.run_coroutine_threadsafe(queue.put(line), loop)

                proc.wait()
                stderr_thread.join(timeout=2)

                if proc.returncode != 0 and stderr_lines:
                    err_msg = "Claude CLI lỗi (exit " + str(proc.returncode) + "):\n" + "\n".join(stderr_lines[-5:])
                    asyncio.run_coroutine_threadsafe(queue.put({"__error__": err_msg}), loop)

            except Exception as e:
                traceback.print_exc()
                err_msg = f"Subprocess error: {type(e).__name__}: {e}"
                asyncio.run_coroutine_threadsafe(queue.put({"__error__": err_msg}), loop)
            finally:
                try:
                    if proc is not None:
                        with _PROC_LOCK:
                            _ACTIVE_PROCS.discard(proc)
                except Exception:
                    pass
                asyncio.run_coroutine_threadsafe(queue.put(SENTINEL), loop)

        thread = threading.Thread(target=reader_thread, daemon=True)
        thread.start()

        while True:
            item = await queue.get()
            if item is SENTINEL:
                break
            if isinstance(item, dict) and "__error__" in item:
                yield {"type": "error", "content": item["__error__"]}
                continue

            try:
                event = json.loads(item)
            except json.JSONDecodeError:
                continue

            etype = event.get("type")

            if etype == "system" and event.get("subtype") == "init":
                self.session_id = event.get("session_id")
                continue

            if etype == "assistant":
                msg = event.get("message", {})
                for block in msg.get("content", []):
                    btype = block.get("type")
                    if btype == "text":
                        text = block.get("text", "")
                        if text.strip():
                            yield {"type": "text", "content": text}
                    elif btype == "tool_use":
                        yield {
                            "type": "tool_call",
                            "name": block.get("name", ""),
                            "input": block.get("input", {}),
                        }
                continue

            if etype == "user":
                msg = event.get("message", {})
                for block in msg.get("content", []):
                    if block.get("type") == "tool_result":
                        content = block.get("content", "")
                        if isinstance(content, list):
                            content = " ".join(
                                c.get("text", "") for c in content if isinstance(c, dict)
                            )
                        yield {"type": "tool_result", "content": str(content)[:500]}
                continue

            if etype == "result":
                yield {
                    "type": "final",
                    "content": event.get("result", ""),
                    "session_id": self.session_id,
                    "cost_usd": event.get("total_cost_usd"),
                    "duration_ms": event.get("duration_ms"),
                }

    def reset_session(self):
        self.session_id = None
