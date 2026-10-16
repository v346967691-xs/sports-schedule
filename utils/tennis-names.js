/**
 * Tennis-only Chinese display names. Keep English identity and IDs intact.
 * Sources: verified tennis-player Wikidata labels (entity IDs below), 2026-10-15.
 * Chinese names checked against official tennis reports:
 * 刘汉屹 https://www.sport.gov.cn/wqzx/n5341/c961183/content.html
 * 张天汇 https://www.sport.gov.cn/n14471/n14487/n14524/c30096575/content.html
 * Exact full-name tokens only; unknown names retain the upstream spelling.
 * 展示口径：西式姓名保留完整“名·姓”；姓氏采用大陆赛事报道常用译法。
 * 修正姓氏不得删去名字，也不按末尾单词全局替换姓氏；中文/东亚原生姓名保留惯用顺序。
 */
// Additional names: Chinese Tennis Association youth report (渠依含、林禹君、邵羽杉):
// https://www.sport.org.cn/shouye/jjty/2026/0922/708986.html
// 孙心然 https://www.sport.gov.cn/n20001280/n20067662/n20067613/c29764027/content.html
// Learner Tien interview https://www.sbs.com.au/language/chinese/zh-hans/podcast-episode/ao-2026-interview-with-learner-tien/3v0j09pwg
// Maria Sakkari sponsor profile https://www.rolex.com/zh-hans-cn/rolex-family/tennis/maria-sakkari
const NAMES = {
  'Rigele Te': '特日格乐', // https://www.sport.gov.cn/n20001280/n20745751/n20767274/c23384540/content.html
  'Botic Van De Zandschulp': '博蒂克·范德赞德舒尔普',
  'Maria Sakkari': '玛利亚·萨卡里',
  'Qu Yihan': '渠依含',
  'Yu Jun Lin': '林禹君',
  'Shao Yushan': '邵羽杉',
  'Xinran Sun': '孙心然',
  "Valentin Vacherot": "瓦伦丁·瓦舍罗", // Q107314093
  "Alexander Blockx": "亚历山大·布洛克斯", // Q114728346
  "Catherine McNally": "凯蒂·麦克娜莉", // Q27537235
  "Dayana Yastremska": "达雅娜·雅斯特雷姆斯卡", // Q23888026
  "Karen Khachanov": "卡连·哈恰诺夫", // Q16568576
  "Felix Auger-Aliassime": "菲利克斯·奥格·阿里辛", // Q20752045
  "Darja Vidmanova": "达尔娅·维德曼诺娃", // Q98278358
  "Maria Timofeeva": "玛丽亚·蒂莫菲耶娃", // Q106367605
  "Maya Joint": "马娅·茹安", // Q123615700
  "Sinja Kraus": "辛雅·克劳斯", // Q57192958
  "Janice Tjen": "贾尼丝·张", // Q126454806
  "Anhelina Kalinina": "安海莉娜·卡利尼娜", // Q15642606
  "Elena-Gabriela Ruse": "埃列娜-加布丽埃拉·鲁塞", // Q20745254
  "Lilli Tagger": "莉莉·塔格尔", // Q128688561
  "Alejandro Tabilo": "亚历杭德罗·塔比洛", // Q65159701
  "Tommy Paul": "托米·保罗", // Q20050871
  "Ma YeXin": "马烨欣",
  "Polina Kudermetova": "波利娜·库德梅托娃", // Q105967693
  "Daria Snigur": "达里娅·斯尼古尔", // Q65553008
  "Katarzyna Kawa": "卡塔芝娜·卡瓦", // Q15770368
  "Viktorija Golubic": "维多利亚·戈卢比奇", // Q7929924
  "Elvina Kalieva": "埃尔维娜·卡利耶娃", // Q108272143
  "Jan-Lennard Struff": "杨-莱纳德·史卓夫", // Q1681537
  "Thiago Agustin Tirante": "蒂亚戈·阿古斯丁·蒂兰特", // Q64747475
  "Aliaksandra Sasnovich": "阿莉娅克桑德拉·萨斯诺维奇", // Q4725560
  "Talia Gibson": "塔利亚·吉布森", // Q110523703
  "Maddison Inglis": "麦迪森·英格利斯", // Q18810491
  "Zeynep Sonmez": "泽伊内普·桑梅斯", // Q65599731
  "Arthur Fils": "阿蒂尔·菲斯", // Q107207693
  "Luca Van Assche": "吕卡·范阿什", // Q107205896
  "Juan Manuel Cerundolo": "胡安·马努埃尔·塞伦多罗", // Q105636111
  "Bu Yunchaokete": "布云朝克特", // Q112965927
  "Bai Zhuoxuan": "白卓璇", // Q117385076
  "Linda Fruhvirtova": "琳达·弗鲁维托瓦", // Q95568176
  "Oleksandra Oliynykova": "奥列克桑德拉·奥利伊尼科娃", // Q105711730
  "Yuan Yue": "袁悦", // Q56248480
  "Matteo Arnaldi": "马特奥·阿纳尔迪", // Q111903012
  "Rei Sakamoto": "坂本怜", // Q124363312
  "Taylah Preston": "泰拉·普雷斯顿", // Q110418366
  "Tamara Korpatsch": "塔玛拉·科尔帕奇", // Q19924597
  "Mai Hontama": "本玉真唯", // Q66495445
  "Katie Boulter": "凯蒂·波尔特", // Q16979848
  "Zhang Zhizhen": "张之臻", // Q21623382
  "Arthur Gea": "阿蒂尔·热亚", // Q120721961
  "Nuno Borges": "努诺·博尔热斯", // Q106238976
  "Novak Djokovic": "诺瓦克·德约科维奇", // Q5812
  "Elsa Jacquemot": "艾尔莎·雅克莫特", // Q64008826
  "Magdalena Frech": "玛格达莱娜·弗雷赫", // Q10636559
  "Anna Bondar": "安娜·邦达尔", // 按巡回赛注册名统一为名·姓
  "Renata Zarazua": "雷娜塔·扎拉祖亚", // Q18636254
  "Jaime Faria": "雅伊梅·法里亚", // Q125249050
  "Arthur Fery": "亚瑟·费利", // Q107406917
  "Luciano Darderi": "卢西亚诺·达德里", // Q109144854
  "Casper Ruud": "卡斯珀·鲁德", // Q18810082
  "Taylor Fritz": "泰勒·弗里茨", // Q17660516
  "Jaume Munar": "若姆·穆纳尔", // Q17274717
  "Brandon Nakashima": "布兰登·中岛", // Q60676610
  "Ugo Humbert": "于戈·安贝尔", // Q54007306
  "Katie Volynets": "凯蒂·沃利内茨", // Q61889608
  "Robin Montgomery": "罗宾·蒙哥马利", // Q66309318
  "Sofia Kenin": "索菲亚·凯文", // Q18679122
  "Ashlyn Krueger": "阿什林·克鲁格", // Q105825572
  "Yuliia Starodubtseva": "尤利娅·斯塔罗杜布采娃", // Q120734490
  "Alina Charaeva": "阿林娜·查拉娃", // Q71126317
  "Alex de Minaur": "亚历克斯·德米纳尔", // Q22958938
  "Mariano Navone": "马里亚诺·纳沃内", // Q119892451
  "Zheng Qinwen": "郑钦文", // Q62096129
  "Shi Han": "施晗", // Q126089370
  "Alex Molcan": "亚历克斯·莫尔坎", // Q73247665
  "Tomas Machac": "托马什·马哈奇", // Q61594997
  "Tomas Martin Etcheverry": "托马斯·马丁·埃切韦里", // Q104728520
  "Stefanos Tsitsipas": "斯特凡诺斯·西西帕斯", // Q24450982
  "Holger Rune": "霍尔格·鲁内", // Q48200561
  "Kyrian Jacquet": "基里安·雅凯", // Q99670362
  "Sonay Kartal": "索尼娅·卡塔尔", // Q110904224
  "Andrea Lazaro Garcia": "安德莉亚·拉萨罗·加西亚", // Q97101712
  "Francisco Cerundolo": "弗朗西斯科·塞伦多罗", // Q61709770
  "Kei Nishikori": "锦织圭", // Q311222
  "Frances Tiafoe": "弗朗西斯·蒂亚弗", // Q17305299
  "Paula Badosa": "宝拉·巴多萨", // Q19560013
  "Daria Kasatkina": "黛莉亚·卡萨特金娜", // Q17144642
  "Jiri Lehecka": "伊里·莱赫茨卡", // Q61415365
  "Zizou Bergs": "齐祖·博格斯", // Q100700157
  "Ignacio Buse": "伊格纳西奥·布斯", // Q116679965
  "Quentin Halys": "昆坦·阿利斯", // Q18001228
  "Aoi Ito": "伊藤葵", // Q114602468
  "Kimberly Birrell": "金伯利·比雷尔", // Q15635268
  "Magda Linette": "玛格达·里纳特", // Q722311
  "Katerina Siniakova": "卡特日娜·西尼亚科娃", // Q3720044
  "Roman Safiullin": "罗曼·萨菲乌林", // Q18637944
  "Flavio Cobolli": "弗拉维奥·科博利", // Q64347071
  "Storm Hunter": "斯托姆·杭特", // Q7620174
  "Carlos Alcaraz": "卡洛斯·阿尔卡拉斯", // Q85518537
  "Alex Michelsen": "亚历克斯·米切尔森", // Q112995784
  "Marina Bassols Ribera": "玛丽娜·巴索尔斯·里贝拉", // Q61854961
  "Kamilla Rakhimova": "卡米拉·拉希莫娃", // Q65769637
  "Denis Shapovalov": "丹尼斯·沙波瓦洛夫", // Q20979382
  "Sho Shimabukuro": "岛袋将", // Q105776866
  "Shang Juncheng": "商竣程", // Q106466705
  "Sebastian Baez": "塞瓦斯蒂安·巴埃斯", // Q47396310
  "Alexander Zverev": "亚历山大·兹维列夫", // Q13990552
  "Cameron Norrie": "卡梅隆·诺里", // Q23668736
  "Harriet Dart": "哈里特·达特", // Q20026221
  "Anastasia Zakharova": "阿纳斯塔西娅·扎哈诺娃", // Q88048339
  "Tallon Griekspoor": "塔伦·格里克斯普尔", // Q28777443
  "Andrey Rublev": "安德烈·卢布列夫", // Q17373391
  "Alejandro Davidovich Fokina": "亚历杭德罗·达维多维奇·福基纳", // Q33084529
  "Matteo Berrettini": "马泰奥·贝雷蒂尼", // Q29918446
  "Alycia Parks": "阿莱西娅·帕克斯", // Q105745525
  "Zhu Lin": "朱琳", // Q17319111
  "Adolfo Daniel Vallejo": "阿道尔夫·丹尼尔·瓦莱约", // Q107493222
  "Rafael Jodar": "拉斐尔·霍达尔", // Q130255645
  "Lanlana Tararudee": "兰拉娜·塔拉路堤", // Q113162452
  "Camila Osorio": "卡米拉·奥索里奥", // 保留注册名 Camila Osorio，不只取第二姓
  "Eva Lys": "伊娃·利斯", // Q86838090
  "Learner Tien": "勒纳·钱", // Q113548256
  "Hubert Hurkacz": "胡贝特·胡尔卡奇", // Q18927958
  "Gao Xinyu": "高馨妤", // Q27156306
  "Panna Udvardy": "帕娜·乌德瓦尔迪", // Q28815694
  "Alexander Bublik": "亚历山大·巴伯里克", // Q23678983
  "Jakub Mensik": "雅库布·门斯克", // Q102228055
  "Anastasia Potapova": "阿纳斯塔西娅·伯塔波娃", // Q24955766
  "Diana Shnaider": "季阿娜·施耐德", // Q107183075
  "Peyton Stearns": "佩顿·斯特恩斯", // Q106293259
  "Liudmila Samsonova": "柳德米拉·萨姆索诺娃", // Q26416429
  "Mirra Andreeva": "米拉·安德烈耶娃", // Q114402278
  "Maja Chwalinska": "玛雅·赫瓦林斯卡", // Q28672411
  "Linda Noskova": "琳达·诺斯科娃", // Q106354932
  "Diane Parry": "戴安娜·帕里", // Q30082774
  "Jasmine Paolini": "加斯明·鲍利尼", // Q19973674
  "Ekaterina Alexandrova": "叶卡捷琳娜·亚历山德罗娃", // Q23719121
  "Daniil Medvedev": "丹尼尔·梅德韦杰夫", // Q21622022
  "Pablo Carreno Busta": "巴勃罗·卡雷尼奥·布斯塔", // Q7121592
  "Karolina Muchova": "卡罗利娜·穆霍娃", // Q23661750
  "Clara Tauson": "克拉拉·陶森", // Q42675013
  "Sara Bejlek": "萨拉·贝莱克", // Q107640117
  "Naomi Osaka": "大坂直美", // Q17466583
  "Nikola Bartunkova": "尼克拉·巴尔通科娃", // Q106522281
  "Aryna Sabalenka": "阿里娜·萨巴伦卡", // Q23448791
  "Coco Gauff": "科科·高夫", // Q39263365
  "Elise Mertens": "爱丽丝·梅尔滕斯", // Q17381675
  "Donna Vekic": "唐娜·维基克", // Q648854
  "Ann Li": "李安", // Q39074494
  "Jelena Ostapenko": "叶莲娜·奥斯塔朋科", // Q5551564
  "Iga Swiatek": "伊加·斯瓦泰克", // 保留名字；姓氏采用大陆赛事报道常用译法
  "Elina Svitolina": "伊莉娜·斯维托丽娜", // 保留名字；姓氏采用大陆赛事报道常用译法
  "Leylah Fernandez": "莱拉·费尔南德斯", // Q50329570
  "Anna Kalinskaya": "安娜·卡琳斯卡娅", // Q20088944
  "Belinda Bencic": "贝琳达·本西奇", // Q509903
  "Iva Jovic": "伊娃·约维奇", // Q122216464
  "Cristina Bucsa": "克里斯蒂安·布萨", // Q56702741
  "Marie Bouzkova": "玛丽·鲍兹科娃", // Q18003204
  "Wang Xinyu": "王欣瑜", // Q44465805
  "Elena Rybakina": "叶连娜·莱巴金娜", // Q42055714
  "Miomir Kecmanovic": "米奥米尔·凯茨曼诺维奇", // Q22005752
  "Aleksandar Kovacevic": "亚历山大·科瓦切维奇", // Q108523625
  "Adrian Mannarino": "阿德里安·曼纳里诺", // Q373522
  "Nikoloz Basilashvili": "尼科洛兹·巴西拉什维利", // Q16297666
  "Federico Cina": "费代里科·奇纳", // Q133294626
  "Yannick Hanfmann": "雅尼克·汉夫曼", // Q29628209
  "Kamil Majchrzak": "卡米尔·迈赫扎克", // Q14840592
  "Marco Trungelliti": "马尔科·图卢杰利蒂", // Q3183203
  "Rinky Hijikata": "土方凛辉", // Q60227425
  "Chak Lam Coleman Wong": "黄泽林", // Q108498952
  "Wu Yibing": "吴易昺", // Q28137186
  "Mattia Bellucci": "马蒂亚·贝鲁奇", // Q114703459
  "Zhou Yi": "周意", // Q123392404
  "Marin Cilic": "马林·契利奇", // Q245241
  "Daniel Altmaier": "丹尼尔·奥特迈尔", // Q30005211
  "Facundo Diaz Acosta": "法昆多·迪亚斯·阿科斯塔", // Q57268922
  "Pavel Kotov": "帕维尔·科托夫", // Q85322897
  "Kimmer Coppejans": "基默·科佩扬斯", // Q1856953
  "Camilo Ugo Carabelli": "卡米洛·乌戈·卡拉贝利", // Q106207380
  "Ilia Simakin": "伊利亚·西马金", // Q127617675
  "Jenson Brooksby": "詹森·布鲁克斯比", // Q56073233
  "James Duckworth": "詹姆斯·达克沃思", // Q1336011
  "Bernard Tomic": "伯纳德·托米奇", // Q288326
  "Hamad Medjedovic": "哈马德·梅杰多维奇", // Q106962940
  "Valentin Royer": "瓦朗坦·鲁瓦耶", // Q126011326
  "Marcos Giron": "马科斯·吉龙", // Q17478053
  "Fabian Marozsan": "法比安·马洛桑", // ATP 杭州站官方中文用名，按名·姓展示
  "Zachary Svajda": "扎卡里·斯瓦达", // Q66391780
  "Nicolas Mejia": "尼古拉斯·梅希亚", // Q56728052
  "Daniel Merida": "丹尼尔·梅里达", // Q132459405
  "Martin Landaluce": "马丁·兰达卢塞", // Q113891092
  "Vit Kopriva": "维特·科普里瓦", // Q102423530
  "Dalibor Svrcina": "达利博尔·斯夫尔奇纳", // Q60238030
  "Ben Shelton": "本·谢尔顿", // Q108532383
  "Lorenzo Musetti": "洛伦佐·穆塞蒂", // Q54813043
  "Mia Pohankova": "米娅·波汉科娃", // Q124082130
  "Mananchaya Sawangkaew": "玛南猜亚·沙旺胶", // Q61559705
  "Wang Xiyu": "王曦雨", // Q41799108
  "Alexandra Eala": "亚历克斯·艾拉", // Q67088022
  "Mayar Sherif": "玛雅·谢里夫", // Q19577829
  "Guo Hanyu": "郭涵煜", // Q41735946
  "Sorana Cirstea": "索兰娜·姬丝蒂亚", // Q230242
  "Yulia Putintseva": "尤利娅·普京采娃", // Q2429984
  "Marta Kostyuk": "玛尔塔·科斯秋克", // Q28535267
  "Zhang Shuai": "张帅", // Q197291
  "Jessica Pegula": "杰茜卡·佩古拉", // Q24159
  "Jannik Sinner": "扬尼克·辛纳", // Q54812588
  "Joao Fonseca": "若昂·丰塞卡", // Q116855500
  "Zhizhen Zhang": "张之臻", // Q21623382
  "Juncheng Shang": "商竣程", // Q106466705
  "Yi Zhou": "周意", // Q123392404
  "Fajing Sun": "孙发京", // Q26251497
  "Jie Cui": "崔杰",
  "Tianhui Zhang": "张天汇",
  "Ye Cong Mo": "莫业聪", // Q123421534
  "Hanyi Liu": "刘汉屹",
  "Victoria Mboko": "维多利亚·博科", // Q110718470
  "Amanda Anisimova": "阿曼达·阿尼西莫娃", // Q24456716
  "Madison Keys": "麦迪逊·凯斯", // Q34403
  "Emma Navarro": "艾玛·纳瓦罗", // Q62675797
  "Yexin Ma": "马烨欣", // Q106293196
  "Lin Zhu": "朱琳",
  "Zhuoxuan Bai": "白卓璇", // Q117385076
  "Xiaodi You": "尤晓迪", // Q15634509
  "Han Shi": "施晗",
}

function nameKey(name) {
  let value = String(name || '').toLowerCase()
  if (typeof value.normalize === 'function') value = value.normalize('NFD')
  return value.replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ').trim().split(/\s+/).sort().join(' ')
}
const INDEX = Object.create(null)
Object.keys(NAMES).forEach(name => { INDEX[nameKey(name)] = NAMES[name] })
function nameZh(name) { return INDEX[nameKey(name)] || '' }
function localizeMatch(match) {
  if (!match || (match.comp !== 'atp' && match.comp !== 'wta')) return match
  const result = Object.assign({}, match)
  ;['home', 'away'].forEach(side => {
    if (match[side]) result[side] = Object.assign({}, match[side], { zh: nameZh(match[side].name) || match[side].zh || '' })
  })
  return result
}
module.exports = { nameZh, nameKey, localizeMatch }
