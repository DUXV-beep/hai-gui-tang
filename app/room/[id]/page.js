'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { io } from 'socket.io-client';
import Brand from '../../Brand';

const CHANNELS = [
  { key: 'chat', label: '自由聊天', hint: '随便聊、讨论，不调用 AI' },
  { key: 'question', label: '提问', hint: '问封闭式问题，AI 只回答：是 / 否 / 无关 / 无法回答' },
  { key: 'deduce', label: '推理', hint: '说出完整推理，AI 判断对错' },
];

// 举报分类（可多选）
const REPORT_CATEGORIES = [
  '涉黄',
  '涉暴血腥',
  '政治敏感',
  '歧视辱骂',
  '逻辑不通',
  '答案有歧义',
  '质量过低',
  '抄袭搬运',
  '广告引流',
];

// 汤池分类偏好（房主可多选，抽汤时只抽命中分类的汤）
const SIP_TAGS = ['恐怖', '温情', '脑洞', '硬核', '短平快'];

// AI 四选一答复 → 彩色徽章
const AI_TYPE = {
  yes: { label: '✅ 是', cls: 'ai-yes' },
  no: { label: '❌ 否', cls: 'ai-no' },
  irrelevant: { label: '🔘 无关', cls: 'ai-other' },
  unknown: { label: '❓ 无法回答', cls: 'ai-unknown' },
};

export default function RoomPage() {
  const params = useParams();
  const router = useRouter();
  const roomId = params?.id ?? '';

  const [socket, setSocket] = useState(null);
  const [channel, setChannel] = useState('chat');
  const [messages, setMessages] = useState({ chat: [], question: [], deduce: [] });
  const [players, setPlayers] = useState([]);
  const [maxPlayers, setMaxPlayers] = useState(6);
  const [hostPlayerId, setHostPlayerId] = useState('');
  const [myPlayerId, setMyPlayerId] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [copied, setCopied] = useState(false);
  const [thinking, setThinking] = useState(false);
  // 连接状态：connecting / connected / reconnecting / failed
  const [connState, setConnState] = useState('connecting');
  // 房主开局前配置
  const [cfgMaxPlayers, setCfgMaxPlayers] = useState(4);
  const [cfgQMode, setCfgQMode] = useState('custom');
  const [cfgQCustom, setCfgQCustom] = useState(20);
  const [cfgHintEnabled, setCfgHintEnabled] = useState(false);
  const [cfgHintLimit, setCfgHintLimit] = useState(3);
  const [cfgSipTags, setCfgSipTags] = useState([]);
  const [cfgTip, setCfgTip] = useState('');
  // 弃权投票 + AI 提示状态
  const [surrenderInfo, setSurrenderInfo] = useState(null);
  const [hintRemaining, setHintRemaining] = useState(0);
  const [hintEnabled, setHintEnabled] = useState(false);
  const [sipFace, setSipFace] = useState(null);
  const [sipId, setSipId] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [reportCats, setReportCats] = useState([]);
  const [reportNote, setReportNote] = useState('');
  const [reportMsg, setReportMsg] = useState('');
  const [reportMsgError, setReportMsgError] = useState(false);
  const [revealed, setRevealed] = useState(null);
  const [winner, setWinner] = useState(null); // 本局推理成功者（MVP）
  const [notice, setNotice] = useState(''); // 绿色成功提示（如"你已成为新房主"）
  // 再来一局确认倒计时
  const [restartConfirm, setRestartConfirm] = useState(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 用 ref 记录最新身份，供 socket 事件回调（闭包）内判断是否刚被提升为房主
  const myPlayerIdRef = useRef('');
  const isHostRef = useRef(false);
  // 复盘过滤：分别控制 自由聊天 / 提问 / 推理 三类消息是否显示
  const [hide, setHide] = useState({ chat: false, question: false, deduce: false });
  // 本局提问次数（服务端统计，跨玩家共享；questionMax 为 null 表示无限）
  const [questionUsed, setQuestionUsed] = useState(0);
  const [questionMax, setQuestionMax] = useState(null);
  const bottomRef = useRef(null);
  // 本局战绩：用时（开始到揭晓）、提问/推理次数由前端统计
  const startTimeRef = useRef(null);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    // 大厅页已把解析后的名字存进 localStorage；空串时由服务端自动命名「玩家N」
    const name = localStorage.getItem('name') || '';
    const hostToken = localStorage.getItem('hostToken') || '';
    // 连接握手带 playerId，便于重连认领身份
    const s = io({ query: { playerId: localStorage.getItem('playerId') || '' } });
    setSocket(s);

    s.on('connect', () => {
      setConnState('connected');
      // 密码房重连需要带密码（房主凭 hostToken 免密，普通玩家凭存的密码）
      // playerId 是稳定的玩家身份，重连时凭它认领原身份/房主
      const roomPwd = localStorage.getItem('roomPassword_' + roomId) || '';
      const playerId = localStorage.getItem('playerId') || '';
      s.emit('join_room', { roomId, name, hostToken, password: roomPwd, playerId });
    });

    // 连接状态提示
    s.on('disconnect', () => setConnState('reconnecting'));
    s.on('reconnect_attempt', () => setConnState('reconnecting'));
    s.on('reconnect_failed', () => setConnState('failed'));

    s.on('room_joined', (state) => {
      setPlayers(state.players || []);
      setMaxPlayers(state.maxPlayers || 6);
      setHostPlayerId(state.hostPlayerId || '');
      setIsHost(!!state.isHost);
      isHostRef.current = !!state.isHost;
      setMyPlayerId(state.playerId || '');
      myPlayerIdRef.current = state.playerId || '';
      setRoomName(state.roomName || '房间' + roomId);
      setCfgMaxPlayers(state.maxPlayers || 4);
      if (state.maxQuestions === null) {
        setCfgQMode('unlimited');
      } else {
        setCfgQMode('custom');
        setCfgQCustom(state.maxQuestions);
      }
      setCfgHintEnabled(!!state.hintEnabled);
      setCfgHintLimit(state.hintLimit || 3);
      setCfgSipTags(state.sipTags || []);
      setHintEnabled(!!state.hintEnabled);
      setHintRemaining(state.hintRemaining || 0);
      setSurrenderInfo(
        state.surrenderOpen
          ? { votes: state.surrenderVotes || [], required: state.surrenderRequired || 0 }
          : null
      );
      setQuestionUsed(state.questionUsed || 0);
      setQuestionMax(state.maxQuestions ?? null);
      if (state.sip) {
        setSipFace(state.sip);
        setSipId(state.sip.id);
      }
    });

    s.on('players_update', (state) => {
      setPlayers(state.players || []);
      setMaxPlayers(state.maxPlayers || 6);
      setHostPlayerId(state.hostPlayerId || '');
      // 实时更新房主身份：房主顺延/移交后无需刷新即可看到自己成为房主
      const hostPid = state.hostPlayerId || '';
      const isHostNow = !!myPlayerIdRef.current && hostPid === myPlayerIdRef.current;
      if (isHostNow && !isHostRef.current) setNotice('🏠 你已成为新房主');
      setIsHost(isHostNow);
      isHostRef.current = isHostNow;
      setHintRemaining(state.hintRemaining || 0);
      setSurrenderInfo(
        state.surrenderOpen
          ? { votes: state.surrenderVotes || [], required: state.surrenderRequired || 0 }
          : null
      );
      setQuestionUsed(state.questionUsed || 0);
      setQuestionMax(state.maxQuestions ?? null);
    });

    s.on('question_limit', ({ used, max }) => {
      setQuestionUsed(used || 0);
      setQuestionMax(max ?? null);
    });

    s.on('surrender_status', ({ open, votes, required }) => {
      setSurrenderInfo(open ? { votes: votes || [], required: required || 0 } : null);
    });

    s.on('hint_update', ({ used, limit }) => {
      setHintRemaining(Math.max(0, (limit || 0) - (used || 0)));
    });

    s.on('game_started', ({ sipId, title, content }) => {
      setSipFace({ title, content });
      setSipId(sipId);
      setRevealed(null);
      setWinner(null);
      setMessages({ chat: [], question: [], deduce: [] });
      setHide({ chat: false, question: false, deduce: false });
      startTimeRef.current = Date.now();
      setDuration(0);
    });

    s.on('new_message', (msg) => {
      // AI 回复到达后关闭"思考中"占位
      if (msg.from === 'AI主持人') setThinking(false);
      setMessages((prev) => ({
        ...prev,
        [msg.channel]: [...(prev[msg.channel] || []), msg],
      }));
    });

    // 中途加入时同步房间历史消息
    s.on('chat_history', ({ messages: history }) => {
      if (!Array.isArray(history) || history.length === 0) return;
      setMessages((prev) => {
        const next = {
          chat: [...prev.chat],
          question: [...prev.question],
          deduce: [...prev.deduce],
        };
        for (const m of history) {
          const ch = m.channel === 'question' || m.channel === 'deduce' ? m.channel : 'chat';
          const exists = next[ch].some(
            (x) => x.ts === m.ts && x.from === m.from && x.text === m.text
          );
          if (!exists) next[ch].push(m);
        }
        return next;
      });
    });

    s.on('reveal_answer', ({ answer, winner: w }) => {
      setRevealed(answer);
      setWinner(w || null);
      if (startTimeRef.current) {
        setDuration(Math.round((Date.now() - startTimeRef.current) / 1000));
      }
    });

    s.on('report_submitted', ({ counts }) => {
      setShowReport(false);
      setReportCats([]);
      setReportNote('');
      setReportMsg(
        '举报已记录（本房 ' + counts.room + ' 人 · 累计 ' + counts.total + ' 人举报）'
      );
      setReportMsgError(false);
    });

    s.on('report_flagged', ({ flagged }) => {
      if (flagged) {
        setReportMsg('该汤已触发自动下架，后续不会再被抽到');
        setReportMsgError(false);
      }
    });

    s.on('player_kicked', ({ target }) => {
      setError('玩家 ' + target + ' 已被移出房间');
    });

    s.on('kicked', ({ reason } = {}) => {
      socket?.disconnect();
      // 用 localStorage 把提示带回大厅，回大厅后显示（不用阻塞的 alert）
      localStorage.setItem('kickTip', reason || '你已被移出房间');
      router.push('/');
    });

    s.on('error', (m) => setError(m));

    return () => s.disconnect();
  }, [roomId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, channel, hide]);

  // 提示自动清除：错误提示 3 秒后消失，举报提示 4 秒后消失
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(''), 3000);
    return () => clearTimeout(t);
  }, [error]);

  useEffect(() => {
    if (!reportMsg) return;
    const t = setTimeout(() => setReportMsg(''), 4000);
    return () => clearTimeout(t);
  }, [reportMsg]);

  // 绿色成功提示自动清除
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // 汤底揭晓后强制停留在自由聊天通道
  useEffect(() => {
    if (revealed && channel !== 'chat') setChannel('chat');
  }, [revealed, channel]);

  // 再来一局确认倒计时：10 秒后自动开始，也可立即开始/取消
  useEffect(() => {
    if (!restartConfirm) return;
    if (restartConfirm.countdown <= 0) {
      doStart();
      return;
    }
    const t = setTimeout(
      () => setRestartConfirm((c) => (c ? { countdown: c.countdown - 1 } : null)),
      1000
    );
    return () => clearTimeout(t);
  }, [restartConfirm]);

  function startGame() {
    socket?.emit('start_game', { roomId });
  }

  function doStart() {
    setRestartConfirm(null);
    socket?.emit('start_game', { roomId });
  }

  function leaveRoom() {
    // 先通知服务端"主动退出"（房主会立即顺延给成员），稍后再断开并回大厅
    socket?.emit('leave_room');
    setTimeout(() => {
      socket?.disconnect();
      router.push('/');
    }, 150);
  }

  function saveConfig() {
    const maxQuestions =
      cfgQMode === 'unlimited'
        ? 'unlimited'
        : Math.min(500, Math.max(10, parseInt(cfgQCustom, 10) || 20));
    socket?.emit('update_room_config', {
      roomId,
      maxPlayers: cfgMaxPlayers,
      maxQuestions,
      hintEnabled: cfgHintEnabled,
      hintLimit: cfgHintLimit,
      sipTags: cfgSipTags,
    });
    setCfgTip('设置已保存');
    setTimeout(() => setCfgTip(''), 2000);
  }

  function toggleReady() {
    socket?.emit('toggle_ready');
  }

  function toggleSipTag(tag) {
    setCfgSipTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }

  function surrenderVote() {
    socket?.emit('surrender_vote');
  }

  function getHint() {
    socket?.emit('get_hint');
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('复制失败，请手动复制地址栏链接');
    }
  }

  function requestKick(playerId, name) {
    if (!window.confirm('确认将「' + name + '」移出房间？（仅房主可操作）')) return;
    socket?.emit('kick_player', { roomId, target: name, targetPlayerId: playerId });
  }

  function toggleCat(cat) {
    setReportCats((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  }

  function submitReport() {
    if (!sipId || reportCats.length === 0) return;
    socket?.emit('report_sip', { sipId, categories: reportCats, note: reportNote, roomId });
  }

  function send() {
    const text = input.trim();
    if (!socket || !text || connState !== 'connected') return;
    setBusy(true);
    socket.emit('send_message', { channel, text });
    // 提问/推理时显示"AI 思考中"占位，收到 AI 回复后关闭
    if (channel === 'question' || channel === 'deduce') setThinking(true);
    setInput('');
    // 简单延时解除「发送中」态，AI 回复以 new_message 事件为准
    setTimeout(() => setBusy(false), 600);
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function toggleFilter(key) {
    setHide((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const currentChannel = CHANNELS.find((c) => c.key === channel);
  const myReady = players.find((p) => p.playerId === myPlayerId)?.ready || false;
  const allReady = players.length > 0 && players.every((p) => p.ready);

  // 自由聊天通道：合并显示所有通道消息（带来源标记），复盘时可按来源过滤
  let shownMessages;
  if (channel === 'chat') {
    shownMessages = [
      ...messages.chat.map((m) => ({ ...m, source: 'chat' })),
      ...messages.question.map((m) => ({ ...m, source: 'question' })),
      ...messages.deduce.map((m) => ({ ...m, source: 'deduce' })),
    ]
      .filter((m) => !hide[m.source])
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  } else {
    shownMessages = messages[channel] || [];
  }

  // 本局战绩：玩家提问/推理的次数（排除 AI 消息）
  const questionCount = messages.question.filter((m) => m.from !== 'AI主持人').length;
  const deduceCount = messages.deduce.filter((m) => m.from !== 'AI主持人').length;

  // 消息气泡分类：AI / 系统 / 我 / 其他玩家
  function msgClass(m) {
    if (m.from === 'AI主持人') return 'ai';
    if (m.from === '系统') return 'system';
    if (m.pid && m.pid === myPlayerId) return 'mine';
    return 'player';
  }

  return (
    <div className="container">
      <div className="topbar">
        <Brand small />
        <button className="secondary btn-sm" onClick={leaveRoom}>
          ← 返回大厅
        </button>
      </div>

      {(connState === 'reconnecting' || connState === 'failed') && (
        <div className={'conn-banner' + (connState === 'failed' ? ' failed' : '')}>
          {connState === 'failed' ? '连接失败，请刷新页面重试' : '连接已断开，正在重连…'}
        </div>
      )}

      <div className="card">
        <div className="room-header">
          <div>
            <span className="room-id">{roomName}</span>
            <span className="badge" style={{ marginLeft: 6 }}>
              {roomId}
            </span>
            <span className="badge" style={{ marginLeft: 6 }}>
              {players.length}/{maxPlayers} 人
            </span>
            <button className="secondary copy-btn" onClick={copyInvite}>
              {copied ? '已复制' : '复制邀请链接'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {isHost ? (
              <button onClick={revealed ? () => setRestartConfirm({ countdown: 10 }) : startGame} disabled={!socket}>
                {revealed ? '再来一局' : sipFace ? '重新抽汤' : '开始游戏'}
              </button>
            ) : (
              <span className="badge">等待房主开始…</span>
            )}
          </div>
        </div>

        <div className="players">
          {players.length === 0 ? (
            <span className="badge">等待玩家加入…</span>
          ) : (
            players.map((p, i) => (
              <span key={i} className="player-chip">
                <span className={'badge' + (p.playerId === hostPlayerId ? ' host' : '')}>
                  {p.name}
                  {p.playerId === hostPlayerId ? ' · 房主' : ''}
                  {p.playerId === myPlayerId ? ' · 我' : ''}
                  {!sipFace && (
                    <span
                      className={'ready-dot' + (p.ready ? ' on' : '')}
                      title={p.ready ? '已准备' : '未准备'}
                    ></span>
                  )}
                </span>
                {isHost && p.playerId !== myPlayerId && (
                  <button
                    className="kick-btn"
                    onClick={() => requestKick(p.playerId, p.name)}
                    title="移出房间"
                  >
                    踢
                  </button>
                )}
              </span>
            ))
          )}
        </div>

        {revealed ? (
          <div className="reveal">
            <b>汤底已揭晓：</b>
            {revealed}
            <div className="stats-row">
              {winner && (
                <span className="badge host">🏆 {winner.name} 推理成功</span>
              )}
              <span className="badge">提问 {questionCount} 次</span>
              <span className="badge">推理 {deduceCount} 次</span>
              <span className="badge">用时 {duration} 秒</span>
            </div>
          </div>
        ) : sipFace ? (
          <div className="sip-face">
            <div className="sip-title">
              <span>{sipFace.title}</span>
              <button className="secondary report-btn" onClick={() => setShowReport(!showReport)}>
                举报
              </button>
            </div>
            <div>{sipFace.content}</div>

            {showReport && (
              <div className="report-panel">
                <div className="report-label">举报原因（可多选）</div>
                <div className="report-cats">
                  {REPORT_CATEGORIES.map((c) => (
                    <button
                      key={c}
                      className={'report-cat' + (reportCats.includes(c) ? ' sel' : '')}
                      onClick={() => toggleCat(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <textarea
                  value={reportNote}
                  onChange={(e) => setReportNote(e.target.value)}
                  placeholder="补充说明（可选）"
                  style={{ minHeight: 44 }}
                />
                <div className="row">
                  <button onClick={submitReport} disabled={reportCats.length === 0}>
                    提交举报
                  </button>
                  <button className="secondary" onClick={() => setShowReport(false)}>
                    取消
                  </button>
                </div>
                {reportMsg && (
                  <p className={'tip' + (reportMsgError ? ' error' : '')}>{reportMsg}</p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="sip-face">
            {isHost ? (
              <div className="room-config">
                <div className="tip" style={{ marginBottom: 8 }}>
                  设置好房间后，点击右上角「开始游戏」抽汤。
                  {players.length > 1 && !allReady && (
                    <span style={{ color: '#e8463a' }}>（有玩家尚未准备）</span>
                  )}
                </div>
                <label>最大人数</label>
                <select
                  value={cfgMaxPlayers}
                  onChange={(e) => setCfgMaxPlayers(Number(e.target.value))}
                >
                  {[2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n} 人
                    </option>
                  ))}
                </select>
                <label>本局提问上限</label>
                <select value={cfgQMode} onChange={(e) => setCfgQMode(e.target.value)}>
                  <option value="custom">自定义</option>
                  <option value="unlimited">无限</option>
                </select>
                {cfgQMode === 'custom' && (
                  <input
                    type="number"
                    min={10}
                    max={500}
                    value={cfgQCustom}
                    onChange={(e) => setCfgQCustom(e.target.value)}
                    placeholder="10 - 500"
                  />
                )}
                <label>汤池分类偏好（可多选，不选则全池随机）</label>
                <div className="report-cats">
                  {SIP_TAGS.map((tag) => (
                    <button
                      key={tag}
                      className={'report-cat' + (cfgSipTags.includes(tag) ? ' sel' : '')}
                      onClick={() => toggleSipTag(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
                <label className={'hint-toggle' + (cfgHintEnabled ? ' on' : '')}>
                  <input
                    type="checkbox"
                    className="check-input"
                    checked={cfgHintEnabled}
                    onChange={(e) => setCfgHintEnabled(e.target.checked)}
                  />
                  <span className="hint-toggle-switch" aria-hidden="true"></span>
                  <span className="hint-toggle-text">
                    开启 AI 提示
                    <small>卡关时可向主持人要提示</small>
                  </span>
                  <span className="hint-toggle-badge">{cfgHintEnabled ? '已开启' : '未开启'}</span>
                </label>
                {cfgHintEnabled && (
                  <select
                    value={cfgHintLimit}
                    onChange={(e) => setCfgHintLimit(Number(e.target.value))}
                    style={{ marginBottom: 8 }}
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n} 次提示
                      </option>
                    ))}
                  </select>
                )}
                <button onClick={saveConfig}>保存设置</button>
                {cfgTip && <p className="tip" style={{ margin: '8px 0 0' }}>{cfgTip}</p>}
              </div>
            ) : (
              <div className="ready-zone">
                <div>房主开始游戏后，将从汤池抽取一道海龟汤。</div>
                <button
                  className={'ready-btn' + (myReady ? ' on' : '')}
                  onClick={toggleReady}
                >
                  {myReady ? '✅ 已准备（点击取消）' : '点我准备'}
                </button>
                <p className="tip" style={{ margin: '8px 0 0' }}>
                  {allReady
                    ? '大家都已准备，等房主开局吧'
                    : `已准备 ${players.filter((p) => p.ready).length}/${players.length} 人`}
                </p>
              </div>
            )}
          </div>
        )}

        {sipFace && !revealed && hintEnabled && (
          <button
            className="secondary hint-btn"
            onClick={getHint}
            disabled={hintRemaining <= 0}
            style={{ marginBottom: 12 }}
          >
            💡 AI 提示（剩余 {hintRemaining} 次）
          </button>
        )}

        {sipFace && !revealed && surrenderInfo && (
          <div className="surrender-box">
            <div className="surrender-text">卡关超时/提问已用完，可投票弃权揭晓汤底</div>
            <div className="surrender-row">
              <span className="badge">
                {surrenderInfo.votes.length}/{surrenderInfo.required} 人同意弃权
              </span>
              {surrenderInfo.votes.some((v) => v.playerId === myPlayerId) ? (
                <span className="badge host">已同意</span>
              ) : (
                <button onClick={surrenderVote}>同意弃权</button>
              )}
            </div>
          </div>
        )}

        <div className="tabs">
          {(revealed ? CHANNELS.filter((c) => c.key === 'chat') : CHANNELS).map((c) => (
            <button
              key={c.key}
              className={'tab' + (channel === c.key ? ' active' : '')}
              onClick={() => setChannel(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {revealed && (
          <div className="channel-hint" style={{ color: '#0f766e' }}>
            本局已结束。自由聊天里已同步全部提问与推理，可用下方按钮过滤复盘内容。
          </div>
        )}

        <div className="channel-hint">{currentChannel?.hint}</div>

        {channel === 'question' && !revealed && (
          <div
            className={
              'question-counter' +
              (questionMax !== null && questionMax - questionUsed <= 3 ? ' low' : '')
            }
          >
            {questionMax === null ? (
              <>
                本局 <span className="big">∞</span> 无限提问
              </>
            ) : (
              <>
                <span className="big">{Math.max(0, questionMax - questionUsed)}</span>
                <span> / {questionMax} 次提问剩余</span>
              </>
            )}
          </div>
        )}

        {revealed && channel === 'chat' && (
          <div className="filter-row">
            <button
              className={'filter-btn' + (hide.chat ? ' off' : '')}
              onClick={() => toggleFilter('chat')}
            >
              自由聊天{hide.chat ? '（已隐藏）' : ''}
            </button>
            <button
              className={'filter-btn' + (hide.question ? ' off' : '')}
              onClick={() => toggleFilter('question')}
            >
              提问{hide.question ? '（已隐藏）' : ''}
            </button>
            <button
              className={'filter-btn' + (hide.deduce ? ' off' : '')}
              onClick={() => toggleFilter('deduce')}
            >
              推理{hide.deduce ? '（已隐藏）' : ''}
            </button>
          </div>
        )}

        <div className="messages">
          {shownMessages.length === 0 && !thinking ? (
            <div className="msg empty">还没有消息，先开个头吧</div>
          ) : (
            shownMessages.map((m, i) => (
              <div key={i} className={'msg ' + msgClass(m)}>
                <div className="msg-from">
                  {m.source && m.source !== 'chat' && (
                    <span className={'sync-tag' + (m.source === 'deduce' ? ' deduce' : '')}>
                      [{m.source === 'question' ? '提问' : '推理'}同步]
                    </span>
                  )}
                  {msgClass(m) !== 'mine' && m.from}
                  {msgClass(m) === 'ai' && m.type && AI_TYPE[m.type] && (
                    <span className={'ai-badge ' + AI_TYPE[m.type].cls}>
                      {AI_TYPE[m.type].label}
                    </span>
                  )}
                  <span className="msg-time">{fmtTime(m.ts)}</span>
                </div>
                <div>{m.text}</div>
              </div>
            ))
          )}
          {thinking && (channel === 'question' || channel === 'deduce') && (
            <div className="msg thinking">AI 主持人正在思考…</div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="input-bar">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={(e) =>
              e.target.closest('.input-bar')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
            }
            placeholder={
              channel === 'question'
                ? '例如：死者是他杀吗？'
                : channel === 'deduce'
                ? '写下你的完整推理…'
                : '随意聊聊…'
            }
          />
          <button onClick={send} disabled={!socket || busy || connState !== 'connected'}>
            发送
          </button>
        </div>

        {error && <div className="toast toast-error">{error}</div>}
        {notice && <div className="toast toast-success">{notice}</div>}
      </div>

      {restartConfirm && (
        <div className="modal-mask" onClick={() => setRestartConfirm(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>再来一局？</h3>
            <p className="tip" style={{ marginBottom: 8 }}>
              新一局将在 <b>{restartConfirm.countdown}</b> 秒后自动开始（上一局复盘将被清空）。
            </p>
            <div className="row">
              <button onClick={doStart}>立即开始</button>
              <button className="secondary" onClick={() => setRestartConfirm(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
