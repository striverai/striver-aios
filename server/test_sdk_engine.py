"""Test engine Claude Agent SDK (v0.9.35). Chạy tay / CI:

    cd server && python test_sdk_engine.py

KHÔNG cần Claude CLI hay đăng nhập - chỉ test phần thuần logic:
- factory claude_engine chọn đúng engine theo env JAVIS_CLAUDE_ENGINE (mặc định cli).
- map_message: message SDK → event dict đúng 'hợp đồng ClaudeCLI' (text/tool_call/
  tool_result/final + session_id/token/cost).
- _permission_gate: whitelist per-call allow/deny + pattern fnmatch + ghi audit JSONL.
(Chạy THẬT end-to-end với CLI + auth nằm ở smoke test tay, không thuộc CI.)
"""
import asyncio
import json
import os
import sys
import tempfile

os.environ.setdefault("JAVIS_STATE_DIR", tempfile.mkdtemp(prefix="javis-sdktest-"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_fails = []


def check(name, cond):
    print(("ok  " if cond else "FAIL ") + name)
    if not cond:
        _fails.append(name)


# ---- 1. Factory chọn engine theo env ----
os.environ.pop("JAVIS_CLAUDE_ENGINE", None)
from claude_cli import claude_engine, ClaudeCLI          # noqa: E402
import claude_sdk_engine                                  # noqa: E402
from claude_sdk_engine import ClaudeSDK, map_message      # noqa: E402

eng = claude_engine(system_prompt="x", cwd=".", tag="t")
check("factory: mặc định → ClaudeCLI", isinstance(eng, ClaudeCLI))
os.environ["JAVIS_CLAUDE_ENGINE"] = "sdk"
eng = claude_engine(system_prompt="x", cwd=".", tag="t", allowed_tools=["Read"], model="haiku")
check("factory: env=sdk → ClaudeSDK", isinstance(eng, ClaudeSDK))
check("factory: truyền đủ tham số", eng.system_prompt == "x" and eng.allowed_tools == ["Read"]
      and eng.model == "haiku" and eng.tag == "t")
os.environ["JAVIS_CLAUDE_ENGINE"] = "cli"
check("factory: env=cli → ClaudeCLI", isinstance(claude_engine(), ClaudeCLI))
os.environ.pop("JAVIS_CLAUDE_ENGINE", None)

# ---- 2. map_message: parity hợp đồng event ----
from claude_agent_sdk import (AssistantMessage, UserMessage, SystemMessage, ResultMessage,  # noqa: E402
                              TextBlock, ToolUseBlock, ToolResultBlock)

evs, sid = map_message(SystemMessage(subtype="init", data={"session_id": "abc123"}))
check("map: init → bắt session_id, không event", evs == [] and sid == "abc123")

evs, sid = map_message(AssistantMessage(content=[
    TextBlock(text="xin chào"), TextBlock(text="   "),
    ToolUseBlock(id="t1", name="Read", input={"file_path": "a.md"})], model="claude"))
check("map: assistant → text + tool_call, bỏ text rỗng",
      evs == [{"type": "text", "content": "xin chào"},
              {"type": "tool_call", "name": "Read", "input": {"file_path": "a.md"}}])

evs, _ = map_message(UserMessage(content=[
    ToolResultBlock(tool_use_id="t1", content=[{"type": "text", "text": "nội dung file"}]),
    ToolResultBlock(tool_use_id="t2", content="chuỗi thẳng " + "x" * 600)]))
check("map: tool_result list + str, clip 500",
      evs[0] == {"type": "tool_result", "content": "nội dung file"}
      and evs[1]["content"].startswith("chuỗi thẳng") and len(evs[1]["content"]) == 500)

evs, sid = map_message(ResultMessage(
    subtype="success", duration_ms=1234, duration_api_ms=1000, is_error=False, num_turns=2,
    session_id="sess9", total_cost_usd=0.05, result="KQ",
    usage={"input_tokens": 10, "cache_read_input_tokens": 90, "cache_creation_input_tokens": 5,
           "output_tokens": 7}))
f = evs[0]
check("map: final đủ trường như ClaudeCLI",
      sid == "sess9" and f["type"] == "final" and f["content"] == "KQ"
      and f["session_id"] == "sess9" and f["cost_usd"] == 0.05 and f["duration_ms"] == 1234
      and f["tokens_in"] == 105 and f["tokens_out"] == 7)

evs, _ = map_message(UserMessage(content="chuỗi thuần không block"))
check("map: user content str → không event", evs == [])

# ---- 3. _permission_gate: whitelist per-call + audit ----


async def gate_tests():
    e = ClaudeSDK(tag="loop-test", allowed_tools=["Read", "Glob", "mcp__javis__pos_*"])
    r1 = await e._permission_gate("Read", {}, None)
    r2 = await e._permission_gate("Write", {"file_path": "x"}, None)
    r3 = await e._permission_gate("mcp__javis__pos_order", {}, None)
    r4 = await e._permission_gate("Bash", {"command": "rm -rf"}, None)
    check("gate: tool trong whitelist → allow", r1.behavior == "allow")
    check("gate: tool ngoài whitelist → deny kèm lý do",
          r2.behavior == "deny" and "Write" in r2.message)
    check("gate: pattern mcp__javis__pos_* khớp", r3.behavior == "allow")
    check("gate: Bash bị chặn", r4.behavior == "deny")


asyncio.run(gate_tests())
audit = claude_sdk_engine._AUDIT_PATH
lines = [json.loads(x) for x in audit.read_text(encoding="utf-8").splitlines()] if audit.exists() else []
check("audit: ghi đủ 4 quyết định JSONL", len(lines) == 4
      and lines[0]["allowed"] is True and lines[1]["allowed"] is False
      and lines[1]["tool"] == "Write" and lines[0]["tag"] == "loop-test")

if _fails:
    print(f"\nFAIL - {len(_fails)} test: {_fails}")
    sys.exit(1)
print("\nOK - test_sdk_engine: tất cả pass")
