'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { io } from 'socket.io-client';
import Brand from './Brand';

// 投稿状态 → 显示徽章
const SIP_STATUS = {
  approved: { label: '已入池', cls: 'st-ok' },
  review: { label: '待人工复核', cls: 'st-warn' },
  rejected: { label: '已否决', cls: 'st-bad' },
  flagged: { label: '已下架', cls: 'st-bad' },
};

// 汤池分类偏好
const SIP_TAGS = ['恐怖', '温情', '脑洞', '硬核', '短平快'];

const TABS = [
  { key: 'play', label: '开局' },
  { key: 'submit', label: '投稿' },
  { key: 'profile', label: '战绩' },
];

// 空状态图示：放大镜 + 问号（神秘悬疑）
function EmptyMark() {
  return (
    <svg className="empty-mark" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="27" cy="27" r="15" />
      <path d="M38 38 L53 53" />
      <path d="M23 20 a4 5 0 0 1 8 0 c0 3.5 -4 3.5 -4 7" />
      <circle cx="27" cy="34" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

// 面板标题（带编号 + 细线）
function SectionHead({ no, children, right }) {
  return (
    <div className="section-head">
      {no && <span className="sec-no">{no}</span>}
      <h2>{children}</h2>
      {right}
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [socket, setSocket] = useState(null);
  const [tab, setTab] = useState('play');
  // 开局：昵称 / 加入
  const [name, setName] = useState('');
  const [joinId, setJoinId] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  // 创建房间
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [qMode, setQMode] = useState('custom');
  const [qCustom, setQCustom] = useState(20);
  const [roomName, setRoomName] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [roomPassword, setRoomPassword] = useState('');
  const [hintEnabled, setHintEnabled] = useState(false);
  const [hintLimit, setHintLimit] = useState(3);
  const [sipTags, setSipTags] = useState([]);
  // 公开房间
  const [publicRooms, setPublicRooms] = useState([]);
  const [publicTotal, setPublicTotal] = useState(0);
  const [roomSearch, setRoomSearch] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  // 我的投稿 / 我的战绩
  const [mySubs, setMySubs] = useState(null);
  const [myGames, setMyGames] = useState(null);
  // 密码弹窗
  const [pwdTarget, setPwdTarget] = useState(null);
  const [pwdInput, setPwdInput] = useState('');
  // 提示
  const [tip, setTip] = useState('');
  const [tipError, setTipError] = useState(false);
  const [sip, setSip] = useState({ title: '', content: '', answer: '' });
  const [submitting, setSubmitting] = useState(false);
  // 用于"去创建房间"滚动定位
  const createRef = useRef(null);

  function scrollToCreate() {
    createRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 稳定的玩家身份
  function getPlayerId() {
    let pid = localStorage.getItem('playerId');
    if (!pid) {
      pid =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('playerId', pid);
    }
    return pid;
  }

  useEffect(() => {
    const s = io({ query: { playerId: getPlayerId() } });
    setSocket(s);

    s.on('connect', () => {
      s.emit('list_public_rooms');
      s.emit('my_submissions');
      s.emit('my_games');
    });

    s.on('public_rooms', (data) => {
      // 兼容：服务端返回 { list, total }；旧格式为数组
      const list = Array.isArray(data) ? data : data?.list || [];
      const total = Array.isArray(data) ? list.length : (data?.total ?? list.length);
      setPublicRooms(list);
      setPublicTotal(total);
    });
    s.on('my_submissions', (list) => setMySubs(list || []));
    s.on('my_games', (list) => setMyGames(list || []));

    s.on('room_joined', (state) => {
      localStorage.setItem('name', state.you || '');
      if (state.hostToken) localStorage.setItem('hostToken', state.hostToken);
      router.push('/room/' + state.roomId);
    });

    s.on('sip_submitted', () => {
      setSubmitting(false);
      setTip('投稿成功，已加入汤池');
      setTipError(false);
      setSip({ title: '', content: '', answer: '' });
      s.emit('my_submissions');
    });

    s.on('sip_in_review', ({ reason } = {}) => {
      setSubmitting(false);
      setTip('未通过 AI 初审，已进入待人工复核' + (reason ? '：' + reason : ''));
      setTipError(false);
      s.emit('my_submissions');
    });

    s.on('error', (msg) => {
      setSubmitting(false);
      setTip(msg);
      setTipError(true);
    });

    return () => s.disconnect();
  }, [router]);

  // 被踢回大厅时显示提示
  useEffect(() => {
    const tip = localStorage.getItem('kickTip');
    if (tip) {
      localStorage.removeItem('kickTip');
      setTip(tip);
      setTipError(true);
    }
  }, []);

  useEffect(() => {
    if (!tip) return;
    const t = setTimeout(() => setTip(''), 5000);
    return () => clearTimeout(t);
  }, [tip]);

  function createRoom() {
    const maxQuestions =
      qMode === 'unlimited'
        ? 'unlimited'
        : Math.min(500, Math.max(10, parseInt(qCustom, 10) || 20));
    socket?.emit('create_room', {
      name,
      maxPlayers,
      maxQuestions,
      roomName,
      isPublic,
      password: roomPassword,
      hintEnabled,
      hintLimit,
      sipTags,
      playerId: getPlayerId(),
    });
  }

  function joinRoom() {
    if (!joinId.trim()) return;
    if (joinPassword) localStorage.setItem('roomPassword_' + joinId, joinPassword);
    socket?.emit('join_room', { roomId: joinId, name, password: joinPassword, playerId: getPlayerId() });
  }

  function randomJoin() {
    socket?.emit('random_join', { name, playerId: getPlayerId() });
  }

  function refreshPublic() {
    socket?.emit('list_public_rooms');
  }

  function refreshMine() {
    socket?.emit('my_submissions');
    socket?.emit('my_games');
  }

  const kw = roomSearch.trim().toUpperCase();
  const shownRooms = kw
    ? publicRooms.filter(
        (r) => r.roomName.toUpperCase().includes(kw) || r.roomId.toUpperCase().includes(kw)
      )
    : publicRooms;

  function joinPublic(roomId, hasPassword) {
    if (hasPassword) {
      setPwdTarget({ roomId });
      setPwdInput('');
    } else {
      socket?.emit('join_room', { roomId, name, playerId: getPlayerId() });
    }
  }

  function confirmPwd() {
    if (!pwdTarget) return;
    const pwd = pwdInput.trim();
    if (!pwd) return;
    localStorage.setItem('roomPassword_' + pwdTarget.roomId, pwd);
    socket?.emit('join_room', {
      roomId: pwdTarget.roomId,
      name,
      password: pwd,
      playerId: getPlayerId(),
    });
    setPwdTarget(null);
  }

  function toggleSipTag(tag) {
    setSipTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  function submitSip() {
    if (!sip.title.trim() || !sip.content.trim() || !sip.answer.trim()) {
      setTip('请填写完整的汤名、汤面和汤底');
      setTipError(true);
      return;
    }
    setSubmitting(true);
    setTip('AI 审核中…');
    setTipError(false);
    socket?.emit('submit_sip', sip);
  }

  return (
    <div className="site">
      <header className="site-header">
        <div className="site-header-inner">
          <Brand />
          <nav className="site-nav">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={'nav-tab' + (tab === t.key ? ' active' : '')}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="site-main">
        <div className="hero">
          <p className="hero-overline">MIST SOUP · 联机推理</p>
          <h1>迷雾汤</h1>
          <div className="hero-rule" />
          <p>「只有面对奇怪的现象，真相才肯 <em>露头</em> —— 夜色已深，推理开场。」</p>
        </div>

        {tab === 'play' && (
          <div className="tab-panel grid-2">
            {/* 左栏：创建 / 加入 */}
            <div>
              <div className="panel stagger" ref={createRef} style={{ '--i': 0 }}>
                <SectionHead no="壹">创建房间</SectionHead>
                <label>你的昵称</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="输入昵称（默认「玩家」）"
                />
                <div className="field">
                  <label>房间名</label>
                  <input
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    placeholder="留空自动生成"
                  />
                </div>
                <div className="field">
                  <label>最大人数</label>
                  <select value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))}>
                    {[2, 3, 4].map((n) => (
                      <option key={n} value={n}>
                        {n} 人
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>本局提问上限</label>
                  <select value={qMode} onChange={(e) => setQMode(e.target.value)}>
                    <option value="custom">自定义</option>
                    <option value="unlimited">无限</option>
                  </select>
                  {qMode === 'custom' && (
                    <input
                      type="number"
                      min={10}
                      max={500}
                      value={qCustom}
                      onChange={(e) => setQCustom(e.target.value)}
                      placeholder="10 - 500"
                    />
                  )}
                </div>
                <div className="field">
                  <label>汤池分类偏好（可多选，不选则全池随机）</label>
                  <div className="report-cats">
                    {SIP_TAGS.map((tag) => (
                      <button
                        key={tag}
                        className={'report-cat' + (sipTags.includes(tag) ? ' sel' : '')}
                        onClick={() => toggleSipTag(tag)}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
                <label className={'hint-toggle' + (hintEnabled ? ' on' : '')}>
                  <input
                    type="checkbox"
                    className="check-input"
                    checked={hintEnabled}
                    onChange={(e) => setHintEnabled(e.target.checked)}
                  />
                  <span className="hint-toggle-switch" aria-hidden="true"></span>
                  <span className="hint-toggle-text">
                    开启 AI 提示
                    <small>卡关时可向主持人要提示</small>
                  </span>
                  <span className="hint-toggle-badge">{hintEnabled ? '已开启' : '未开启'}</span>
                </label>
                {hintEnabled && (
                  <select value={hintLimit} onChange={(e) => setHintLimit(Number(e.target.value))}>
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n} 次提示
                      </option>
                    ))}
                  </select>
                )}
                <label className="check-label">
                  <input
                    type="checkbox"
                    className="check-input"
                    checked={isPublic}
                    onChange={(e) => setIsPublic(e.target.checked)}
                  />
                  公开房间（可被公开列表 / 随机加入找到）
                </label>
                {isPublic && (
                  <div className="field">
                    <label>房间密码（可选，防广告脚本）</label>
                    <input
                      type="password"
                      value={roomPassword}
                      onChange={(e) => setRoomPassword(e.target.value)}
                      placeholder="留空表示无需密码"
                    />
                  </div>
                )}
                <button className="btn-primary" onClick={createRoom} disabled={!socket}>
                  创建房间
                </button>
              </div>

              <div className="panel stagger" style={{ '--i': 1 }}>
                <SectionHead no="贰">加入房间</SectionHead>
                <div className="field">
                  <label>房间号</label>
                  <input
                    value={joinId}
                    onChange={(e) => setJoinId(e.target.value.toUpperCase())}
                    placeholder="输入 6 位房间号"
                  />
                </div>
                <div className="field">
                  <label>房间密码（如需）</label>
                  <input
                    type="password"
                    value={joinPassword}
                    onChange={(e) => setJoinPassword(e.target.value)}
                    placeholder="留空表示无需密码"
                  />
                </div>
                <button className="btn-primary" onClick={joinRoom} disabled={!socket || !joinId.trim()}>
                  加入房间
                </button>
              </div>
            </div>

            {/* 右栏：公开房间 + 玩法 */}
            <div>
              <div className="panel stagger" style={{ '--i': 2 }}>
                <SectionHead no="叁" right={<button className="secondary btn-sm" onClick={refreshPublic}>刷新</button>}>
                  公开房间
                </SectionHead>
                <div className="field">
                  <input
                    value={roomSearch}
                    onChange={(e) => setRoomSearch(e.target.value)}
                    placeholder="搜索房间名 / 房间号…"
                  />
                </div>
                <button className="secondary" onClick={randomJoin} disabled={!socket} style={{ width: '100%' }}>
                  随机加入（公开无密码房）
                </button>
                <div className="room-list" style={{ marginTop: 12 }}>
                  {publicRooms.length === 0 ? (
                    <div className="empty-state">
                      <EmptyMark />
                      <p className="empty-title">此刻没有亮着灯的房间</p>
                      <p className="empty-desc">公开房间会实时出现在这里，也可以自己开一间</p>
                      <button className="secondary btn-sm" onClick={scrollToCreate}>去创建房间</button>
                    </div>
                  ) : shownRooms.length === 0 ? (
                    <div className="empty-state">
                      <EmptyMark />
                      <p className="empty-title">没有匹配的房间</p>
                      <p className="empty-desc">换个关键字，或直接去创建一间</p>
                      <button className="secondary btn-sm" onClick={scrollToCreate}>去创建房间</button>
                    </div>
                  ) : (
                    shownRooms.map((r) => (
                      <div key={r.roomId} className="room-item">
                        <div className="room-meta">
                          <span className="room-name">{r.roomName}</span>
                          <span className="badge">
                            {r.players}/{r.maxPlayers} 人
                          </span>
                          <span className="badge">{r.status === 'playing' ? '进行中' : '等待中'}</span>
                          {r.hasPassword && <span className="badge host">需密码</span>}
                        </div>
                        <button className="btn-sm" onClick={() => joinPublic(r.roomId, r.hasPassword)}>
                          加入
                        </button>
                      </div>
                    ))
                  )}
                </div>
                {publicTotal > publicRooms.length && (
                  <p className="tip" style={{ textAlign: 'center', marginTop: 10 }}>
                    还有 {publicTotal - publicRooms.length} 间公开房间未显示（列表仅展示前 30 间，可直接输入房间号加入）
                  </p>
                )}
              </div>

              <div className="panel stagger" style={{ '--i': 3 }}>
                <button className="collapse-btn" onClick={() => setShowGuide((v) => !v)}>
                  {showGuide ? '收起玩法说明 ▲' : '玩法说明 ▼'}
                </button>
                {showGuide && (
                  <div className="guide" style={{ marginTop: 12 }}>
                    <div className="guide-line">
                      <span className="guide-tag">规则</span>
                      <span>
                        主持人只给你一个奇怪场景（汤面），真相藏在汤底。房主开局后，靠三个通道协作推理。
                      </span>
                    </div>
                    <div className="guide-line">
                      <span className="guide-tag">自由</span>
                      <span>随便聊、商量，AI 不介入。</span>
                    </div>
                    <div className="guide-line">
                      <span className="guide-tag">提问</span>
                      <span>问「是不是 / 有没有」这类封闭式问题，AI 只回答：是 / 否 / 无关 / 无法回答。</span>
                    </div>
                    <div className="guide-line">
                      <span className="guide-tag">推理</span>
                      <span>写出完整故事情节提交，AI 判断是否与汤底吻合，正确则揭晓汤底。</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === 'submit' && (
          <div className="tab-panel grid-2">
            <div className="panel stagger" style={{ '--i': 0 }}>
              <SectionHead no="壹">投稿新汤</SectionHead>
              <div className="field">
                <label>汤名</label>
                <input
                  value={sip.title}
                  onChange={(e) => setSip({ ...sip, title: e.target.value })}
                  placeholder="例如：电梯里的男人"
                />
              </div>
              <div className="field">
                <label>汤面（给玩家看的谜面）</label>
                <textarea
                  value={sip.content}
                  onChange={(e) => setSip({ ...sip, content: e.target.value })}
                  placeholder="描述谜面的场景，但不揭示真相"
                />
              </div>
              <div className="field">
                <label>汤底（真实答案，仅 AI 主持人可见）</label>
                <textarea
                  value={sip.answer}
                  onChange={(e) => setSip({ ...sip, answer: e.target.value })}
                  placeholder="写下真实的故事真相"
                />
              </div>
              <button className="btn-primary" onClick={submitSip} disabled={!socket || submitting}>
                {submitting ? 'AI 审核中…' : '提交到汤池'}
              </button>
              <p className="tip" style={{ margin: '10px 0 0' }}>
                投稿先经 AI 审核（闭环 / 歧义 / 违规）：通过即入池，未通过进入待人工复核。
              </p>
            </div>

            <div className="panel stagger" style={{ '--i': 1 }}>
              <SectionHead no="贰" right={<button className="secondary btn-sm" onClick={refreshMine}>刷新</button>}>
                我的投稿
              </SectionHead>
              {mySubs === null ? (
                <div className="empty-state">加载中…</div>
              ) : mySubs.length === 0 ? (
                <div className="empty-state">
                  <EmptyMark />
                  <p className="empty-title">尚无投稿</p>
                  <p className="empty-desc">写一道你的海龟汤，通过 AI 审核后进入汤池</p>
                </div>
              ) : (
                mySubs.map((s) => (
                  <div key={s.id} className="my-sub">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <b>{s.title}</b>
                      <span className={'badge ' + (SIP_STATUS[s.status]?.cls || '')}>
                        {SIP_STATUS[s.status]?.label || s.status}
                      </span>
                    </div>
                    {s.review_note && <div className="tip">{s.review_note}</div>}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {tab === 'profile' && (
          <div className="tab-panel">
            <div className="panel stagger" style={{ '--i': 0 }}>
              <SectionHead no="壹" right={<button className="secondary btn-sm" onClick={refreshMine}>刷新</button>}>
                我的战绩
              </SectionHead>
              {myGames === null ? (
                <div className="empty-state">加载中…</div>
              ) : myGames.length === 0 ? (
                <div className="empty-state">
                  <EmptyMark />
                  <p className="empty-title">尚无对局记录</p>
                  <p className="empty-desc">开一局，或加入一间公开房间，战绩会出现在这里</p>
                  <button className="secondary btn-sm" onClick={() => setTab('play')}>
                    去开局
                  </button>
                </div>
              ) : (
                myGames.map((g) => (
                  <div key={g.id} className="my-sub">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <b>{g.sip_title}</b>
                      <span className="badge">{g.winner_name ? `🏆 ${g.winner_name}` : '弃权'}</span>
                    </div>
                    <div className="tip">
                      提问 {g.question_count} · 推理 {g.deduce_count} · 用时 {g.duration_sec} 秒
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </main>

      <footer className="site-footer">迷雾汤 · 夜色里的每一道谜，都在等一个答案</footer>

      {tip && (
        <div className={'toast ' + (tipError ? 'toast-error' : 'toast-neutral')}>{tip}</div>
      )}

      {pwdTarget && (
        <div className="modal-mask" onClick={() => setPwdTarget(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>输入房间密码</h3>
            <p className="tip" style={{ marginBottom: 8 }}>
              该房间需要密码才能加入
            </p>
            <input
              type="password"
              value={pwdInput}
              onChange={(e) => setPwdInput(e.target.value)}
              placeholder="输入密码"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && confirmPwd()}
            />
            <div className="row">
              <button className="btn-primary" onClick={confirmPwd} disabled={!pwdInput.trim()}>
                确定
              </button>
              <button className="secondary" onClick={() => setPwdTarget(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
