// 组装一期完整日报 —— 产出可直接落云表的 JSON
//
// 用法：node tools/brief-build.js 2026-09-21 morning [--json]
//
// ⚠️ 合规：AI 生成内容必须带标识（《人工智能生成合成内容标识办法》2025-09-01 施行）。
// 这里同时写入显式标识（页面展示的文案）与隐式标识（aigc 元数据字段），
// 缺一项都过不了小程序审核。

const W = require('./brief-window.js');
const Wr = require('./brief-write.js');
const Im = require('./brief-image.js');
const Pv = require('./brief-preview.js');

const HOUR = 3600000;

function pad(n) { return String(n).padStart(2, '0'); }

// ISO（北京时区）用于展示
function bjIso(ms) {
  const d = new Date(ms + 8 * HOUR);
  return d.toISOString().slice(0, 10) + 'T' + d.toISOString().slice(11, 16) + ':00+08:00';
}

function fmtWindow(from, to) {
  const f = new Date(from + 8 * HOUR).toISOString();
  const t = new Date(to + 8 * HOUR).toISOString();
  return f.slice(5, 10).replace('-', '/') + ' ' + f.slice(11, 16) + ' → ' + t.slice(5, 10).replace('-', '/') + ' ' + t.slice(11, 16);
}

// 同一天出两期，seq 用「日期序号」让标题与意象轮换，避免连续几天撞句式
function seqOf(dateStr) {
  return parseInt(dateStr.slice(8, 10), 10) + (parseInt(dateStr.slice(5, 7), 10) * 3);
}

function build(dateStr, kind) {
  const isMorning = kind === 'morning';
  const res = isMorning ? W.morning(dateStr, 4, W.carryOver(W.prevDay(dateStr))) : W.evening(dateStr, 4);
  const pubAt = isMorning ? W.bjMs(dateStr, W.MORNING_HOUR) : W.bjMs(dateStr, W.EVENING_HOUR);
  const seq = seqOf(dateStr) + (isMorning ? 0 : 1);

  const out = {
    id: dateStr + '-' + kind,
    kind,
    date: dateStr,
    pubAt: bjIso(pubAt),
    window: { from: bjIso(res.window[0]), to: bjIso(res.window[1]) },
    windowLabel: fmtWindow(res.window[0], res.window[1]),
    mode: res.top.length ? 'report' : 'preview',
    headline: null,
    briefs: [],
    preview: null,
    aigc: {
      explicit: 'AI 生成',
      explicitNote: '本页赛事信息与文字由 AI 基于公开赛程数据自动生成',
      implicit: { AIGC: true, generator: 'sports-brief', labeled: true },
    },
    generatedAt: bjIso(Date.now()),
  };

  if (!res.top.length) {
    // 空窗 → 前瞻：取未来 72 小时
    const from = pubAt;
    const to = from + 72 * HOUR;
    const list = W.M.filter((m) => {
      const t = Date.parse(m.start);
      return m.status === 'upcoming' && t >= from && t < to;
    });
    // ⚠️ mode 三态，第三种是 'empty'：既没有已结束的比赛、也没有未来赛程可前瞻。
    // 回测历史日期时必然出现（快照里那时段的比赛早已 finished，没有 upcoming），
    // 生产环境不会遇到（快照始终带约 62 天 future fixtures）。
    // 必须显式区分，否则会产出「导语有、清单空」的空壳日报。
    if (!list.length) {
      out.mode = 'empty';
      out.note = '本窗口无已结束比赛，且快照内无未来赛程可供前瞻';
      return out;
    }
    // 每栏最多 3 条：三栏齐全时共 9 条，够读又不至于变成赛程表
    out.preview = Pv.build(list, pubAt, 3);
    out.preview.intro = Pv.intro(dateStr, kind, out.windowLabel, 72);
    return out;
  }

  // 头条
  const head = res.top[0];
  const t = Wr.title(head, seq);
  out.headline = {
    matchId: head.id,
    narrative: t.narrative.key,
    narrativeZh: t.narrative.label,
    score: head._score,
    reasons: head._reasons,
    title: t.text,
    lead: Wr.lead(head),
    body: Wr.body(head),
    factbox: Wr.factbox(head),
    image: Im.imageConcept(head, seq),
  };

  // 简讯：同期其他比赛的一句话
  out.briefs = res.top.slice(1).map((m) => {
    const nar = Wr.narrative(m);
    const comp = Wr.compZh(m.comp);
    return {
      matchId: m.id,
      comp,
      stage: Wr.stageZh(m.stage),
      line: comp + '：' + m.home.zh + ' ' + m.home.score + '-' + m.away.score + ' ' + m.away.zh,
      narrative: nar.key,
      narrativeZh: nar.label,
      score: m._score,
    };
  });

  return out;
}

function render(o) {
  const L = [];
  const kindZh = o.kind === 'morning' ? '早报' : '晚报';
  L.push('┌─ ' + o.date + ' ' + kindZh + '　' + o.windowLabel + '　出报 ' + o.pubAt.slice(11, 16));
  if (o.mode === 'empty') {
    L.push('│ 　（无素材 · 不出报）');
    L.push('│ ' + (o.note || ''));
  } else if (o.mode === 'preview') {
    L.push('│ 　（空窗期 · 前瞻）');
    L.push('│ ' + o.preview.intro);
    let lastGroup = null;
    o.preview.items.forEach((it, i) => {
      if (it.group !== lastGroup) {
        lastGroup = it.group;
        L.push('│ 　〔' + it.groupZh + '〕');
      }
      L.push('│ 　' + (i + 1) + '. ' + it.time.slice(5) + '　' + it.comp + (it.stage && it.stage !== it.comp ? it.stage : '') + '　' + it.home + ' vs ' + it.away);
      L.push('│ 　　　' + (it.why ? it.why + '　·　' : '') + it.relative + '开赛');
    });
  } else {
    const h = o.headline;
    L.push('│');
    L.push('│ ★ ' + h.title);
    L.push('│ 　' + h.lead);
    h.body.forEach((p) => L.push('│ 　' + p));
    L.push('│');
    L.push('│ 〔图〕' + h.image.conceptZh + '　配色 ' + h.image.palette.primary + ' / ' + h.image.palette.secondary);
    L.push('│ 　　　' + h.image.prompt.slice(0, 120) + '…');
    if (o.briefs.length) {
      L.push('│');
      L.push('│ 简讯');
      o.briefs.forEach((b) => L.push('│ 　· ' + b.line + (b.narrativeZh ? '　（' + b.narrativeZh + '）' : '')));
    }
  }
  L.push('└─ ' + o.aigc.explicit + '：' + o.aigc.explicitNote);
  return L.join('\n');
}

// ⚠️ 必须判断 require.main：brief-push.js 会 require 本文件，
// 不判断的话被 require 时也会跑一遍 CLI 并 process.exit（踩过）
if (require.main === module) {
  const dateStr = process.argv[2];
  const kind = process.argv[3] || 'morning';
  if (!dateStr) {
    console.error('用法：node tools/brief-build.js <出报日 YYYY-MM-DD> [morning|evening] [--json]');
    process.exit(1);
  }
  const o = build(dateStr, kind);
  if (process.argv.includes('--json')) console.log(JSON.stringify(o, null, 2));
  else console.log(render(o));
}

module.exports = { build, render, bjIso };
