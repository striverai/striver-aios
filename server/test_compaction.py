"""Test nén hội thoại dài engine API (v0.9.34). Chạy tay / CI:

    cd server && python test_compaction.py

Không cần API key, không chạm mạng (api_stream giả). Phủ: trim_history giữ run system
dẫn đầu, migration cột compact cho DB cũ, seed_messages chèn tóm tắt, maybe_compact
nén đúng ngưỡng + gộp tóm tắt cũ + không phá khi provider lỗi.
"""
import asyncio
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import compaction                      # noqa: E402
from sessions import SessionStore     # noqa: E402

_fails = []


def check(name, cond):
    print(("ok  " if cond else "FAIL ") + name)
    if not cond:
        _fails.append(name)


# ---- 1. trim_history ----
check("trim: rỗng an toàn", compaction.trim_history([]) == [])
short = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]
check("trim: ngắn giữ nguyên", compaction.trim_history(short) is short)

msgs = [{"role": "system", "content": "sys"}, {"role": "system", "content": "tóm tắt nén"}]
for i in range(20):
    msgs.append({"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"})
out = compaction.trim_history(msgs, max_msgs=12)
check("trim: giữ CẢ 2 system dẫn đầu (system prompt + tóm tắt)",
      [m["content"] for m in out[:2]] == ["sys", "tóm tắt nén"])
check("trim: tail đúng cửa sổ", len(out) <= 2 + 12)
check("trim: tail mở đầu bằng user", out[2]["role"] == "user")
check("trim: không mutate input", len(msgs) == 22)

# ---- 2. Migration DB cũ (chưa có cột compact) ----
tmp = Path(tempfile.mkdtemp(prefix="javis-compacttest-"))
old_db = tmp / "old.db"
conn = sqlite3.connect(str(old_db))
conn.executescript("""
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT, brain TEXT NOT NULL DEFAULT 'brain',
    engine TEXT, model TEXT, cli_session_id TEXT,
    created_at REAL NOT NULL, updated_at REAL NOT NULL,
    msg_count INTEGER NOT NULL DEFAULT 0, parent_session_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT, ts REAL NOT NULL, tool_calls_json TEXT
);
""")
conn.commit()
conn.close()
store = SessionStore(db_path=old_db)
sid = store.create_session(brain="brain")
store.set_compact(sid, "tóm tắt thử", 4)
sess = store.get_session(sid)
check("migration: DB cũ thêm cột + set/get compact chạy",
      sess.get("compact_summary") == "tóm tắt thử" and sess.get("compact_count") == 4)

# ---- 3. seed_messages ----
store2 = SessionStore(db_path=tmp / "s2.db")
sid2 = store2.create_session(brain="brain")
raw = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(10)]
check("seed: chưa nén → giữ nguyên", compaction.seed_messages(store2, sid2, raw) is raw)
store2.set_compact(sid2, "đã bàn về X, chốt Y", 6)
seeded = compaction.seed_messages(store2, sid2, raw)
check("seed: bỏ 6 message đầu đã phủ", len(seeded) == 1 + 4)
check("seed: tóm tắt là system message đầu",
      seeded[0]["role"] == "system" and "đã bàn về X" in seeded[0]["content"])
check("seed: message sau tóm tắt đúng mạch", seeded[1]["content"] == "m6")

# ---- 4. maybe_compact với api_stream giả ----
calls = []


def fake_stream(text):
    async def _f(prov, key, model, messages, reasoning):
        calls.append(messages[0]["content"])
        yield {"type": "meta", "model": model}
        yield {"type": "text", "content": text}
    return _f


async def main():
    st = SessionStore(db_path=tmp / "s3.db")
    s = st.create_session(brain="brain")
    for i in range(10):   # 10 message: cut = 10-12 < 0 → chưa nén
        st.append_message(s, "user" if i % 2 == 0 else "assistant", f"nội dung {i}")
    r = await compaction.maybe_compact(st, s, "openrouter", "k", "m", fake_stream("TT1"))
    check("compact: dưới ngưỡng → không nén", r is False and not calls)

    for i in range(10, 20):   # 20 message: cut = 8 >= min_chunk 6 → nén msgs[0:8]
        st.append_message(s, "user" if i % 2 == 0 else "assistant", f"nội dung {i}")
    r = await compaction.maybe_compact(st, s, "openrouter", "k", "m", fake_stream("TT1"))
    sess = st.get_session(s)
    check("compact: đủ ngưỡng → nén", r is True)
    check("compact: lưu summary + count=8",
          sess.get("compact_summary") == "TT1" and sess.get("compact_count") == 8)
    check("compact: prompt chứa nội dung cần nén", "nội dung 0" in calls[-1] and "nội dung 7" in calls[-1])

    r = await compaction.maybe_compact(st, s, "openrouter", "k", "m", fake_stream("TT-thừa"))
    check("compact: ngay sau đó → không nén lại (idempotent)", r is False)

    for i in range(20, 26):   # 26 message: cut = 14, 14-8 = 6 → nén tiếp, GỘP tóm tắt cũ
        st.append_message(s, "user" if i % 2 == 0 else "assistant", f"nội dung {i}")
    r = await compaction.maybe_compact(st, s, "openrouter", "k", "m", fake_stream("TT2"))
    sess = st.get_session(s)
    check("compact: vòng 2 nén tiếp count=14", r is True and sess.get("compact_count") == 14)
    check("compact: prompt vòng 2 mang tóm tắt cũ để gộp", "TT1" in calls[-1])

    async def err_stream(prov, key, model, messages, reasoning):
        yield {"type": "error", "content": "provider chết"}
    for i in range(26, 34):
        st.append_message(s, "user" if i % 2 == 0 else "assistant", f"nội dung {i}")
    r = await compaction.maybe_compact(st, s, "openrouter", "k", "m", err_stream)
    sess = st.get_session(s)
    check("compact: provider lỗi → False, giữ nguyên tóm tắt cũ",
          r is False and sess.get("compact_summary") == "TT2" and sess.get("compact_count") == 14)


asyncio.run(main())

if _fails:
    print(f"\nFAIL - {len(_fails)} test: {_fails}")
    sys.exit(1)
print("\nOK - test_compaction: tất cả pass")
