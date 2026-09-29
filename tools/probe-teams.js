// 列出数据中出现过的队伍中文名，用于建立强队名单
const M = require('../data/matches.js');

const groups = {};
M.forEach(m => {
  const g = groups[m.comp] || (groups[m.comp] = new Set());
  if (m.home && m.home.zh) g.add(m.home.zh);
  if (m.away && m.away.zh) g.add(m.away.zh);
});

const order = ['epl', 'liga', 'seriea', 'bundesliga', 'ligue1', 'ucl', 'uel', 'nations', 'chn',
  'lpl', 'lck', 'lec', 'worlds', 'msi', 'nba'];

order.forEach(c => {
  const set = groups[c];
  if (!set) return;
  const arr = Array.from(set).sort();
  console.log('\n=== ' + c + ' （' + arr.length + ' 队）===');
  // 每行最多 6 个，便于阅读
  for (let i = 0; i < arr.length; i += 6) {
    console.log('  ' + arr.slice(i, i + 6).map(s => s.padEnd(14)).join(''));
  }
});

console.log('\n=== 出现的 stage 取值样例 ===');
const stages = {};
M.forEach(m => { stages[m.comp] = stages[m.comp] || new Set(); stages[m.comp].add(m.stage); });
order.forEach(c => {
  if (stages[c]) console.log('  ' + c.padEnd(12) + Array.from(stages[c]).slice(0, 8).join(' / '));
});
