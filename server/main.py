"""
Jarvis OS — Backend
Kiến trúc: Voice (browser) ⇄ FastAPI WebSocket ⇄ Claude Code CLI subprocess

Jarvis KHÔNG gọi Anthropic API trực tiếp. Mọi reasoning + tool calling đi qua
`claude` CLI đã cài trên máy → tự kế thừa MCP, skills, auth.
"""
import os
import json
from pathlib import Path
import re
import shutil
import time
import yaml
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, UploadFile, File, Form
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
import edge_tts
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from claude_cli import ClaudeCLI, find_claude_cli, cancel_all
from graph_builder import build_graph

app = FastAPI(title="Jarvis OS")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

DASHBOARD_PATH = Path(__file__).parent.parent / "dashboard"
app.mount("/static", StaticFiles(directory=str(DASHBOARD_PATH)), name="static")

CLAUDE_MD_PATH = Path(__file__).parent.parent / "CLAUDE.md"
SYSTEM_PROMPT = CLAUDE_MD_PATH.read_text(encoding="utf-8") if CLAUDE_MD_PATH.exists() else None

# Bộ nhớ dài hạn — lưu TRONG vault đang chọn để đi theo vault
MEMORY_SEED = (
    "# Bộ nhớ Jarvis — Index\n\n"
    "> Chỉ mục bộ nhớ dài hạn của Jarvis. Mỗi dòng = 1 ký ức, trỏ tới file trong `facts/`.\n"
    "> Nội dung file này được nạp vào đầu mỗi câu hỏi để Jarvis nhớ ngữ cảnh.\n\n"
    "_(Chưa có ký ức nào. Jarvis sẽ học dần sau mỗi hội thoại.)_\n"
)

def _brain_memory_dir(brain: str) -> Path:
    """Folder Memory NẰM TRONG vault/brain đang chọn (tạo nếu chưa có)."""
    base = Path(__file__).parent.parent
    if not brain or brain == "brain":
        root = base / "brain"
    else:
        root = Path(brain) if os.path.isdir(brain) else (base / "brain")
    mem = root / "Memory"
    try:
        (mem / "facts").mkdir(parents=True, exist_ok=True)
        (mem / "conversations").mkdir(parents=True, exist_ok=True)
        idx = mem / "MEMORY.md"
        if not idx.exists():
            idx.write_text(MEMORY_SEED, encoding="utf-8")
    except Exception as e:
        print(f"[memory dir error] {e}", file=__import__('sys').stderr)
    return mem

def build_system_prompt(brain: str = "brain") -> str:
    """CLAUDE.md + nạp MEMORY.md của vault đang chọn → Jarvis luôn nhớ ngữ cảnh."""
    base = CLAUDE_MD_PATH.read_text(encoding="utf-8") if CLAUDE_MD_PATH.exists() else ""
    idx = _brain_memory_dir(brain) / "MEMORY.md"
    mem = ""
    try:
        if idx.exists():
            mem = idx.read_text(encoding="utf-8")
    except Exception:
        mem = ""
    if mem.strip():
        base += "\n\n# === BỘ NHỚ DÀI HẠN (nạp sẵn) ===\n" + mem
    # Đường dẫn lớp Agentic của vault đang làm việc (để Jarvis tạo agent/workflow qua chat)
    root = _brain_memory_dir(brain).parent
    base += (
        "\n\n# === LỚP AGENTIC (vault đang làm việc) ===\n"
        f"Vault root: {root}\n"
        f"- AGENT: tạo/sửa tại `{root}/Jarvis/agents/<slug>.md`\n"
        f"- WORKFLOW: tạo/sửa tại `{root}/Jarvis/workflows/<slug>.md`\n"
        "Khi user yêu cầu tạo/sửa agent hoặc workflow qua chat, ghi file .md đúng định dạng "
        "(xem mục 'Tạo/sửa Agent & Workflow qua chat' trong system prompt) bằng ĐƯỜNG DẪN TUYỆT ĐỐI ở trên. "
        "Studio sẽ tự nhận file mới."
    )
    return base

def log_conversation(brain: str, user_msg: str, jarvis_msg: str):
    """Ghi log hội thoại vào Memory của vault đang chọn (nguyên liệu để học)."""
    try:
        from datetime import datetime, timezone, timedelta
        now = datetime.now(timezone(timedelta(hours=7)))
        conv = _brain_memory_dir(brain) / "conversations"
        f = conv / f"{now.strftime('%Y-%m-%d')}.md"
        entry = f"\n## {now.strftime('%H:%M')}\n**Bạn:** {user_msg}\n\n**Jarvis:** {jarvis_msg}\n"
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(entry)
    except Exception as e:
        print(f"[memory log error] {e}", file=__import__('sys').stderr)

# Working directory cho Claude CLI — mặc định là root project Jarvis OS
# để Claude đọc được CLAUDE.md và truy cập MCPs cài globally
CLAUDE_CWD = os.getenv("CLAUDE_CWD", str(Path(__file__).parent.parent))

# Second Brain — gộp folder brain/ trong project + vault Bullet Journal
PROJECT_ROOT = Path(__file__).parent.parent
BRAIN_PATH = os.getenv("BRAIN_PATH", str(PROJECT_ROOT / "brain"))
OBSIDIAN_VAULT_PATH = os.getenv("OBSIDIAN_VAULT_PATH", r"D:\My Bullet Journal")
# Nơi lưu file đính kèm từ chat (source cho Second Brain)
SOURCES_PATH = os.getenv("SOURCES_PATH", str(PROJECT_ROOT / "brain" / "01 - Sources"))


@app.get("/")
async def root():
    html = (DASHBOARD_PATH / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(html, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})


@app.post("/stop")
async def stop():
    """Ngắt mọi lệnh Claude đang chạy (nút Stop khi nói sai)."""
    n = cancel_all()
    return {"ok": True, "cancelled": n}


@app.get("/memory/stats")
async def memory_stats(brain: str = Query("brain")):
    """Đếm số ký ức đã học trong vault đang chọn."""
    try:
        facts_dir = _brain_memory_dir(brain) / "facts"
        facts = len(list(facts_dir.glob("*.md")))
    except Exception:
        facts = 0
    return {"facts": facts}


@app.post("/reflect")
async def reflect(brain: str = Form("brain")):
    """Vòng tự học: Jarvis đọc hội thoại gần đây → rút ký ức bền vững → ghi vào Memory của vault."""
    cli = ClaudeCLI(system_prompt=SYSTEM_PROMPT, cwd=CLAUDE_CWD)
    if not cli.is_available():
        return {"ok": False, "error": "Claude CLI chưa cài"}

    mem = _brain_memory_dir(brain)
    conv_dir = mem / "conversations"
    facts_dir = mem / "facts"
    index = mem / "MEMORY.md"
    vault_root = mem.parent
    wiki_dir = _resolve_subfolder(str(vault_root), r"^(\d+\s*[-_.]\s*)?wiki$", "Wiki")
    conv_today = conv_dir / f"{__import__('datetime').date.today().strftime('%Y-%m-%d')}.md"
    prompt = (
        "VÒNG TỰ HỌC. Hãy:\n"
        f"1) Đọc log hội thoại gần đây: {conv_today} (nếu không có thì đọc file mới nhất trong {conv_dir}).\n"
        f"2) Đọc chỉ mục bộ nhớ hiện tại: {index}\n"
        "3) Rút ra các SỰ THẬT BỀN VỮNG đáng nhớ (về user, doanh nghiệp, sở thích cách làm việc, quyết định đã chốt). "
        "Bỏ qua chuyện nhất thời. Bỏ qua điều đã có trong bộ nhớ.\n"
        f"4) Với mỗi ký ức MỚI: tạo 1 file trong {facts_dir} (theo format trong CLAUDE.md) và thêm 1 dòng vào {index}.\n"
        "5) Nếu phát hiện ký ức trùng/cũ/sai: gộp hoặc cập nhật, đừng nhân bản.\n"
        f"6) ĐÚC KẾT TRI THỨC: nếu hội thoại có KHÁI NIỆM / framework / nguyên lý / quy trình TÁI SỬ DỤNG được "
        f"(không phải thông tin cá nhân nhất thời), hãy chưng cất vào Wiki tại folder \"{wiki_dir}\": "
        f"tạo note mới (1 khái niệm = 1 file) hoặc cập nhật note đã có, frontmatter type: wiki, có wikilink [[...]] tới khái niệm liên quan. "
        f"Nếu vault có CLAUDE.md riêng (đọc {vault_root}/CLAUDE.md nếu có) thì TUÂN THEO quy ước Wiki trong đó. "
        "Mục tiêu: tri thức tích luỹ dần, làm dày bộ não. Đừng tạo Wiki rỗng/trùng.\n"
        "Cuối cùng, báo cáo NGẮN GỌN tiếng Việt: học thêm mấy ký ức + đúc kết mấy khái niệm Wiki (tên). Nếu không có gì mới, nói 'Không có gì mới'."
    )

    final = ""
    async for ev in cli.query(prompt):
        if ev["type"] == "final":
            final = ev.get("content", "")
        elif ev["type"] == "error":
            return {"ok": False, "error": ev["content"][:300]}

    facts = len(list(facts_dir.glob("*.md")))
    return {"ok": True, "summary": final, "facts": facts}


@app.get("/health")
async def health():
    cli = find_claude_cli()
    return {
        "status": "ok",
        "claude_cli": cli or "NOT FOUND",
        "claude_cli_available": cli is not None,
        "cwd": CLAUDE_CWD,
    }


@app.get("/metrics")
async def metrics():
    """
    Số liệu động — Jarvis tự phát hiện MCP đang kết nối và trả về các card
    phù hợp (kinh doanh và/hoặc cuộc sống). Không hardcode ngành nào.
    """
    cli = ClaudeCLI(system_prompt=SYSTEM_PROMPT, cwd=CLAUDE_CWD)
    if not cli.is_available():
        return {"error": "Claude CLI chưa cài", "cards": []}

    prompt = (
        "Xem các MCP/tool đang kết nối. Lấy 3-6 chỉ số quan trọng nhất hiện tại "
        "(kinh doanh hoặc cuộc sống, tùy nguồn dữ liệu có sẵn). "
        "CHỈ trả về JSON thuần, không markdown, dạng: "
        '{\"cards\":[{\"label\":\"tên chỉ số\",\"value\":\"giá trị\",\"sub\":\"so sánh/ghi chú ngắn\",\"trend\":\"up|down|flat\"}]}. '
        "Nếu chưa có MCP dữ liệu nào phù hợp, trả về {\"cards\":[],\"note\":\"lý do ngắn\"}. "
        "Trả về JSON trên một dòng."
    )

    final = ""
    async for event in cli.query(prompt):
        if event["type"] == "final":
            final = event.get("content", "")
        elif event["type"] == "error":
            return {"error": event["content"][:200], "cards": []}

    import re
    # Tìm object JSON ngoài cùng có "cards"
    m = re.search(r"\{.*\}", final, re.DOTALL)
    if m:
        try:
            data = json.loads(m.group(0))
            if "cards" in data:
                return data
        except json.JSONDecodeError:
            pass
    return {"error": "Không parse được số liệu", "raw": final[:300], "cards": []}


@app.get("/graph")
async def graph(
    source: str = Query("all", description="all | brain | vault"),
    path: str = Query(None, description="Đường dẫn folder tùy ý (ưu tiên nếu có)"),
):
    """Lớp Graphify — dựng đồ thị kết nối note từ wikilink."""
    if path:
        roots = [path]
    elif source == "brain":
        roots = [BRAIN_PATH]
    elif source == "vault":
        roots = [OBSIDIAN_VAULT_PATH]
    else:
        roots = [BRAIN_PATH, OBSIDIAN_VAULT_PATH]
    return build_graph(roots)


def _sanitize_filename(name: str) -> str:
    name = os.path.basename(name or "").strip()
    name = re.sub(r"[^\w\-. ()À-ỹ]", "_", name, flags=re.UNICODE)
    return name or "file"

def _unique_path(folder: str, name: str) -> str:
    base, ext = os.path.splitext(name)
    candidate = os.path.join(folder, name)
    i = 1
    while os.path.exists(candidate):
        candidate = os.path.join(folder, f"{base}_{i}{ext}")
        i += 1
    return candidate

IMG_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
STAGING = PROJECT_ROOT / ".staging"

def _brain_root(brain: str) -> str:
    if not brain or brain == "brain":
        return str(PROJECT_ROOT / "brain")
    return brain if os.path.isdir(brain) else str(PROJECT_ROOT / "brain")

def _resolve_subfolder(root: str, name_regex: str, default_name: str) -> str:
    """Tìm (hoặc tạo) subfolder khớp regex trong root (vd Sources / Attachments)."""
    if not os.path.isdir(root):
        root = str(PROJECT_ROOT / "brain")
    try:
        for name in os.listdir(root):
            full = os.path.join(root, name)
            if os.path.isdir(full) and re.match(name_regex, name.strip(), re.IGNORECASE):
                return full
    except Exception:
        pass
    dest = os.path.join(root, default_name)
    os.makedirs(dest, exist_ok=True)
    return dest

@app.post("/upload")
async def upload(file: UploadFile = File(...), brain: str = Form("")):
    """Nhận file → stage tạm (chưa vào Sources). Bước /ingest-upload sẽ chuyển thành .md."""
    os.makedirs(STAGING, exist_ok=True)
    raw = file.filename or ""
    if not raw or raw in ("blob", "image.png"):
        ext = os.path.splitext(raw)[1] or ".png"
        raw = f"paste-{int(time.time())}{ext}"
    name = _sanitize_filename(raw)
    staged = _unique_path(str(STAGING), name)
    try:
        with open(staged, "wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    ext = os.path.splitext(staged)[1].lower()
    kind = "image" if ext in IMG_EXTS else "file"
    root = _brain_root(brain)
    sources = _resolve_subfolder(root, r"^(\d+\s*[-_.]\s*)?sources$", "Sources")
    attachments = _resolve_subfolder(root, r"^(\d+\s*[-_.]\s*)?attachments$", "Attachments")
    return {"ok": True, "staged": staged, "name": os.path.basename(staged),
            "kind": kind, "size": os.path.getsize(staged),
            "sources": sources, "attachments": attachments}

@app.post("/ingest-upload")
async def ingest_upload(
    staged: str = Form(...), sources: str = Form(...),
    attachments: str = Form(""), kind: str = Form("file"), name: str = Form(""),
):
    """Dùng Claude CLI biến file staged thành .md nguồn: text→trích, ảnh→mô tả."""
    cli = ClaudeCLI(system_prompt=SYSTEM_PROMPT, cwd=CLAUDE_CWD)
    if not cli.is_available():
        return {"ok": False, "error": "Claude CLI chưa cài"}
    slug = _sanitize_filename(os.path.splitext(name)[0]) or "source"

    if kind == "image":
        prompt = (
            f"File ẢNH vừa tải lên nằm ở: {staged}\n"
            f"Hãy:\n"
            f"1) Đọc và HIỂU KỸ ảnh (chữ trong ảnh, số liệu, biểu đồ, sơ đồ, ý chính).\n"
            f"2) Tạo file Markdown tại folder \"{sources}\" tên \"{slug}.md\" gồm:\n"
            f"   - frontmatter: type: source, source_kind: screenshot, status: unprocessed, created (hôm nay), original: {name}\n"
            f"   - phần MÔ TẢ CHI TIẾT nội dung ảnh bằng tiếng Việt.\n"
            f"3) Di chuyển file ảnh gốc vào folder \"{attachments}\" rồi nhúng vào .md bằng ![[tên-ảnh]].\n"
            f"CHỈ in ra đường dẫn đầy đủ của file .md đã tạo, không giải thích thêm."
        )
    else:
        prompt = (
            f"File VĂN BẢN vừa tải lên nằm ở: {staged}\n"
            f"Hãy:\n"
            f"1) Đọc toàn bộ nội dung.\n"
            f"2) Tạo file Markdown SẠCH tại folder \"{sources}\" tên \"{slug}.md\" gồm:\n"
            f"   - frontmatter: type: source, source_kind phù hợp, status: unprocessed, created (hôm nay), original: {name}\n"
            f"   - nội dung đã định dạng gọn gàng, giữ nguyên thông tin, bỏ rác.\n"
            f"3) Xóa file gốc tại {staged}.\n"
            f"CHỈ in ra đường dẫn đầy đủ của file .md đã tạo, không giải thích thêm."
        )

    final = ""
    async for ev in cli.query(prompt):
        if ev["type"] == "final":
            final = ev.get("content", "")
        elif ev["type"] == "error":
            return {"ok": False, "error": ev["content"][:200]}

    m = re.search(r"[A-Za-z]:\\[^\n\"]+\.md|/[^\n\"]+\.md", final)
    md_path = m.group(0).strip() if m else os.path.join(sources, f"{slug}.md")
    if os.path.exists(md_path):
        return {"ok": True, "md_path": md_path, "md_name": os.path.basename(md_path),
                "folder": os.path.basename(sources)}
    return {"ok": False, "error": "Không tạo được .md", "raw": final[:200]}

# Cấu trúc chuẩn Jarvis — kiểm tra khi mở vault
# detect: regex khớp tên folder top-level (linh hoạt "06 - Sources" / "Sources")
STANDARD_STRUCTURE = [
    {"key": "sources", "label": "Sources", "kind": "dir", "detect": r"^(\d+\s*[-_.]\s*)?sources$", "create": "06 - Sources", "essential": True},
    {"key": "wiki", "label": "Wiki", "kind": "dir", "detect": r"^(\d+\s*[-_.]\s*)?wiki$", "create": "07 - Wiki", "essential": True},
    {"key": "attachments", "label": "Attachments", "kind": "dir", "detect": r"^(\d+\s*[-_.]\s*)?attachments$", "create": "99 - Attachments", "essential": False},
    {"key": "daily", "label": "Daily Log", "kind": "dir", "detect": r"^(\d+\s*[-_.]\s*)?daily log$", "create": "01 - Daily Log", "essential": False},
    {"key": "weekly", "label": "Weekly Log", "kind": "dir", "detect": r"^(\d+\s*[-_.]\s*)?weekly log$", "create": "02 - Weekly Log", "essential": False},
    {"key": "monthly", "label": "Monthly Log", "kind": "dir", "detect": r"^(\d+\s*[-_.]\s*)?monthly log$", "create": "03 - Monthly Log", "essential": False},
    {"key": "projects", "label": "Projects", "kind": "dir", "detect": r"^(\d+\s*[-_.]\s*)?projects$", "create": "05 - Projects", "essential": False},
    {"key": "templates", "label": "Templates", "kind": "dir", "detect": r"^templates$", "create": "Templates", "essential": False},
    {"key": "memory", "label": "Memory (Jarvis)", "kind": "dir", "detect": r"^memory$", "create": "Memory", "essential": True},
    {"key": "jarvis_agents", "label": "Jarvis / agents", "kind": "exact", "path": "Jarvis/agents", "create": "Jarvis/agents", "essential": True},
    {"key": "jarvis_workflows", "label": "Jarvis / workflows", "kind": "exact", "path": "Jarvis/workflows", "create": "Jarvis/workflows", "essential": True},
    {"key": "schema", "label": "Schema (AGENTS.md)", "kind": "file_any", "files": ["AGENTS.md", "CLAUDE.md"], "create": "AGENTS.md", "essential": True},
]

def _check_structure(root: Path):
    items = []
    try:
        top_dirs = [d for d in os.listdir(root) if os.path.isdir(root / d)]
    except Exception:
        top_dirs = []
    for it in STANDARD_STRUCTURE:
        present, where = False, None
        if it["kind"] == "dir":
            for d in top_dirs:
                if re.match(it["detect"], d.strip(), re.IGNORECASE):
                    present, where = True, d
                    break
        elif it["kind"] == "exact":
            p = root / it["path"]
            present = p.exists()
            where = it["path"] if present else None
        elif it["kind"] == "file_any":
            for f in it["files"]:
                if (root / f).exists():
                    present, where = True, f
                    break
        items.append({"key": it["key"], "label": it["label"], "present": present,
                      "where": where, "essential": it["essential"]})
    return items

JARVIS_README = (
    "# Jarvis\n\nLớp điều phối của Jarvis OS trong vault này.\n\n"
    "- `agents/` — các Agent (vai trò + skills + bộ nhớ riêng)\n"
    "- `workflows/` — quy trình nhiều agent (status active/off)\n"
    "- Skills dùng chung ở `.claude/skills/`\n"
)
SCHEMA_SEED = (
    "# AGENTS.md — Vault Schema (Jarvis)\n\n"
    "> Vault này hoạt động với Jarvis OS. Cấu trúc:\n\n"
    "- `06 - Sources/` — ghi chú thô (source of truth)\n"
    "- `07 - Wiki/` — tri thức đã chưng cất, có `[[wikilink]]`\n"
    "- `Memory/` — bộ nhớ dài hạn của Jarvis (facts + conversations)\n"
    "- `Jarvis/` — agents + workflows\n\n"
    "Nguyên lý: Sources → (ingest) → Wiki. Tri thức tích luỹ, không tái phát hiện.\n"
)

@app.get("/vault/check")
async def vault_check(brain: str = Query("brain")):
    """Kiểm tra cấu trúc chuẩn của vault đang chọn."""
    root = Path(_brain_root(brain))
    items = _check_structure(root)
    missing = [i for i in items if not i["present"]]
    missing_essential = [i for i in missing if i["essential"]]
    return {"root": str(root), "items": items,
            "ok": len(missing_essential) == 0, "missing": len(missing),
            "missing_essential": len(missing_essential)}

@app.post("/vault/init")
async def vault_init(brain: str = Form("brain")):
    """Tạo các mục cấu trúc còn thiếu để vault chạy với Jarvis."""
    root = Path(_brain_root(brain))
    items = _check_structure(root)
    present_keys = {i["key"] for i in items if i["present"]}
    created = []
    for it in STANDARD_STRUCTURE:
        if it["key"] in present_keys:
            continue
        try:
            if it["kind"] in ("dir", "exact"):
                (root / it["create"]).mkdir(parents=True, exist_ok=True)
                created.append(it["label"])
            elif it["kind"] == "file_any":
                (root / it["create"]).write_text(SCHEMA_SEED, encoding="utf-8")
                created.append(it["label"])
        except Exception as e:
            print(f"[vault init error] {it['key']}: {e}", file=__import__('sys').stderr)
    # Seed Jarvis/README + Memory
    try:
        jr = root / "Jarvis" / "README.md"
        if not jr.exists():
            jr.parent.mkdir(parents=True, exist_ok=True)
            jr.write_text(JARVIS_README, encoding="utf-8")
        _brain_memory_dir(brain)  # đảm bảo Memory seed
    except Exception:
        pass
    return {"ok": True, "created": created}

# ============================================================
# STUDIO — Agents / Skills / Workflows
# ============================================================
def _slugify(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    s = re.sub(r"[\s_]+", "-", s)
    return s[:60] or "item"

def _read_md(path):
    try:
        text = Path(path).read_text(encoding="utf-8")
    except Exception:
        return {}, ""
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            try:
                meta = yaml.safe_load(parts[1]) or {}
            except Exception:
                meta = {}
            return (meta if isinstance(meta, dict) else {}), parts[2].strip()
    return {}, text

def _write_md(path, meta, body):
    fm = yaml.safe_dump(meta, allow_unicode=True, sort_keys=False).strip()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(f"---\n{fm}\n---\n\n{body}\n", encoding="utf-8")

def _today():
    from datetime import date
    return date.today().strftime("%Y-%m-%d")

def _agents_dir(brain):
    d = Path(_brain_root(brain)) / "Jarvis" / "agents"; d.mkdir(parents=True, exist_ok=True); return d
def _workflows_dir(brain):
    d = Path(_brain_root(brain)) / "Jarvis" / "workflows"; d.mkdir(parents=True, exist_ok=True); return d

def _agent_memory(brain, slug):
    f = _brain_memory_dir(brain) / "agents" / slug / "MEMORY.md"
    try:
        return f.read_text(encoding="utf-8") if f.exists() else ""
    except Exception:
        return ""

def _log_agent_run(brain, slug, task, out):
    try:
        d = _brain_memory_dir(brain) / "agents" / slug / "runs"
        d.mkdir(parents=True, exist_ok=True)
        from datetime import datetime, timezone, timedelta
        now = datetime.now(timezone(timedelta(hours=7)))
        with open(d / f"{now.strftime('%Y-%m-%d')}.md", "a", encoding="utf-8") as fh:
            fh.write(f"\n## {now.strftime('%H:%M')}\n**Task:** {task}\n\n**Kết quả:** {out[:1500]}\n")
    except Exception:
        pass

# ---- Agents ----
@app.get("/agents")
async def list_agents(brain: str = Query("brain")):
    out = []
    for f in sorted(_agents_dir(brain).glob("*.md")):
        meta, body = _read_md(f)
        out.append({"slug": f.stem, "name": meta.get("name", f.stem),
                    "role": meta.get("role", ""), "skills": meta.get("skills", []) or [],
                    "model": meta.get("model", ""), "prompt": body})
    return {"agents": out}

@app.post("/agents")
async def save_agent(name: str = Form(...), role: str = Form(""), skills: str = Form(""),
                     model: str = Form(""), slug: str = Form(""), prompt: str = Form(""),
                     brain: str = Form("brain")):
    slug = slug or _slugify(name)
    skills_list = [s.strip() for s in re.split(r"[,\n]", skills) if s.strip()]
    meta = {"type": "agent", "name": name, "slug": slug, "role": role,
            "skills": skills_list, "model": model or "sonnet", "updated": _today()}
    _write_md(_agents_dir(brain) / f"{slug}.md", meta, (prompt.strip() or role))
    return {"ok": True, "slug": slug}

@app.post("/agents/delete")
async def delete_agent(slug: str = Form(...), brain: str = Form("brain")):
    f = _agents_dir(brain) / f"{slug}.md"
    if f.exists():
        f.unlink()
    return {"ok": True}

# ---- Skills ----
@app.get("/skills")
async def list_skills(brain: str = Query("brain")):
    root = Path(_brain_root(brain))
    seen = {}
    for base in [root / ".claude" / "skills", root / ".agents"]:
        if base.is_dir():
            for sk in sorted(base.iterdir()):
                smd = sk / "SKILL.md"
                if smd.is_file():
                    meta, body = _read_md(smd)
                    desc = meta.get("description", "")
                    if not desc and body:
                        desc = body.split("\n")[0][:140]
                    seen.setdefault(sk.name, {"slug": sk.name, "name": meta.get("name", sk.name),
                                              "description": desc, "source": base.name})
    return {"skills": list(seen.values())}

# ---- Workflows ----
@app.get("/workflows")
async def list_workflows(brain: str = Query("brain")):
    out = []
    for f in sorted(_workflows_dir(brain).glob("*.md")):
        meta, _ = _read_md(f)
        out.append({"slug": f.stem, "name": meta.get("name", f.stem),
                    "status": meta.get("status", "off"),
                    "description": meta.get("description", ""),
                    "steps": meta.get("steps", []) or []})
    return {"workflows": out}

@app.post("/workflows")
async def save_workflow(name: str = Form(...), description: str = Form(""), steps: str = Form("[]"),
                        status: str = Form("active"), slug: str = Form(""), brain: str = Form("brain")):
    slug = slug or _slugify(name)
    try:
        steps_list = json.loads(steps)
    except Exception:
        steps_list = []
    meta = {"type": "workflow", "name": name, "slug": slug, "status": status,
            "description": description, "steps": steps_list, "updated": _today()}
    _write_md(_workflows_dir(brain) / f"{slug}.md", meta, description)
    return {"ok": True, "slug": slug}

@app.post("/workflows/toggle")
async def toggle_workflow(slug: str = Form(...), brain: str = Form("brain")):
    f = _workflows_dir(brain) / f"{slug}.md"
    if not f.exists():
        return {"ok": False, "error": "not found"}
    meta, body = _read_md(f)
    meta["status"] = "off" if meta.get("status") == "active" else "active"
    _write_md(f, meta, body)
    return {"ok": True, "status": meta["status"]}

@app.post("/workflows/delete")
async def delete_workflow(slug: str = Form(...), brain: str = Form("brain")):
    f = _workflows_dir(brain) / f"{slug}.md"
    if f.exists():
        f.unlink()
    return {"ok": True}

@app.get("/workflows/run")
async def run_workflow(slug: str = Query(...), brain: str = Query("brain"), input: str = Query("")):
    """Chạy workflow nhiều agent tuần tự, stream tiến độ qua SSE."""
    wf_file = _workflows_dir(brain) / f"{slug}.md"
    if not wf_file.exists():
        return JSONResponse({"error": "workflow not found"}, status_code=404)
    meta, _ = _read_md(wf_file)
    steps = meta.get("steps", []) or []
    vault_root = str(_brain_root(brain))

    def sse(obj):
        return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

    async def gen():
        yield sse({"type": "start", "workflow": meta.get("name", slug), "steps": len(steps)})
        prev = ""
        for i, step in enumerate(steps):
            agent_slug = step.get("agent", "")
            task = step.get("task", "")
            ameta, abody = _read_md(_agents_dir(brain) / f"{agent_slug}.md")
            agent_name = ameta.get("name", agent_slug)
            task_f = task.replace("{{input}}", input or "").replace("{{prev}}", prev or "")
            yield sse({"type": "step_start", "i": i, "agent": agent_name, "task": task_f})
            amem = _agent_memory(brain, agent_slug)
            sysprompt = (
                f"Bạn là agent **{agent_name}**.\nVai trò: {ameta.get('role','')}\n{abody}\n\n"
                f"Skills khả dụng: {', '.join(ameta.get('skills', []) or []) or '(không)'}. Dùng skill khi cần.\n"
                + (f"\n# Bộ nhớ của bạn:\n{amem}\n" if amem else "")
                + "\nLàm việc trong vault. Tập trung hoàn thành nhiệm vụ, trả kết quả rõ ràng, ngắn gọn."
            )
            cli = ClaudeCLI(system_prompt=sysprompt, cwd=vault_root)
            out = ""
            async for ev in cli.query(task_f):
                if ev["type"] == "text":
                    yield sse({"type": "step_text", "i": i, "content": ev["content"]})
                elif ev["type"] == "tool_call":
                    yield sse({"type": "step_tool", "i": i, "tool": ev["name"]})
                elif ev["type"] == "final":
                    out = ev.get("content") or out
                elif ev["type"] == "error":
                    yield sse({"type": "step_error", "i": i, "content": ev["content"]})
            prev = out
            yield sse({"type": "step_done", "i": i, "agent": agent_name, "output": out})
            _log_agent_run(brain, agent_slug, task_f, out)
        yield sse({"type": "done", "result": prev})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.post("/studio/seed")
async def studio_seed(brain: str = Form("brain")):
    """Tạo bộ Agent + Workflow mẫu để bắt đầu."""
    a = _agents_dir(brain)
    examples = [
        {"name": "Researcher", "role": "Chuyên nghiên cứu, tìm tư liệu và tổng hợp nguồn đáng tin cậy.",
         "skills": ["deep-research"], "prompt": "Bạn tìm 5-7 nguồn chất lượng, trích dẫn rõ ràng, tổng hợp insight chính."},
        {"name": "Writer", "role": "Chuyên viết bài chuẩn SEO và hấp dẫn từ tư liệu nghiên cứu.",
         "skills": ["salepage-16-buoc"], "prompt": "Bạn viết bài có cấu trúc, hook mạnh, dùng tư liệu được cung cấp."},
    ]
    for ex in examples:
        slug = _slugify(ex["name"])
        meta = {"type": "agent", "name": ex["name"], "slug": slug, "role": ex["role"],
                "skills": ex["skills"], "model": "sonnet", "updated": _today()}
        _write_md(a / f"{slug}.md", meta, ex["prompt"])
    wf_meta = {"type": "workflow", "name": "Research → Write", "slug": "research-and-write",
               "status": "active", "description": "Nghiên cứu chủ đề rồi viết bài hoàn chỉnh.",
               "steps": [
                   {"agent": "researcher", "task": "Nghiên cứu kỹ chủ đề: {{input}}. Tìm nguồn, tổng hợp insight chính."},
                   {"agent": "writer", "task": "Viết một bài hoàn chỉnh về '{{input}}' dựa trên nghiên cứu sau:\n{{prev}}"},
               ], "updated": _today()}
    _write_md(_workflows_dir(brain) / "research-and-write.md", wf_meta, wf_meta["description"])
    return {"ok": True}


@app.get("/browse")
async def browse(path: str = Query("", description="Thư mục cần liệt kê; rỗng = ổ đĩa/gốc")):
    """Duyệt thư mục để chọn brain folder. Đếm số file .md trong mỗi folder con."""
    import string
    import glob as _glob

    # Rỗng → liệt kê ổ đĩa (Windows) hoặc home (Unix)
    if not path:
        if os.name == "nt":
            drives = [f"{d}:\\" for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")]
            return {"path": "", "parent": None,
                    "dirs": [{"name": d, "path": d, "md": None} for d in drives]}
        path = os.path.expanduser("~")

    if not os.path.isdir(path):
        return {"error": "Không phải thư mục", "path": path, "parent": None, "dirs": []}

    try:
        dirs = []
        for name in sorted(os.listdir(path), key=str.lower):
            if name.startswith(".") or name.startswith("$"):
                continue
            full = os.path.join(path, name)
            if os.path.isdir(full):
                # Đếm nhanh số .md (kể cả thư mục con) — giới hạn để nhẹ
                try:
                    md = len(_glob.glob(f"{full}/**/*.md", recursive=True)[:500])
                except Exception:
                    md = 0
                dirs.append({"name": name, "path": full, "md": md})
        parent = os.path.dirname(path.rstrip("\\/")) or None
        if os.name == "nt" and parent and len(parent) <= 2:
            parent = ""  # về danh sách ổ đĩa
        # Tự đếm md ngay trong path hiện tại
        here_md = len(_glob.glob(f"{path}/**/*.md", recursive=True)[:1000])
        return {"path": path, "parent": parent, "here_md": here_md, "dirs": dirs[:300]}
    except PermissionError:
        return {"error": "Không có quyền truy cập", "path": path, "parent": None, "dirs": []}
    except Exception as e:
        return {"error": str(e), "path": path, "parent": None, "dirs": []}


@app.get("/config")
async def config():
    return {
        "workspace_name": os.getenv("WORKSPACE_NAME", "Jarvis OS"),
        "user_name": os.getenv("USER_NAME", "Bạn"),
        "tts_voice": os.getenv("TTS_VOICE", "vi-VN-HoaiMyNeural"),
        "tts_rate": os.getenv("TTS_RATE", "+5%"),
    }


# ============================================
# TTS — Edge TTS (giọng Vietnamese chuẩn, miễn phí)
# ============================================
@app.get("/tts")
async def tts(
    text: str = Query(...),
    voice: str = Query("vi-VN-HoaiMyNeural"),
    rate: str = Query("+5%"),
):
    """Sinh audio TTS bằng Edge TTS."""
    import sys
    from fastapi import HTTPException, Response

    try:
        communicate = edge_tts.Communicate(text, voice, rate=rate)
        audio_buffer = bytearray()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_buffer.extend(chunk["data"])

        if not audio_buffer:
            print(f"[TTS] Empty audio for text={text[:50]!r}", file=sys.stderr)
            raise HTTPException(502, "Edge TTS không trả audio — server cần restart sau upgrade edge-tts.")

        return Response(
            content=bytes(audio_buffer),
            media_type="audio/mpeg",
            headers={"Cache-Control": "no-cache"}
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[TTS ERROR] {type(e).__name__}: {e}", file=sys.stderr)
        raise HTTPException(502, f"TTS failed: {type(e).__name__}: {e}")


@app.get("/tts/voices")
async def tts_voices():
    voices = await edge_tts.list_voices()
    return {
        "voices": [
            {"name": v["ShortName"], "gender": v["Gender"], "display": v["FriendlyName"]}
            for v in voices if v["Locale"].startswith("vi")
        ]
    }


# ============================================
# WebSocket — Voice chat với Claude Code
# ============================================
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    cli = ClaudeCLI(system_prompt=SYSTEM_PROMPT, cwd=CLAUDE_CWD)

    if not cli.is_available():
        await ws.send_text(json.dumps({
            "type": "error",
            "content": "Claude Code CLI chưa được cài. Chạy: npm install -g @anthropic-ai/claude-code"
        }))
        await ws.close()
        return

    try:
        while True:
            raw = await ws.receive_text()
            payload = json.loads(raw)

            # Lệnh đặc biệt
            if payload.get("action") == "reset":
                cli.reset_session()
                await ws.send_text(json.dumps({"type": "system", "content": "Đã reset hội thoại."}))
                continue

            user_message = payload.get("message", "").strip()
            if not user_message:
                continue
            brain = payload.get("brain", "brain")

            await ws.send_text(json.dumps({
                "type": "status",
                "content": "Jarvis đang suy nghĩ..."
            }))

            # Nạp bộ nhớ của vault đang chọn vào system prompt (Jarvis luôn nhớ)
            cli.system_prompt = build_system_prompt(brain)

            final_text = ""
            async for event in cli.query(user_message):
                etype = event["type"]

                if etype == "tool_call":
                    await ws.send_text(json.dumps({
                        "type": "tool_call",
                        "tool": event["name"],
                        "content": f"⚙ Đang gọi: {event['name']}"
                    }))
                elif etype == "tool_result":
                    await ws.send_text(json.dumps({
                        "type": "tool_result",
                        "content": event["content"][:200]
                    }))
                elif etype == "text":
                    # Stream từng đoạn text về frontend (real-time)
                    await ws.send_text(json.dumps({
                        "type": "stream",
                        "content": event["content"]
                    }))
                elif etype == "final":
                    final_text = event.get("content") or final_text
                    await ws.send_text(json.dumps({
                        "type": "response",
                        "content": final_text,
                        "session_id": event.get("session_id"),
                        "cost_usd": event.get("cost_usd"),
                    }))
                elif etype == "error":
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "content": event["content"]
                    }))

            # Log hội thoại vào Memory của vault để Jarvis tự học sau này
            if final_text:
                log_conversation(brain, user_message, final_text)

    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=7777, reload=False)
