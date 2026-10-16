/** ESPN post 也包含取消/延期，不能直接等同于完赛。 */
function fromEspn(type) {
  type=type||{}
  const text=[type.name,type.description,type.shortDetail,type.detail].join(' ')
  if(/cancel|abandon/i.test(text))return {status:'canceled',statusText:'已取消'}
  if(/postpon/i.test(text))return {status:'upcoming',statusText:'已延期'}
  if(/suspend|delay/i.test(text))return {status:type.state==='in'?'live':'upcoming',statusText:/suspend/i.test(text)?'比赛暂停':'开赛延迟'}
  if(/retir|withdraw/i.test(text))return {status:'finished',statusText:'退赛'}
  if(/walk.?over/i.test(text))return {status:'finished',statusText:'不战而胜'}
  return {status:type.state==='in'?'live':type.state==='post'&&type.completed!==false?'finished':'upcoming',statusText:type.state==='post'&&type.completed===false?'待开赛':''}
}
function normalize(match) {
  if(!match)return match
  const text=String(match.statusText||'')
  const status=/取消|cancel|abandon/i.test(text)?'canceled':/延期|postpon/i.test(text)?'upcoming':/延迟|delay/i.test(text)&&match.status!=='live'?'upcoming':match.status
  if(status===match.status)return match
  const next={...match,status}
  if(status!=='finished')delete next.winnerId
  return next
}
module.exports={fromEspn,normalize}
