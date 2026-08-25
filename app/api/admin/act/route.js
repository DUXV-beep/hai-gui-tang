import db from '../../../../lib/db';
import adminSession from '../../../../lib/adminSession';

// 管理后台操作：approve(复核通过/误报上架) reject(复核否决) delete(确认删除)
// 需已登录 session；每次操作写入 admin_logs 供追溯
export async function POST(req) {
  const token = adminSession.readToken(req);
  if (!adminSession.verify(token)) {
    return Response.json({ error: '未登录或会话已过期' }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: '请求格式错误' }, { status: 400 });
  }

  const { action, id } = body || {};
  const sid = parseInt(id, 10);
  if (!sid) return Response.json({ error: '参数错误' }, { status: 400 });

  const sip = db.prepare('SELECT id, title FROM sips WHERE id = ?').get(sid);
  if (!sip) return Response.json({ error: '目标不存在' }, { status: 404 });

  if (action === 'approve' || action === 'restore') {
    db.prepare("UPDATE sips SET status = 'approved' WHERE id = ?").run(sid);
  } else if (action === 'reject') {
    db.prepare("UPDATE sips SET status = 'rejected' WHERE id = ?").run(sid);
  } else if (action === 'take_down') {
    // 从汤池直接下架：移入 flagged（举报处理队列），保留可追溯
    db.prepare("UPDATE sips SET status = 'flagged' WHERE id = ?").run(sid);
  } else if (action === 'delete') {
    db.prepare('DELETE FROM reports WHERE sip_id = ?').run(sid);
    db.prepare('DELETE FROM sips WHERE id = ?').run(sid);
  } else {
    return Response.json({ error: '未知操作' }, { status: 400 });
  }

  // 操作日志（登录 session 内视为管理员，operator 固定 admin）
  db.prepare(
    'INSERT INTO admin_logs (action, target_id, target_title, operator) VALUES (?, ?, ?, ?)'
  ).run(action, sid, sip.title || '', 'admin');

  return Response.json({ ok: true });
}
