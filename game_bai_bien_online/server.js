'use strict';
/**
 * Máy chủ "Hẹn Hò Bên Biển – Online" (bản thử nghiệm kín).
 * - Phục vụ tệp tĩnh trong thư mục public/
 * - Đồng bộ người chơi thời gian thực qua WebSocket (/ws)
 * - Số điện thoại chỉ đi qua bộ nhớ, KHÔNG ghi ra đĩa, KHÔNG ghi log,
 *   và chỉ được gửi cho đúng người kia khi cả hai cùng đồng ý.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ROOM_CODE = (process.env.ROOM_CODE || 'bienxanh').trim().toLowerCase();
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 30;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Kích thước thế giới (khớp với client)
const W = 960, FLOOR_MIN = 385, FLOOR_MAX = 515;
const NEAR = 110;               // khoảng cách được coi là "đứng gần"
const REQ_TIMEOUT = 20000;      // lời mời hết hạn sau 20 giây

// Ngưỡng thân thiết (mỗi cặp)
const GATE = { hand: 15, phone: 25, kiss: 40 };
const GAIN = { heart: 1, say: 3, hand: 5, kiss: 8, phone: 5 };

// Câu nói có sẵn – không cho gõ tự do để hạn chế nội dung xấu
const PHRASES = [
  'Chào bạn 👋', 'Biển hôm nay đẹp nhỉ?', 'Bạn đến từ đâu vậy?', 'Đi dạo cùng mình không?',
  'Nụ cười của bạn đẹp ghê 😊', 'Cảm ơn bạn nhé!', 'Hihi 🙈', 'Mình đi trước nhé, hẹn gặp lại!'
];

// ---------- HTTP tĩnh ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Không tìm thấy'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
});

// ---------- Trạng thái ----------
const players = new Map();   // id -> player
const bonds = new Map();     // "a|b" -> điểm thân thiết
const pending = new Map();   // reqId -> {id, from, to, type, phone, timer}

const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
const getBond = (a, b) => bonds.get(pairKey(a, b)) || 0;
function addBond(a, b, n) {
  const v = Math.min(100, getBond(a, b) + n);
  bonds.set(pairKey(a, b), v);
  sendTo(a, { t: 'bond', with: b, v });
  sendTo(b, { t: 'bond', with: a, v });
}
const dist = (a, b) => Math.hypot(a.x - b.x, (a.y - b.y) * 1.6);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const blockedEither = (a, b) => a.blocked.has(b.id) || b.blocked.has(a.id);

function pub(p) { return { id: p.id, name: p.name, avatar: p.avatar, color: p.color, x: p.x, y: p.y, dir: p.dir, holding: p.holding }; }
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function sendTo(id, msg) { const p = players.get(id); if (p) send(p.ws, msg); }
function broadcast(msg, except) {
  const s = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.id === except) continue;
    if (msg.from && p.blocked.has(msg.from)) continue;
    if (p.ws.readyState === 1) p.ws.send(s);
  }
}

function cleanName(s) {
  return String(s || '').replace(/[<>&"'`\\\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}
// Số di động Việt Nam: 0xxxxxxxxx hoặc +84xxxxxxxxx (đầu số 3,5,7,8,9)
function cleanPhone(s) {
  const v = String(s || '').replace(/[\s.\-()]/g, '');
  return /^(0|\+84)(3|5|7|8|9)\d{8}$/.test(v) ? v : null;
}

function release(p) {
  if (!p.holding) return;
  const q = players.get(p.holding);
  p.holding = null;
  if (q && q.holding === p.id) q.holding = null;
  broadcast({ t: 'unhold', a: p.id, b: q ? q.id : null });
}

function cancelRequestsOf(id) {
  for (const [rid, r] of pending) if (r.from === id || r.to === id) { clearTimeout(r.timer); pending.delete(rid); sendTo(r.from === id ? r.to : r.from, { t: 'reqGone', reqId: rid }); }
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
wss.on('connection', ws => {
  let me = null;
  let budget = 40, last = Date.now(); // chống spam: ~40 thông điệp/giây

  ws.on('message', raw => {
    const now = Date.now();
    budget = Math.min(40, budget + (now - last) / 25); last = now;
    if (--budget < 0) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (!me) {
      if (m.t !== 'join') return;
      if (String(m.code || '').trim().toLowerCase() !== ROOM_CODE) return send(ws, { t: 'denied', reason: 'Mã phòng không đúng.' });
      if (m.adult !== true) return send(ws, { t: 'denied', reason: 'Trò chơi chỉ dành cho người từ đủ 18 tuổi.' });
      const name = cleanName(m.name);
      if (name.length < 2) return send(ws, { t: 'denied', reason: 'Tên cần từ 2 đến 16 ký tự.' });
      if (players.size >= MAX_PLAYERS) return send(ws, { t: 'denied', reason: 'Phòng đã đầy, vui lòng quay lại sau.' });
      me = {
        id: crypto.randomBytes(5).toString('hex'), ws, name,
        avatar: m.avatar === 'girl' ? 'girl' : 'boy',
        color: ['#3aa0d8', '#ff8fab', '#7bc67b', '#f4a261', '#9b7bd6', '#e76f51', '#2ec4b6', '#ffb703'][Math.floor(Math.random() * 8)],
        x: 150 + Math.random() * 660, y: FLOOR_MIN + Math.random() * (FLOOR_MAX - FLOOR_MIN), dir: 1,
        holding: null, blocked: new Set(), lastAct: 0
      };
      players.set(me.id, me);
      send(ws, { t: 'welcome', id: me.id, me: pub(me), players: [...players.values()].filter(p => p !== me).map(pub), phrases: PHRASES, gate: GATE });
      broadcast({ t: 'join', p: pub(me) }, me.id);
      return;
    }

    const other = typeof m.to === 'string' ? players.get(m.to) : null;
    switch (m.t) {
      case 'move': {
        me.x = clamp(Number(m.x) || 0, 30, W - 30);
        me.y = clamp(Number(m.y) || 0, FLOOR_MIN, FLOOR_MAX);
        me.dir = m.dir < 0 ? -1 : 1;
        broadcast({ t: 'move', id: me.id, x: me.x, y: me.y, dir: me.dir, mv: !!m.mv }, me.id);
        break;
      }
      case 'heart':
      case 'say': {
        if (now - me.lastAct < 700) return;
        me.lastAct = now;
        const idx = m.t === 'say' ? Number(m.idx) : -1;
        if (m.t === 'say' && !(idx >= 0 && idx < PHRASES.length)) return;
        const target = other && !blockedEither(me, other) ? other : null;
        broadcast({ t: m.t, from: me.id, to: target ? target.id : null, idx });
        if (target && dist(me, target) < NEAR * 1.5) {
          const k = 'g' + m.t + pairKey(me.id, target.id);
          if (!me[k] || now - me[k] > (m.t === 'say' ? 2500 : 2000)) { me[k] = now; addBond(me.id, target.id, GAIN[m.t]); }
        }
        break;
      }
      case 'req': { // mời cầm tay / hôn má / trao số
        const type = m.type;
        if (!['hand', 'kiss', 'phone'].includes(type) || !other || other === me) return;
        if (blockedEither(me, other)) return send(ws, { t: 'toast', text: 'Không thể tương tác với người này.' });
        if (dist(me, other) > NEAR) return send(ws, { t: 'toast', text: 'Hãy lại gần hơn nhé.' });
        const b = getBond(me.id, other.id);
        if (b < GATE[type]) return send(ws, { t: 'toast', text: `Cần thân thiết ≥ ${GATE[type]} (hiện ${b}). Trò chuyện thêm đã!` });
        if (type === 'hand' && (me.holding || other.holding)) return send(ws, { t: 'toast', text: 'Một trong hai người đang nắm tay rồi.' });
        if (type === 'kiss' && me.holding !== other.id) return send(ws, { t: 'toast', text: 'Hãy nắm tay nhau trước đã 🤝' });
        let phone = null;
        if (type === 'phone') { phone = cleanPhone(m.phone); if (!phone) return send(ws, { t: 'toast', text: 'Số điện thoại chưa hợp lệ.' }); }
        for (const r of pending.values()) if (r.from === me.id && r.to === other.id) return send(ws, { t: 'toast', text: 'Đang chờ người kia trả lời...' });
        const id = crypto.randomBytes(4).toString('hex');
        const r = { id, from: me.id, to: other.id, type, phone };
        r.timer = setTimeout(() => { pending.delete(id); sendTo(r.from, { t: 'reqResult', reqId: id, type, ok: false, by: other.id, reason: 'timeout' }); sendTo(r.to, { t: 'reqGone', reqId: id }); }, REQ_TIMEOUT);
        pending.set(id, r);
        sendTo(other.id, { t: 'req', reqId: id, type, from: me.id, name: me.name });
        send(ws, { t: 'toast', text: 'Đã gửi lời mời, chờ người kia đồng ý...' });
        break;
      }
      case 'resp': {
        const r = pending.get(String(m.reqId));
        if (!r || r.to !== me.id) return;
        const from = players.get(r.from);
        clearTimeout(r.timer); pending.delete(r.id);
        if (!from) return;
        if (!m.accept) { r.phone = null; return sendTo(from.id, { t: 'reqResult', reqId: r.id, type: r.type, ok: false, by: me.id }); }
        if (dist(me, from) > NEAR * 1.3 && r.type !== 'phone') return send(ws, { t: 'toast', text: 'Hai người đã đi quá xa nhau.' });
        if (r.type === 'hand') {
          if (me.holding || from.holding) return;
          me.holding = from.id; from.holding = me.id;
          broadcast({ t: 'hold', a: from.id, b: me.id });
          addBond(from.id, me.id, GAIN.hand);
        } else if (r.type === 'kiss') {
          if (from.holding !== me.id) return;
          broadcast({ t: 'kiss', a: from.id, b: me.id });
          addBond(from.id, me.id, GAIN.kiss);
        } else if (r.type === 'phone') {
          const myPhone = cleanPhone(m.phone);
          if (!myPhone) { r.phone = null; sendTo(from.id, { t: 'reqResult', reqId: r.id, type: 'phone', ok: false, by: me.id }); return send(ws, { t: 'toast', text: 'Số điện thoại chưa hợp lệ, lời mời đã hủy.' }); }
          // Chỉ gửi cho đúng hai người trong cặp. Không lưu lại.
          sendTo(from.id, { t: 'phone', from: me.id, name: me.name, phone: myPhone });
          send(ws, { t: 'phone', from: from.id, name: from.name, phone: r.phone });
          r.phone = null;
          addBond(from.id, me.id, GAIN.phone);
        }
        sendTo(from.id, { t: 'reqResult', reqId: r.id, type: r.type, ok: true, by: me.id });
        break;
      }
      case 'release': release(me); break;
      case 'block': {
        if (!other || other === me) return;
        me.blocked.add(other.id);
        if (me.holding === other.id) release(me);
        for (const [rid, r] of pending) if ((r.from === me.id && r.to === other.id) || (r.from === other.id && r.to === me.id)) { clearTimeout(r.timer); pending.delete(rid); }
        send(ws, { t: 'toast', text: `Đã chặn ${other.name}. Hai bạn sẽ không thấy nhau nữa.` });
        send(ws, { t: 'leave', id: other.id });
        sendTo(other.id, { t: 'leave', id: me.id });
        break;
      }
      case 'report': {
        if (!other || other === me) return;
        const reason = String(m.reason || '').slice(0, 60).replace(/[\u0000-\u001f]/g, '');
        // Chỉ ghi tên hiển thị và lý do – không ghi dữ liệu cá nhân khác.
        console.log(`[BÁO CÁO] ${new Date().toISOString()} "${me.name}" báo cáo "${other.name}": ${reason}`);
        send(ws, { t: 'toast', text: 'Cảm ơn bạn, báo cáo đã được ghi nhận.' });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!me) return;
    release(me);
    cancelRequestsOf(me.id);
    players.delete(me.id);
    for (const k of [...bonds.keys()]) if (k.includes(me.id)) bonds.delete(k);
    broadcast({ t: 'leave', id: me.id });
  });
});

server.listen(PORT, () => {
  console.log(`Hẹn Hò Bên Biển – Online đang chạy tại http://localhost:${PORT}`);
  console.log(`Mã phòng: ${ROOM_CODE === 'bienxanh' ? 'bienxanh (mặc định – nên đổi bằng biến môi trường ROOM_CODE)' : '(đã đặt qua ROOM_CODE)'}`);
});
