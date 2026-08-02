# RunPy — Trình biên dịch Python trực tuyến

Web app chạy code Python trên trình duyệt, dành cho người mới học.

## Cài đặt & chạy

```bash
cd runpy
npm install
node server.js
```

Server chạy tại `http://<ip-server>:25080`.

Yêu cầu trên máy chủ: **Node.js ≥ 18** và **python3** đã cài sẵn (`python3 --version` để kiểm tra).

## Chạy nền / production (khuyến nghị dùng PM2)

```bash
npm install -g pm2
pm2 start server.js --name runpy
pm2 save
pm2 startup   # để tự khởi động lại khi server reboot
```

Nếu deploy sau Nginx/Caddy, reverse-proxy về `127.0.0.1:25080`.

## Cách hoạt động / các giới hạn đã cài sẵn

| Giới hạn | Giá trị | Mục đích |
|---|---|---|
| Số người chạy code cùng lúc | 10 luồng, hàng đợi tối đa 30 | Ổn định tốc độ khi đông người |
| Thời gian chạy mỗi lần | 8 giây (`timeout`) | Chặn vòng lặp vô hạn |
| Bộ nhớ mỗi tiến trình | 256MB (`ulimit -v`) | Chặn code ăn hết RAM server |
| Số tiến trình con | 24 (`ulimit -u`) | Chặn fork-bomb |
| Dung lượng lưu trữ / người | 20MB (`sessions/<id>`) | Free quota theo yêu cầu |
| Session hết hạn | 2 giờ không hoạt động | Tự dọn dẹp ổ đĩa |

Mỗi người dùng được cấp một `sessionId` ngẫu nhiên lưu trong `localStorage` trình duyệt, tương ứng với 1 thư mục riêng trong `sessions/` — code và file họ tạo ra (nếu ghi file) đều nằm trong không gian 20MB đó, độc lập với người khác.

## ⚠️ Giới hạn về bảo mật cần biết

Sandbox hiện tại dùng `ulimit` + `timeout` ở mức hệ điều hành (không dùng Docker/container). Việc này đã chặn được:
- Vòng lặp vô hạn, treo CPU quá lâu
- Ăn hết RAM
- Fork-bomb
- Ghi file vượt quota

Nhưng **không cách ly hoàn toàn** như container thật (code Python vẫn chạy chung user hệ thống với server, có thể đọc file hệ thống nếu có quyền, hoặc gọi mạng ra ngoài). Nếu công khai cho người lạ dùng ở quy mô lớn hơn, nên nâng cấp lên chạy mỗi lần thực thi trong **Docker container tạm thời** hoặc dùng **gVisor/Firecracker** để cách ly triệt để. Với quy mô ~10 người dùng quen biết/học viên, mức bảo vệ hiện tại là hợp lý.

## Cấu trúc

```
runpy/
├── server.js          # Express server + sandbox thực thi
├── public/
│   ├── index.html      # Giao diện
│   ├── style.css
│   └── script.js        # Gọi API, hiển thị kết quả, quản lý session
└── sessions/            # Nơi lưu code/file của từng người dùng (tự tạo)
```
