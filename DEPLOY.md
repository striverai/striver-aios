# Cài đặt Jarvis OS trên server / VPS

Jarvis OS là một AI agent cá nhân + Second Brain. "Bộ não" của nó là **Claude Code CLI**
(đăng nhập một lần, không cần API key). Có 3 cách chạy — chọn 1.

> ⚠️ **An toàn:** Jarvis chạy Claude với toàn quyền đọc/ghi file trên máy. Mặc định nó chỉ
> mở ở `localhost` (loopback). Đừng phơi cổng 7777 ra Internet nếu chưa đặt mật khẩu
> (vào dashboard → Settings để đặt) hoặc chưa có reverse-proxy xác thực phía trước.

---

## Cách 1 — Docker (dễ nhất, khuyến nghị cho VPS)

Cần: một VPS Linux (khuyên Ubuntu) đã có Docker. Chưa có Docker?
`curl -fsSL https://get.docker.com | sh`

```bash
# 1) Lấy mã nguồn về server
git clone https://github.com/blogminhquy/jarvis-os.git jarvis && cd jarvis

# 2) Tạo file cấu hình (mặc định chạy được luôn, sửa sau cũng được)
cp .env.example .env

# 3) Đăng nhập Claude (bộ não) — LÀM 1 LẦN
docker compose run --rm jarvis claude auth login --claudeai
#    → hiện 1 đường link + 1 mã. Mở link trên trình duyệt bất kỳ, dán mã, bấm duyệt.
#    Token được lưu vĩnh viễn trong volume claude-auth.

# 4) Bật Jarvis
docker compose up -d
```

Mở Jarvis: nó chỉ nghe ở `localhost` của server cho an toàn. Từ máy của bạn:
```bash
ssh -L 7777:localhost:7777 <user>@<ip-server>
# rồi mở http://localhost:7777 trên trình duyệt
```

Lệnh hằng ngày:
```bash
docker compose logs -f     # xem Jarvis đang làm gì
docker compose restart     # khởi động lại
docker compose down        # tắt
docker compose build --pull && docker compose up -d   # cập nhật
```

Mọi ghi chú / vault / settings nằm trong Docker volume (`jarvis-data`, `claude-auth`) →
**không mất** khi restart hay update.

### 🌐 Truy cập từ xa (Hostinger / VPS bất kỳ) — Cloudflare Tunnel

Mở giao diện Javis từ máy khác mà KHÔNG cần mở port / không cần tên miền — như Hermes:

1. **Đặt mật khẩu TRƯỚC (bắt buộc):** mở Javis (qua SSH tunnel ở bước 5) → Dashboard → **Tài khoản** → đặt mật khẩu admin. Javis chạy Claude toàn quyền trên máy → TUYỆT ĐỐI không phơi ra Internet khi chưa có mật khẩu. (Server cũng in cảnh báo nếu chạy public mà chưa đặt.)
2. Bật tunnel: `docker compose --profile tunnel up -d`
3. Lấy URL: `docker compose logs tunnel | grep trycloudflare` → mở `https://<ngẫu-nhiên>.trycloudflare.com` trên trình duyệt bất kỳ, đăng nhập mật khẩu. Giờ xem & thao tác Javis từ xa.

**URL cố định (tên miền riêng, kiểu `*.hstgr.cloud`):** tạo *named tunnel* ở Cloudflare Zero Trust (miễn phí) → lấy token → `TUNNEL_TOKEN=...` vào `.env` → đổi dòng `command` của service `tunnel` sang bản `run --token` (comment sẵn trong `docker-compose.yml`), trỏ tới `http://jarvis:7777`. Quick tunnel đổi URL mỗi lần restart; named tunnel cho URL ổn định.

---

## Cách 2 — Cài trực tiếp lên Linux/macOS (không Docker)

```bash
git clone https://github.com/blogminhquy/jarvis-os.git jarvis && cd jarvis
chmod +x install.sh && ./install.sh
```

Script tự cài Python + Node + Claude CLI, tạo venv, cài deps, đăng ký dịch vụ tự chạy khi
boot (systemd) và in ra địa chỉ. Nếu nó báo Claude chưa đăng nhập, chạy 1 lần:
```bash
claude auth login --claudeai
```
Quản lý dịch vụ: `journalctl -u jarvis -f` · `sudo systemctl restart jarvis`

---

## Cách 3 — Windows (máy cá nhân)

Double-click `setup.bat` (chạy hiện cửa sổ) hoặc `start-jarvis.vbs` (chạy ngầm).
Dừng bằng `stop-jarvis.bat`. Mở http://localhost:7777

---

## Biến môi trường (`.env`)

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `JARVIS_HOST` | Địa chỉ nghe. `127.0.0.1` = chỉ máy này; `0.0.0.0` = mọi nơi (Docker tự đặt) | `127.0.0.1` |
| `JARVIS_PORT` | Cổng | `7777` |
| `JARVIS_STATE_DIR` | Nơi Jarvis ghi state (settings, sessions, loop config) | `server/` (Docker: `/data/state`) |
| `OBSIDIAN_VAULT_PATH` | Vault Second Brain chính | `vault/` trong repo (Docker: `/data/vault`) |
| `BRAIN_PATH` | Thư mục brain | `brain/` trong repo (Docker: `/data/brain`) |
| `CLAUDE_CWD` | Thư mục làm việc của Claude CLI | repo root |

---

## 🔄 Cập nhật khi có code mới

Repo là **private** (`github.com/blogminhquy/jarvis-os`). Để `git clone`/`pull` trên VPS: khi git
hỏi mật khẩu, dán **Personal Access Token**; hoặc thêm SSH deploy key rồi clone qua
`git@github.com:blogminhquy/jarvis-os.git`.

Mỗi khi bạn push code mới, trên VPS chỉ cần:

```bash
cd jarvis && ./update.sh
```

Script tự `git pull` rồi:
- **Docker**: `docker compose build && docker compose up -d` — dữ liệu trong volume KHÔNG mất.
- **Native (systemd)**: `pip install -r requirements.txt` + `systemctl restart jarvis`.

Ép chế độ: `./update.sh docker` hoặc `./update.sh native`. Làm tay tương đương:
```bash
git pull && docker compose build && docker compose up -d          # Docker
git pull && ./.venv/bin/pip install -r requirements.txt && sudo systemctl restart jarvis   # Native
```

Trên máy Windows của bạn, đẩy code lên GitHub: `git add -A && git commit -m "..." && git push`

Để trống = dùng mặc định in-repo → cài trên máy mới chạy được ngay, không cần sửa gì.

---

## Đăng nhập Claude là bước duy nhất bắt buộc

"Bộ não" của Jarvis là Claude Code CLI. Token đăng nhập nằm trong `~/.claude`
(Docker: volume `claude-auth`). Đăng nhập 1 lần → tồn tại qua mọi restart/update.
Nếu đã đăng nhập trên máy khác, có thể copy thư mục `~/.claude` sang.
