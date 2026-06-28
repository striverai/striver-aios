# Brain — Second Brain của Jarvis OS

Thư mục này là **Second Brain self-contained** của Jarvis OS. Khi handoff (git clone), toàn bộ tri thức đi theo repo.

## Cấu trúc

| Folder | Vai trò |
|---|---|
| `00 - Inbox/` | Capture nhanh — Jarvis lưu ý tưởng/note thô vào đây |
| `01 - Sources/` | Nguồn thô: bài viết, transcript, screenshot |
| `02 - Wiki/` | Tri thức đã chưng cất — có `[[wikilink]]` nối với nhau |
| `03 - Projects/` | Dự án đang chạy |
| `04 - Daily/` | Daily log |

## Wikilink

Dùng `[[Tên Note]]` để nối các note. Lớp **Graph** trong dashboard đọc các link này để vẽ mạng lưới kết nối (giống Obsidian graph view / Graphify).

## Liên kết với Bullet Journal vault

Mặc định Jarvis cũng đọc vault chính tại `D:\My Bullet Journal` (cấu hình qua `OBSIDIAN_VAULT_PATH` trong `.env`). Graph có thể gộp cả 2 nguồn.
