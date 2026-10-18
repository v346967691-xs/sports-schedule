const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const vm = require('vm')
const poster = require('../utils/poster')
function context() {
  return {
    font: '', textAlign: 'left', texts: [], gradients: [],
    createLinearGradient(...coords) {
      const gradient = { coords, stops: [], addColorStop(at, color) { this.stops.push([at, color]) } }
      this.gradients.push(gradient)
      return gradient
    },
    measureText(text) {
      const size = Number((this.font.match(/([\d.]+)px/) || [0, 20])[1])
      return { width: [...String(text)].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? size : size * .6), 0) }
    },
    fillText(text, x, y) { this.texts.push({text, x, y, width: this.measureText(text).width, align: this.textAlign, font: this.font, color: this.fillStyle}) },
    fillRect() {}, drawImage() {}, scale() {}, clearRect() {},
  }
}
test('match cards keep long names, dotted IDs and unequal line counts centered clear of three-digit scores', () => {
  for (const [cat, home, away] of [
    ['football', '巴黎圣日耳曼', '皇家马德里'],
    ['basketball', '俄克拉荷马城雷霆', '明尼苏达森林狼'],
    ['tennis', '米拉·安德烈耶娃', '维罗妮卡·库德梅托娃'],
    ['esports', '杭州LGD.NBW', '苏州KSG'],
  ]) for (const scored of [false, true]) {
    const ctx = context()
    poster.drawMatch(ctx, {cat, home, away, homeScore: scored ? 128 : null, awayScore: scored ? 109 : null})
    const h = ctx.texts.filter(t => t.x < 250 && t.align === 'center')
    const a = ctx.texts.filter(t => t.x > 250 && t.align === 'center')
    const middle = ctx.texts.find(t => t.x === 250)
    assert.equal(h.map(t => t.text).join(''), home)
    assert.equal(a.map(t => t.text).join(''), away)
    assert.ok(h.length <= 2 && a.length <= 2)
    assert.equal(h[0].font, a[0].font)
    for (const t of h) assert.ok(t.x + t.width / 2 <= 250 - middle.width / 2 - 11)
    for (const t of a) assert.ok(t.x - t.width / 2 >= 250 + middle.width / 2 + 11)
    for (const lines of [h, a]) assert.equal(lines.reduce((n,t) => n + t.y, 0) / lines.length, 192)
    assert.ok(!ctx.texts.some(t => t.text.includes('…')))
    assert.ok(ctx.texts.every(t => t.color === (scored && t === middle ? '#ffe0a3' : '#ffffff')))
    if (scored) assert.ok(parseInt(middle.font.match(/(\d+)px/)[1]) > parseInt(h[0].font.match(/(\d+)px/)[1]))
    if (cat === 'esports') assert.ok(h.some(t => t.text.includes('LGD.NBW')))
    if (cat === 'basketball' && !scored) assert.equal(h[0].text, '俄克拉荷马城')
  }
})
test('upcoming zeroes remain VS; live zeroes and completed triple-digit scores are retained', () => {
  for (const [status, homeScore, awayScore, expected] of [['upcoming',0,0,'VS'],['live',0,0,'0-0'],['finished',128,109,'128-109'],['live',NaN,1,'VS']]) {
    const ctx=context(); poster.drawMatch(ctx,{status,homeScore,awayScore})
    assert.ok(ctx.texts.some(t => t.text === expected))
  }
})

test('final scores are prominently larger than names and VS, with a separate color', () => {
  const ctx = context()
  poster.drawMatch(ctx, {status:'finished',home:'梅德韦杰夫',away:'保罗',homeScore:2,awayScore:1,statusText:'已结束'})
  const score = ctx.texts.find(t => t.text === '2-1')
  assert.match(score.font, /800 56px/)
  assert.equal(score.color, '#ffe0a3')
  assert.equal(ctx.texts.find(t => t.text === '已结束').color, '#ffffff')
})
test('corner labels never overlap and dates are explicit even when a share is viewed later', () => {
  assert.equal(poster.matchDate('2026-10-18'),'10月18日')
  assert.equal(poster.matchDate('明天'),'')
  const ctx=context()
  poster.drawMatch(ctx,{comp:'武汉网球公开赛 · WTA 1000',stage:'Quarterfinal',date:'2026-10-18',timeText:'18:30',statusText:'第2盘进行中'})
  for (const y of [34,372]) {
    const [right,left]=ctx.texts.filter(t=>t.y===y)
    assert.ok(left.x + left.width + 17 <= right.x - right.width)
    assert.match(left.font, /700 20px/)
    assert.match(right.font, /700 20px/)
  }
  assert.ok(ctx.texts.some(t=>t.text==='10月18日 18:30'))
  assert.deepEqual(ctx.gradients.map(g => g.coords), [[0,0,0,100],[0,400,0,300]])
  assert.ok(ctx.gradients.every(g => g.stops[0][1] === 'rgba(5,17,35,0.82)' && g.stops.at(-1)[1] === 'rgba(5,17,35,0)'))
  assert.equal(ctx.shadowColor, 'transparent')
})
test('each sport selects its packaged background and a failed image still produces a card', async () => {
  const loaded=[];const ctx=context()
  let fail=false
  const canvas={getContext:()=>ctx,createImage:()=>({set src(s){loaded.push(s); Promise.resolve().then(()=>fail?this.onerror():this.onload())}})}
  const box={require, module:{exports:{}},wx:{createSelectorQuery:()=>({in(){return this},select(){return this},fields(){return this},exec(cb){cb([{node:canvas}])}}),canvasToTempFilePath(o){o.success({tempFilePath:'card.jpg'})}}}
  // Resolve the module's only runtime dependency from its own directory.
  box.require=require('module').createRequire(require.resolve('../utils/poster'))
  vm.runInNewContext(fs.readFileSync(require.resolve('../utils/poster'),'utf8'),box)
  for(const cat of Object.keys(poster.BG.matches)) {
    assert.equal(await box.module.exports.build({},'canvas','match',{cat}),'card.jpg')
    assert.equal(loaded.at(-1),poster.BG.matches[cat])
    assert.ok(fs.existsSync(require('path').join(__dirname,'..',loaded.at(-1))))
  }
  fail=true
  assert.equal(await box.module.exports.build({},'canvas','match',{cat:'tennis'}),'card.jpg')
})

test('right corner keeps its full last character anchored and expands left without clipping or overlap', () => {
  for (const stage of ['德玛西亚杯 · 决赛', '德玛西亚杯英雄联盟职业锦标赛 · 淘汰赛半决赛']) {
    const ctx = context()
    poster.drawMatch(ctx, {comp:'德玛西亚杯',stage,date:'2026-10-17',timeText:'17:00',statusText:'已结束'})
    const [right, left] = ctx.texts.filter(t => t.y === 34)
    assert.equal(right.text, stage)
    assert.equal(left.text, '德玛西亚杯')
    assert.equal(right.align, 'right')
    assert.equal(right.x, 472)
    assert.ok(right.x - right.width >= left.x + left.width + 17.9)
    assert.ok(!ctx.texts.some(t => t.text.includes('…')))
  }
})

test('brief card raises its title, places a small bold date to the right and centers the enlarged summary', () => {
  const ctx = context()
  poster.drawBrief(ctx, {bg:{},dateText:'10月18日',kindZh:'早报',sub:'千钧利落：KC 3-0 带走 MVK'})
  const title = ctx.texts.find(t => t.text === '闪现早报')
  const date = ctx.texts.find(t => t.text === '10月18日')
  assert.equal(title.y, 136)
  assert.equal(date.y, 142)
  assert.match(date.font, /700 18px/)
  assert.ok(date.x >= title.x + title.width + 15)
  const summary = ctx.texts.filter(t => t.y >= 210 && t.y <= 244)
  assert.ok(summary.length > 0 && summary.length <= 2)
  assert.ok(summary.every(t => t.x === 250 && t.align === 'center' && /700 24px/.test(t.font)))
})

test('wrapped brief summary is left aligned within a centered text block', () => {
  const ctx = context()
  poster.drawBrief(ctx, {bg:{},kindZh:'晚报',sub:'FUR 3-1 拿下 GG，晋级比赛入决胜局'})
  const lines = ctx.texts.filter(t => t.y === 210 || t.y === 244)
  assert.equal(lines.length, 2)
  assert.ok(lines.every(t => t.align === 'left' && t.x === lines[0].x))
  const width = Math.max(...lines.map(t => t.width))
  assert.equal(lines[0].x, (500 - width) / 2)
})
