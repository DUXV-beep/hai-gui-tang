import adminSession from '../../../../lib/adminSession';

// 管理后台登录：校验口令后下发 httpOnly session cookie（替代 query string 传密码）
// 带失败锁定：按 IP 连续失败超阈值即临时锁定，防暴力破解
export async function POST(req) {
  // 客户端 IP：优先 NextRequest.ip（生产走反代时由 x-forwarded-for 提供）
  const ip =
    req?.ip ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';

  const lock = adminSession.loginLocked(ip);
  if (lock.locked) {
    return Response.json(
      { error: `失败次数过多，请 ${lock.retryAfter} 秒后再试` },
      { status: 429 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: '请求格式错误' }, { status: 400 });
  }

  const { password } = body || {};
  if (password !== (process.env.ADMIN_PASSWORD || 'admin')) {
    const r = adminSession.recordLoginFailure(ip);
    const msg = r.locked
      ? '失败次数过多，账号已临时锁定，请稍后再试'
      : '口令错误，还可重试 ' + r.remaining + ' 次';
    return Response.json({ error: msg }, { status: 401 });
  }

  // 成功：清空失败记录并下发会话
  adminSession.clearLoginFailures(ip);
  const token = adminSession.create();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `admin_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${adminSession.TTL_S}`,
    },
  });
}
