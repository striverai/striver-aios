# Kế hoạch: chuyển engine Claude sang Claude Agent SDK (Python)

> Bản kế hoạch dev, viết 2026-07-12 trên nền code v0.9.34. Trạng thái: ĐỀ XUẤT - chưa làm.
> Mục tiêu: thay lớp tự chế spawn `claude` CLI (subprocess + parse stream-json) bằng
> `claude-agent-sdk` chính chủ, giữ nguyên giao diện với phần còn lại của Javis.

## 1. Vì sao (động lực)

Javis đang tự shell-out Claude Code CLI bằng `subprocess.Popen` + tự parse `--output-format
stream-json` trong `server/claude_cli.py` (~600 dòng). Lớp này là nơi dính bug liên tục:

- **WinError 206** (v0.9.31): Windows trần command line 32767 ký tự, phải tự chuyển prompt sang
  stdin. SDK chính chủ đã xử lý sẵn vấn đề này (docs khuyến nghị SystemPromptFile cho prompt to).
- Tự viết watchdog idle-timeout, tự kill cây tiến trình (`taskkill /T`), tự đọc stderr thread
  riêng, tự registry `_ACTIVE_PROCS` để Stop theo tag - toàn việc SDK làm hộ và được Anthropic
  bảo trì theo mỗi bản CLI mới.
- Quyền tool hiện là danh sách TĨNH `--allowedTools`/`--disallowedTools` truyền lúc spawn;
  3 mức quyền suggest/auto/full của Javis chỉ enforce được ở tầng hub MCP, KHÔNG chặn được
  tool builtin (Bash/Write) theo ngữ cảnh từng call.

`claude-agent-sdk` (pip, chỉ cần Python, auth KẾ THỪA đăng nhập Claude Code CLI = vẫn chạy
bằng gói subscription, đúng triết lý Javis) cho:

- `query()` / `ClaudeSDKClient` - vòng agentic + stream event có kiểu, khỏi tự parse JSON.
- `can_use_tool` callback + hook `PreToolUse` - quyết định CHO/CHẶN từng tool call bằng code
  Python NGAY trong tiến trình server -> map 1-1 với ma trận quyền read/write/danger của
  `mcp_catalog.classify` + 3 mức suggest/auto/full. Đây là nâng cấp an toàn lớn nhất.
- `@tool` + `create_sdk_mcp_server` - tool Python chạy IN-PROCESS: plugin host của Javis
  (javis_generate_image, datetime-vn...) đấu thẳng vào engine Claude không cần đi vòng hub HTTP.
- `resume` / `fork_session` / `interrupt` / session utilities (list_sessions, rename) - thay
  `--resume` tự chế + registry kill theo tag.
- `enable_file_checkpointing` + `rewind_files()` - tương lai: undo thao tác file của loop `auto`.

## 2. Phạm vi

- CHỈ engine Claude (provider `anthropic-cli`). CodexCLI (ChatGPT), engine API
  (OpenRouter/OpenAI/Anthropic API/Gemini) GIỮ NGUYÊN.
- Mọi call site hiện dùng `ClaudeCLI` phải chạy y hệt, KHÔNG sửa: chat web (main.py),
  metrics, workflow, lint, routines, Telegram, learn.py, tasks.py, reminders.py,
  self_improve.py (loop).

## 3. Kiến trúc đích: adapter giữ nguyên giao diện

Không đổi call site - viết `server/claude_sdk_engine.py` với class `ClaudeSDK` cùng "hợp đồng"
với `ClaudeCLI` hiện tại:

```
ClaudeCLI (hiện tại)                    ClaudeSDK (mới)
────────────────────                    ────────────────────
__init__(system_prompt, cwd, tag,       giữ nguyên chữ ký
         allowed_tools, model)
.session_id  (--resume)                 options.resume / fork_session
.mcp_config / .mcp_strict               options.mcp_servers / strict_mcp_config
.disallowed_tools                       options.disallowed_tools
.max_wall_s                             asyncio.wait_for + client.interrupt()
.query(prompt) -> yield dict            bọc AssistantMessage/ToolUseBlock/ResultMessage
  {type: text|tool_call|tool_result     về ĐÚNG các event dict cũ (text/tool_call/
   |final|error, session_id,            tool_result/final/error + tokens_in/out
   tokens_in/out, cost_usd}             + cost_usd từ ResultMessage)
cancel_all(tag)                         registry client theo tag -> client.interrupt()
```

Chọn engine bằng env `JAVIS_CLAUDE_ENGINE=sdk|cli` (mặc định `cli`). `find_claude_cli()` vẫn
là điều kiện khả dụng chung; SDK không thấy CLI thì fallback `cli` và log rõ.

Quyền 3 mức map vào `can_use_tool` (thay cho allowedTools tĩnh khi chạy SDK):

```
suggest  -> chỉ allow tool đọc (classify=read) + đọc file; deny còn lại kèm message lý do
auto     -> allow read+write nội vault; deny danger (tiền/đơn/gửi tin) + Bash ngoài vault
full     -> allow hết (như --dangerously-skip-permissions hiện tại)
```

Audit: mọi quyết định allow/deny ghi log như hub đang làm - engine Claude lần đầu có audit
tool builtin (Bash/Write/Edit) chứ không chỉ tool MCP.

## 4. Lộ trình (4 phase + spike)

**Phase 0 - Spike (0.5-1 ngày, quyết go/no-go):** cài `claude-agent-sdk` vào venv, viết script
thử trên Windows 11 + Python 3.12: (1) query subscription auth chạy không cần API key;
(2) stream text + tool event; (3) resume đúng session; (4) interrupt giữa chừng; (5) mcp_servers
trỏ file cấu hình hub hiện tại chạy được; (6) system prompt 26k + prompt 40k không lỗi;
(7) đo overhead spawn so với Popen hiện tại. Fail điểm nào ghi lại điểm đó.

**Phase 1 - Adapter chạy dark (1-2 ngày):** viết `claude_sdk_engine.py` + test contract
(so sánh chuỗi event SDK vs CLI trên cùng prompt). Flag mặc định `cli`, bật `sdk` thử tay.

**Phase 2 - Quyền + audit (1 ngày):** `can_use_tool` map 3 mức + audit log. Bật SDK cho
nhánh LOOP trước (được lợi nhất từ chặn per-call, blast radius nhỏ nhất vì loop mới mặc
định suggest + enabled:false).

**Phase 3 - Plugin in-process (0.5 ngày):** plugins_host đăng ký tool qua
`create_sdk_mcp_server` cho engine Claude (handler + schema plugin map thẳng vào `@tool`).
Hub HTTP giữ nguyên cho Codex + engine API.

**Phase 4 - Flip mặc định (sau 1-2 tuần dùng thật):** đổi mặc định sang `sdk`, giữ nhánh
`cli` một bản phát hành làm lối thoát, rồi mới xoá code Popen chết trong claude_cli.py.

## 5. Rủi ro + cách đỡ

- **SDK trẻ, đổi API nhanh** -> pin version trong requirements.txt; test contract trong CI
  bắt lệch sớm; adapter cô lập mọi import SDK vào 1 file.
- **Windows/event loop:** claude_cli.py từng phải né asyncio-subprocess bằng Popen+thread
  (tương thích Selector/Proactor). SDK dùng anyio - spike PHẢI chạy trong đúng uvicorn loop
  của Javis, không chỉ script rời.
- **Lệch phiên bản CLI:** SDK yêu cầu CLI mới hơn bản user cài -> spike xác định version sàn,
  trang Model hiện cảnh báo nếu CLI cũ.
- **Hồi quy hành vi ngầm** (fork nền max_wall_s, kill theo họ tag, stderr surfacing...) ->
  giữ nguyên semantics trong adapter, viết test cho từng semantics trước khi flip.
- **Rollback:** flag env đổi lại `cli` là xong, không đụng dữ liệu.

## 6. Tiêu chí thành công

1. Toàn bộ luồng hiện có (chat/workflow/loop/telegram/task/reminder) chạy trên SDK không sửa
   call site, event UI y hệt.
2. Loop mode suggest bị CHẶN THẬT khi thử gọi Write/Bash (hiện chỉ chặn được qua allowedTools
   lúc spawn); audit log ghi lại quyết định.
3. Xoá được >= 300 dòng code tự chế trong claude_cli.py sau Phase 4.
4. Không tăng p50 latency lượt chat quá 10% so với Popen hiện tại.

## 7. Việc KHÔNG làm đợt này

- Không migrate CodexCLI (không có SDK tương đương; giữ Popen + stdin fix v0.9.31).
- Không bỏ hub MCP (Codex + engine API vẫn cần; hub vẫn là chỗ quản multi-account + OAuth).
- Không dùng session_store/checkpointing của SDK thay SQLite sessions của Javis (xem lại sau).
