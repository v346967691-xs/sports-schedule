/** 相邻两轮独立适配；只改变布局，不补造选手、签位或晋级关系。 */
const tree = require('./tournament-bracket')
function layout(bracket, options = {}) {
  const width = Math.max(240, options.width || 375), height = Math.max(220, options.height || 454)
  const availableWidth = 750 - 32
  const availableHeight = height * 750 / width - 32
  const columns = bracket.columns || []
  const count = Math.max(0, columns.length - 1)
  const current = Math.max(0, Math.min(options.current || 0, Math.max(0, count - 1)))
  const followedIds = [...new Set((bracket.nodes || []).flatMap(node => node.sides.filter(side => side.followed).map(side => side.id)))]
  const pages = Array.from({length: columns.length ? Math.max(1, count) : 0}, (_, index) => {
    const orders = columns.slice(index, index + 2).map(column => column.order)
    const entries = bracket.nodes.filter(node => orders.includes(node.round.order)).map(node => {
      const {top, left, column, ...entry} = node
      return entry
    })
    const pair = tree.build(entries, {followedIds, edges: bracket.edges || []})
    const shift = Math.min(...pair.nodes.map(node => node.top)) - 20
    pair.nodes = pair.nodes.map(node => ({...node, top: node.top - shift}))
    pair.lines = pair.lines.map(line => ({...line, top: line.top - shift}))
    pair.height -= shift
    // 早轮保持字号和上下滚动；四分之一决赛以后的少量卡片尽量完整适配高度。
    const late = pair.columns.every(column => column.nodes.length <= 4)
    const autoZoom = Math.floor(Math.min(1.15, availableWidth / pair.width,
      late ? availableHeight / pair.height : Infinity) * 1000) / 1000
    const zoom = index === current && Number.isFinite(options.zoom) ? options.zoom : autoZoom
    const display = {nodes: pair.nodes, lines: pair.lines, width: pair.width, height: pair.height, nodeWidth: pair.nodeWidth, nodeHeight: pair.nodeHeight}
    return {index, key: String(columns[index].order), bracket: display, autoZoom, zoom,
      treeWidth: Math.ceil(pair.width * zoom), treeHeight: Math.ceil(pair.height * zoom), scrollTop: 0}
  })
  const navigation = columns.map((column, index) => ({index, key: String(column.order),
    label: column.label.replace('四分之一决赛', '1/4决赛'),
    final: /^(?:总)?决赛$/.test(column.label),
    bars: Array.from({length: Math.min(8, Math.max(2, Math.ceil(Math.log2(column.nodes.length)) + 1))}, (_, i) => i),
    selected: index === current || index === current + 1, first: index === current, last: index === current + 1 || columns.length === 1}))
  return {pages, navigation, current, zoom: pages[current] ? pages[current].zoom : 1}
}
module.exports = {layout}
