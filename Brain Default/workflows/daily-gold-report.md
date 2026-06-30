---
type: workflow
name: Daily Gold Price Report
slug: daily-gold-report
status: active
description: Báo cáo giá vàng hàng ngày lúc 7h sáng
steps:
  - agent: gold-price-reporter
    task: "Fetch giá vàng hôm nay ({{input}}), so sánh hôm qua, báo cáo theo style Jarvis kèm metrics card"
updated: 2026-06-30
---

## Mục đích
Workflow tự động cập nhật giá vàng vào lúc 7h sáng mỗi ngày.

## Quy trình
1. Agent `gold-price-reporter` fetch giá vàng từ source được cấu hình
2. Format báo cáo (prose + metrics card)
3. Gửi lên dashboard cho user

## Setup
- **Schedule:** 7h sáng mỗi ngày (dùng skill `schedule`)
- **Source:** cần xác định (API / MCP / Website scraping)
- **Input:** loại vàng cần báo (mặc định: vàng 9999)
