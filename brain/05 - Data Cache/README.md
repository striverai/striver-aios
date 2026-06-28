# 05 - Data Cache

Lưu snapshot số liệu kinh doanh theo kỳ. Mục đích: không phải gọi lại MCP khi hỏi về dữ liệu đã đóng kỳ.

## Quy tắc cache

| Loại dữ liệu | Nên cache? | Lý do |
|---|---|---|
| Báo cáo tháng/tuần đã đóng | Có | Số không thay đổi nữa |
| Tổng hợp theo kỳ (top SP, doanh thu...) | Có | Load nặng, dùng nhiều lần |
| Dữ liệu hôm nay / đang chạy | Không | Cần số mới nhất |
| Tồn kho realtime | Không | Thay đổi liên tục |

## Cấu trúc

```
05 - Data Cache/
  pos/           → Số liệu từ POSCAKE (doanh thu, đơn hàng, sản phẩm...)
  facebook-ads/  → Số liệu quảng cáo Meta
  calendar/      → Tóm tắt lịch tuần đã qua
```

## Định dạng file

Tên file: `{nguồn}_{YYYY-MM}_{loại}.md`

Ví dụ:
- `pos_2026-06_doanh-thu.md`
- `facebook-ads_2026-06_hieu-suat.md`

## Cách Jarvis dùng cache

1. Khi được hỏi về kỳ đã đóng → kiểm tra cache trước
2. Nếu có cache → đọc trực tiếp, không gọi MCP
3. Nếu chưa có → gọi MCP, lưu cache, trả lời
4. Kỳ hiện tại (hôm nay/tuần này) → luôn gọi MCP để lấy số mới nhất
