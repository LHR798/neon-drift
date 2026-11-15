/* ============================================================
   NEON DRIFT · 成绩排行 API
   Cloudflare Pages Functions + D1

   路由（Pages 自动按文件路径映射）：
     GET  /api/scores            排行榜（支持 ?mode= &diff= &limit= &name=）
     GET  /api/scores?health=1   健康检查（用于部署后自检）
     POST /api/scores            提交一局成绩
     OPTIONS                     允许跨域预检

   绑定要求：Pages 项目 Settings → Functions → D1 database bindings
             Variable name = DB

   表结构见仓库根目录 schema.sql。若忘记执行建表，本模块会在首次
   请求时用 CREATE TABLE IF NOT EXISTS 自动补齐（懒初始化），
   因此直接部署也能跑；生产环境仍建议预先执行 schema.sql 建好索引。
   ============================================================ */

const LIMITS = {
  nameMin: 1, nameMax: 14,
  scoreMax: 2_000_000,
  secondsMax: 86_400,
  waveMax: 999,
  killsMax: 2_000_000,
  levelMax: 200,
  comboMax: 999,
  limitMax: 100,
  /* 合理性约束：分数不能脱离「存活时长 + 击杀数」凭空膨胀。
     这是宽松上限，正常游玩（含高连杀、精英、Boss、合约加成）不会触发。 */
  scorePerSecond: 900,
  scorePerKill: 220,
  scoreBase: 3000,
  killsPerSecond: 45,
  /* 限频：同一 IP 在窗口内最多提交次数 */
  rateWindowSec: 60,
  rateMax: 8,
  /* gameId 长度 */
  gameIdMax: 64
};

const MODES = ['standard', 'quick'];
const DIFFS = ['casual', 'standard', 'hard'];
const RANKS = ['D', 'C', 'B', 'A', 'S'];
const VER_MAX = 24;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: CORS });
}
function fail(msg, status, extra) {
  return json(Object.assign({ ok: false, error: msg }, extra || {}), status || 400);
}

/* 昵称：去控制字符 / 零宽字符 / 首尾空白，限制长度。
   前端渲染还会再转义一次，双保险防 XSS。 */
function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .replace(/[<>]/g, '')                 // 尖括号不能进昵称，服务端再挡一层 XSS
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.nameMax);
}

function int(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function num(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function clientIp(request) {
  return (request.headers.get('CF-Connecting-IP') ||
          request.headers.get('X-Forwarded-For') ||
          '0.0.0.0').split(',')[0].trim();
}
/* 不存明文 IP：只保留一段摘要，够做限频，不落用户隐私原文 */
async function ipHash(ip) {
  try {
    const data = new TextEncoder().encode(ip + '|neon-drift-v1');
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0'))
      .join('').slice(0, 24);
  } catch (_) { return 'unknown'; }
}

/* ---------- 懒建表 ----------
   按 DB 实例记录（WeakMap），而不是模块级布尔：绑定被替换、数据库重建、
   或表被删掉时，仍能重新建表。布尔标志会让新库沿用旧库的"已建"状态，
   导致首个请求 no such table、甚至丢掉一局成绩。 */
const schemaChecked = new WeakMap();
async function ensureSchema(db) {
  if (!db || typeof db !== 'object' || schemaChecked.get(db)) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS scores (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id     TEXT    NOT NULL UNIQUE,
      name        TEXT    NOT NULL,
      score       INTEGER NOT NULL,
      seconds     REAL    NOT NULL,
      wave        INTEGER NOT NULL,
      kills       INTEGER NOT NULL,
      level       INTEGER NOT NULL,
      combo       INTEGER NOT NULL DEFAULT 0,
      mode        TEXT    NOT NULL,
      difficulty  TEXT    NOT NULL,
      rank        TEXT    NOT NULL,
      ver         TEXT    NOT NULL DEFAULT '',
      ip_hash     TEXT    NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_scores_rank
                ON scores(score DESC, seconds ASC, created_at ASC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_scores_ip
                ON scores(ip_hash, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_scores_name
                ON scores(name, score DESC)`)
  ]);
  schemaChecked.set(db, true);
}

function isNoTable(e) {
  return /no such table|does not exist|SQLITE_ERROR/i.test(String(e && e.message || e));
}

/* 缺表时清掉该实例的标记、重建表，再把整个操作重跑一次。
   INSERT OR IGNORE + game_id UNIQUE 保证重试不会写重复记录。 */
async function withSchemaRetry(db, fn) {
  try { return await fn(); }
  catch (e) {
    if (!isNoTable(e)) throw e;
    schemaChecked.delete(db);
    await ensureSchema(db);
    return await fn();
  }
}

/* 筛选条件：mode / diff 的值已白名单化，SQL 里不拼用户输入 */
function whereClause(mode, diff) {
  const parts = [], binds = [];
  if (mode !== 'all') { parts.push('mode = ?'); binds.push(mode); }
  if (diff !== 'all') { parts.push('difficulty = ?'); binds.push(diff); }
  return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', binds };
}
function bindAll(stmt, arr) {
  return arr.length ? stmt.bind(...arr) : stmt;
}

/* ============================================================
   GET · 排行榜
   ============================================================ */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = url.searchParams;

  if (!env || !env.DB) {
    return fail('D1_NOT_BOUND', 503, {
      hint: '请在 Pages 项目 Settings → Functions → D1 database bindings 添加变量名为 DB 的绑定，然后重新部署'
    });
  }
  if (q.get('health') === '1') {
    try {
      return await withSchemaRetry(env.DB, async () => {
        await ensureSchema(env.DB);
        const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores').first();
        return json({ ok: true, service: 'neon-drift-scores', bound: true,
                      rows: r ? r.n : 0, time: Date.now() });
      });
    } catch (e) {
      return fail('DB_ERROR', 500, { msg: String(e.message || e).slice(0, 160) });
    }
  }

  const mode = MODES.includes(q.get('mode')) ? q.get('mode') : 'all';
  const diff = DIFFS.includes(q.get('diff')) ? q.get('diff') : 'all';
  const limit = int(q.get('limit'), 1, LIMITS.limitMax, 50);
  const myName = cleanName(q.get('name') || '');
  const w = whereClause(mode, diff);

  try {
    return await withSchemaRetry(env.DB, async () => {
    await ensureSchema(env.DB);
    const rows = await bindAll(env.DB.prepare(
      `SELECT id, name, score, seconds, wave, kills, level, combo,
              mode, difficulty, rank, ver, created_at
         FROM scores${w.sql}
        ORDER BY score DESC, seconds ASC, created_at ASC
        LIMIT ?`
    ), w.binds.concat([limit])).all();

    const tot = await bindAll(env.DB.prepare(
      `SELECT COUNT(*) AS n FROM scores${w.sql}`
    ), w.binds).first();

    /* 我的名次：在该筛选下，取这个昵称的最好一局，算它排第几。 */
    let myRank = null, myBest = null;
    if (myName) {
      const best = await bindAll(env.DB.prepare(
        `SELECT score, seconds FROM scores${w.sql}${w.sql ? ' AND' : ' WHERE'} name = ?
          ORDER BY score DESC, seconds ASC LIMIT 1`
      ), w.binds.concat([myName])).first();
      if (best) {
        myBest = best;
        const betterWhere = (w.sql ? w.sql + ' AND' : ' WHERE') +
          ' (score > ? OR (score = ? AND seconds < ?))';
        const cnt = await bindAll(env.DB.prepare(
          `SELECT COUNT(*) AS n FROM scores${betterWhere}`
        ), w.binds.concat([best.score, best.score, best.seconds])).first();
        myRank = (cnt ? cnt.n : 0) + 1;
      }
    }

    return json({
      ok: true,
      filter: { mode, diff, limit },
      items: rows.results || [],
      total: tot ? tot.n : 0,
      myRank, myBest,
      generatedAt: Date.now()
    });
    });
  } catch (e) {
    return fail('DB_ERROR', 500, { msg: String(e.message || e).slice(0, 160) });
  }
}

/* ============================================================
   POST · 提交一局成绩（幂等：gameId 相同不会重复入库）
   ============================================================ */
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env || !env.DB) {
    return fail('D1_NOT_BOUND', 503, {
      hint: '请在 Pages 项目 Settings → Functions → D1 database bindings 添加变量名为 DB 的绑定，然后重新部署'
    });
  }

  let body;
  try { body = await request.json(); }
  catch (_) { return fail('BAD_JSON', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('BAD_BODY', 400);

  const gameId = String(body.gameId || '').slice(0, LIMITS.gameIdMax);
  if (!gameId) return fail('NO_GAME_ID', 400);

  const name = cleanName(body.name) || '匿名驾驶员';
  if (name.length < LIMITS.nameMin) return fail('BAD_NAME', 400);

  const score = int(body.score, 0, LIMITS.scoreMax, 0);
  const seconds = num(body.seconds, 0, LIMITS.secondsMax, 0);
  const wave = int(body.wave, 1, LIMITS.waveMax, 1);
  const kills = int(body.kills, 0, LIMITS.killsMax, 0);
  const level = int(body.level, 1, LIMITS.levelMax, 1);
  const combo = int(body.combo, 0, LIMITS.comboMax, 0);
  const mode = MODES.includes(body.mode) ? body.mode : 'standard';
  const difficulty = DIFFS.includes(body.difficulty) ? body.difficulty : 'standard';
  const rank = RANKS.includes(body.rank) ? body.rank : 'D';
  const ver = String(body.ver || '').replace(/[^\w.\-]/g, '').slice(0, VER_MAX);

  /* 合理性校验：只挡明显伪造，不误伤正常高分。
     前几项是硬边界，后两项是「分数/击杀不能脱离时长凭空膨胀」。 */
  if (score > LIMITS.scoreBase + seconds * LIMITS.scorePerSecond + kills * LIMITS.scorePerKill) {
    return fail('IMPLAUSIBLE_SCORE', 422);
  }
  if (kills > 50 + seconds * LIMITS.killsPerSecond) {
    return fail('IMPLAUSIBLE_KILLS', 422);
  }

  const ip = await ipHash(clientIp(request));
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    return await withSchemaRetry(env.DB, async () => {
    await ensureSchema(env.DB);

    /* 幂等：同一 gameId 重复提交（网络重试 / 双击）直接返回已有结果 */
    const dup = await env.DB.prepare(
      'SELECT id, score, seconds, created_at FROM scores WHERE game_id = ?'
    ).bind(gameId).first();
    if (dup) {
      const c = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM scores WHERE score > ? OR (score = ? AND seconds < ?)'
      ).bind(dup.score, dup.score, dup.seconds).first();
      return json({ ok: true, duplicate: true, id: dup.id,
                    rank: (c ? c.n : 0) + 1, total: null });
    }

    /* 限频：同 IP 60 秒内最多 8 局，挡住最粗暴的脚本刷榜 */
    const rate = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM scores WHERE ip_hash = ? AND created_at > ?'
    ).bind(ip, nowSec - LIMITS.rateWindowSec).first();
    if (rate && rate.n >= LIMITS.rateMax) return fail('RATE_LIMITED', 429);

    const ins = await env.DB.prepare(
      `INSERT OR IGNORE INTO scores
       (game_id, name, score, seconds, wave, kills, level, combo,
        mode, difficulty, rank, ver, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(gameId, name, score, seconds, wave, kills, level, combo,
           mode, difficulty, rank, ver, ip, nowSec).run();

    let rowId = ins && ins.meta && ins.meta.last_row_id;
    if (!rowId) {
      const again = await env.DB.prepare('SELECT id FROM scores WHERE game_id = ?')
        .bind(gameId).first();
      rowId = again ? again.id : null;
    }

    const c = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM scores WHERE score > ? OR (score = ? AND seconds < ?)'
    ).bind(score, score, seconds).first();
    const t = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores').first();

    return json({ ok: true, id: rowId, rank: (c ? c.n : 0) + 1,
                  total: t ? t.n : 0, name, score }, 201);
    });
  } catch (e) {
    return fail('DB_ERROR', 500, { msg: String(e.message || e).slice(0, 160) });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
