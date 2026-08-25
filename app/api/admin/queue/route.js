import db from '../../../../lib/db';
import adminSession from '../../../../lib/adminSession';

// 管理后台：查询待人工复核 + 被举报下架 两个队列（需已登录 session）
export async function GET(req) {
  const token = adminSession.readToken(req);
  if (!adminSession.verify(token)) {
    return Response.json({ error: '未登录或会话已过期' }, { status: 401 });
  }

  const review = db
    .prepare(
      "SELECT id, title, content, answer, author, created_at FROM sips WHERE status = 'review' ORDER BY id DESC"
    )
    .all();

  const flagged = db
    .prepare(
      "SELECT id, title, content, answer, author, created_at FROM sips WHERE status = 'flagged' ORDER BY id DESC"
    )
    .all()
    .map((s) => ({
      ...s,
      reports: db
        .prepare(
          'SELECT player_name, categories, note, created_at FROM reports WHERE sip_id = ? ORDER BY id'
        )
        .all(s.id),
    }));

  // 已通过汤池（全量浏览，最新 200 条）+ 已否决队列
  const approved = db
    .prepare(
      "SELECT id, title, author, tags, difficulty, created_at FROM sips WHERE status = 'approved' ORDER BY id DESC LIMIT 200"
    )
    .all();
  const rejected = db
    .prepare(
      "SELECT id, title, author, tags, created_at FROM sips WHERE status = 'rejected' ORDER BY id DESC LIMIT 200"
    )
    .all();

  return Response.json({ review, flagged, approved, rejected });
}
