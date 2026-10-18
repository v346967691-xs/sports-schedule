/** 退赛判定的展示口径；源比分及实际逐盘记录不作改写。 */
function display(match) {
  if (!match || !['atp','wta'].includes(match.comp) || match.status!=='finished'
    || !/退赛|不战|retir|walk.?over|withdraw/i.test(match.statusText||'')) return match
  const winner=String(match.winnerId||'')
  const side=winner&&!/^(?:0|TBD|待定|-\d+)$/i.test(winner)
    ?['home','away'].find(key=>match[key]&&String(match[key].id)===winner):''
  const result={...match,_isRetirement:true,_retirementKnown:!!side,
    home:{...match.home},away:{...match.away}}
  if(!side){result._retirementPending=true;return result}
  for(const key of ['home','away']){
    result[key].retired=key!==side
  }
  return result
}
module.exports={display}
