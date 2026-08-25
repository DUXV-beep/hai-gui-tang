// 管理后台会话：数据库持久化（admin_sessions 表）
// 用 SQLite 而非内存 Map：Next dev 会把本模块打包进各个 API 路由形成独立实例，
// 数据库落盘保证 login/queue/act 路由读到的 session 一致，且服务器重启后登录态保留。
// 登录失败锁定同样落库：防暴力破解（按 IP 计数，超限锁定一段时间）。
const crypto = require('node:crypto');
const db = require('./db');

const TTL_MS = 24 * 60 * 60 * 1000; // 会话 24 小时
const TTL_S = 24 * 60 * 60;
const COOKIE = 'admin_session';

// 失败锁定参数（可用环境变量覆盖，便于调节/测试）
const FAIL_LIMIT = Math.max(1, parseInt(process.env.ADMIN_MAX_FAIL || '5', 10)); // 连续失败 N 次
const LOCK_MS = Math.max(60_000, parseInt(process.env.ADMIN_LOCK_MINUTES || '15', 10) * 60_000); // 锁定时长
const WINDOW_MS = 10 * 60 * 1000; // 超过该间隔的失败视为新一轮

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_login_failures (
    ip TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    locked_until INTEGER DEFAULT 0,
    last_fail INTEGER DEFAULT 0
  );
`);

function create() {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO admin_sessions (token, created_at) VALUES (?, ?)').run(token, Date.now());
  return token;
}

function verify(token) {
  if (!token) return false;
  const row = db.prepare('SELECT created_at FROM admin_sessions WHERE token = ?').get(token);
  if (!row) return false;
  if (Date.now() - row.created_at > TTL_MS) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
    return false;
  }
  return true;
}

function destroy(token) {
  db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
}

// ---- 登录失败锁定 ----

// 是否已被锁定；返回 { locked, retryAfter }
function loginLocked(ip) {
  const row = db
    .prepare('SELECT locked_until FROM admin_login_failures WHERE ip = ?')
    .get(ip || 'unknown');
  const until = row && row.locked_until ? row.locked_until : 0;
  if (until > Date.now()) {
    return { locked: true, retryAfter: Math.ceil((until - Date.now()) / 1000) };
  }
  return { locked: false, retryAfter: 0 };
}

// 记录一次失败；达到阈值则锁定。返回 { locked, remaining }
function recordLoginFailure(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const row = db.prepare('SELECT count, last_fail FROM admin_login_failures WHERE ip = ?').get(key);
  // 距上次失败超过窗口，或从未失败 → 重新计数
  const count = row && now - (row.last_fail || 0) <= WINDOW_MS ? row.count + 1 : 1;
  if (count >= FAIL_LIMIT) {
    db.prepare(
      `INSERT INTO admin_login_failures (ip, count, locked_until, last_fail) VALUES (?, 0, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET count = 0, locked_until = excluded.locked_until, last_fail = excluded.last_fail`
    ).run(key, now + LOCK_MS, now);
    return { locked: true, remaining: 0 };
  }
  db.prepare(
    `INSERT INTO admin_login_failures (ip, count, locked_until, last_fail) VALUES (?, ?, 0, ?)
     ON CONFLICT(ip) DO UPDATE SET count = excluded.count, locked_until = 0, last_fail = excluded.last_fail`
  ).run(key, count, now);
  return { locked: false, remaining: FAIL_LIMIT - count };
}

// 登录成功：清空该 IP 的失败记录
function clearLoginFailures(ip) {
  db.prepare('DELETE FROM admin_login_failures WHERE ip = ?').run(ip || 'unknown');
}

// 从 Next 请求对象读取 cookie
function readToken(req) {
  const cookie = req.headers?.get?.('cookie') || '';
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === COOKIE && v) return v;
  }
  return '';
}

module.exports = {
  create,
  verify,
  destroy,
  readToken,
  TTL_S,
  loginLocked,
  recordLoginFailure,
  clearLoginFailures,
};
