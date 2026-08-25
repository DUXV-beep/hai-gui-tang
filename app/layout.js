import './globals.css';

export const metadata = {
  title: '海龟汤 · 联机推理游戏',
  description: 'AI 主持的联机海龟汤：投稿、抽汤、提问、推理、揭晓汤底',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}