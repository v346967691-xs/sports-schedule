const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const old=require('../utils/bracket'),board=require('../utils/elimination-board')
function match(id,stage,home,away,extra={}) {
  return {id,stage,comp:'worlds',start:'2026-11-01T12:00Z',time:'20:00',status:'upcoming',bo:5,
    home:{id:home,name:home,score:null},away:{id:away,name:away,score:null},...extra}
}
function source() {
  return old.buildBracket([match('q1','四分之一决赛','A','B',{status:'finished',home:{id:'A',name:'A',score:3},away:{id:'B',name:'B',score:1}}),
    match('q2','四分之一决赛','C','D',{status:'finished',home:{id:'C',name:'C',score:3},away:{id:'D',name:'D',score:2}}),
    match('q3','四分之一决赛','E','F'),match('q4','四分之一决赛','G','H'),
    match('s1','半决赛','A','C'),match('s2','半决赛','TBD','TBD'),match('f','决赛','TBD','TBD')],'全球总决赛')
}
test('shared board translates team nodes and draws only known advancement, never chronological guesses',()=>{
  const input=source(),before=JSON.stringify(input),tree=board.normalize(input,'worlds')
  assert.deepEqual(tree.columns.map(c=>c.label),['四分之一决赛','半决赛','决赛'])
  assert.equal(tree.edges.length,2)
  assert.ok(tree.edges.every(e=>e.to==='s1'))
  assert.equal(tree.champion,'')
  assert.equal(JSON.stringify(input),before)
  const incomplete=structuredClone(input);incomplete.columns[0].nodes[0].rows[0].score=1
  assert.ok(!board.normalize(incomplete,'worlds').edges.some(e=>e.from==='q1'))
  const gap=structuredClone(input);gap.columns.splice(1,1)
  gap.columns[1].nodes[0].rows[0].key='A'
  assert.equal(board.normalize(gap,'worlds').edges.length,0,'missing semifinals cannot become a direct quarterfinal-to-final edge')
})
test('earlier knockout rounds sort before quarters while Swiss, double elimination and placement games stay out',()=>{
  const input=old.buildBracket([match('r32','Round of 32','A','B'),match('r16','八分之一决赛','A','C'),
    match('q','Quarterfinal','A','D'),match('s','Semifinal','A','E'),match('f','Final','A','F')],'Worlds')
  assert.deepEqual(board.normalize(input).columns.map(c=>c.label),['32强赛','16强赛','四分之一决赛','半决赛','决赛'])
  for(const label of ['瑞士轮','小组赛','第16周','胜者组决赛','败者组半决赛','季军决赛','三四名决赛','Play-in final'])assert.equal(old.koIndexOf(label),-1,label)
  assert.equal(board.normalize(source(),'msi'),null)
})
test('shared parent controller supports swipe, icons, zoom, fit and detail navigation across pages',()=>{
  const page={...board.controller,data:{bracket:source()},setData(p){Object.assign(this.data,p)},goDetail(e){this.opened=e.currentTarget.dataset.id}}
  page.readWindowSize({windowWidth:375,windowHeight:700})
  page.setData(page.bracketState(page.data.bracket,'worlds'))
  assert.equal(page.data.bracketPages.length,2)
  assert.equal(page.data.roundNavigation.at(-1).final,true)
  page.onZoom({detail:{step:-0.2}});assert.equal(page.data.autoFit,false)
  page.onBracketSwipe({detail:{current:1}});assert.equal(page.data.bracketIndex,1);assert.equal(page.data.autoFit,true)
  page.onBracketRound({detail:{index:0}});assert.equal(page.data.bracketIndex,0)
  page.onAutoFit();assert.equal(page.data.autoFit,true)
  page.onBoardMatch({detail:{id:'s1'}});assert.equal(page.opened,'s1')
  page.setData(page.bracketState(page.data.bracket,'demacia'));assert.equal(page.data.bracketIndex,0)
})
test('all progressive board surfaces register the same packaged component and forward its interaction events',()=>{
  for(const name of ['tournament','worlds','schedule']) {
    const dir=path.resolve(__dirname,'../pages',name),config=JSON.parse(fs.readFileSync(path.join(dir,name+'.json')))
    assert.equal(config.usingComponents['elimination-board'],'/components/elimination-board/elimination-board')
    const wxml=fs.readFileSync(path.join(dir,name+'.wxml'),'utf8'),js=fs.readFileSync(path.join(dir,name+'.js'),'utf8')
    assert.ok(wxml.includes('<elimination-board'))
    for(const binding of ['bindzoom="onZoom"','bindswipe="onBracketSwipe"','bindround="onBracketRound"','bindautofit="onAutoFit"','bindmatchtap="onBoardMatch"'])assert.ok(wxml.includes(binding),name+binding)
    assert.ok(js.includes("require('../../utils/elimination-board').controller"))
  }
  const wxml=fs.readFileSync(path.resolve(__dirname,'../components/elimination-board/elimination-board.wxml'),'utf8')
  assert.ok(wxml.includes('pane.bracket.nodes'))
  assert.ok(!wxml.includes('pane.tree.nodes'))
  assert.ok(wxml.includes('round-map-trophy'))
  let definition
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../components/elimination-board/elimination-board.js'),'utf8'),{Component:d=>{definition=d}})
  const events=[],component={triggerEvent:(...args)=>events.push(args)}
  for(const [method,event] of [['onRound',{currentTarget:{dataset:{index:1}}}],['onSwipe',{detail:{current:1}}],['onZoom',{currentTarget:{dataset:{step:-0.2}}}],['onMatch',{currentTarget:{dataset:{id:'q1'}}}]])definition.methods[method].call(component,event)
  assert.deepEqual(events.map(e=>e[0]),['round','swipe','zoom','matchtap'])
  assert.equal(events[3][1].id,'q1')
})
