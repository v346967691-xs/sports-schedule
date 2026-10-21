/** NBA展示名：ID和英文原名用于身份/搜索，城市全名仅作别名。 */
const ROWS = [
  [1,'老鹰','亚特兰大老鹰','Atlanta Hawks'],[2,'凯尔特人','波士顿凯尔特人','Boston Celtics'],
  [17,'篮网','布鲁克林篮网','Brooklyn Nets'],[30,'黄蜂','夏洛特黄蜂','Charlotte Hornets'],
  [4,'公牛','芝加哥公牛','Chicago Bulls'],[5,'骑士','克利夫兰骑士','Cleveland Cavaliers'],
  [6,'独行侠','达拉斯独行侠','Dallas Mavericks'],[7,'掘金','丹佛掘金','Denver Nuggets'],
  [8,'活塞','底特律活塞','Detroit Pistons'],[9,'勇士','金州勇士','Golden State Warriors'],
  [10,'火箭','休斯顿火箭','Houston Rockets'],[11,'步行者','印第安纳步行者','Indiana Pacers'],
  [12,'快船','洛杉矶快船','LA Clippers'],[13,'湖人','洛杉矶湖人','Los Angeles Lakers'],
  [29,'灰熊','孟菲斯灰熊','Memphis Grizzlies'],[14,'热火','迈阿密热火','Miami Heat'],
  [15,'雄鹿','密尔沃基雄鹿','Milwaukee Bucks'],[16,'森林狼','明尼苏达森林狼','Minnesota Timberwolves'],
  [3,'鹈鹕','新奥尔良鹈鹕','New Orleans Pelicans'],[18,'尼克斯','纽约尼克斯','New York Knicks'],
  [25,'雷霆','俄克拉荷马雷霆','Oklahoma City Thunder'],[19,'魔术','奥兰多魔术','Orlando Magic'],
  [20,'76人','费城76人','Philadelphia 76ers'],[21,'太阳','菲尼克斯太阳','Phoenix Suns'],
  [22,'开拓者','波特兰开拓者','Portland Trail Blazers'],[23,'国王','萨克拉门托国王','Sacramento Kings'],
  [24,'马刺','圣安东尼奥马刺','San Antonio Spurs'],[28,'猛龙','多伦多猛龙','Toronto Raptors'],
  [26,'爵士','犹他爵士','Utah Jazz'],[27,'奇才','华盛顿奇才','Washington Wizards'],
]
const SHORT=Object.fromEntries(ROWS.map(r=>[String(r[0]),r[1]]))
const FULL=Object.fromEntries(ROWS.flatMap(r=>[[r[2],r[1]],[r[3],r[1]]]))
Object.assign(FULL,{'Los Angeles Clippers':'快船','俄克拉荷马城雷霆':'雷霆','新奥尔良鹈鹕队':'鹈鹕','费城七六人':'76人'})
const FULL_ENTRIES=Object.entries(FULL).sort((a,b)=>b[0].length-a[0].length)
function text(value) {
  if(typeof value!=='string')return value
  if(FULL[value])return FULL[value]
  let result=value
  for(const [full,short]of FULL_ENTRIES)result=result.split(full).join(short)
  return result
}
function aliases(id){const row=ROWS.find(r=>String(r[0])===String(id));return row?row.slice(1):[]}
function team(t,comp) {
  if(!t||comp!=='nba')return t
  const short=SHORT[String(t.id)] || FULL[t.zh] || FULL[t.name]
  return short?{...t,zh:short,display:short,...(t.zhName?{zhName:short}:{})}:t
}
function match(m){return m&&m.comp==='nba'?{...m,home:team(m.home,'nba'),away:team(m.away,'nba')}:m}
// 只替换展示文本字段，不改id、链接、赛事键、缩写或球员身份。缓存旧数据亦可立即适配。
const DISPLAY=/^(name|zh|zhName|display|displayName|team|teamName|teamZh|tz|homeName|awayName|title|headline|text|body|summary|note|caption|intro|reason|home|away)$/
const localized=new WeakMap()
function payload(value) {
  if(!value||typeof value!=='object')return value
  if(localized.has(value))return localized.get(value)
  const result=Array.isArray(value)?value.map(payload):Object.fromEntries(Object.entries(value).map(([key,v])=>[key,
    typeof v==='string'&&DISPLAY.test(key)?text(v):v&&typeof v==='object'?payload(v):v]))
  localized.set(value,result);return result
}
module.exports={SHORT,ROWS,text,team,match,payload,aliases}
