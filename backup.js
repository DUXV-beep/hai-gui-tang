// 自动备份 SQLite 数据库到 data/backups/（gzip 压缩 + SHA256 校验文件，保留最近 30 份）
// 可独立运行：node backup.js；也可被 server.js 引入定时执行
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const DB_FILE = path.join(process.cwd(), 'data', 'turtleSoup.db');
const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');
const KEEP = 30; // 最多保留的备份份数

function backup() {
  if (!fs.existsSync(DB_FILE)) {
    console.log('[backup] 数据库不存在，跳过');
    return null;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(BACKUP_DIR, 'turtleSoup-' + ts);
  const gzDest = base + '.db.gz';
  const shaDest = base + '.sha256';

  // 压缩备份：gzip 原始 db 文件
  const gzip = zlib.createGzip();
  const read = fs.createReadStream(DB_FILE);
  const write = fs.createWriteStream(gzDest);
  read.pipe(gzip).pipe(write);

  // 计算原文件 SHA256，写入校验文件（校验内容损坏）
  const hash = crypto.createHash('sha256');
  const verify = fs.createReadStream(DB_FILE);
  verify.on('data', (d) => hash.update(d));
  verify.on('end', () => {
    fs.writeFileSync(shaDest, hash.digest('hex') + '  ' + path.basename(DB_FILE) + '\n');
  });

  // 清理旧备份，只保留最近 KEEP 份（按 .gz 文件计数）
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('turtleSoup-') && f.endsWith('.db.gz'))
    .sort();
  while (files.length > KEEP) {
    const rm = files.shift();
    fs.unlinkSync(path.join(BACKUP_DIR, rm));
    fs.unlinkSync(path.join(BACKUP_DIR, rm.replace(/\.db\.gz$/, '.sha256')));
  }

  console.log('[backup] 完成 ->', gzDest);
  return gzDest;
}

if (require.main === module) {
  backup();
}

module.exports = { backup };
