'use client';

import { useState } from 'react';
import Brand from '../Brand';

export default function AdminPage() {
  const [pwd, setPwd] = useState('');
  const [authed, setAuthed] = useState(false);
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [showAnswer, setShowAnswer] = useState({});
  // 全局搜索关键字（按汤名 / 作者 / id 过滤所有队列）
  const [q, setQ] = useState('');

  function filter(list) {
    const kw = q.trim().toLowerCase();
    if (!kw) return list || [];
    return (list || []).filter(
      (s) =>
        String(s.title || '').toLowerCase().includes(kw) ||
        String(s.author || '').toLowerCase().includes(kw) ||
        String(s.id || '').includes(kw)
    );
  }

  async function login() {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    });
    if (res.status === 401) {
      setMsg('口令错误');
      return;
    }
    setMsg('');
    setAuthed(true);
    await loadQueue();
  }

  async function loadQueue() {
    const res = await fetch('/api/admin/queue');
    if (res.status === 401) {
      // 会话过期：回到登录态
      setAuthed(false);
      setData(null);
      setMsg('会话已过期，请重新登录');
      return;
    }
    const json = await res.json();
    setData(json);
  }

  async function act(action, id) {
    await fetch('/api/admin/act', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, id }),
    });
    await loadQueue(); // 操作后刷新队列
  }

  async function logout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    setAuthed(false);
    setData(null);
    setPwd('');
    setMsg('已退出登录');
  }

  // 操作二次确认：删除需要双重确认（不可恢复）
  function confirmAct(action, id) {
    const names = { approve: '通过入池', reject: '否决', restore: '重新上架', take_down: '下架', delete: '删除' };
    const label = names[action] || '操作';
    if (action === 'delete') {
      if (!window.confirm('确认删除这道汤？删除后不可恢复！')) return;
      if (!window.confirm('再次确认：真的要永久删除吗？')) return;
    } else if (!window.confirm('确认' + label + '这道汤？')) {
      return;
    }
    act(action, id);
  }

  function toggleAnswer(id) {
    setShowAnswer((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  if (!authed) {
    return (
      <div className="container">
        <div className="topbar">
          <Brand small />
        </div>
        <div className="card">
          <h1>管理后台</h1>
          <label>管理口令</label>
          <input
            type="password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && login()}
          />
          <button className="btn-primary" onClick={login}>进入</button>
          {msg && <p className="tip error">{msg}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="topbar">
        <Brand small />
        <button className="secondary btn-sm" onClick={logout}>
          退出登录
        </button>
      </div>
      <div className="card">
        <div className="section-head">
          <h2>管理后台</h2>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索：按汤名 / 作者 / id 过滤所有队列…"
          style={{ marginBottom: 0 }}
        />
      </div>

      <div className="card">
        <h2>待人工复核（AI 未通过）· {filter(data?.review).length}</h2>
        {filter(data?.review).length === 0 && <p className="tip">暂无待复核内容</p>}
        {filter(data?.review).map((s) => (
          <div key={s.id} className="admin-item">
            <div>
              <b>{s.title}</b> <span className="badge">#{s.id} · {s.author}</span>
            </div>
            <div className="tip">汤面：{s.content}</div>
            <div className="tip">
              汤底：
              <button className="secondary link" onClick={() => toggleAnswer(s.id)}>
                {showAnswer[s.id] ? s.answer : '展开'}
              </button>
            </div>
            <div className="row">
              <button onClick={() => confirmAct('approve', s.id)}>通过入池</button>
              <button className="secondary" onClick={() => confirmAct('reject', s.id)}>
                否决
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>被举报下架（待处理）· {filter(data?.flagged).length}</h2>
        {filter(data?.flagged).length === 0 && <p className="tip">暂无被举报内容</p>}
        {filter(data?.flagged).map((s) => (
          <div key={s.id} className="admin-item">
            <div>
              <b>{s.title}</b> <span className="badge">#{s.id} · {s.author}</span>
            </div>
            <div className="tip">汤面：{s.content}</div>
            <div className="tip">
              举报详情：
              {s.reports
                .map((r) => `${r.player_name || r.player}（${r.categories}${r.note ? '：' + r.note : ''}）`)
                .join('；')}
            </div>
            <div className="row">
              <button className="secondary" onClick={() => confirmAct('restore', s.id)}>
                误报 · 重新上架
              </button>
              <button onClick={() => confirmAct('delete', s.id)}>确认删除</button>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>汤池（已通过）· {filter(data?.approved).length}</h2>
        {filter(data?.approved).length === 0 && <p className="tip">暂无内容</p>}
        {filter(data?.approved).map((s) => (
          <div key={s.id} className="admin-item">
            <div>
              <b>{s.title}</b> <span className="badge">#{s.id} · {s.author}</span>
              {s.tags && <span className="badge">🏷 {s.tags}</span>}
            </div>
            <div className="row">
              <button className="secondary" onClick={() => confirmAct('take_down', s.id)}>
                下架
              </button>
              <button onClick={() => confirmAct('delete', s.id)}>确认删除</button>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>已否决 · {filter(data?.rejected).length}</h2>
        {filter(data?.rejected).length === 0 && <p className="tip">暂无否决内容</p>}
        {filter(data?.rejected).map((s) => (
          <div key={s.id} className="admin-item">
            <div>
              <b>{s.title}</b> <span className="badge">#{s.id} · {s.author}</span>
            </div>
            <div className="row">
              <button className="secondary" onClick={() => confirmAct('restore', s.id)}>
                恢复上架
              </button>
              <button onClick={() => confirmAct('delete', s.id)}>确认删除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
