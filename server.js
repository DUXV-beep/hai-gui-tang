// 自定义服务器：同时承载 Next.js 与 Socket.io
const path = require('node:path');

// 手动加载 .env.local，确保 API Key 在启动时进入环境变量
try {
  process.loadEnvFile(path.join(process.cwd(), '.env.local'));
} catch {}

const { createServer } = require('http');
const { randomUUID, createHash } = require('node:crypto');
const next = require('next');
const { Server } = require('socket.io');
const db = require('./lib/db');
const ai = require('./lib/aiHost');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

// 内存中的房间：key 为 roomId；rooms 表持久化房间配置与进度，重启后可恢复
const rooms = new Map();

// 房主离线宽限期：期间原房主可凭 playerId/hostToken 认领，超时才把房主移交给其他玩家（防假房主）
const HOST_TRANSFER_GRACE_MS = 60 * 1000;

// 公开房列表最多展示数（防止房间过多时列表无限延长）
const MAX_PUBLIC_ROOMS = 30;

// 房间持久化：写入/更新 rooms 表（players 是实时的，不持久化）
// chat_history/ask_history/弃权状态也入库，保证服务器重启后对局可继续
function saveRoom(room) {
  db.prepare(
    `INSERT INTO rooms (id, host_token, max_players, max_questions, question_count, status, sip_id, used_sip_ids, room_name, is_public, password, password_hash, password_salt, sip_tags, started_at, hint_enabled, hint_limit, hint_used, chat_history, ask_history, surrender_open, surrender_votes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       host_token=excluded.host_token,
       max_players=excluded.max_players,
       max_questions=excluded.max_questions,
       question_count=excluded.question_count,
       status=excluded.status,
       sip_id=excluded.sip_id,
       used_sip_ids=excluded.used_sip_ids,
       room_name=excluded.room_name,
       is_public=excluded.is_public,
       password=excluded.password,
       password_hash=excluded.password_hash,
       password_salt=excluded.password_salt,
       sip_tags=excluded.sip_tags,
       started_at=excluded.started_at,
       hint_enabled=excluded.hint_enabled,
       hint_limit=excluded.hint_limit,
       hint_used=excluded.hint_used,
       chat_history=excluded.chat_history,
       ask_history=excluded.ask_history,
       surrender_open=excluded.surrender_open,
       surrender_votes=excluded.surrender_votes`
  ).run(
    room.id,
    room.hostToken,
    room.maxPlayers,
    Number.isFinite(room.maxQuestions) ? room.maxQuestions : null,
    room.questionCount,
    room.status,
    room.sip ? room.sip.id : null,
    JSON.stringify(room.usedSipIds),
    room.roomName,
    room.isPublic ? 1 : 0,
    room.passwordHash ? null : (room.password || null), // 新库只存散列；老库明文仅在尚未散列时保留
    room.passwordHash || null,
    room.passwordSalt || null,
    JSON.stringify(room.sipTags || []),
    room.startedAt,
    room.hintEnabled ? 1 : 0,
    room.hintLimit,
    room.hintUsed,
    JSON.stringify(room.chatHistory || []),
    JSON.stringify(room.askHistory || []),
    room.surrenderOpen ? 1 : 0,
    JSON.stringify(Array.from(room.surrenderVotes || [])),
    room.createdAt
  );
}

function deleteRoom(id) {
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
}

// 启动时从数据库恢复房间（players 清空，重连后重新加入；房主凭 hostToken 认领）
function loadRooms() {
  const saved = db.prepare('SELECT * FROM rooms').all();
  for (const r of saved) {
    const sip = r.sip_id
      ? db.prepare('SELECT id, title, content, answer, difficulty FROM sips WHERE id = ?').get(r.sip_id) ||
        null
      : null;
    rooms.set(r.id, {
      id: r.id,
      players: new Map(),
      sip,
      status: r.status,
      hostId: null, // 重启后 players 为空，房主凭 hostToken/playerId 重连认领
      hostLostAt: Date.now(), // 重启后房主视为离线，从此刻开始计宽限期
      hostToken: r.host_token,
      maxPlayers: r.max_players,
      maxQuestions: r.max_questions == null ? Infinity : r.max_questions,
      questionCount: r.question_count,
      deduceCount: 0,
      usedSipIds: JSON.parse(r.used_sip_ids || '[]'),
      roomName: r.room_name,
      isPublic: !!r.is_public,
      password: r.password || '',
      passwordHash: r.password_hash || '',
      passwordSalt: r.password_salt || '',
      sipTags: JSON.parse(r.sip_tags || '[]'),
      pendingLeave: new Map(), // pid -> 延迟离开公告定时器（重连可取消）
      startedAt: r.started_at,
      hintEnabled: !!r.hint_enabled,
      hintLimit: r.hint_limit || 3,
      hintUsed: r.hint_used || 0,
      askHistory: JSON.parse(r.ask_history || '[]'),
      chatHistory: JSON.parse(r.chat_history || '[]'),
      surrenderOpen: !!r.surrender_open,
      surrenderVotes: new Set(JSON.parse(r.surrender_votes || '[]')),
      createdAt: r.created_at,
    });
  }
}
loadRooms();

// 没填昵称的玩家自动命名为「玩家N」，N = 第几个未填昵称进入的玩家（全服递增）
let anonymousSeq = 0;

function resolveName(rawName) {
  const n = String(rawName || '').trim();
  if (n) return n.slice(0, 20);
  anonymousSeq += 1;
  return `玩家${anonymousSeq}`;
}

// 空房间保留 5 分钟（给房主跳转/短暂离开留时间），超时后清理并同步数据库
function sweepRooms() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.players.size === 0 && now - room.createdAt > 5 * 60 * 1000) {
      rooms.delete(id);
      deleteRoom(id); // 同步删除数据库记录
    }
  }
}
setInterval(sweepRooms, 60_000);

function randomRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// 归一化客户端传来的 playerId（存 localStorage 实现跨连接身份稳定）；缺失时生成新 id
function normalizePlayerId(raw) {
  const pid = String(raw || '').trim().slice(0, 64);
  return pid || randomUUID();
}

// 房间密码：sha256(salt + 密码) 存库，不再明文；兼容老库明文
function hashPassword(pwd, salt) {
  return createHash('sha256').update(salt + pwd).digest('hex');
}
function roomHasPassword(room) {
  return !!(room.passwordHash || room.password);
}
function roomPasswordOk(room, pwd) {
  if (!roomHasPassword(room)) return true;
  if (room.passwordHash) return hashPassword(String(pwd || ''), room.passwordSalt) === room.passwordHash;
  return String(pwd || '') === room.password; // 老库明文兜底
}

// AI 调用限流：每 socket 30 秒内最多 8 次；每房间 60 秒内最多 40 次（防刷爆 API Key）
function aiAllowed(socket, room) {
  const now = Date.now();
  const sArr = (socket.data.aiCalls = (socket.data.aiCalls || []).filter((t) => now - t < 30000));
  if (sArr.length >= 8) return false;
  const rArr = (room.aiCalls = (room.aiCalls || []).filter((t) => now - t < 60000));
  if (rArr.length >= 40) return false;
  sArr.push(now);
  rArr.push(now);
  return true;
}
// 投稿限流：每 socket 60 秒内最多 3 次
function submitAllowed(socket) {
  const now = Date.now();
  const arr = (socket.data.submits = (socket.data.submits || []).filter((t) => now - t < 60000));
  if (arr.length >= 3) return false;
  arr.push(now);
  return true;
}

function randomSip(room) {
  // 只从「已审核通过」的汤池抽取；被举报下架/未通过/否决的汤不会被抽到
  // 同房间去重：优先抽本房间还没抽过的汤，池子耗尽时才允许重复
  // 房主可选分类偏好（sipTags）：命中任一标签即可；未选则全池随机
  const used = (room && room.usedSipIds) || [];
  const wantTags = (room && room.sipTags) || [];
  let sips = db
    .prepare("SELECT id, title, content, answer, difficulty, tags FROM sips WHERE status = 'approved' ORDER BY id")
    .all();
  if (wantTags.length) {
    const hit = sips.filter((s) => {
      const tags = (s.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      return tags.some((t) => wantTags.includes(t));
    });
    if (hit.length) sips = hit;
  }
  if (used.length) {
    const fresh = sips.filter((s) => !used.includes(s.id));
    if (fresh.length) sips = fresh;
  }
  if (sips.length === 0) return null;
  return sips[Math.floor(Math.random() * sips.length)];
}

// 返回给客户端的房间状态；绝不包含汤底 answer
function roomState(roomId, includeSip) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const entries = Array.from(room.players.entries());
  const hostPlayer = room.players.get(room.hostId);
  const state = {
    roomId,
    roomName: room.roomName || '房间' + roomId,
    hasPassword: roomHasPassword(room),
    players: entries.map(([pid, p]) => ({
      name: p.name,
      playerId: pid,
      ready: !!p.ready,
    })),
    status: room.status,
    maxPlayers: room.maxPlayers,
    hostName: hostPlayer ? hostPlayer.name : (entries[0]?.[1].name || ''),
    hostPlayerId: room.hostId || null,
    sipTags: room.sipTags || [],
    questionUsed: room.questionCount,
    maxQuestions: Number.isFinite(room.maxQuestions) ? room.maxQuestions : null,
    surrenderOpen: !!room.surrenderOpen,
    surrenderVotes: room.surrenderVotes
      ? Array.from(room.surrenderVotes).map((pid) => ({
          name: room.players.get(pid)?.name || '玩家',
          playerId: pid,
        }))
      : [],
    surrenderRequired: room.players.size,
    hintEnabled: !!room.hintEnabled,
    hintLimit: room.hintLimit,
    hintRemaining: room.hintEnabled ? Math.max(0, room.hintLimit - room.hintUsed) : 0,
  };
  if (includeSip && room.sip) {
    state.sip = { id: room.sip.id, title: room.sip.title, content: room.sip.content };
  }
  return state;
}

// room_joined 附带当前 socket 自己的信息（you/playerId/isHost），供前端判断身份；房主额外拿到 hostToken 用于重连认领
function joinedPayload(roomId, socket) {
  const state = roomState(roomId, true);
  const room = rooms.get(roomId);
  if (state && room) {
    const pid = socket.data.playerId || '';
    state.you = room.players.get(pid)?.name || '';
    state.playerId = pid;
    state.isHost = room.hostId === pid;
    if (state.isHost) state.hostToken = room.hostToken;
  }
  return state;
}

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));
  // CORS 收窄：默认只允许本机 localhost（同源场景本就不需要跨域，防止被别的页面刷）；
  // 公网上线时在 .env.local 里设 PUBLIC_ORIGIN=https://你的域名（可逗号分隔多个）
  const allowedOrigins = (process.env.PUBLIC_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const io = new Server(server, {
    cors: {
      origin: allowedOrigins.length
        ? allowedOrigins
        : ['http://localhost:3000', 'http://127.0.0.1:3000'],
      methods: ['GET', 'POST'],
    },
    // 心跳：20s ping + 20s 超时，约 40s 内判定死连接并触发 disconnect（防"假在线"占坑）
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });

  // 建房/加入限流（按 IP 计数，防多连接刷房）
  const ipRoomCalls = new Map(); // key: ip:create|join -> [timestamps]

  // 数据库自动备份：启动后 3 秒备份一次，之后每 6 小时备份一次
  const { backup } = require('./backup');
  const runBackup = () => {
    try {
      backup();
    } catch (e) {
      console.error('[backup] 失败:', e.message);
    }
  };
  setTimeout(runBackup, 3000);
  setInterval(runBackup, 6 * 60 * 60 * 1000);

  // 开放弃权投票（幂等）：向房间广播弃权状态
  function openSurrender(room) {
    if (room.surrenderOpen) return;
    room.surrenderOpen = true;
    room.surrenderVotes = new Set();
    saveRoom(room);
    io.to(room.id).emit('surrender_status', {
      open: true,
      votes: [],
      required: room.players.size,
    });
  }

  // 广播消息并存入房间历史（供中途加入的玩家同步）；同步持久化到数据库
  function broadcastMessage(room, msg) {
    room.chatHistory = room.chatHistory || [];
    room.chatHistory.push(msg);
    if (room.chatHistory.length > 300) room.chatHistory = room.chatHistory.slice(-300);
    saveRoom(room);
    io.to(room.id).emit('new_message', msg);
  }

  // 新玩家加入后下发房间历史
  function emitHistory(socket, room) {
    socket.emit('chat_history', { messages: room.chatHistory || [] });
  }

  // 系统公告：以「系统」身份发一条聊天消息（不影响 AI、不计次数）
  function systemAnnounce(room, text) {
    broadcastMessage(room, { channel: 'chat', from: '系统', text, ts: Date.now() });
  }

  // 离开公告：延迟 5 秒再广播，期间若同 playerId 重连则取消（避免跳转/刷新造成误报）
  function scheduleLeaveAnnounce(room, pid, name) {
    cancelLeaveAnnounce(room, pid);
    const timer = setTimeout(() => {
      room.pendingLeave.delete(pid);
      if (room.players.has(pid)) return; // 已重连回来
      systemAnnounce(room, `${name} 离开了房间`);
    }, 5000);
    room.pendingLeave.set(pid, timer);
  }
  function cancelLeaveAnnounce(room, pid) {
    const t = room.pendingLeave && room.pendingLeave.get(pid);
    if (t) {
      clearTimeout(t);
      room.pendingLeave.delete(pid);
    }
  }

  // 公开房间列表：等待中在前、人数降序；过滤已满房间；最多返回 MAX_PUBLIC_ROOMS 间
  // 返回 { list, total }，total 为当前可加入的公开房间总数（供客户端提示"还有 N 间"）
  function publicRoomList() {
    const list = [];
    for (const room of rooms.values()) {
      if (!room.isPublic) continue;
      if (room.players.size >= room.maxPlayers) continue; // 已满的房不能加入，不展示
      list.push({
        roomId: room.id,
        roomName: room.roomName || '房间' + room.id,
        players: room.players.size,
        maxPlayers: room.maxPlayers,
        hasPassword: roomHasPassword(room),
        status: room.status,
      });
    }
    list.sort((a, b) => {
      if ((a.status === 'playing') !== (b.status === 'playing')) return a.status === 'playing' ? 1 : -1;
      return b.players - a.players;
    });
    return { list: list.slice(0, MAX_PUBLIC_ROOMS), total: list.length };
  }
  function broadcastPublicRooms() {
    io.emit('public_rooms', publicRoomList());
  }

  // 建房/加入限流：每连接每 60s 建房 ≤5 次、加入 ≤20 次；再叠加按 IP 的总量限制（防多连接刷房）
  function roomActionAllowed(socket, type) {
    const now = Date.now();
    const win = 60_000;
    const perSocket = type === 'create' ? 5 : 20;
    const key = type === 'create' ? 'createWin' : 'joinWin';
    socket.data[key] = (socket.data[key] || []).filter((t) => now - t < win);
    if (socket.data[key].length >= perSocket) return false;
    socket.data[key].push(now);

    const ip =
      socket.handshake?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
      socket.handshake?.address ||
      'unknown';
    const ipKey = ip + ':' + type;
    const perIp = type === 'create' ? 20 : 60;
    let arr = ipRoomCalls.get(ipKey) || [];
    arr = arr.filter((t) => now - t < win);
    if (arr.length >= perIp) return false;
    arr.push(now);
    ipRoomCalls.set(ipKey, arr);
    return true;
  }

  // 一局结束：落库对局记录 + 广播揭晓（推理成功者=MVP，弃权则无）
  function finishGame(room, { winner = null } = {}) {
    room.status = 'finished';
    saveRoom(room);
    const durationSec = room.startedAt ? Math.max(0, Math.round((Date.now() - room.startedAt) / 1000)) : 0;
    const playersSnap = Array.from(room.players.entries()).map(([pid, p]) => ({
      name: p.name,
      playerId: pid,
    }));
    db.prepare(
      `INSERT INTO games (room_id, sip_title, winner_name, winner_pid, question_count, deduce_count, duration_sec, players_json, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      room.id,
      room.sip ? room.sip.title : '',
      winner ? winner.name : null,
      winner ? winner.playerId : null,
      room.questionCount || 0,
      room.deduceCount || 0,
      durationSec,
      JSON.stringify(playersSnap),
      Date.now()
    );
    io.to(room.id).emit('reveal_answer', {
      answer: room.sip ? room.sip.answer : '',
      winner: winner ? { name: winner.name, playerId: winner.playerId } : null,
    });
    io.to(room.id).emit('players_update', roomState(room.id));
  }

  // 当前房主是否在线（房主身份对应的 socket 是否存活）
  function hostOnline(room) {
    if (!room.hostId) return false;
    const host = room.players.get(room.hostId);
    if (!host) return false;
    return !!io.sockets.sockets.get(host.socketId);
  }

  // 移交房主：把房主身份交给某玩家，并广播系统提示
  function promoteHost(room, pid) {
    if (room.hostId === pid) return;
    const oldName = room.players.get(room.hostId)?.name;
    room.hostId = pid;
    room.hostLostAt = null;
    const newName = room.players.get(pid)?.name || '玩家';
    broadcastMessage(room, {
      channel: 'chat',
      from: '系统',
      text: oldName ? `${oldName} 离线超时，${newName} 成为新房主` : `${newName} 成为新房主`,
      ts: Date.now(),
    });
    io.to(room.id).emit('players_update', roomState(room.id));
  }

  // 选出在线最久的玩家作为新房主候选
  function nextHostEntry(room) {
    const candidates = Array.from(room.players.entries())
      .filter(([, p]) => p.socketId && io.sockets.sockets.get(p.socketId))
      .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
    return candidates[0] || null;
  }

  // 定时检查（每 30s）：1) 卡关开放弃权；2) 房主离线超宽限期移交；3) 清扫"假在线"玩家占坑；4) 清理 IP 限流计数
  setInterval(() => {
    const now = Date.now();
    // 清理过期 IP 限流计数
    if (ipRoomCalls.size) {
      for (const [k, arr] of ipRoomCalls) {
        const fresh = arr.filter((t) => now - t < 60_000);
        if (fresh.length) ipRoomCalls.set(k, fresh);
        else ipRoomCalls.delete(k);
      }
    }
    for (const room of rooms.values()) {
      // 卡关检查
      if (room.status === 'playing' && !room.surrenderOpen && room.startedAt && now - room.startedAt > 10 * 60 * 1000) {
        openSurrender(room);
      }
      // 假在线清扫：socket 已不存活（半开连接/断线未触发事件）的玩家直接移除，防占坑
      let changed = false;
      for (const [pid, p] of Array.from(room.players.entries())) {
        if (!p.socketId || !io.sockets.sockets.get(p.socketId)) {
          room.players.delete(pid);
          if (pid === room.hostId) {
            room.hostLostAt = now;
            saveRoom(room);
          }
          scheduleLeaveAnnounce(room, pid, p.name);
          changed = true;
        }
      }
      if (changed) io.to(room.id).emit('players_update', roomState(room.id));
      // 房主移交：原房主离线超过宽限期 → 移交给在线最久的玩家
      if (room.hostLostAt && now - room.hostLostAt > HOST_TRANSFER_GRACE_MS && !hostOnline(room)) {
        const next = nextHostEntry(room);
        if (next) promoteHost(room, next[0]);
        else room.hostLostAt = now; // 无人在线，重新计时
      }
    }
  }, 30_000);

  io.on('connection', (socket) => {
    socket.data.name = '玩家';
    socket.data.roomId = null;
    // 连接握手时带上稳定的 playerId（用于首页"我的投稿/战绩"等非房间场景）
    socket.data.playerId = String(socket.handshake?.query?.playerId || '').trim().slice(0, 64);

    socket.on('create_room', ({ name, maxPlayers, maxQuestions, roomName, isPublic, password, hintEnabled, hintLimit, playerId, sipTags } = {}) => {
      // 建房限流（防刷房）
      if (!roomActionAllowed(socket, 'create')) return socket.emit('error', '创建房间过于频繁，请稍后再试');
      const roomId = randomRoomId();
      const pid = normalizePlayerId(playerId);
      socket.data.playerId = pid;
      const player = { name: resolveName(name), score: 0, ready: false, socketId: socket.id, joinedAt: Date.now() };
      const cap = Math.min(4, Math.max(2, parseInt(maxPlayers, 10) || 4));
      // 提问上限：'unlimited'/空 → 无限；数字 → 限制在 10-500
      const mq =
        maxQuestions === 'unlimited' || maxQuestions === null || maxQuestions === undefined
          ? Infinity
          : Math.min(500, Math.max(10, parseInt(maxQuestions, 10) || Infinity));
      // 密码只存 sha256 散列，不落明文
      const pwd = String(password || '').slice(0, 20);
      const passwordSalt = pwd ? randomUUID() : '';
      const passwordHash = pwd ? hashPassword(pwd, passwordSalt) : '';
      const room = {
        id: roomId,
        roomName: String(roomName || '').trim().slice(0, 20) || '房间' + roomId,
        isPublic: !!isPublic,
        password: '',
        passwordHash,
        passwordSalt,
        sipTags: Array.isArray(sipTags) ? sipTags.filter((t) => typeof t === 'string' && t).slice(0, 5) : [],
        players: new Map([[pid, player]]),
        sip: null,
        status: 'waiting',
        hostId: pid,
        hostLostAt: null,
        hostToken: Math.random().toString(36).slice(2, 12),
        maxPlayers: cap,
        maxQuestions: mq,
        questionCount: 0,
        deduceCount: 0,
        usedSipIds: [],
        startedAt: null,
        hintEnabled: !!hintEnabled,
        hintLimit: Math.min(3, Math.max(1, parseInt(hintLimit, 10) || 3)),
        hintUsed: 0,
        askHistory: [],
        chatHistory: [],
        surrenderOpen: false,
        surrenderVotes: new Set(),
        pendingLeave: new Map(),
        createdAt: Date.now(),
      };
      rooms.set(roomId, room);
      saveRoom(room);
      socket.data.roomId = roomId;
      socket.data.name = player.name;
      socket.join(roomId);
      socket.emit('room_joined', joinedPayload(roomId, socket));
      emitHistory(socket, room);
      broadcastPublicRooms();
    });

    socket.on('join_room', ({ roomId, name, playerId, hostToken, password } = {}) => {
      const id = String(roomId || '').toUpperCase().trim();
      const room = rooms.get(id);
      if (!room) return socket.emit('error', '房间不存在');
      // 加入限流（防刷加入）
      if (!roomActionAllowed(socket, 'join')) return socket.emit('error', '操作过于频繁，请稍后再试');

      const pid = normalizePlayerId(playerId);
      socket.data.playerId = pid;

      // 密码校验：有密码的房间必须密码正确（房主凭 hostToken / 原房主凭 playerId 免密重连）
      const isHostReclaim = !!(hostToken && hostToken === room.hostToken) || (room.hostId && pid === room.hostId);
      if (!roomPasswordOk(room, password) && !isHostReclaim) {
        return socket.emit('error', '房间密码错误');
      }

      const existing = room.players.get(pid);
      let isNew = false;
      if (existing) {
        // 身份重连：把身份从旧 socket 迁到新 socket（防止刷新/多标签后旧连接残留占位）
        if (existing.socketId && existing.socketId !== socket.id) {
          const oldSocket = io.sockets.sockets.get(existing.socketId);
          if (oldSocket) {
            oldSocket.data.roomId = null;
            oldSocket.leave(id);
          }
        }
        existing.socketId = socket.id;
        existing.joinedAt = existing.joinedAt || Date.now();
        cancelLeaveAnnounce(room, pid); // 重连回来，取消"离开"公告
      } else {
        if (room.players.size >= room.maxPlayers) return socket.emit('error', '房间已满');
        room.players.set(pid, {
          name: resolveName(name),
          score: 0,
          ready: false,
          socketId: socket.id,
          joinedAt: Date.now(),
        });
        isNew = true;
      }

      socket.data.roomId = id;
      socket.data.name = room.players.get(pid).name;
      socket.join(id);

      // 房主身份：原房主重连 / 持正确 hostToken → 认领；房主离线且超过宽限期才移交（防假房主）
      if (pid === room.hostId || (hostToken && hostToken === room.hostToken)) {
        room.hostId = pid;
        room.hostLostAt = null;
      } else if (!hostOnline(room)) {
        if (room.hostLostAt == null) {
          room.hostLostAt = Date.now();
        } else if (Date.now() - room.hostLostAt > HOST_TRANSFER_GRACE_MS) {
          promoteHost(room, pid);
        }
      }
      saveRoom(room);

      socket.emit('room_joined', joinedPayload(id, socket));
      emitHistory(socket, room);
      io.to(id).emit('players_update', roomState(id));
      if (isNew) systemAnnounce(room, `${socket.data.name} 加入了房间`);
      broadcastPublicRooms();
    });

    // 公开房间列表：返回当前可加入的公开房间（不含密码，只给"是否有密码"标识）
    socket.on('list_public_rooms', () => {
      socket.emit('public_rooms', publicRoomList());
    });

    // 随机加入：随机进入一个公开、无密码、未满的房间；没有则自动创建一间并作为房主进入
    socket.on('random_join', ({ name, playerId } = {}) => {
      // 加入限流（随机加入本质是加入动作）
      if (!roomActionAllowed(socket, 'join')) return socket.emit('error', '操作过于频繁，请稍后再试');
      const pid = normalizePlayerId(playerId);
      socket.data.playerId = pid;
      const publics = Array.from(rooms.values()).filter(
        (r) => r.isPublic && !roomHasPassword(r) && r.players.size < r.maxPlayers
      );
      if (publics.length === 0) {
        // 无公开房 → 自动创建一间，需过建房限流
        if (!roomActionAllowed(socket, 'create')) return socket.emit('error', '创建房间过于频繁，请稍后再试');
        const roomId = randomRoomId();
        const player = { name: resolveName(name), score: 0, ready: false, socketId: socket.id, joinedAt: Date.now() };
        const room = {
          id: roomId,
          roomName: '房间' + roomId,
          isPublic: true,
          password: '',
          passwordHash: '',
          passwordSalt: '',
          sipTags: [],
          players: new Map([[pid, player]]),
          sip: null,
          status: 'waiting',
          hostId: pid,
          hostLostAt: null,
          hostToken: Math.random().toString(36).slice(2, 12),
          maxPlayers: 4,
          maxQuestions: 20,
          questionCount: 0,
          deduceCount: 0,
          usedSipIds: [],
          startedAt: null,
          hintEnabled: false,
          hintLimit: 3,
          hintUsed: 0,
          askHistory: [],
          chatHistory: [],
          surrenderOpen: false,
          surrenderVotes: new Set(),
          pendingLeave: new Map(),
          createdAt: Date.now(),
        };
        rooms.set(roomId, room);
        saveRoom(room);
        socket.data.roomId = roomId;
        socket.data.name = player.name;
        socket.join(roomId);
        socket.emit('room_joined', joinedPayload(roomId, socket));
        emitHistory(socket, room);
        broadcastPublicRooms();
        return;
      }
      const room = publics[Math.floor(Math.random() * publics.length)];
      const existing = room.players.get(pid);
      let isNew = false;
      if (existing) {
        if (existing.socketId && existing.socketId !== socket.id) {
          const oldSocket = io.sockets.sockets.get(existing.socketId);
          if (oldSocket) {
            oldSocket.data.roomId = null;
            oldSocket.leave(room.id);
          }
        }
        existing.socketId = socket.id;
        existing.joinedAt = existing.joinedAt || Date.now();
        cancelLeaveAnnounce(room, pid);
      } else {
        const player = { name: resolveName(name), score: 0, ready: false, socketId: socket.id, joinedAt: Date.now() };
        room.players.set(pid, player);
        isNew = true;
      }
      socket.data.roomId = room.id;
      socket.data.name = room.players.get(pid).name;
      socket.join(room.id);
      if (pid === room.hostId) {
        room.hostLostAt = null;
      } else if (!hostOnline(room)) {
        if (room.hostLostAt == null) room.hostLostAt = Date.now();
        else if (Date.now() - room.hostLostAt > HOST_TRANSFER_GRACE_MS) promoteHost(room, pid);
      }
      saveRoom(room);
      socket.emit('room_joined', joinedPayload(room.id, socket));
      emitHistory(socket, room);
      io.to(room.id).emit('players_update', roomState(room.id));
      if (isNew) systemAnnounce(room, `${socket.data.name} 加入了房间`);
      broadcastPublicRooms();
    });

    // 房主在开局前调整房间配置（最大人数 / 提问上限 / AI 提示 / 汤池偏好分类）
    socket.on('update_room_config', ({ roomId, maxPlayers, maxQuestions, hintEnabled, hintLimit, sipTags } = {}) => {
      const id = String(roomId || '').toUpperCase().trim();
      const room = rooms.get(id);
      if (!room || socket.data.roomId !== id) return;
      if (socket.data.playerId !== room.hostId) return socket.emit('error', '只有房主可以修改房间设置');
      room.maxPlayers = Math.min(4, Math.max(2, parseInt(maxPlayers, 10) || 4));
      room.maxQuestions =
        maxQuestions === 'unlimited' || maxQuestions === null || maxQuestions === undefined
          ? Infinity
          : Math.min(500, Math.max(10, parseInt(maxQuestions, 10) || 20));
      if (typeof hintEnabled === 'boolean') room.hintEnabled = hintEnabled;
      if (hintLimit !== undefined) room.hintLimit = Math.min(3, Math.max(1, parseInt(hintLimit, 10) || 3));
      if (Array.isArray(sipTags)) room.sipTags = sipTags.filter((t) => typeof t === 'string' && t).slice(0, 5);
      saveRoom(room);
      io.to(id).emit('players_update', roomState(id));
      broadcastPublicRooms();
    });

    // 准备 / 取消准备（等待阶段；房主也可标记，但开局不强制全员就绪）
    socket.on('toggle_ready', () => {
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (!room || room.status !== 'waiting') return;
      const pid = socket.data.playerId;
      const player = pid && room.players.get(pid);
      if (!player) return;
      player.ready = !player.ready;
      io.to(roomId).emit('players_update', roomState(roomId));
    });

    // 我的投稿：按作者 playerId 回查投稿状态（作者反馈闭环）
    socket.on('my_submissions', () => {
      const pid = socket.data.playerId || '';
      if (!pid) return socket.emit('my_submissions', []);
      const list = db
        .prepare(
          "SELECT id, title, status, review_note, created_at FROM sips WHERE author_pid = ? ORDER BY id DESC LIMIT 50"
        )
        .all(pid);
      socket.emit('my_submissions', list);
    });

    // 我的战绩：最近参与过的对局（按玩家快照匹配 playerId）
    socket.on('my_games', () => {
      const pid = socket.data.playerId || '';
      if (!pid) return socket.emit('my_games', []);
      const all = db.prepare('SELECT * FROM games ORDER BY ended_at DESC LIMIT 200').all();
      const mine = all
        .filter((g) => (JSON.parse(g.players_json || '[]')).some((p) => p.playerId === pid))
        .slice(0, 10);
      socket.emit('my_games', mine);
    });

    // 弃权投票：全员同意后揭晓汤底（按 playerId 记票，重连不丢票）
    socket.on('surrender_vote', () => {
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (!room || room.status !== 'playing') return;
      if (!room.surrenderOpen) return;
      room.surrenderVotes = room.surrenderVotes || new Set();
      room.surrenderVotes.add(socket.data.playerId || randomUUID());
      const required = room.players.size;
      saveRoom(room);
      io.to(roomId).emit('surrender_status', {
        open: true,
        votes: Array.from(room.surrenderVotes).map((pid) => ({
          name: room.players.get(pid)?.name || '玩家',
          playerId: pid,
        })),
        required,
      });
      if (room.surrenderVotes.size >= required) {
        finishGame(room); // 弃权揭晓：无 MVP
        broadcastPublicRooms();
      }
    });

    // AI 提示：不泄底的方向性提示
    socket.on('get_hint', async () => {
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (!room || !room.sip) return;
      if (!room.hintEnabled) return socket.emit('error', '本房间未开启 AI 提示');
      if (room.hintUsed >= room.hintLimit) return socket.emit('error', '提示次数已用完');
      if (!aiAllowed(socket, room)) return socket.emit('error', 'AI 主持人繁忙，请稍后再试');
      room.hintUsed += 1;
      saveRoom(room);
      try {
        const hint = await ai.generateHint({
          answer: room.sip.answer,
          content: room.sip.content,
          askHistory: room.askHistory || [],
          hintIndex: room.hintUsed,
        });
        broadcastMessage(room, {
          channel: 'chat',
          from: 'AI主持人',
          text: '💡 AI 提示：' + hint,
          ts: Date.now(),
        });
        io.to(roomId).emit('hint_update', { used: room.hintUsed, limit: room.hintLimit });
      } catch (err) {
        console.error('[hint]', err.message);
        room.hintUsed = Math.max(0, room.hintUsed - 1); // 失败回滚
        saveRoom(room);
        socket.emit('error', '提示生成失败，请稍后再试');
      }
    });

    socket.on('start_game', ({ roomId } = {}) => {
      const id = String(roomId || '').toUpperCase().trim();
      const room = rooms.get(id);
      if (!room || socket.data.roomId !== id) return;
      // 仅房主可以开局
      if (socket.data.playerId !== room.hostId) return socket.emit('error', '只有房主可以开始游戏');

      const sip = randomSip(room);
      if (!sip) return io.to(id).emit('error', '汤池为空，请先投稿');

      room.sip = sip;
      room.status = 'playing';
      room.questionCount = 0; // 新一局重置提问次数
      room.deduceCount = 0;
      room.usedSipIds.push(sip.id); // 记录本房间已抽过的汤，避免重复
      room.startedAt = Date.now(); // 卡关计时起点
      room.surrenderOpen = false; // 新一局重置弃权
      room.surrenderVotes = new Set();
      room.hintUsed = 0; // 新一局重置提示次数
      room.askHistory = []; // 新一局重置已问记录
      room.chatHistory = []; // 新一局重置聊天历史
      for (const p of room.players.values()) p.ready = false; // 重置就绪状态
      saveRoom(room);
      // 只下发汤面，汤底留在服务端
      io.to(id).emit('game_started', { sipId: sip.id, title: sip.title, content: sip.content });
      io.to(id).emit('players_update', roomState(id));
      io.to(id).emit('question_limit', {
        used: room.questionCount,
        max: Number.isFinite(room.maxQuestions) ? room.maxQuestions : null,
      });
      broadcastPublicRooms();
    });

    socket.on('submit_sip', async ({ title, content, answer } = {}) => {
      const t = String(title || '').trim();
      const c = String(content || '').trim();
      const a = String(answer || '').trim();
      if (!t || !c || !a) return socket.emit('error', '汤面、汤底都不能为空');
      // 投稿限流：防刷（60 秒最多 3 次）
      if (!submitAllowed(socket)) return socket.emit('error', '投稿过于频繁，请稍后再试');

      // 投稿 AI 初审：通过 → approved 直接入池；不通过 → review 待人工复核（不丢弃）
      // 审核服务异常时「不凭放行」，一律进入待人工复核，防止绕过审核
      let status = 'approved';
      let reviewNote = null;
      try {
        const review = await ai.reviewSip(c, a);
        if (!review.pass) {
          status = 'review';
          reviewNote = review.reason || '未通过 AI 初审，待人工复核';
        }
      } catch (err) {
        console.error('[review]', err.message);
        status = 'review';
        reviewNote = 'AI 审核服务异常，已进入待人工复核';
      }

      db.prepare(
        'INSERT INTO sips (title, content, answer, author, author_pid, review_note, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(t, c, a, socket.data.name || '匿名', socket.data.playerId || '', reviewNote, status);

      if (status === 'approved') {
        socket.emit('sip_submitted');
      } else {
        socket.emit('sip_in_review', { reason: reviewNote });
      }
    });

    socket.on('report_sip', ({ sipId, categories = [], note = '', roomId } = {}) => {
      const id = parseInt(sipId, 10);
      if (!id) return socket.emit('error', '参数错误');
      const sip = db.prepare('SELECT id FROM sips WHERE id = ?').get(id);
      if (!sip) return socket.emit('error', '汤不存在');

      const playerName = socket.data.name || '匿名';
      const playerPid = socket.data.playerId || randomUUID();
      // 去重：同一玩家（按 playerId）对同一汤只计一次（全局去重，重连/改名不重复计）
      const exist = db.prepare('SELECT id FROM reports WHERE sip_id = ? AND player = ?').get(id, playerPid);
      if (exist) return socket.emit('error', '你已举报过这道汤');

      const cats = Array.isArray(categories)
        ? categories.filter((x) => typeof x === 'string' && x).slice(0, 9)
        : [];
      if (cats.length === 0) return socket.emit('error', '请至少选择一个举报分类');

      db.prepare(
        'INSERT INTO reports (sip_id, room_id, player, player_name, categories, note) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, String(roomId || ''), playerPid, playerName, cats.join(','), String(note || '').slice(0, 200));

      // 阈值判定：同一房间内 ≥3 个不同玩家 或 全局累计 ≥5 个不同玩家 → 自动下架
      const roomCount = db
        .prepare('SELECT COUNT(DISTINCT player) AS c FROM reports WHERE sip_id = ? AND room_id = ?')
        .get(id, String(roomId || ''));
      const totalCount = db
        .prepare('SELECT COUNT(DISTINCT player) AS c FROM reports WHERE sip_id = ?')
        .get(id);

      let flagged = false;
      if (roomCount.c >= 3 || totalCount.c >= 5) {
        // 已下架/已删除的保持原状，仅把仍在池中的下架
        db.prepare("UPDATE sips SET status = 'flagged' WHERE id = ? AND status = 'approved'").run(id);
        flagged = true;
      }
      socket.emit('report_submitted', { counts: { room: roomCount.c, total: totalCount.c } });
      socket.emit('report_flagged', { flagged });
    });

    socket.on('kick_player', ({ roomId, target, targetPlayerId } = {}) => {
      const id = String(roomId || '').toUpperCase().trim();
      const room = rooms.get(id);
      if (!room || socket.data.roomId !== id) return;
      // 仅房主可以踢人
      if (socket.data.playerId !== room.hostId) return socket.emit('error', '只有房主可以踢人');

      const tPid = String(targetPlayerId || '').trim();
      let targetEntry = null;
      if (tPid && room.players.has(tPid)) {
        targetEntry = [tPid, room.players.get(tPid)];
      } else {
        // 兼容旧客户端：按名字匹配
        targetEntry =
          Array.from(room.players.entries()).find(([, p]) => p.name === String(target || '').trim()) || null;
      }
      if (!targetEntry) return socket.emit('error', '目标玩家不在房间');
      if (targetEntry[0] === room.hostId) return; // 不能踢房主

      const tName = targetEntry[1].name;
      const targetSocket = io.sockets.sockets.get(targetEntry[1].socketId);
      room.players.delete(targetEntry[0]);
      if (targetSocket) {
        targetSocket.emit('kicked', { reason: '被房主移出房间' });
        targetSocket.leave(id);
        targetSocket.data.roomId = null; // 被踢后不能再向房间发消息
      }
      io.to(id).emit('player_kicked', { target: tName });
      systemAnnounce(room, `${tName} 被房主移出房间`);
      io.to(id).emit('players_update', roomState(id));
      broadcastPublicRooms();
    });

    socket.on('send_message', async ({ channel, text } = {}) => {
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (!room) return;

      const from = socket.data.name || '玩家';
      const clean = String(text || '').trim();
      if (!clean) return;

      // 发言频率限制：3 秒内最多 3 条，超过则限制 2 秒（触发后清空计数，2 秒后恢复）
      const now = Date.now();
      if (socket.data.cooldownUntil && now < socket.data.cooldownUntil) {
        return socket.emit('error', '发言过快，请 2 秒后再试');
      }
      const recent = (socket.data.lastMsgs || []).filter((t) => now - t < 3000);
      if (recent.length >= 3) {
        socket.data.cooldownUntil = now + 2000;
        socket.data.lastMsgs = [];
        return socket.emit('error', '发言过快，请 2 秒后再试');
      }
      recent.push(now);
      socket.data.lastMsgs = recent;

      // 通道一：自由聊天，无 AI，纯广播（带发送者 pid，供前端区分"我/对方"气泡）
      if (channel === 'chat') {
        broadcastMessage(room, {
          channel,
          from,
          text: clean,
          ts: Date.now(),
          pid: socket.data.playerId,
        });
        return;
      }

      // 汤底揭晓后锁定提问与推理通道，仅自由聊天可用
      if (room.status === 'finished') {
        return socket.emit('error', '本局已结束，汤底已揭晓');
      }

      if (!room.sip) return socket.emit('error', '游戏尚未开始');

      // AI 调用限流（提问/推理都会调 AI）：超限时拒绝，且不广播（避免有问无答）
      if (!aiAllowed(socket, room)) return socket.emit('error', 'AI 主持人繁忙，请稍后再试');

      // 提问次数限制（仅提问通道）：超限时开放弃权投票并拒绝
      if (channel === 'question') {
        if (Number.isFinite(room.maxQuestions) && room.questionCount >= room.maxQuestions) {
          openSurrender(room); // 提问用完：开放弃权投票
          return socket.emit('error', '本局提问次数已用完');
        }
        room.questionCount += 1;
        saveRoom(room);
        // 记录该问题，供 AI 提示参考（避免重复提示已问过/已推过的方向）
        room.askHistory = room.askHistory || [];
        room.askHistory.push(clean);
        if (room.askHistory.length > 50) room.askHistory = room.askHistory.slice(-50);
        io.to(roomId).emit('question_limit', {
          used: room.questionCount,
          max: Number.isFinite(room.maxQuestions) ? room.maxQuestions : null,
        });
      }

      // 先广播玩家的问题 / 推理（带时间戳 + 发送者 pid，供前端跨通道合并排序/区分自己）
      broadcastMessage(room, {
        channel,
        from,
        text: clean,
        ts: Date.now(),
        pid: socket.data.playerId,
      });

      const answer = room.sip.answer;
      const emitAI = (text2, extra = {}) =>
        broadcastMessage(room, { channel, from: 'AI主持人', text: text2, ts: Date.now(), ...extra });

      // 通道二：提问，AI 四选一（附语义分类，前端渲染彩色徽章）
      if (channel === 'question') {
        try {
          const reply = await ai.answerQuestion(answer, clean);
          emitAI(reply, { type: ai.classifyAnswer(reply) });
        } catch (err) {
          console.error('[question]', err.message);
          emitAI('（主持人暂时掉线了，请稍后再试）');
        }
      }

      // 通道三：推理，AI 判断，通过则公布汤底（记录 MVP）
      if (channel === 'deduce') {
        room.deduceCount = (room.deduceCount || 0) + 1;
        try {
          const result = await ai.judgeDeduction(answer, room.sip.content, clean);
          emitAI(result.feedback || '（无评价）');
          if (result.accept) {
            finishGame(room, { winner: { name: from, playerId: socket.data.playerId } });
            broadcastPublicRooms();
          }
        } catch (err) {
          console.error('[deduce]', err.message);
          emitAI('（主持人暂时掉线了，请稍后再试）');
        }
      }
    });

    // 主动退出房间：立即移除；房主则立刻顺延给在线最久的成员（不走宽限期）
    socket.on('leave_room', () => {
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (!room) return;
      const pid = socket.data.playerId;
      const player = pid && room.players.get(pid);
      if (!player || player.socketId !== socket.id) return;
      const name = player.name;
      const wasHost = pid === room.hostId;
      room.players.delete(pid);
      cancelLeaveAnnounce(room, pid);
      if (wasHost) {
        room.hostLostAt = null; // 主动退出不进入宽限期，立即顺延
        const next = nextHostEntry(room);
        if (next) {
          room.hostId = next[0];
          broadcastMessage(room, {
            channel: 'chat',
            from: '系统',
            text: `房主 ${name} 已离开，${next[1].name} 成为新房主`,
            ts: Date.now(),
          });
        } else {
          room.hostId = null;
        }
        saveRoom(room);
      } else {
        systemAnnounce(room, `${name} 离开了房间`);
      }
      socket.leave(roomId);
      socket.data.roomId = null; // 退出后不能再向房间发消息
      io.to(roomId).emit('players_update', roomState(roomId));
      broadcastPublicRooms();
    });

    socket.on('disconnect', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      const pid = socket.data.playerId;
      const player = pid && room.players.get(pid);
      // 只有该玩家当前绑定的 socket 断开才移除身份，避免多标签/刷新时误删
      if (player && player.socketId === socket.id) {
        room.players.delete(pid);
        if (pid === room.hostId) {
          room.hostLostAt = Date.now(); // 房主离线，开始宽限期（期间原房主可重连认领）
          saveRoom(room);
        }
        scheduleLeaveAnnounce(room, pid, player.name); // 延迟公告，重连即取消
      }
      // 不立即删房间：创建者从大厅跳转房间页时 socket 会断开，房间需保留让新 socket 重新加入
      io.to(roomId).emit('players_update', roomState(roomId));
      broadcastPublicRooms();
    });
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`> 海龟汤已启动：http://localhost:${PORT}`);
  });
});