// 批量生成日报：按出报日 × 早/晚双轨，产出可落云表的 JSON
// 用法：node tools/brief-generate.js [起始出报日] [结束出报日]
//       node tools/brief-generate.js --check       只做健康度检查，不打印全文
//
// 产物：data/brief/<YYYY-MM-DD>-<morning|evening>.json
// 这些文件不进小程序包（project.config.json 已 ignore data/brief/），
// 运行时由小程序从云端 daily_brief 表拉取。

const fs = require('fs');
const path = require('path');
const W = require('./brief-window.js');
const B = require('./brief-build.js');

const OUT = path.join(__dirname, '..', 'data', 'brief');

// 出报日序列
// ⚠️ pubDays() 是从「有已结束比赛的日期」反推的，只适合回测。
// 生产环境是**每天都要出报**（没有比赛就出前瞻），所以必须按日历逐日。
function calendarDays(from, to) {
  const out = [];
  let d = from;
  while (d <= to) {
    out.push(d);
    d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  }
  return out;
}

function generate(from, to, opts) {
  const days = (opts && opts.calendar) ? calendarDays(from, to) : W.pubDays().filter((d) => d >= from && d <= to);
  const all = [];
  let report = 0; let preview = 0; let broken = 0; let empty = 0;
  const byNarrative = {};

  days.forEach((ds) => {
    ['morning', 'evening'].forEach((kind) => {
      let o;
      try {
        o = B.build(ds, kind);
      } catch (e) {
        broken++;
        console.error('生成失败 ' + ds + ' ' + kind + '：' + e.message);
        return;
      }
      // 健康度：战报必须有标题，前瞻必须有条目；empty 是合法第三态（回测边界）
      const ok = (o.mode === 'report' && o.headline && o.headline.title)
        || (o.mode === 'preview' && o.preview && o.preview.items.length);
      if (!ok && o.mode !== 'empty') { broken++; console.error('空壳 ' + ds + ' ' + kind); return; }
      if (o.mode === 'report') { report++; byNarrative[o.headline.narrative] = (byNarrative[o.headline.narrative] || 0) + 1; }
      else if (o.mode === 'preview') preview++;
      else { empty++; return; } // empty 期不产出文件
      all.push(o);
      if (opts && opts.write) {
        const f = path.join(OUT, ds + '-' + kind + '.json');
        fs.writeFileSync(f, JSON.stringify(o, null, 2), 'utf8');
      }
    });
  });

  return { all, days: days.length, report, preview, empty, broken, byNarrative };
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const write = args.includes('--write');
const from = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))[0] || '2026-09-01';
const to = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))[1] || '2026-09-29';

if (write && !fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const r = generate(from, to, { write, calendar: true });

console.log('=== 批量生成 ' + from + ' → ' + to + ' ===');
console.log('出报日 ' + r.days + ' 天　共 ' + (r.report + r.preview) + ' 期');
console.log('  战报 ' + r.report + ' 期　前瞻 ' + r.preview + ' 期　无素材 ' + r.empty + ' 期　异常 ' + r.broken + ' 期');
console.log('\n头条叙事分布：');
Object.keys(r.byNarrative).sort((a, b) => r.byNarrative[b] - r.byNarrative[a])
  .forEach((k) => console.log('  ' + k.padEnd(14) + String(r.byNarrative[k]).padStart(3) + ' 期'));

if (write) console.log('\n已写入 ' + OUT);
if (!checkOnly && r.all.length) {
  console.log('\n=== 抽样（前 4 期）===');
  r.all.slice(0, 4).forEach((o) => console.log(B.render(o) + '\n'));
}
