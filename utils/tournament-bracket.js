/** 通用晋级图：适配器负责轮次/胜者/系列赛，布局只连接已核实的晋级关系。 */
const tennis = require('./tennis')
const view = require('./view')
const NODE_W = 280, NODE_H = 118, COLUMN_GAP = 62, ROW_GAP = 24, HEADER_H = 62
const validPlayer = id => !!id && !/^(?:TBD|待定|0|-\d+)$/i.test(String(id))

function tennisRound(match) {
  const raw = String(match.stage || '').split('·').slice(1).join('·').trim()
  if (/qualif/i.test(raw)) return null
  if (/^quarter\s*finals?$|四分之一|八强/i.test(raw)) return { order: 105, label: '四分之一决赛' }
  if (/^semi\s*-?\s*finals?$|半决赛/i.test(raw)) return { order: 106, label: '半决赛' }
  if (/^(?:grand\s*)?finals?$|^决赛$/i.test(raw)) return { order: 107, label: '决赛' }
  let n = raw.match(/^Round\s+(\d+)$/i)
  if (n) return { order: Number(n[1]), label: `第${n[1]}轮` }
  n = raw.match(/^Round of\s+(\d+)$/i)
  if (n) return { order: 100 - Math.log2(Number(n[1])), label: `${n[1]}强赛` }
  return null
}

function tennisEntries(matches) {
  return (matches || []).filter(match=>tennis.isTennis(match)&&require('./match-status').normalize(match).status!=='canceled').map(match => {
    match=require('./match-status').normalize(match)
    match = require('./tennis-result').display(match)
    const round = tennisRound(match)
    if (!round) return null
    const sides = ['home', 'away'].map(side => {
      const player = match[side] || {}
      return { id: String(player.id || ''), name: validPlayer(player.id) ? require('./tennis-names').displayName(player.name,view.nameOf(player)) : '待定',
        score: typeof player.score === 'number' ? player.score : null, retired:!!player.retired, seed:player.seed || null }
    })
    let winnerId = ''
    if (match.status === 'finished') {
      if (validPlayer(match.winnerId) && sides.some(side => side.id === String(match.winnerId))) winnerId = String(match.winnerId)
      else if (!/退赛|不战|取消|retir|walkover|cancel/i.test(match.statusText || '')
        && sides.every(side => side.score != null) && sides[0].score !== sides[1].score) {
        winnerId = sides[0].score > sides[1].score ? sides[0].id : sides[1].id
      }
    }
    return { id: match.id, matchIds: [match.id], round, sides, winnerId,
      start: match.start, status: match.status, statusText: match.statusText || '',
      timeLabel: `${String(match.date || '').slice(5)} ${match.time || ''}`.trim() }
  }).filter(Boolean)
}

/** 相邻轮次以胜者身份唯一匹配；不按时间/数组序号猜测尚未公布的签位。 */
function confirmedLinks(columns) {
  const edges = []
  for (let i = 0; i < columns.length - 1; i++) {
    const current = columns[i].nodes, next = columns[i + 1].nodes
    current.forEach(node => {
      if (!validPlayer(node.winnerId)) return
      const targets = next.filter(target => target.sides.some(side => side.id === node.winnerId))
      const sources = current.filter(source => source.winnerId === node.winnerId)
      if (targets.length === 1 && sources.length === 1) edges.push({ from: node.id, to: targets[0].id })
    })
  }
  return edges
}

/** 输入标准化对阵：支持单场、两回合、BO系列赛适配器提供统一节点。 */
function build(entries, options = {}) {
  const bucket = new Map(), ids = new Set()
  ;(entries || []).forEach(entry => {
    if (!entry || !entry.round || !Number.isFinite(entry.round.order) || ids.has(entry.id)) return
    ids.add(entry.id)
    const nodes = bucket.get(entry.round.order) || []
    nodes.push(Object.assign({}, entry, { sides: entry.sides.map((side, rowKey) => Object.assign({}, side, {
      rowKey,
      win: entry.status === 'finished' && !!entry.winnerId && side.id === entry.winnerId,
      followed: (options.followedIds || []).indexOf(side.id) >= 0,
    })) }))
    bucket.set(entry.round.order, nodes)
  })
  const columns = [...bucket.keys()].sort((a, b) => a - b).map((order, index) => ({
    order, label: bucket.get(order)[0].round.label, left: index * (NODE_W + COLUMN_GAP),
    nodes: bucket.get(order).sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true })),
  }))
  if (!columns.length) return { columns: [], nodes: [], lines: [], edges: [], width: 0, height: 0, confirmed: 0 }
  const nodes = columns.flatMap((column, index) => column.nodes.map(node => Object.assign(node, { column: index, left: column.left })))
  const byId = new Map(nodes.map(node => [node.id, node]))
  const edges = confirmedLinks(columns)
  // 显式官方签位关系也可由未来赛事适配器传入；只接受相邻轮次、唯一且存在的节点。
  ;(options.edges || []).forEach(edge => {
    const from = byId.get(edge.from), to = byId.get(edge.to)
    if (from && to && to.column === from.column + 1 && !edges.some(e => e.from === edge.from)) edges.push(edge)
  })
  const parents = new Map(), outgoing = new Set()
  edges.forEach(edge => {
    const list = parents.get(edge.to) || []
    list.push(byId.get(edge.from)); parents.set(edge.to, list); outgoing.add(edge.from)
  })
  let cursor = 0
  function place(node) {
    if (node.top != null) return node.top
    const children = parents.get(node.id) || []
    children.sort((a, b) => node.sides.findIndex(s => s.id === a.winnerId) - node.sides.findIndex(s => s.id === b.winnerId))
    if (children.length) node.top = children.reduce((sum, child) => sum + place(child), 0) / children.length
    else { node.top = HEADER_H + cursor * (NODE_H + ROW_GAP); cursor++ }
    return node.top
  }
  const anonymous = node => !parents.has(node.id) && node.sides.every(side => !validPlayer(side.id))
  nodes.filter(node => !outgoing.has(node.id) && !anonymous(node))
    .sort((a, b) => b.column - a.column || a.id.localeCompare(b.id)).forEach(place)
  // 未公布签位的后轮空卡独立排布，不能占掉首轮顶部，也不能伪造晋级连线。
  columns.forEach(column => column.nodes.filter(anonymous).forEach((node, index, unknown) => {
    let top = HEADER_H + Math.floor((index + 0.5) * Math.max(1, cursor) / unknown.length) * (NODE_H + ROW_GAP)
    while (column.nodes.some(other => other !== node && other.top != null && Math.abs(other.top - top) < NODE_H + ROW_GAP)) top += NODE_H + ROW_GAP
    node.top = top
  }))
  const lines = []
  edges.forEach(edge => {
    const a = byId.get(edge.from), b = byId.get(edge.to)
    const x = a.left + NODE_W, y = a.top + NODE_H / 2, y2 = b.top + NODE_H / 2
    const middle = x + COLUMN_GAP / 2
    lines.push({ id: `${a.id}-a`, left: x, top: y, width: COLUMN_GAP / 2, height: 2 },
      { id: `${a.id}-b`, left: middle, top: Math.min(y, y2), width: 2, height: Math.max(2, Math.abs(y - y2)) },
      { id: `${a.id}-c`, left: middle, top: y2, width: COLUMN_GAP / 2, height: 2 })
  })
  const champion = columns[columns.length - 1].nodes.find(node => /^(?:决赛|总决赛)$/.test(node.round.label) && node.status === 'finished' && node.winnerId)
  return { columns, nodes, lines, edges, width: columns.length * (NODE_W + COLUMN_GAP) - COLUMN_GAP,
    height: Math.max(HEADER_H + NODE_H + ROW_GAP, ...nodes.map(node => node.top + NODE_H + ROW_GAP)), confirmed: edges.length,
    champion: champion ? champion.sides.find(side => side.id === champion.winnerId).name : '', nodeWidth: NODE_W, nodeHeight: NODE_H }
}

module.exports = { tennisRound, tennisEntries, confirmedLinks, build }
