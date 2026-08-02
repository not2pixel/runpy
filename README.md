# RunPy — Trình biên dịch Python trực tuyến

Web app chạy code Python trên trình duyệt, dành cho người mới học.

## Cài đặt & chạy

```bash
cd runpy
npm install

# Cài tini — BẮT BUỘC, xem lý do ở mục cảnh báo bên dưới
sudo apt-get update && sudo apt-get install -y tini

# Chạy server qua tini ở chế độ subreaper (-s)
tini -s -- node server.js
```

Server chạy tại `http://<ip-server>:25080`.

Yêu cầu trên máy chủ: **Node.js ≥ 18**, **python3**, và **tini** đã cài sẵn.

## ⚠️ BẮT BUỘC: chạy qua `tini -s`, không chạy `node server.js` trực tiếp

Khi code Python của người dùng tự tạo thêm tiến trình con (`os.fork()`, `multiprocessing`, hoặc vô tình/cố ý tạo fork-bomb), các tiến trình con này có thể chết trước cha của chúng và trở thành **zombie process**. Nếu không có gì đứng ra "dọn" (reap) chúng, zombie sẽ tích tụ dần và cuối cùng làm cạn kiệt bảng tiến trình của *toàn bộ máy chủ* — gây lỗi `fork: Resource temporarily unavailable` cho mọi tiến trình trên máy, không riêng gì RunPy. (Đây chính là nguyên nhân gốc của lỗi bạn từng gặp.)

`tini -s` giải quyết việc này bằng cách đứng làm "subreaper": nó tự động dọn mọi tiến trình mồ côi thay vì để chúng trôi nổi. Đây là giải pháp chuẩn, được dùng rộng rãi trong Docker (`docker run --init` thực chất cũng dùng tini bên dưới).

**Nếu deploy bằng Docker**, chỉ cần thêm cờ `--init` khi chạy container (không cần cài tini thủ công):
```bash
docker run --init -p 25080:25080 your-runpy-image
```

**Nếu deploy bằng PM2** (xem mục dưới): PM2 tự quản lý tiến trình con trực tiếp của nó nhưng KHÔNG dọn zombie cháu (grandchildren) do code Python tự fork ra — vẫn cần chạy PM2 qua `tini -s` hoặc bật `--init` nếu dùng trong container.

## Chạy nền / production (khuyến nghị dùng PM2)

```bash
sudo apt-get install -y tini
npm install -g pm2
pm2 start "tini -s -- node server.js" --name runpy
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
