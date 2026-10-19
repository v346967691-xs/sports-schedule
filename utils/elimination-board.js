/** 共用交互控制器；兼容旧球队签表与网球标准节点，只画确认的晋级线。 */
const tree = require('./tournament-bracket')
const windowed = require('./bracket-window')
function normalize(source, context) {
  if (!source || context === 'msi') return null
  if ((source.nodes || []).some(node => node.sides)) return source
  if ((source.columns || []).some(column => /胜者组|败者组|双败|upper|lower|loser|winner.*bracket/i.test(column.label))) return null
  const entries = (source.columns || []).flatMap((column, index) => column.nodes.map(node => {
    const sides = node.rows.map(row => ({id:row.key, name:row.name, color:row.color, score:row.score}))
    const won = node.rows.find(row => row.win && row.key && row.key !== 'TBD')
    const winnerId = node.finished && won && (!node.bo || won.score >= Math.floor(node.bo / 2) + 1) ? won.key : ''
    const labels=['四分之一决赛','半决赛','决赛','16强赛','32强赛','64强赛','128强赛']
    const label=labels[require('./bracket').koIndexOf(column.label)] || column.label
    return {id:node.id, matchIds:[node.id], round:{order:index,label}, sides, winnerId, summaryLabel:node.bo ? `BO${node.bo} · 系列赛局分` : '',
      status:node.status || (node.finished ? 'finished' : 'upcoming'), statusText:node.statusText || (node.finished ? '已结束' : ''),
      start:node.start, timeLabel:node.timeLabel || `${String(node.start || '').slice(5,10)} ${node.time || ''}`.trim()}
  }))
  return entries.length ? tree.build(entries) : null
}
function value(event, key) {
  return event && event.detail && event.detail[key] !== undefined ? event.detail[key] : event.currentTarget.dataset[key]
}
const controller = {
  readWindowSize(size) {
    if (!size) {
      try { size = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : typeof wx.getSystemInfoSync === 'function' ? wx.getSystemInfoSync() : {} }
      catch (_) { size = {} }
    }
    this.windowSize = {width:size.windowWidth || 375,height:(size.windowHeight || 667)*0.68}
  },
  onResize(e) { this.readWindowSize(e.size); this.manualZoom = null; if (this.data.bracket) this.setData(this.bracketState(this.data.bracket)) },
  bracketState(source, context) {
    if (context !== undefined && context !== this.boardContext) {
      this.boardContext = context; this.pairIndex = 0; this.manualZoom = null
    }
    if (!this.windowSize) this.readWindowSize()
    const bracket = normalize(source, this.boardContext) || tree.build([])
    if (this.pendingRound !== null && this.pendingRound !== undefined && bracket.columns.length) {
      const index = bracket.columns.findIndex(column => column.order === this.pendingRound)
      if (index >= 0) this.pairIndex = index
      this.pendingRound = null
    }
    const state = windowed.layout(bracket,{...this.windowSize,current:this.pairIndex || 0,zoom:this.manualZoom})
    this.pairIndex = state.current
    const pane = state.pages[state.current]
    return {boardTree:bracket,bracketPages:state.pages,roundNavigation:state.navigation,bracketIndex:state.current,
      zoom:state.zoom,zoomLabel:Math.round(state.zoom*100),autoFit:!Number.isFinite(this.manualZoom),
      treeWidth:pane?pane.treeWidth:0,treeHeight:pane?pane.treeHeight:0}
  },
  selectBracketPair(index) {
    if (!this.data.bracket || !Number.isInteger(index)) return
    const columns = this.data.bracket.columns || []
    const next = Math.max(0,Math.min(index,Math.max(0,columns.length-2)))
    if (next === this.pairIndex) return
    this.pairIndex = next; this.manualZoom = null
    this.setData(this.bracketState(this.data.bracket))
  },
  onBracketSwipe(e) { this.selectBracketPair(Number(e.detail.current)) },
  onBracketRound(e) { this.selectBracketPair(Number(value(e,'index'))) },
  onAutoFit() { if(this.data.bracket){this.manualZoom=null;this.setData(this.bracketState(this.data.bracket))} },
  onZoom(e) {
    if(!this.data.bracket)return
    const step=Number(value(e,'step'));if(!Number.isFinite(step))return
    this.manualZoom=Math.max(0.4,Math.min(1.6,Math.round((this.data.zoom+step)*100)/100))
    this.setData(this.bracketState(this.data.bracket))
  },
  onBoardMatch(e) { this.goDetail({currentTarget:{dataset:{id:e.detail.id}}}) },
}
module.exports={normalize,controller}
