// SQLite 数据层（使用 Node 内置 node:sqlite，无需额外依赖）
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'turtleSoup.db'));

// 汤池表：answer（汤底）只存服务端，绝不下发客户端
// status: approved=可抽 / review=AI拒待人工复核 / rejected=人工否决 / flagged=被举报下架
// tags: 逗号分隔的分类（恐怖/温情/脑洞/硬核/短平快）；author_pid=投稿人身份（查"我的投稿"）
db.exec(`
  CREATE TABLE IF NOT EXISTS sips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    answer TEXT NOT NULL,
    author TEXT,
    difficulty TEXT DEFAULT 'standard',
    tags TEXT DEFAULT '',
    author_pid TEXT,
    review_note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// 迁移：老库 sips 表补列
const sipCols = db.prepare('PRAGMA table_info(sips)').all();
if (!sipCols.some((c) => c.name === 'status')) {
  db.exec("ALTER TABLE sips ADD COLUMN status TEXT DEFAULT 'approved'");
}
if (!sipCols.some((c) => c.name === 'tags')) db.exec("ALTER TABLE sips ADD COLUMN tags TEXT DEFAULT ''");
if (!sipCols.some((c) => c.name === 'author_pid')) db.exec('ALTER TABLE sips ADD COLUMN author_pid TEXT');
if (!sipCols.some((c) => c.name === 'review_note')) db.exec('ALTER TABLE sips ADD COLUMN review_note TEXT');

// 举报表：同一玩家对同一汤去重（UNIQUE 由查询保证，这里不建约束以便保留历史）
// player 存 playerId（跨重连/改名稳定）；player_name 存展示用昵称
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sip_id INTEGER NOT NULL,
    room_id TEXT,
    player TEXT,
    player_name TEXT,
    categories TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// 管理后台操作日志：approve/reject/restore/delete 都落库，可追溯
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT,
    target_id INTEGER,
    target_title TEXT,
    operator TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// 对局记录：每局结束后写入（谁推理成功=MVP、用时、次数），供"我的战绩"查询
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT,
    sip_title TEXT,
    winner_name TEXT,
    winner_pid TEXT,
    question_count INTEGER DEFAULT 0,
    deduce_count INTEGER DEFAULT 0,
    duration_sec INTEGER DEFAULT 0,
    players_json TEXT DEFAULT '[]',
    ended_at INTEGER
  );
`);

// 房间持久化表：服务器重启后恢复房间（players 是实时的，不持久化）
// max_questions 为 NULL 表示不限提问次数；is_public=1 公开（可在列表/随机加入）
// password_hash/password_salt=密码散列（不再明文存库）；sip_tags=本局汤池偏好分类
// started_at=开局时间（卡关计时）；hint_enabled/hint_limit/hint_used=AI 提示
// chat_history/ask_history/surrender_open/surrender_votes=对局进度，重启后继续
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    host_token TEXT,
    max_players INTEGER,
    max_questions INTEGER,
    question_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'waiting',
    sip_id INTEGER,
    used_sip_ids TEXT DEFAULT '[]',
    room_name TEXT,
    is_public INTEGER DEFAULT 0,
    password TEXT,
    password_hash TEXT,
    password_salt TEXT,
    sip_tags TEXT DEFAULT '[]',
    started_at INTEGER,
    hint_enabled INTEGER DEFAULT 0,
    hint_limit INTEGER DEFAULT 3,
    hint_used INTEGER DEFAULT 0,
    chat_history TEXT DEFAULT '[]',
    ask_history TEXT DEFAULT '[]',
    surrender_open INTEGER DEFAULT 0,
    surrender_votes TEXT DEFAULT '[]',
    created_at INTEGER
  );
`);

// 迁移：老库 rooms 表补列
const roomCols = db.prepare('PRAGMA table_info(rooms)').all();
if (!roomCols.some((c) => c.name === 'room_name')) db.exec('ALTER TABLE rooms ADD COLUMN room_name TEXT');
if (!roomCols.some((c) => c.name === 'is_public')) db.exec('ALTER TABLE rooms ADD COLUMN is_public INTEGER DEFAULT 0');
if (!roomCols.some((c) => c.name === 'password')) db.exec('ALTER TABLE rooms ADD COLUMN password TEXT');
if (!roomCols.some((c) => c.name === 'password_hash')) db.exec('ALTER TABLE rooms ADD COLUMN password_hash TEXT');
if (!roomCols.some((c) => c.name === 'password_salt')) db.exec('ALTER TABLE rooms ADD COLUMN password_salt TEXT');
if (!roomCols.some((c) => c.name === 'sip_tags')) db.exec("ALTER TABLE rooms ADD COLUMN sip_tags TEXT DEFAULT '[]'");
if (!roomCols.some((c) => c.name === 'started_at')) db.exec('ALTER TABLE rooms ADD COLUMN started_at INTEGER');
if (!roomCols.some((c) => c.name === 'hint_enabled')) db.exec('ALTER TABLE rooms ADD COLUMN hint_enabled INTEGER DEFAULT 0');
if (!roomCols.some((c) => c.name === 'hint_limit')) db.exec('ALTER TABLE rooms ADD COLUMN hint_limit INTEGER DEFAULT 3');
if (!roomCols.some((c) => c.name === 'hint_used')) db.exec('ALTER TABLE rooms ADD COLUMN hint_used INTEGER DEFAULT 0');
if (!roomCols.some((c) => c.name === 'chat_history')) db.exec("ALTER TABLE rooms ADD COLUMN chat_history TEXT DEFAULT '[]'");
if (!roomCols.some((c) => c.name === 'ask_history')) db.exec("ALTER TABLE rooms ADD COLUMN ask_history TEXT DEFAULT '[]'");
if (!roomCols.some((c) => c.name === 'surrender_open')) db.exec('ALTER TABLE rooms ADD COLUMN surrender_open INTEGER DEFAULT 0');
if (!roomCols.some((c) => c.name === 'surrender_votes')) db.exec("ALTER TABLE rooms ADD COLUMN surrender_votes TEXT DEFAULT '[]'");

// 迁移：老库 reports 表补 player_name 列
const repCols = db.prepare('PRAGMA table_info(reports)').all();
if (!repCols.some((c) => c.name === 'player_name')) db.exec('ALTER TABLE reports ADD COLUMN player_name TEXT');

// 内置示例汤，保证首次运行汤池非空
const seedSips = [
  {
    title: '奶奶的橘子树',
    content: '我从奶奶房间拿了个橘子给爸爸，爸爸却惊恐万分。',
    answer:
      '我们家很穷，奶奶生前很疼我，知道我爱吃橘子，于是自己省吃俭用给我买橘子吃，时间久了便患上了精神类疾病，每天吃土充饥，身体也逐渐垮了。奶奶去世后，爸爸希望能继续领取养老补助，便隐瞒了奶奶去世的消息，奶奶就一个人冰冷地躺在她的房间里。那天我看到奶奶房间的窗户被一根树枝捅破，几颗橘子挂在上面摇摇欲坠，我以为这是奶奶送给我的橘子，便高兴地告诉爸爸。后来我才知道，原来是奶奶吃土时，把我埋的种子也一同吃了下去，土和奶奶变成了种子的养分，种子便开始慢慢地生根发芽开花结果。但我相信这棵橘子树就是奶奶，她是用她的爱换了一种方式永远陪伴着我。',
  },
  {
    title: '乞丐',
    content: '我是个乞丐，醒来发现碗里多了样东西，为此我饱餐了一顿，但是在第七天时，我却死了。',
    answer:
      '老一辈的人说，在路上捡到的红包千万不要把它用掉，你用了就代表你同意这门亲事。可我只是一个乞丐，哪里知道这些？就这样我靠着这些钱舒舒服服地过了六天，直到第七天晚上，我的新娘找到了我。',
  },
  {
    title: '捉迷藏',
    content: '我跟妈妈玩捉迷藏，当妈妈看到我时，我却一动也不能动了。',
    answer:
      '我跟妈妈在家玩捉迷藏，我藏到了床底下。随着咚咚咚的脚步声，我知道妈妈要进来了，可当门被打开后，我看到了妈妈的眼睛——她倒在地上，身体被人拖着，似乎已经没有了呼吸。而我捂着口鼻一动也不敢动！',
  },
  {
    title: '预言',
    content: '我有一个能够预言的万能婆婆，可我从舞会回来后，却发现她消失了。',
    answer:
      '从小性格内向的我，无论遇到什么事情都很懦弱没有主见，渐渐地这种性格已经严重影响到我的生活，于是我的大脑内分裂出一个能预言的万能婆婆。在她的指引下，我可以很自信且从容地应对各种问题和抉择。可是渐渐地我越来越依赖她，婆婆人格为了避免占据我的全部，于是她选择了消失。在没有婆婆人格的帮助下，六神无主的我参加了那场舞会，而舞会后的我便选择结束了自己。',
  },
  {
    title: '灰姑娘',
    content: '我叫辛德瑞拉，可怜又丑陋的我却嫁给了王子，那天王子对我说了句话，我知道下一场舞会又要开始了。',
    answer:
      '我收到了王子舞会的邀请函，我很惊讶，因为我长相丑陋身世可怜，但我还是穿上了我最好看的衣服和侍卫送来的水晶鞋，就像做梦一样，那么多人里面王子偏偏选择了我。婚后一天，我误入了王子的密室，在浓浓的血腥味中，我看到了很多双穿着水晶鞋的脚。我想赶紧离开密室，却发现王子拿着刀向我走来，他对我说：你的脸，配不上你的脚。我低头看了看我的脚才知道，为什么在那么多漂亮女孩中，王子偏偏选择了我。（王子是恋足癖，结过很多次婚，我知道下一场舞会要开始了，是因为我即将被王子砍断双腿，王子要去找下一个目标了）',
  },
  {
    title: '人鱼公主',
    content: '美人鱼与人类王子相爱并一起来到了王子的国家，可不久后却传来了王子的死讯。',
    answer:
      '我是人鱼公主，相传吃了我的肉，便可以在海里生存。那日我救了人类的王子，他的善良体贴吸引了我，因此我们相爱了。我决定嫁给他并随他一起生活在他的国家，可当王子把我带回他的国家后，我却看到在这个国家里，很多人都没有双腿！众人的议论声传到了我的耳朵里，因为他们没有双腿，在陆地上生活不便，他们听闻吃了我的肉可以在水里生活，他们想去海里生活，他们要把我吃了。我感觉到很绝望，而王后辛德瑞拉也向王子传达了她的旨意。可第二天皇宫却传来了王子的死讯，在他的尸体旁写着"人鱼不能吃，有毒！"。而我却因此安然无恙地活了下来。',
  },
  {
    title: '午夜列车',
    content:
      '离午夜还有五分钟，一个男子上了列车。男子的神情很奇怪，他看了看车上的几个人，然后开始问起乘客的年龄。"女士，您今年28岁吗？""你怎么知道？""先生您今年55吗？""对呀。"然后男人一个个地猜对了乘客的年龄。"婆婆，您今年69岁吗？""不是的，再过5分钟我就要69岁了。"男子听完，脸色惨白。',
    answer:
      '男子有超能力，可以预知人的死亡年龄，但是看不到自己的。男子上车后，看到车上的人看起来和自己死亡的年龄几乎都差不多，他觉得很奇怪，于是试探性地问了几个人，发现这些人都将在当年死去。问到婆婆时，他意会过来五分钟后列车就会出事故，这一车的人都将死掉。',
  },
  {
    title: '洗衣机',
    content: '夜晚，贫穷的拾荒者捡了一台洗衣机回家。半夜他从睡梦中惊醒，好像听到了洗衣机启动的声音。',
    answer:
      '凶手杀人分尸，将尸体装入洗衣机内，再用洗衣机运尸块到郊外。拾荒者开着小三轮捡到洗衣机时，凶手正在不远处奋力挖土填坑。凶手反应过来时，拾荒者已经开着小三轮带着洗衣机跑了。于是凶手跟踪拾荒者到家，潜入启动洗衣机，为了清洗掉里面的血迹。',
  },
  {
    title: '奶奶',
    content:
      '我和奶奶、妈妈相依为命。奶奶很爱我。奶奶从不允许我去楼上的小阁楼。奶奶的身体越来越差，有一段时间我仿佛听见了阁楼上的咚咚咚的踩踏声。奶奶临死前告诉我阁楼上的柜子里有我最爱的洋娃娃，我来到阁楼打开柜子果然看见了一个洋娃娃。',
    answer:
      '奶奶很爱我，总想给我最好的。家里很穷，奶奶身体越来越差，妈妈却依旧让奶奶干重活，奶奶打算报复，于是把妈妈杀了。因为身体虚弱，所以她每天晚上把尸体的一部分搬上阁楼，慢慢做成了我喜欢的洋娃娃。',
  },
  {
    title: '小红裙',
    content: '姐姐为我选了一件小红裙，我穿着去上学了，然后有人死了。',
    answer:
      '我的母亲和老师有染，他们总趁着父亲不在时温存。而为老师提供信息的就是我的小红裙，每当我穿着小红裙去上学就说明那晚父亲准不在。这天妈妈忙，姐姐为我选了一件小红裙，老师看见以为父亲不在家，便来我家找母亲，正好被父亲撞上，然后父亲杀了他。',
  },
  {
    title: '好孩子',
    content: '"我要做个好孩子，我是个好孩子…"我不停对自己说道。新闻报道了一起凶杀案，凶手至今下落不明…',
    answer:
      '"我"是一只狗狗，像很多狗狗一样，"我"很警惕，每次家里来人"我"都会叫个不停。但是主人很不喜欢这样，他们受够了"我"每天看到快递员、邮递员，甚至他们的朋友也要大声汪汪的日子，主人们训练"我"要抑制住想叫的欲望。这一次，"我"在后院睡觉时突然被惊醒，我看见一个不认识的人深夜偷偷潜入主人们家里，"我"终于没有叫出声，看着这个不认识的人一个个残杀了我的主人们。',
  },
  {
    title: '好孩子',
    content: '爸爸把地面弄脏了，妈妈又不想做饭了，这么大的人了，还是这么顽皮，不像我，我要做一个好孩子。',
    answer:
      '我是一个孤儿，当初我的父母嫌我不听话而抛弃了我，所以我发誓一定要做一个好孩子。现在的爸妈领养了我，我努力听话，但是他们还是觉得我不合适，要把我送走。爸爸的血流了一地，把地面都弄脏了。妈妈在厨房里一动不动，看样子是做不了饭了。我看着自己沾满了鲜血的双手，我很开心，一个好孩子是不会被抛弃的，看来我还是一个好孩子呢！',
  },
  {
    title: '数数',
    content: '我数数，他也在数数，我毛骨悚然。',
    answer:
      '我家住在高层，今天我闲着无聊向窗户外面看的时候，意外目击了一场案件，就发生在对面大楼里，一个男人像是刺死了一个人。我连忙掏出手机想要报警，警察问我发生事故的楼层，于是我数着男人所在的楼层。等数到男人那层时，我发现男人注意到了我，数着我所在的楼层，握着血淋淋的刀，露出诡异的笑容！',
  },
  {
    title: '音乐',
    content: '一群人在听音乐，音乐停了，他死了。',
    answer:
      '他是个瞎子，在高空表演走钢丝，一群人在看。有人放音乐，他们约定好音乐停了就是他走到尽头了。可是中途，突然停电了，音乐在迫不得已的情况下停了，他以为他走到尽头了，便放松大意了，从高空中坠落而死。',
  },
  {
    title: '夺爱',
    content: '妈妈很喜欢"妹妹"，可这一切本来是我的。',
    answer:
      '我们是一对双胞胎，可妈妈从小就更喜欢妹妹。妈妈为了分辨我们，给了我一条项链让我天天戴着。那天晚上姐姐跟我说："我好喜欢你的项链，给我戴一会儿就一会儿！就戴一天，我明天早上就给你"，我没多想，便同意姐姐了。第二天妈妈带我们去游泳，一不小心，我们两个溺水了，妈妈想救妹妹，看到了那条项链误以为姐姐是妹妹，就救了姐姐。可是我们还没有换回来！（姐姐知道第二天妈妈要带她们去游泳，故意和妹妹一起溺水的，因为她知道妈妈更喜欢妹妹肯定会先救妹妹）',
  },
];

// 内置汤的分类标签（按标题映射，避免改动上面的数据块）
const SEED_TAGS = {
  奶奶的橘子树: '温情,脑洞',
  乞丐: '恐怖,脑洞',
  捉迷藏: '恐怖',
  预言: '脑洞,温情',
  灰姑娘: '恐怖,脑洞',
  人鱼公主: '恐怖,脑洞',
  午夜列车: '恐怖,硬核',
  洗衣机: '恐怖',
  奶奶: '恐怖,硬核',
  小红裙: '恐怖,脑洞',
  好孩子: '恐怖,脑洞',
  数数: '恐怖,硬核',
  音乐: '脑洞,温情',
  夺爱: '脑洞,硬核',
};

const countRow = db.prepare('SELECT COUNT(*) AS c FROM sips').get();
if (countRow.c === 0) {
  const insert = db.prepare(
    'INSERT INTO sips (title, content, answer, author, difficulty, tags) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const s of seedSips) {
    insert.run(s.title, s.content, s.answer, '系统', 'standard', SEED_TAGS[s.title] || '');
  }
}

module.exports = db;
module.exports.seedSips = seedSips;
module.exports.SEED_TAGS = SEED_TAGS;