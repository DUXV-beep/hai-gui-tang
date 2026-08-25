'use client';

// 品牌标识：夜雾中的海龟剪影
export default function Brand({ small = false, sub = true }) {
  return (
    <div className={'brand' + (small ? ' brand-sm' : '')}>
      <svg className="mark" viewBox="0 0 64 64" aria-hidden="true">
        <circle
          cx="32"
          cy="32"
          r="29"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          opacity="0.4"
          strokeDasharray="3 5"
        />
        <ellipse cx="32" cy="38" rx="16" ry="11" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path
          d="M32 19 a9 8 0 0 1 0 16 a9 8 0 0 1 0 -16z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <circle cx="28.4" cy="26.6" r="1.7" fill="currentColor" />
        <circle cx="35.6" cy="26.6" r="1.7" fill="currentColor" />
        <path d="M28 31 q4 3 8 0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M16 36 q-6 3 -4 -4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M48 36 q6 3 4 -4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M20 48 q-2 7 3 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M44 48 q2 7 -3 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div>
        <div className="brand-title">迷雾汤</div>
        {sub && <div className="brand-sub">海龟汤 · 联机推理</div>}
      </div>
    </div>
  );
}
