import adminSession from '../../../../lib/adminSession';

// 管理后台退出登录：销毁 session 并清除 cookie
export async function POST(req) {
  const token = adminSession.readToken(req);
  if (token) adminSession.destroy(token);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'admin_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
    },
  });
}
