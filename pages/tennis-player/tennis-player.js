const data = require('../../utils/data')
const model = require('../../utils/tennis-insights')
const names = require('../../utils/tennis-names')
const view = require('../../utils/view')
const follows = require('../../utils/team-follows')
const share = require('../../utils/share')
const countries = { CHN:'中国',USA:'美国',RUS:'俄罗斯',ESP:'西班牙',ITA:'意大利',GER:'德国',FRA:'法国',GBR:'英国',JPN:'日本',AUS:'澳大利亚',SRB:'塞尔维亚',POL:'波兰',BLR:'白俄罗斯',KAZ:'哈萨克斯坦',CZE:'捷克',CAN:'加拿大' }
const signed = number => number > 0 ? `+${number}` : String(number)
Page({
  data: { comp:'', name:'', enName:'', player:null, profile:[], upcoming:[], recent:[], eligibility:[], finals:null,
    gains:[], drops:[], followed:false, photo:'', error:'', asOf:'', liveReady:false },
  onLoad(query) {
    const comp = query && query.comp
    if (!['atp','wta'].includes(comp) || !query.name) { this.setData({error:'缺少选手信息，请从比赛或排行榜进入。'});return }
    this.comp = comp; this.playerName = decodeURIComponent(query.name); this.playerId = query.id ? decodeURIComponent(query.id) : ''
    this.setData({ comp, name: names.nameZh(this.playerName) || this.playerName, enName:this.playerName })
  },
  onShow() {
    if (this.data.error) return
    this.stop(); this.visible = true; this.build()
    Promise.all([data.refresh(),data.refreshTennisInsights()]).then(async()=>{
      if(!this.visible)return
      this.build()
      if(this.needsScores()){await data.refreshLive();if(this.visible)this.build()}
    })
    this.timer = setInterval(()=>Promise.all([data.refreshTennisInsights(),
      this.needsScores()?data.refreshLive():Promise.resolve()]).then(()=>{if(this.visible)this.build()}),60000)
  },
  onHide() {this.visible=false;this.stop()}, onUnload(){this.visible=false;this.stop()},
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null},
  needsScores(){
    return (this.data.upcoming||[]).some(match=>typeof data.needsLivePoll==='function' && data.needsLivePoll(match))
  },
  build() {
    const payload = data.tennisInsightPayload(this.comp)
    const player = model.findPlayer(payload,this.playerName) || {key:names.nameKey(this.playerName),name:this.playerName,espnId:this.playerId}
    const filter = { comp:this.comp,id:player.espnId || this.playerId || player.key,name:player.name,abbr:player.name }
    const matches = data.tennisMatches().filter(match=>match.comp===this.comp&&data.matchHasTeam(match,filter))
    const upcoming = matches.filter(match=>match.status==='live'||match.status==='upcoming').sort((a,b)=>a.start.localeCompare(b.start))
    const recent = matches.filter(match=>match.status==='finished').sort((a,b)=>b.start.localeCompare(a.start)).slice(0,10)
    const details = payload && payload.profiles && payload.profiles[player.key] || {}
    const profile = []
    const add=(label,value)=>{if(value!==undefined&&value!==null&&value!=='')profile.push({label,value})}
    add('国籍',countries[player.country]||player.country)
    if(details.birthDate)add(/\//.test(details.birthDate)?'生日（来源原文）':'生日',details.birthDate)
    else if(player.birthYear)add('出生年份',`${player.birthYear} 年`)
    add('年龄',details.age?`${details.age} 岁`:null);add('身高',details.height);add('体重',details.weight)
    add('持拍',details.hand==='RIGHT'?'右手':details.hand==='LEFT'?'左手':details.hand)
    add('转职业',details.proYear?`${details.proYear} 年`:null)
    const points=model.pointsDetails(player)
    const name=names.nameZh(player.name)||player.name
    this.followPlayer={...filter,display:name}
    const ids=[player.espnId,this.playerId,player.key].filter(Boolean)
    this.existingFollow=follows.all().find(row=>row.comp===this.comp&&(ids.includes(String(row.id))||names.nameKey(row.name)===player.key))
    const followed=!!this.existingFollow
    this.setData({name,enName:player.name,player:{...player,deltaLabel:points.delta==null?'':signed(points.delta)},profile,
      liveReady:Number.isFinite(player.points),photo:details.photo||player.photo||'',followed,
      gains:points.gains,drops:points.drops,
      upcoming:view.decorateList(upcoming.slice(0,12),{compOf:data.compOf,tennisTournamentLevel:data.tennisTournamentLevel}),
      recent:view.decorateList(recent,{compOf:data.compOf,tennisTournamentLevel:data.tennisTournamentLevel}),
      finals:model.finalsStatus(payload,player),eligibility:model.participation(payload,player,matches),
      asOf:payload?new Date(Date.parse(payload.asOf)+8*3600000).toISOString().replace('T',' ').slice(0,16)+' 北京时间':'',
      stale:payload?Date.now()-Date.parse(payload.asOf)>2*3600000:false})
    wx.setNavigationBarTitle({title:name})
  },
  onFollow(){if(!this.followPlayer)return;follows.toggle(this.existingFollow||this.followPlayer);this.build()},
  onPhotoError(){this.setData({photo:''})},
  goDetail(e){wx.navigateTo({url:`/pages/detail/detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}`})},
  onPullDownRefresh(){Promise.all([data.refresh(),data.refreshTennisInsights(true),data.refreshLive(true)]).then(()=>this.build()).finally(()=>wx.stopPullDownRefresh())},
  onShareAppMessage(){return share.message({title:`${this.data.name} · 实时积分与参赛前景`,path:model.profileUrl(this.comp,{name:this.playerName,id:this.playerId})})},
  onShareTimeline(){return share.timeline({title:`${this.data.name} · 实时积分与参赛前景`,query:`comp=${this.comp}&name=${encodeURIComponent(this.playerName)}&id=${encodeURIComponent(this.playerId)}`})},
})
