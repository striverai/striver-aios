"""
Cấu hình tập trung của Jarvis OS — đọc/ghi server/settings.json (gitignored, chứa secret).
Gồm: workspace, tài khoản admin (mật khẩu hash), model engine, telegram.
Auth CHỈ bật khi đã đặt mật khẩu → bản local chưa đặt vẫn chạy như cũ.
"""
import json
import os
import hashlib
import secrets
from pathlib import Path

# Mọi state Jarvis tự ghi (settings, auth sessions, loop config) nằm ở JARVIS_STATE_DIR.
# Mặc định = server/ (không đổi trên máy cũ). Docker/VPS đặt = /data/state (volume ghi được,
# vì code tree /app là read-only trong container).
STATE_DIR = Path(os.getenv("JARVIS_STATE_DIR", str(Path(__file__).parent)))
try:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

SETTINGS_PATH = STATE_DIR / "settings.json"

_DEFAULT = {
    "workspace_name": "Jarvis OS",
    "setup_done": False,                       # đã qua bộ cài đặt lần đầu chưa
    "auth": {"username": "", "password_hash": "", "salt": ""},
    "model": {
        # --- Mô hình MAIN MODEL theo provider (mới) ---
        # Rỗng = suy ra từ legacy engine (config cũ không vỡ); UI set vào đây khi user đổi model.
        "main": {"provider": "", "model": ""},
        # Model phụ cho việc NỀN (loop/metrics/ingest) — alias Claude qua CLI. "" = dùng mặc định
        # (không đổi). Đặt model rẻ (vd haiku) để tiết kiệm khi chạy nền nhiều.
        "auxiliary": {"model": ""},
        # Độ sâu suy nghĩ (reasoning/thinking) khi trả lời chat: off | low | medium | high.
        # Anthropic API/OpenRouter → adaptive thinking + effort; OpenAI → reasoning_effort (chỉ o-series);
        # Claude Code CLI → chèn từ khoá think/ultrathink vào prompt. off = trả lời nhanh như cũ.
        "reasoning": "off",
        # --- Credentials theo provider ---
        "openrouter_key": "",
        "anthropic_api_key": "",               # provider Anthropic API (P2)
        "openai_api_key": "",                  # provider OpenAI (ChatGPT API)
        # Provider 'openai-oauth' — đăng nhập ChatGPT Plus/Pro qua device-code (xem openai_oauth.py).
        "openai_oauth": {"access_token": "", "refresh_token": "", "id_token": "", "account_id": "", "plan": "", "expires_at": 0},
        # --- Legacy: giữ đồng bộ với main để engine cũ không vỡ (engine/claude_model/openrouter_model) ---
        "engine": "cli",                       # cli (Claude Code, đủ MCP) | openrouter | anthropic-api
        "claude_model": "",                    # "" = mặc định CLI; hoặc opus/sonnet/haiku/fable
        "openrouter_model": "openai/gpt-4o-mini",
        # Catalog model theo provider (Telegram /model dùng key 'claude'+'openrouter'; picker dùng cả 3).
        "catalog": {
            "claude": ["opus", "sonnet", "haiku", "fable"],                       # anthropic-cli (alias)
            "anthropic-api": ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
            "openai": ["gpt-4o", "gpt-4o-mini", "o3-mini"],                        # OpenAI API
            "openai-oauth": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],  # ChatGPT OAuth (Codex; chỉ fallback — picker load động)
            "openrouter": ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash-001", "deepseek/deepseek-chat"],
        },
    },
    "telegram": {"enabled": False, "token": "", "chat_id": ""},
    "dashboard": {
        # graph_enabled=False → vào thẳng Console, KHÔNG dựng graph 3D (nhẹ cho VPS/điện thoại).
        # Frontend cũng tự ép lite-mode khi màn hình hẹp dù cờ này bật.
        "graph_enabled": True,
    },
    # MCP do Jarvis quản lý (danh sách server ở mcp_servers.json). strict=True → CHỈ dùng
    # server của Jarvis (--strict-mcp-config), bỏ qua config MCP sẵn có của máy.
    "mcp": {"strict": False},
}


def read_settings():
    cfg = json.loads(json.dumps(_DEFAULT))   # deep copy
    try:
        if SETTINGS_PATH.exists():
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            for k, v in (data or {}).items():
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    cfg[k].update(v)
                else:
                    cfg[k] = v
    except Exception:
        pass
    return cfg


def write_settings(cfg):
    SETTINGS_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ---- Mật khẩu ----
def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000).hex()
    return h, salt


def auth_enabled(cfg=None):
    cfg = cfg or read_settings()
    return bool(cfg.get("auth", {}).get("password_hash"))


def verify_password(password, cfg=None):
    cfg = cfg or read_settings()
    a = cfg.get("auth", {})
    if not a.get("password_hash"):
        return False
    h, _ = hash_password(password, a.get("salt"))
    return secrets.compare_digest(h, a["password_hash"])


# ---- Session (lưu ra file → restart KHÔNG bị đăng xuất) ----
_SESS_PATH = STATE_DIR / ".sessions.json"


def _load_sessions():
    try:
        if _SESS_PATH.exists():
            return set(json.loads(_SESS_PATH.read_text(encoding="utf-8")))
    except Exception:
        pass
    return set()


SESSIONS = _load_sessions()


def _save_sessions():
    try:
        _SESS_PATH.write_text(json.dumps(list(SESSIONS)), encoding="utf-8")
    except Exception:
        pass


def new_session():
    t = secrets.token_urlsafe(32)
    SESSIONS.add(t)
    _save_sessions()
    return t


def valid_session(token):
    return bool(token) and token in SESSIONS


def drop_session(token):
    SESSIONS.discard(token)
    _save_sessions()


def clear_sessions():
    SESSIONS.clear()
    _save_sessions()
