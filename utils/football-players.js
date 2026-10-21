/** 指定足球赛事的旧缓存显示适配；只认ESPN球员ID，不按缩写或姓氏猜人。 */
const {ZH} = require('../data/football-player-names')
const COMPS = ['ucl','liga','epl']
function name(id) { return /^\d+$/.test(String(id)) ? ZH[String(id)] || '' : '' }
function row(player,display) {
  const zh = player && name(player.i || player.id)
  return zh ? {...player,z:zh,...(display?{n:zh}:{})} : player
}
const localized = new WeakMap()
function payload(value,comp) {
  if (!COMPS.includes(comp) || !value || typeof value !== 'object') return value
  if (localized.has(value)) return localized.get(value)
  const out = {...value}
  if (Array.isArray(value.players)) out.players = value.players.map(p=>row(p,false))
  if (value.lineups) {
    out.lineups = {...value.lineups}
    for (const side of ['home','away']) {
      if (Array.isArray(value.lineups[side])) out.lineups[side] = value.lineups[side].map(p=>row(p,true))
    }
  }
  if (value.mvp && Array.isArray(value.mvp.candidates)) {
    out.mvp = {...value.mvp,candidates:value.mvp.candidates.map(p=>{
      const zh = p && name(String(p.id || '').replace(/^espn:/,''))
      return zh ? {...p,name:zh} : p
    })}
  }
  localized.set(value,out)
  return out
}
module.exports = {COMPS,name,payload}
