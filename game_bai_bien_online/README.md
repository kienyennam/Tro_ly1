# 🏖️ Hẹn Hò Bên Biển – Online (bản thử nghiệm kín)

Nhiều người chơi cùng có mặt trên một bãi biển, gặp gỡ nhau và tương tác thời gian thực:

- 💬 **Nói** bằng câu có sẵn (không cho gõ tự do, để hạn chế nội dung xấu)
- 💗 **Thả tim**
- 🤝 **Cầm tay**: cần điểm thân thiết ≥ 15 và **người kia phải đồng ý**
- 📱 **Trao số điện thoại**: cần thân thiết ≥ 25, **cả hai cùng đồng ý** thì mới thấy số của nhau
- 😘 **Hôn má**: cần thân thiết ≥ 40, đang nắm tay, và người kia đồng ý
- 🛡️ **Chặn / Báo cáo** người chơi khác

## Chạy thử trên máy

```bash
cd game_bai_bien_online
npm install
ROOM_CODE=ma-phong-cua-ban npm start
```

Mở `http://localhost:3000` và nhập mã phòng. Có thể gửi link kèm mã phòng cho người chơi:
`http://<địa-chỉ>/?phong=ma-phong-cua-ban`

Các biến môi trường:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 3000 | Cổng máy chủ |
| `ROOM_CODE` | `bienxanh` | Mã phòng. **Nên đổi** để chỉ nhóm thử nghiệm vào được |
| `MAX_PLAYERS` | 30 | Số người tối đa cùng lúc |

## Đưa lên mạng

Ứng dụng là một tiến trình Node.js (≥ 18) có dùng WebSocket, nên cần nơi chạy được Node lâu dài: máy chủ ảo (VPS), Render, Railway, Fly.io…
GitHub Pages **không** chạy được, vì GitHub Pages chỉ phục vụ trang tĩnh.
Nên dùng HTTPS: trình duyệt sẽ tự chuyển sang `wss://`.

## Bảo vệ dữ liệu cá nhân (thiết kế hiện tại)

- Chỉ hỏi số điện thoại khi người chơi **chủ động** trao số.
- Số chỉ đi qua bộ nhớ máy chủ để chuyển cho đúng người kia, **không ghi ra đĩa, không ghi log**, và bị xóa ngay sau khi chuyển.
- Lời mời trao số hết hạn sau 20 giây. Bị từ chối thì số của người mời không được gửi đi.
- Báo cáo vi phạm chỉ ghi tên hiển thị và lý do ra log máy chủ.
- Không có tài khoản: điểm thân thiết và danh bạ mất khi thoát hoặc tải lại trang.

## Lưu ý trước khi mở rộng

Đây là **bản thử nghiệm kín** cho nhóm nhỏ. Trước khi mở công khai hoặc thu tiền, cần rà soát các quy định sau (cần kiểm tra lại hiệu lực):
- quy định về trò chơi điện tử trên mạng (Nghị định 147/2024/NĐ-CP; trò chơi nhiều người tương tác qua máy chủ nhiều khả năng thuộc loại G1);
- quy định về bảo vệ dữ liệu cá nhân (Nghị định 13/2023/NĐ-CP và các văn bản mới hơn).

Ngoài ra, nên xác minh tuổi thật thay vì chỉ cho người chơi tự xác nhận, và có người kiểm duyệt báo cáo.
