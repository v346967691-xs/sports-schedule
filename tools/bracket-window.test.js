const test=require('node:test'),assert=require('node:assert/strict')
const graph=require('../utils/tournament-bracket'),windowed=require('../utils/bracket-window')
function fullDraw(size=128){
  const entries=[];let players=Array.from({length:size},(_,i)=>String(i+1)),round=1
  while(players.length>1){
    const label=players.length===2?'决赛':players.length===4?'半决赛':players.length===8?'四分之一决赛':`第${round}轮`
    const next=[]
    for(let i=0;i<players.length;i+=2){
      entries.push({id:`r${round}-${i}`,round:{order:round,label},status:'finished',winnerId:players[i],
        sides:[{id:players[i],name:`Player ${players[i]}`,score:2},{id:players[i+1],name:`Player ${players[i+1]}`,score:0}]})
      next.push(players[i])
    }
    players=next;round++
  }
  return graph.build(entries,{followedIds:['1']})
}
test('a full draw compacts the last two rounds into one phone screen without scaling away the player names',()=>{
  const source=fullDraw(),before=JSON.stringify(source)
  const state=windowed.layout(source,{width:320,height:400,current:5})
  const pane=state.pages[state.current],nodes=pane.bracket.nodes
  assert.equal(nodes.length,3);assert.equal(state.current,5)
  assert.ok(source.nodes.filter(n=>n.column>=5).some(n=>n.top>400*750/320))
  assert.ok(pane.treeHeight<=400*750/320)
  assert.ok(pane.treeWidth<=750-32);assert.ok(pane.zoom>=0.85)
  assert.equal(pane.bracket.lines.length,6)
  assert.ok(nodes.some(n=>n.sides.some(s=>s.followed)))
  assert.equal(JSON.stringify(source),before,'view changes never mutate the full draw')
  assert.equal(state.navigation.filter(n=>n.selected).length,2)
  assert.equal(state.navigation.at(-1).final,true)
})
test('early rounds remain readable and vertically scrollable; changing rounds resets a manual zoom',()=>{
  const source=fullDraw()
  const initial=windowed.layout(source,{width:390,height:500,current:0,zoom:1.4})
  assert.equal(initial.pages[0].zoom,1.4)
  assert.ok(initial.pages[0].treeHeight>500*750/390)
  const late=windowed.layout(source,{width:390,height:500,current:99})
  assert.equal(late.current,5)
  assert.ok(late.pages[5].zoom<=1.15)
  assert.equal(late.navigation[4].label,'1/4决赛')
})
test('missing contestants keep placeholders and have no invented advancement lines',()=>{
  const source=graph.build([{id:'semi-a',round:{order:1,label:'半决赛'},sides:[{id:'a',name:'A'},{id:'b',name:'B'}]},
    {id:'semi-b',round:{order:1,label:'半决赛'},sides:[{id:'c',name:'C'},{id:'d',name:'D'}]},
    {id:'final',round:{order:2,label:'决赛'},sides:[{id:'TBD',name:'待定'},{id:'0',name:'待定'}]}])
  const pane=windowed.layout(source).pages[0]
  assert.equal(pane.bracket.nodes.length,3);assert.equal(pane.bracket.lines.length,0)
  assert.equal(windowed.layout(graph.build([])).pages.length,0)
  assert.equal(windowed.layout(graph.build([source.nodes[2]])).pages.length,1)
})
test('official explicit progression edges survive pair layout even before the winner is known',()=>{
  const source=graph.build([{id:'semi',round:{order:1,label:'半决赛'},sides:[{id:'a',name:'A'},{id:'b',name:'B'}]},
    {id:'final',round:{order:2,label:'决赛'},sides:[{id:'0',name:'待定'},{id:'TBD',name:'待定'}]}],{edges:[{from:'semi',to:'final'}]})
  const pane=windowed.layout(source).pages[0]
  assert.equal(pane.bracket.lines.length,3)
  assert.ok(pane.bracket.nodes.every(n=>!n.winnerId))
})
test('all archived events fit late rounds on narrow screens and keep every window free from overlapping cards',()=>{
  const archive=require('../utils/tennis-event'),rows=archive.archiveRows(require('../data/tennis-events'))
  const events=archive.eventsOf(rows)
  let largest=0
  for(const event of events){
    const source=graph.build(graph.tennisEntries(rows.filter(row=>archive.identity(row).key===event.key)))
    const state=windowed.layout(source,{width:320,height:400})
    largest=Math.max(largest,Buffer.byteLength(JSON.stringify(state)))
    for(const page of state.pages){
      const nodes=page.bracket.nodes
      for(const column of new Set(nodes.map(n=>n.column))){
        const same=nodes.filter(n=>n.column===column).sort((a,b)=>a.top-b.top)
        same.slice(1).forEach((node,i)=>assert.ok(node.top-same[i].top>=page.bracket.nodeHeight,`${event.name} overlaps`))
      }
      if([0,1].every(col=>nodes.filter(n=>n.column===col).length<=4))assert.ok(page.treeHeight<=400*750/320)
    }
  }
  assert.ok(largest<450000,'keep window state well below the per-update transfer limit')
})
