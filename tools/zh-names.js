/**
 * 球队中文名映射
 *
 * 足球 / NBA 按 ESPN team id 匹配，英雄联盟按官方队伍简码匹配。
 * 取不到中文名时回落到数据源自带的英文名，不猜、不硬凑。
 */

const ESPN_ZH = {
  // 英超
  359: '阿森纳', 362: '阿斯顿维拉', 331: '布莱顿', 337: '布伦特福德', 349: '伯恩茅斯',
  363: '切尔西', 384: '水晶宫', 368: '埃弗顿', 370: '富勒姆', 306: '赫尔城',
  373: '伊普斯维奇', 357: '利兹联', 364: '利物浦', 382: '曼城', 360: '曼联',
  361: '纽卡斯尔联', 393: '诺丁汉森林', 388: '考文垂', 367: '热刺', 366: '桑德兰',
  // 西甲
  96: '阿拉维斯', 93: '毕尔巴鄂竞技', 1068: '马德里竞技', 83: '巴塞罗那', 85: '塞尔塔',
  90: '拉科鲁尼亚', 3751: '埃尔切', 88: '西班牙人', 2922: '赫塔菲', 1538: '莱万特',
  99: '马拉加', 97: '奥萨苏纳', 101: '巴列卡诺', 244: '皇家贝蒂斯', 86: '皇家马德里',
  89: '皇家社会', 243: '塞维利亚', 94: '瓦伦西亚', 102: '比利亚雷亚尔', 87: '桑坦德竞技',
  // 意甲
  103: 'AC米兰', 104: '罗马', 105: '亚特兰大', 107: '博洛尼亚', 2925: '卡利亚里',
  2572: '科莫', 109: '佛罗伦萨', 4057: '弗罗西诺内', 3263: '热那亚', 110: '国际米兰',
  111: '尤文图斯', 112: '拉齐奥', 113: '莱切', 114: '那不勒斯', 115: '帕尔马',
  3997: '萨索洛', 239: '都灵', 118: '乌迪内斯', 17530: '威尼斯', 4007: '蒙扎',
  // 德甲
  598: '柏林联合', 131: '勒沃库森', 132: '拜仁慕尼黑', 124: '多特蒙德', 268: '门兴格拉德巴赫',
  125: '法兰克福', 3841: '奥格斯堡', 122: '科隆', 127: '汉堡', 2950: '美因茨',
  11420: 'RB莱比锡', 126: '弗赖堡', 3307: '帕德博恩', 10388: '埃尔弗斯贝格', 133: '沙尔克04',
  134: '斯图加特', 137: '云达不莱梅', 7911: '霍芬海姆',
  // 法甲
  172: '欧塞尔', 174: '摩纳哥', 7868: '昂热', 6997: '布雷斯特', 3236: '勒阿弗尔',
  2697: '勒芒', 175: '朗斯', 166: '里尔', 273: '洛里昂', 167: '里昂',
  176: '马赛', 2502: '尼斯', 6851: '巴黎FC', 160: '巴黎圣日耳曼', 169: '雷恩',
  180: '斯特拉斯堡', 179: '图卢兹', 170: '特鲁瓦',
  // 中超（ESPN 给的是英文队名，逐条按 team id 映射）
  2052: '北京国安', 21355: '成都蓉城', 131704: '重庆铜梁龙', 22537: '大连英博',
  8240: '河南队', 131705: '辽宁铁人', 21910: '青岛海牛', 22198: '青岛西海岸',
  7521: '山东泰山', 15515: '上海海港', 977: '上海申花', 22199: '深圳新鹏城',
  8239: '天津津门虎', 21506: '武汉三镇', 22536: '云南玉昆', 18203: '浙江队',
  // 欧冠其余球队
  887: 'AEK雅典', 2980: '博德闪耀', 570: '布鲁日', 437: '波尔图', 436: '费内巴切',
  142: '费耶诺德', 432: '加拉塔萨雷', 4411: '林茨', 148: '埃因霍温', 493: '顿涅茨克矿工',
  494: '布拉格斯拉维亚', 521: '布拉迪斯拉发', 2250: '葡萄牙体育', 21922: '萨巴赫', 510: '维京',
  // 欧国联（国家队）
  585: '阿尔巴尼亚', 587: '安道尔', 579: '亚美尼亚', 474: '奥地利', 581: '阿塞拜疆',
  583: '白俄罗斯', 459: '比利时', 452: '波黑', 462: '保加利亚', 477: '克罗地亚',
  445: '塞浦路斯', 450: '捷克', 479: '丹麦', 448: '英格兰', 444: '爱沙尼亚',
  447: '法罗群岛', 458: '芬兰', 478: '法国', 584: '格鲁吉亚', 481: '德国',
  16721: '直布罗陀', 455: '希腊', 480: '匈牙利', 470: '冰岛', 461: '以色列',
  162: '意大利', 2619: '哈萨克斯坦', 18272: '科索沃', 456: '拉脱维亚', 589: '列支敦士登',
  460: '立陶宛', 582: '卢森堡', 453: '马耳他', 483: '摩尔多瓦', 6775: '黑山',
  449: '荷兰', 463: '北马其顿', 586: '北爱尔兰', 464: '挪威', 471: '波兰',
  482: '葡萄牙', 476: '爱尔兰', 473: '罗马尼亚', 588: '圣马力诺', 580: '苏格兰',
  6757: '塞尔维亚', 468: '斯洛伐克', 472: '斯洛文尼亚', 164: '西班牙', 466: '瑞典',
  475: '瑞士', 465: '土耳其', 457: '乌克兰', 578: '威尔士',
  // 欧联
  20024: '阿拉拉特亚美尼亚', 140: '阿尔克马尔', 441: '安德莱赫特', 1929: '本菲卡',
  1895: '贝西克塔斯', 256: '凯尔特人', 597: '萨格勒布迪纳摩', 622: '费伦茨瓦罗斯',
  13083: '贝尔谢巴工人', 11505: '比亚韦斯托克', 2990: '波兹南莱赫', 490: '索菲亚列夫斯基',
  987: '利勒斯特罗姆', 147: '奈梅亨', 3362: '采列', 1010: '克里特OFI',
  435: '奥林匹亚科斯', 617: '尼科西亚奥莫尼亚', 2790: '萨尔茨堡红牛', 3746: '格拉茨风暴',
  433: '布拉格斯巴达', 21615: '托伦斯', 5807: '圣吉罗斯联', 11706: '比尔森胜利',
  // 中国国字号及相关对手
  658: '中国男足', 2754: '中国女足', 131735: '中国U17',
  130885: '斐济U17', 16295: '摩洛哥U17', 18767: '西班牙U17',
  469: '伊朗', 6724: '吉尔吉斯斯坦', 4390: '马尔代夫', 2666: '新西兰',
  6167: '巴勒斯坦', 4380: '叙利亚', 6723: '塔吉克斯坦', 17815: '越南',
  7507: '土库曼斯坦',
  // 欧协联（欧战第三级别，队名来源比五大联赛杂，逐条按 team id 映射）
  139: '阿贾克斯', 152: '特温特', 262: '哈茨', 443: '帕纳辛奈科斯', 489: '哈伊杜克',
  572: '中日德兰', 620: '布兰', 909: '哥本哈根', 936: '圣图尔登', 997: '特拉布宗体育',
  2290: '贝尔格莱德红星', 2528: '阿拉木图凯拉特', 2994: '布拉加', 3024: '图恩',
  3101: '北西兰', 3611: '根特', 7672: '卢加诺', 7853: '奥胡斯', 7922: '亚布洛内茨',
  8089: '克拉约瓦大学', 8169: '库奥皮奥', 10834: '索菲亚中央陆军', 17856: '林肯红魔',
  19246: '里加', 20025: '伊比利亚1999', 20028: '考纳斯萨尔基里斯', 20301: '米亚尔比',
  20703: '埃斯卡尔德斯国际', 20710: '巴尼亚卢卡战士', 21943: '埃格纳蒂亚', 22281: '帕福斯',
  // NBA
  1: '亚特兰大老鹰', 2: '波士顿凯尔特人', 17: '布鲁克林篮网', 30: '夏洛特黄蜂', 4: '芝加哥公牛',
  5: '克利夫兰骑士', 6: '达拉斯独行侠', 7: '丹佛掘金', 8: '底特律活塞', 9: '金州勇士',
  10: '休斯顿火箭', 11: '印第安纳步行者', 12: '洛杉矶快船', 13: '洛杉矶湖人', 29: '孟菲斯灰熊',
  14: '迈阿密热火', 15: '密尔沃基雄鹿', 16: '明尼苏达森林狼', 3: '新奥尔良鹈鹕', 18: '纽约尼克斯',
  25: '俄克拉荷马雷霆', 19: '奥兰多魔术', 20: '费城76人', 21: '菲尼克斯太阳', 22: '波特兰开拓者',
  23: '萨克拉门托国王', 24: '圣安东尼奥马刺', 28: '多伦多猛龙', 26: '犹他爵士', 27: '华盛顿奇才',
  134478: '伦敦雄狮',
  // 亚足联俱乐部赛事：ESPN 的 /statistics 端点不给 team 对象，只能按 id 兜底（2026-10-04）
  7129: '加拉法',
  // 20912 = Al-Quwa Al-Jawiya（伊拉克「空军俱乐部」，中文媒体惯称「巴格达空军」）。
  // ⚠️ 它的 displayName 是全大写 `Al-QUWA AL-JAWIYA`，nameZh 的词典匹配不上，只能按 id 兜底。
  20912: '巴格达空军',
}

const LOL_ZH = {
  // LPL
  BLG: '哔哩哔哩', JDG: '京东电竞', TES: '滔搏电竞', WBG: '微博电竞', AL: "Anyone's Legend",
  IG: 'IG', FPX: 'FPX', NIP: 'NIP', TT: 'TT', LNG: 'LNG', EDG: 'EDG', WE: 'WE',
  RNG: 'RNG', UP: 'UP', OMG: 'OMG', RA: 'RA', LGD: 'LGD',
  // LCK
  T1: 'T1', GEN: 'Gen.G', HLE: '韩华生命', DK: 'DK', KRX: 'DRX', KT: 'KT Rolster',
  NS: '农心RedForce', BFX: 'BNK FearX', DNS: 'DN Freecs', BRO: 'OK储蓄银行Brion',
  // LEC / 其他赛区
  G2: 'G2 Esports', FNC: 'Fnatic', MKOI: 'Movistar KOI', KC: 'Karmine Corp',
  VIT: 'Team Vitality', TH: 'Team Heretics', NAVI: 'NAVI', SK: 'SK Gaming',
  GX: 'GIANTX', SHFT: 'Shifters',
  // 国际赛区
  FLY: 'FlyQuest', TLAW: 'Team Liquid', PSG: 'PSG Talon', CFO: '中信飞牡蛎',
  VKS: 'Vivo Keyd Stars', TSW: 'Team Secret Whales', FUR: 'FURIA', LYON: 'LYON',
  '100T': '100 Thieves', DCG: 'Deep Cross Gaming',
  // 亚运会电竞（国家队，用 IOC 三字码）
  // ⚠️ 港澳台必须写「中国香港 / 中国澳门 / 中国台北」，这是硬性要求，不能简写
  CHN: '中国', TPE: '中国台北', HKG: '中国香港', MAC: '中国澳门',
  KOR: '韩国', JPN: '日本', VIE: '越南', THA: '泰国', PHI: '菲律宾', INA: '印度尼西亚',
  MAS: '马来西亚', SGP: '新加坡', IND: '印度', PAK: '巴基斯坦', KSA: '沙特', UAE: '阿联酋',
  KAZ: '哈萨克斯坦', UZB: '乌兹别克斯坦', MGL: '蒙古', QAT: '卡塔尔', BRN: '巴林',
  SRI: '斯里兰卡', NEP: '尼泊尔', BAN: '孟加拉国', MYA: '缅甸', CAM: '柬埔寨', LAO: '老挝',
  // 其他赛区（VCS / LTA 等，世界赛常见）
  GAM: 'GAM Esports', RED: 'RED Kalunga', SR: 'Shopify Rebellion',
  // 未确定的对阵方（接口有时先占位为 TBD），不补的话小程序上会直接显示 TBD
  TBD: '待定',
}

/**
 * 英文名 → 中文名的兜底字典（国家队为主）
 *
 * 为什么要这一张：ESPN 的 `getTeams?hl=zh-CN` 实测**拿不到中文名**（1586 支队里
 * 含中文的 0 个），而 `lastFiveGames` / `seasonseries` 里出现的对手往往不在我们的
 * 赛程窗口内，ESPN_ZH 按 id 查不到。这时候只能按英文名兜底，否则界面上会冒出
 * "Ivory Coast" 这种原文。俱乐部基本都能按 id 命中，这里主要补国字号。
 */
const NAME_ZH = {
  // 亚洲
  China: '中国', 'Hong Kong': '中国香港', 'Chinese Taipei': '中国台北', Macau: '中国澳门',
  Japan: '日本', 'South Korea': '韩国', 'North Korea': '朝鲜', Mongolia: '蒙古',
  India: '印度', Indonesia: '印度尼西亚', Thailand: '泰国', Vietnam: '越南', Myanmar: '缅甸',
  Malaysia: '马来西亚', Singapore: '新加坡', Philippines: '菲律宾', Syria: '叙利亚',
  Jordan: '约旦', Lebanon: '黎巴嫩', Palestine: '巴勒斯坦', Kuwait: '科威特', Bahrain: '巴林',
  Oman: '阿曼', 'United Arab Emirates': '阿联酋', Qatar: '卡塔尔', 'Saudi Arabia': '沙特阿拉伯',
  Iraq: '伊拉克', Iran: '伊朗', Uzbekistan: '乌兹别克斯坦', Kazakhstan: '哈萨克斯坦',
  Turkmenistan: '土库曼斯坦', Kyrgyzstan: '吉尔吉斯斯坦', Tajikistan: '塔吉克斯坦',
  Afghanistan: '阿富汗', Nepal: '尼泊尔', 'Sri Lanka': '斯里兰卡', Bangladesh: '孟加拉国',
  Maldives: '马尔代夫', Bhutan: '不丹', Brunei: '文莱', Laos: '老挝', Cambodia: '柬埔寨',
  'Timor-Leste': '东帝汶',
  // 欧洲
  Albania: '阿尔巴尼亚', Andorra: '安道尔', Armenia: '亚美尼亚', Austria: '奥地利',
  Azerbaijan: '阿塞拜疆', Belarus: '白俄罗斯', Belgium: '比利时',
  'Bosnia and Herzegovina': '波黑', Bulgaria: '保加利亚', Croatia: '克罗地亚',
  Cyprus: '塞浦路斯', Czechia: '捷克', Denmark: '丹麦', England: '英格兰',
  Estonia: '爱沙尼亚', 'Faroe Islands': '法罗群岛', Finland: '芬兰', France: '法国',
  Georgia: '格鲁吉亚', Germany: '德国', Gibraltar: '直布罗陀', Greece: '希腊',
  Hungary: '匈牙利', Iceland: '冰岛', Israel: '以色列', Italy: '意大利',
  Kosovo: '科索沃', Latvia: '拉脱维亚', Liechtenstein: '列支敦士登', Lithuania: '立陶宛',
  Luxembourg: '卢森堡', Malta: '马耳他', Moldova: '摩尔多瓦', Montenegro: '黑山',
  Netherlands: '荷兰', 'North Macedonia': '北马其顿', 'Northern Ireland': '北爱尔兰',
  Norway: '挪威', Poland: '波兰', Portugal: '葡萄牙', 'Republic of Ireland': '爱尔兰',
  Romania: '罗马尼亚', Russia: '俄罗斯', 'San Marino': '圣马力诺', Scotland: '苏格兰',
  Serbia: '塞尔维亚', Slovakia: '斯洛伐克', Slovenia: '斯洛文尼亚', Spain: '西班牙',
  Sweden: '瑞典', Switzerland: '瑞士', Turkey: '土耳其', Ukraine: '乌克兰', Wales: '威尔士',
  // 非洲
  Algeria: '阿尔及利亚', Angola: '安哥拉', Benin: '贝宁', Botswana: '博茨瓦纳',
  'Burkina Faso': '布基纳法索', Burundi: '布隆迪', Cameroon: '喀麦隆',
  'Cape Verde': '佛得角', 'Central African Republic': '中非', Chad: '乍得',
  Comoros: '科摩罗', Congo: '刚果', 'Congo DR': '刚果民主共和国', Djibouti: '吉布提',
  Egypt: '埃及', 'Equatorial Guinea': '赤道几内亚', Eritrea: '厄立特里亚',
  Eswatini: '斯威士兰', Ethiopia: '埃塞俄比亚', Gabon: '加蓬', Gambia: '冈比亚',
  Ghana: '加纳', Guinea: '几内亚', 'Guinea-Bissau': '几内亚比绍', 'Ivory Coast': '科特迪瓦',
  Kenya: '肯尼亚', Lesotho: '莱索托', Liberia: '利比里亚', Libya: '利比亚',
  Madagascar: '马达加斯加', Malawi: '马拉维', Mali: '马里', Mauritania: '毛里塔尼亚',
  Mauritius: '毛里求斯', Morocco: '摩洛哥', Mozambique: '莫桑比克', Namibia: '纳米比亚',
  Niger: '尼日尔', Nigeria: '尼日利亚', Rwanda: '卢旺达', Senegal: '塞内加尔',
  Seychelles: '塞舌尔', 'Sierra Leone': '塞拉利昂', Somalia: '索马里',
  'South Africa': '南非', 'South Sudan': '南苏丹', Sudan: '苏丹', Tanzania: '坦桑尼亚',
  Togo: '多哥', Tunisia: '突尼斯', Uganda: '乌干达', Zambia: '赞比亚', Zimbabwe: '津巴布韦',
  // 中北美
  Canada: '加拿大', 'Costa Rica': '哥斯达黎加', Cuba: '古巴', Curacao: '库拉索',
  'Dominican Republic': '多米尼加', 'El Salvador': '萨尔瓦多', Grenada: '格林纳达',
  Guatemala: '危地马拉', Haiti: '海地', Honduras: '洪都拉斯', Jamaica: '牙买加',
  Mexico: '墨西哥', Nicaragua: '尼加拉瓜', Panama: '巴拿马', 'Puerto Rico': '波多黎各',
  'Trinidad and Tobago': '特立尼达和多巴哥', 'United States': '美国',
  Aruba: '阿鲁巴', Bahamas: '巴哈马', Barbados: '巴巴多斯', Belize: '伯利兹',
  Bermuda: '百慕大', 'British Virgin Islands': '英属维尔京群岛',
  'Cayman Islands': '开曼群岛', Dominica: '多米尼克', Guyana: '圭亚那',
  'Saint Kitts and Nevis': '圣基茨和尼维斯', 'Saint Lucia': '圣卢西亚', Suriname: '苏里南',
  // ⚠️ ESPN 在这批小岛国上写的是缩写 "St."，与上面的 "Saint" 是**两个不同的 key**
  //    （foldKey 只剥声调与撇号，不会把 St. 还原成 Saint），所以必须各自写一份。
  'St. Kitts and Nevis': '圣基茨和尼维斯', 'St. Lucia': '圣卢西亚',
  'St. Vincent and the Grenadines': '圣文森特和格林纳丁斯',
  'Antigua and Barbuda': '安提瓜和巴布达', Montserrat: '蒙特塞拉特',
  Guadeloupe: '瓜德罗普', Martinique: '马提尼克', Bonaire: '博奈尔',
  'Turks and Caicos Islands': '特克斯和凯科斯群岛',
  'US Virgin Islands': '美属维尔京群岛', 'French Guiana': '法属圭亚那',
  // 圣马丁岛分属法荷，ESPN 用 "St. Martin"（法属）与 "Sint Maarten"（荷属）区分，别合并
  'St. Martin': '法属圣马丁', 'Sint Maarten': '荷属圣马丁',
  // 南美
  Argentina: '阿根廷', Bolivia: '玻利维亚', Brazil: '巴西', Chile: '智利',
  Colombia: '哥伦比亚', Ecuador: '厄瓜多尔', Paraguay: '巴拉圭', Peru: '秘鲁',
  Uruguay: '乌拉圭', Venezuela: '委内瑞拉',
  // 大洋洲
  Australia: '澳大利亚', 'New Zealand': '新西兰', Fiji: '斐济', 'Papua New Guinea': '巴布亚新几内亚',
  Samoa: '萨摩亚', Tahiti: '塔希提', Tonga: '汤加', Vanuatu: '瓦努阿图',
  'Solomon Islands': '所罗门群岛', 'Cook Islands': '库克群岛',
  Anguilla: '安圭拉', 'Saint Vincent and the Grenadines': '圣文森特和格林纳丁斯',
  'New Caledonia': '新喀里多尼亚', Mozambique: '莫桑比克', 'China PR': '中国',
  'Kyrgyz Republic': '吉尔吉斯斯坦', Yemen: '也门', Pakistan: '巴基斯坦',
  'Brunei Darussalam': '文莱', 'Curacao': '库拉索',
  // 上游同一支队有多种写法（ESPN 不同端点不一致），统一收一份别名
  "Côte d'Ivoire": '科特迪瓦', 'Türkiye': '土耳其', 'Czech Republic': '捷克',
  'Korea Republic': '韩国', 'Republic of Korea': '韩国', 'Korea DPR': '朝鲜',
  'IR Iran': '伊朗', USA: '美国', UAE: '阿联酋', 'Cabo Verde': '佛得角',
  'Bosnia-Herzegovina': '波黑', 'Congo, DR': '刚果民主共和国',
  // 国际足联之外的遗留写法
  'Sao Tome and Principe': '圣多美和普林西比', 'Cape Verde Islands': '佛得角',
}

/**
 * 青年队（U17 / U20 世界杯）队名：ESPN 给的是 "Spain U17" / "China PR U17"，
 * 队 id 与成年国家队不同，ESPN_ZH 查不到，只能按英文名剥掉年龄段后缀再查国家队表。
 * ⚠️ 中国男女足 U17 会重名（都叫「中国U17」），女足这支显式标出来。
 */
const YOUTH_ZH = {
  'China U17': '中国U17',
  'China PR U17': '中国U17女足',
  'China U20': '中国U20',
  'China PR U20': '中国U20女足',
}

/**
 * 亚冠（及亚足联俱乐部赛事）对手 —— 为什么单独一张表：
 * 中超球队打亚冠精英联赛，近况里的对手是韩/日/泰/马/澳的**俱乐部**，
 * 上面那张国家队表覆盖不到，ESPN 也不给中文名。
 * 只补东亚区（中超球队只在东亚区踢），西亚区等真碰上了再加。
 */
const CLUB_ZH = {
  // 韩国 K 联赛
  'Pohang Steelers': '浦项制铁', 'Ulsan HD': '蔚山HD', 'Ulsan Hyundai': '蔚山现代',
  'FC Seoul': '首尔FC', 'Gwangju FC': '光州FC', 'Gangwon FC': '江原FC',
  'Jeonbuk Hyundai Motors': '全北现代', 'Suwon FC': '水原FC', 'Daegu FC': '大邱FC',
  'Daejeon Hana Citizen': '大田韩亚市民', 'Incheon United': '仁川联',
  'Gimcheon Sangmu': '金泉尚武', 'Jeju SK': '济州SK', 'Gimpo FC': '金浦FC',
  // 日本 J 联赛
  'Sanfrecce Hiroshima': '广岛三箭', 'Vissel Kobe': '神户胜利船', 'Machida Zelvia': '町田泽维亚',
  'Kashima Antlers': '鹿岛鹿角', 'Yokohama F. Marinos': '横滨水手', 'Kawasaki Frontale': '川崎前锋',
  'Urawa Red Diamonds': '浦和红钻', 'Gamba Osaka': '大阪钢巴', 'FC Tokyo': '东京FC',
  'Nagoya Grampus': '名古屋鲸鱼', 'Kashiwa Reysol': '柏太阳神', 'Cerezo Osaka': '大阪樱花',
  'Avispa Fukuoka': '福冈黄蜂', 'Shonan Bellmare': '湘南丽海', 'Albirex Niigata': '新潟天鹅',
  'Tokyo Verdy': '东京绿茵', 'Kyoto Sanga': '京都不死鸟', 'Shimizu S-Pulse': '清水心跳',
  // 泰国
  'Buriram United': '武里南联', 'Ratchaburi FC': '拉查武里', 'Ratchaburi': '拉查武里',
  'Bangkok United': '曼谷联', 'Port FC': '狮子港', 'BG Pathum United': '巴吞联',
  'Muangthong United': '蒙通联',
  // 马来西亚 / 新加坡
  'Johor Darul Ta\'zim': '柔佛DT', 'Selangor FC': '雪兰莪', 'Lion City Sailors': '狮城水手',
  // 澳大利亚
  'Melbourne City': '墨尔本城', 'Sydney FC': '悉尼FC', 'Central Coast Mariners': '中央海岸水手',
  'Melbourne Victory': '墨尔本胜利', 'Adelaide United': '阿德莱德联', 'Brisbane Roar': '布里斯班狮吼',
  'Perth Glory': '珀斯光荣', 'Newcastle Jets': '纽卡斯尔喷气机', 'Western United': '西部联',
  'Wellington Phoenix': '惠灵顿凤凰', 'Macarthur FC': '麦克阿瑟',
  // 亚冠精英 · 东亚区（含北京国安 / 上海海港）
  'Cong An Hanoi': '河内公安', 'Jeonbuk Motors': '全北现代',
  // 亚冠精英 · 西亚区（ESPN 有时写 "Al Hilal" 有时写 "Al-Hilal"，两种都收）
  'Air Force Club': '空军俱乐部', 'Al Ahli': '吉达国民', 'Al-Ahli': '吉达国民',
  'Al Ain': '艾因', 'Al-Ain': '艾因',
  'Al Gharafa': '加拉法', 'Al-Gharafa': '加拉法',
  'Al Hilal': '利雅得新月', 'Al-Hilal': '利雅得新月', 'AlHilal': '利雅得新月',
  'Al Ittihad': '吉达联合', 'Al-Ittihad': '吉达联合',
  'Al Nassr': '利雅得胜利', 'Al-Nassr': '利雅得胜利', 'AlNassr': '利雅得胜利',
  'Al Qadsiah': '卡迪西亚', 'Al-Qadsiah': '卡迪西亚',
  'Al Sadd': '萨德', 'Al-Sadd': '萨德',
  'Al Shamal': '沙马尔', 'Al-Shamal': '沙马尔',
  'Al Wasl': '瓦斯尔', 'Al-Wasl': '瓦斯尔',
  'Esteghlal': '德黑兰独立', 'Neftchi Fergana': '费尔干纳石油',
  'Pakhtakor Tashkent': '塔什干棉农', 'Shabab Al-Ahli': '迪拜青年国民',
  'Traktor Sazi FC': '大不里士拖拉机',

  // ── 2026-10-04 新增 5 项赛事的队名 ──────────────────────────────────────
  // 亚冠二级（afc.cup，2026 赛季有上海申花）
  'Arkadag': '阿尔卡达格', 'Al Muharraq': '穆哈拉格', 'Gol Gohar FC Sirjan': '戈尔戈哈尔',
  'Al-Jazira': '阿布扎比半岛', 'Persib': '万隆', 'Viettel': '越电信',
  'Al Hussein': '侯赛因', 'SC East Bengal': '东孟加拉',
  'Al-Nahda Muscat Club': '纳赫达', 'Al Taawoun': '塔翁', 'Al-Wahda': '瓦赫达',
  'Kuwait SC': '科威特体育', 'Khaldiya': '哈尔迪亚', 'Nasaf Qarshi': '纳萨夫',
  'Al Rayyan': '拉扬', 'Al-Faisaly': '费萨里', 'Al-Shorta': '警察队',
  'Al-Seeb': '锡卜', 'Tai Po FC': '大埔', 'Lion City Sailors FC': '狮城水手',
  'Preah Khan Reach Svay Rieng FC': '柴桢', 'Kitchee': '杰志',
  'Phnom Penh Crown': '金边皇冠', 'Kuching City': '古晋市',
  'BG Tampines Rovers FC': '淡滨尼流浪者',
  // 女足欧冠（uefa.wchampions）：球队 id 与男足不同，只能按英文名收
  'Bayern Munich': '拜仁慕尼黑', 'Manchester City': '曼城', 'Internazionale': '国际米兰',
  'BK Häcken': '赫根', 'HB Køge': '克厄', 'OH Leuven': '鲁汶',
  'OL Lyonnes': '里昂', 'Paris FC': '巴黎FC', 'Austria Vienna': '奥地利维也纳',
  'Servette': '塞尔维特', 'Paris Saint-Germain': '巴黎圣日耳曼',
  'Juventus': '尤文图斯', 'Benfica': '本菲卡', 'Real Madrid': '皇家马德里',
  'Barcelona': '巴塞罗那', 'Chelsea': '切尔西', 'Arsenal': '阿森纳', 'Roma': '罗马',
  // 美职联（usa.1）
  'New York City FC': '纽约城', 'Nashville SC': '纳什维尔', 'Charlotte FC': '夏洛特',
  'Houston Dynamo FC': '休斯敦迪纳摩', 'Columbus Crew': '哥伦布机员',
  'Colorado Rapids': '科罗拉多急流', 'Orlando City SC': '奥兰多城',
  'San Diego FC': '圣迭戈', 'Philadelphia Union': '费城联', 'CF Montréal': '蒙特利尔',
  'Toronto FC': '多伦多', 'Chicago Fire FC': '芝加哥火焰', 'Austin FC': '奥斯汀',
  'San Jose Earthquakes': '圣何塞地震', 'FC Dallas': '达拉斯',
  'Sporting Kansas City': '堪萨斯城竞技', 'Seattle Sounders FC': '西雅图海湾人',
  'Red Bull New York': '纽约红牛', 'Inter Miami CF': '迈阿密国际',
  'Atlanta United FC': '亚特兰大联', 'LA Galaxy': '洛杉矶银河',
  'New England Revolution': '新英格兰革命', 'Real Salt Lake': '皇家盐湖城',
  'LAFC': '洛杉矶FC', 'Portland Timbers': '波特兰伐木者',
  'Minnesota United FC': '明尼苏达联', 'Vancouver Whitecaps': '温哥华白帽',
  'St. Louis CITY SC': '圣路易斯城', 'D.C. United': '华盛顿特区联',
  'FC Cincinnati': '辛辛那提',
  // 解放者杯（conmebol.libertadores）
  'Fluminense': '弗卢米嫩塞', 'Platense': '普拉滕斯', 'Palmeiras': '帕尔梅拉斯',
  'Liga de Quito': '基多体育大学', 'Corinthians': '科林蒂安',
  'Independiente del Valle': '山谷独立', 'Flamengo': '弗拉门戈',
  // 解放者杯 · 其余参赛队（射手榜会带出这些队，不补就会在界面上冒裸 team id）
  'Universidad Católica': '天主教大学', 'Cruzeiro': '克鲁塞罗', 'Libertad': '自由队',
  'Cerro Porteño': '波特诺山丘', 'Sporting Cristal': '水晶竞技', 'Bolívar': '玻利瓦尔',
  'Peñarol': '佩纳罗尔', 'Nacional': '民族队', 'Universitario': '大学队',
  'Atlético Junior': '巴兰基亚青年', 'Independiente Santa Fe': '圣菲独立',
  'Deportes Tolima': '托利马', 'Coquimbo Unido': '科金博联合', 'Mirassol': '米拉索尔',
  'Independiente Rivadavia': '里瓦达维亚独立', 'Cusco FC': '库斯科',
  'Deportivo La Guaira': '拉瓜伊拉', 'Always Ready': '时刻准备',
  'MLS All-Stars': '美职联全明星',
}

/**
 * 杯赛淘汰赛的「占位对阵」。
 *
 * 抽签之后、上一轮打完之前，ESPN 的对手位不是队名而是占位串，而且**没有 team id**：
 *   "Group A Winner" / "Group A 2nd Place" / "3rd Place Group A/C/D" / "Round of 16 3 Winner"
 * 不翻的话赛程卡上会直接冒出英文（2026 亚洲杯 2027-01 的 48 场小组赛之后全是这种）。
 * 认不出来就返回空串，调用方回落到原文，绝不猜。
 */
const KO_ROUND_ZH = {
  quarterfinal: '1/4 决赛', quarterfinals: '1/4 决赛',
  semifinal: '半决赛', semifinals: '半决赛', final: '决赛',
}

/**
 * 球员中文名（**按 ESPN athlete id**，不是按名字）
 * ============================================================
 * 只有「射手榜 / 助攻榜」用得上。ESPN 全站**不提供任何球员中文名**
 * （2026-10-03 实测 `?lang=zh` / `zh-CN` / `region=cn` 全部无效），
 * 只能自己维护。按 id 存而不是按名字存，是因为：
 *   ① 上游偶有拼写/变音符号变动（Cádiz / Cadiz），按名字会漏；
 *   ② 同名的球员确实存在，按 id 才唯一。
 *
 * ⚠️ **未命中就回落英文原名**（`shortName`，形如 "E. Haaland"），
 *    这与队名的处理不同 —— 队名查不到是显示英文全名，这里显示英文短名。
 *    所以**中英混排是预期内的正常状态**，不是 bug：赛季中随时有新人冒上来。
 *    想减少混排就往这张表里补，不要改成「查不到就不显示」。
 *
 * ⚠️ **写「简称」而不是全名**：榜单那一列的宽度只够十来个字，
 *    中文体育媒体在射手榜上也是用简称（哈兰德 / 姆巴佩 / 凯恩），
 *    写「埃尔林·哈兰德」既占宽度又不像中文媒体的叫法。
 *    只有确实需要区分同名球员时才带上名（费兰·托雷斯 / 保·托雷斯）。
 *    分不清是哪一个的（比如只给 "L. Martínez" 却看不出是劳塔罗还是利桑德罗）
 *    **宁可不写**，让它回落英文 —— 错的比英文更糟。
 *
 * 怎么补：跑 `node tools/scorers.js`，末尾会按进球排序列出「没有中文名的球员」及 id，
 *         直接粘回这里填空即可。量大时先跑 `node tools/player-names.js` 自动播种，
 *         再用这张表纠错与改简称（人工表优先级更高）。
 */
const PLAYER_ZH = {
  /* ---------- 欧冠 ---------- */
  '253989': '哈兰德',
  '231050': '拉菲尼亚',
  '362150': '亚马尔',
  '142200': '凯恩',
  '286831': '奥利塞',
  '186381': '吉拉西',
  '265869': '费兰·托雷斯',
  '251100': '保·托雷斯',
  '269136': '德米罗维奇',
  '229744': '登贝莱',
  '145078': '巴尔特拉',
  '311475': '巴图里纳',
  '296969': '卡塔莫',
  '279790': '帕罗特',
  '266291': '德斯特',
  '259902': '库尼亚',
  '257206': '索博斯洛伊',
  '337970': '帕斯',
  '273300': '温达夫',
  '329690': '阿克利乌什',
  '301524': '若昂·戈梅斯',
  '300002': '米考塔泽',
  '290232': '施蒂勒',
  '285450': '恩佐·费尔南德斯',
  '277206': '阿尔瓦雷斯',
  '276221': '格林伍德',
  '270821': '阿劳霍',
  '227714': '福纳尔斯',
  '219713': '劳塔罗',

  /* ---------- 英超 ---------- */
  '235662': '伊萨克',
  '132659': '格罗斯',
  '284960': '若昂·佩德罗',
  '298008': '谢尔基',
  '124091': '布鲁诺·费尔南德斯',
  '265653': '摩根·罗杰斯',
  '310958': '沙德',
  '243364': '塔弗尼耶',
  '280555': '萨卡',
  '282229': '布罗贝',
  '273292': '塞梅尼奥',
  '296395': '帕尔默',
  '197717': '卡尔弗特-勒温',
  '271170': '姆贝乌莫',
  '225564': '亚内尔特',
  '231182': '哈弗茨',
  '300853': '米切尔',
  '249524': '加克波',
  '243396': '吉布斯-怀特',
  '243386': '巴恩斯',
  '299910': '格瓦迪奥尔',
  '219362': '镰田大地',
  '102368': '埃瓦尼尔森',
  '162843': '麦金',
  '298329': '卡拉菲奥里',
  '20975': '恩西索',
  '238262': '赖斯',
  '353951': '哈托',
  '250787': '福登',

  /* ---------- 西甲 ---------- */
  '231388': '姆巴佩',
  '122260': '奥巴梅扬',
  '207288': '布迪米尔',
  '297373': '巴埃纳',
  '291281': '贝林厄姆',
  '273499': '戴维',
  '306263': '苏契奇',
  '307390': '莫莱罗',
  '323838': '小西蒙尼',
  '274913': '阿德耶米',
  '252107': '维尼修斯',
  '268782': '戈登',
  '227765': '奥尔莫',

  /* ---------- 西甲（2026-10-04：球队名单播种后人工复核补） ----------
     这一层优先级最高，用来**覆盖自动结果**（`tools/player-names.js` 生成的 AUTO_PLAYER_ZH）。
     两条来路，都不是「为了多一个名字」，而是纠偏：
       ① 自动给了**错的**（张冠李戴）；
       ② 自动给了港台译名、被 `looksHongKong` 挡回落英文 —— 这里把正确的大陆译法补回来。
     ⚠️ 补之前逐条核过英文名与中文媒体的通用译法。凡不确定是哪一个的一律不写。 */
  '186430': '克里斯滕森', // Andreas Christensen —— 自动给成「克里斯托弗·海梅罗特」（另一个人）
  '225637': '路易斯·费利佩', // Luiz Felipe —— 自动给成「路易斯·菲利佩·斯科拉里」（套了教练 Scolari）
  '368992': '库巴西', // Pau Cubarsí —— 自动给的「保·库瓦尔西」不够通用
  '128714': '埃里克·加西亚', // Eric García —— 带名以区别同队的 Joan García
  '92800': '阿斯帕斯', // Iago Aspas
  '188398': '希门尼斯', // José María Giménez
  '220626': '特拉奥雷', // Adama Traoré
  '242710': '福伊特', // Juan Foyth
  '271129': '科斯塔', // Logan Costa
  '222661': '马费奥', // Pablo Maffeo
  '356000': '海森', // Dean Huijsen
  '363039': '福特', // Héctor Fort
  '300912': '埃扎尔祖利', // Abde Ezzalzouli
  '283891': '穆尼奥斯', // Aihen Muñoz
  '254320': '古里迪', // Jon Guridi
  '319114': '索特洛', // Hugo Sotelo
  '195032': '巴塔利亚', // Augusto Batalla
  '403575': '法里尼亚斯', // Brian Fariñas
  '340677': '内托', // Martim Neto
  '190291': '勒马尔', // Thomas Lemar
  '279904': '尤特格拉', // Ferran Jutglà
  '207834': '奥德罗', // Emil Audero
  '240235': '费巴斯', // Aleix Febas
  '140754': '勒热纳', // Florian Lejeune
  '297359': '帕切科', // Jon Pacheco
  '355433': '萨尔', // Mamadou Sarr
  '284769': '布坎南', // Tajon Buchanan
  '300333': '科马斯', // Arnau Comas
  '226140': '卡诺斯', // Sergi Canós
  '268601': '鲁伊瓦尔', // Aitor Ruibal

  /* ---------- NBA（2026-10-05：名单播种后人工复核补） ----------
     ⚠️ 背景：这一批 617 人跑下来只命中 4 条（命中率 1%），原因是通道 A 的闸门
        写死了「必须是**足球运动员**」（`P106=Q937857`，见 tools/player-names.js 的
        FOOTBALLER_Q），NBA 球员几乎全被判成「非足球员」挡下 —— 详见 REFERENCE §二。
        所以下面这几条不是「补覆盖率」，而是把 AUTO 给错的**港译**改回大陆通用译法。
        ⚠️ 已逐个用 ESPN core API 核过 id → displayName，确认不是张冠李戴。 */
  '4397040': '布兰登·威廉姆斯', // Brandon Williams —— 自动给的「班顿·威廉斯」是港译
  '4432582': '马克斯·克里斯蒂', // Max Christie —— 自动给的「基斯迪」是港译

  /* ---------- 意甲 ---------- */
  '259481': '马伦',
  '250850': '弗拉泰西',
  '376473': '马斯坦托诺',
  '290545': '小马尔蒂尼',
  '176203': '拉比奥',
  '217331': '图拉姆',
  '364742': '迪奥',
  '258307': '布雷默',
  '309273': '霍伊伦',
  '285226': '科内',
  '204669': '扎卡尼',
  '164839': '迪巴拉',
  '212597': '曼奇尼',
  '228298': '丘库埃泽',

  /* ---------- 德甲 ---------- */
  '212330': '希克',
  '274887': '布尔卡特',
  '170257': '菲尔克鲁格',
  '146804': '格雷戈里奇',
  '319368': '努萨',
  '355369': '乌尊',
  '290044': '古铁雷斯',
  '170209': '金特尔',
  '357030': '佐野海舟',
  '191209': '曹法尔',
  '190161': '基米希',
  '236721': '戴维斯',
  '209595': '斯希里',
  '196029': '奥诺拉',

  /* ---------- 法甲 ---------- */
  '259743': '戈伊里',
  '156898': '托万',
  '333310': '努瓦马',
  '159047': '马尔基尼奥斯',
  '346844': '蒂亚戈·桑托斯',
  '274277': '上田绮世',
  '192060': '托利索',
  '88965': '吉鲁',
  '195501': '戈洛温',
  '214596': '法比安·鲁伊斯',

  /* ---------- 欧国联 ---------- */
  '276350': '若昂·菲利克斯',
  '308932': '达姆斯高',
  '307111': '博布',
  '288896': '贡萨洛·拉莫斯',
  '303793': '措利斯',
  '240209': '穆里奇',
  '258906': '约克雷斯',
  '281122': '恩梅查',
  '203669': '厄德高',
  '290591': '努诺·门德斯',
  '220819': '帕夫利迪斯',
  '122575': '塔迪奇',
  '275842': '恩多耶',
  '103485': '佩里西奇',

  /* ---------- 欧联 ---------- */
  '252971': '科洛·穆阿尼',
  '297370': '皮诺',
  '288340': '勒费',
  '271873': '切利克',
  '249663': '梅迪纳',
  '229443': '卢克巴基奥',
  '298349': '沃尔特马德',
  '245916': '克鲁伊维特',
  '272700': '科克曲',
  '333419': '沃顿',
  '314790': '斯科特',
  '305684': '特吕费尔',
  '259474': '格拉巴拉',
  '227697': '卢库米',
  '219294': '阿莱士·加西亚',

  /* ---------- 中超 ----------
     ⚠️ 中超外援的中文名基本是**音译**，与本地球迷的叫法一致即可；
         中国球员用本名（张玉宁 / 韦世豪 / 张稀哲 / 高天意）。 */
  '233666': '张玉宁',
  '207701': '韦世豪',
  '255779': '高天意',
  '302980': '奥斯卡',
  '173239': '卡迪斯',
  '216975': '索萨',
  '218955': '克雷桑',
  '202305': '古斯塔沃',
  '287781': '克莱伯',
  '194410': '米特里塔',
  '222356': '韦斯利',
  '301780': '杰菲尼奥',
  '251462': '戴维森',
  '237548': '托利奇',
  '208131': '阿布雷乌',
  '176678': '斯坦丘',
  '302535': '泽卡',
  '251743': '姆本扎',
  '238895': '沙达斯',
  '203128': '绍尔',
  '180446': '纳扎里奥',
  '144889': '约尼塔',
  '165050': '卡扎伊什维利',
  '201497': '塞尔吉尼奥',
  '288372': '雅库布',
  '290424': '钦帕努',

  /* ---------- 亚冠精英 ---------- */
  '172151': '张稀哲',
  '135355': '宇佐美贵史',
  '208128': '鲁本·内维斯',
  '230422': '布内贾',
  '211141': '米林科维奇-萨维奇',
  '233075': '基尼奥内斯',

  /* ---------- 2026-10-04 名单播种复核：跨赛事纠错 ----------
     来源：`check-surname.js` 的「同姓氏译名应一致」检测 + 人工判读。
     两类：① 张冠李戴（自动给的是另一个人）；② 港译漏网（词表当时还没这些词）。
     ⚠️ 写在这里是为了**不重跑播种器也能立刻生效**（手工层优先级最高）。 */
  '332354': '韦斯利', // Wesley —— 自动给成「韦斯利·斯内德」（那是荷兰的 Sneijder，另一个人）
  '203072': '詹姆斯', // Daniel James —— 自动给成港译「丹尼尔·占士」
  '197105': '桑切斯', // Davinson Sánchez —— 自动给成港译「戴云逊·山齐士」
  '314858': '桑托斯', // Andrey Santos —— 自动给成港译「安迪利·山度士」
  '239241': '哈泽德', // Conor Hazard —— 自动给成港译「干拿·夏萨特」
  '394250': '门德斯', // Rodrigo Mendes —— 自动给成港译「洛迪高·文迪斯」
  '365332': '摩尔', // Mikey Moore —— 自动给成港译「米奇·摩亚」
  '280764': '阿劳霍', // Julián Araujo —— 自动给的「朱利安·阿勞霍」残留繁体「勞」
  '256909': '佩佩', // Pepê —— 自动给了全名「克普勒·拉韦兰·利马·费雷拉」，太长
  '359796': '迪乌夫', // El Hadji Malick Diouf —— 自动给的「艾尔-哈吉·马历·迪奥夫」中间名是港译
}

/**
 * 自动生成的种子表（`node tools/player-names.js` 产出，来源 Wikidata 中文标签）。
 *
 * ⚠️ **两层结构是刻意的**：这里是人工权威层，`player-zh.js` 是自动覆盖层。
 *    查法固定「先人工、后自动」：
 *      · 想改简称（「埃尔林·哈兰德」→「哈兰德」）或纠错 → 写进上面的 PLAYER_ZH，覆盖自动结果；
 *      · 想扩大覆盖 → 重跑生成器，不要手工往 player-zh.js 里塞。
 *    文件缺失（还没生成过）不影响运行，只是全部回落英文短名。
 */
let AUTO_PLAYER_ZH = {}
try {
  // eslint-disable-next-line
  AUTO_PLAYER_ZH = require('./player-zh').AUTO_PLAYER_ZH || {}
} catch (err) {
  AUTO_PLAYER_ZH = {}
}

/** 球员中文名（按 ESPN athlete id），查不到返回空串让调用方回落英文 */
function playerZh(id) {
  const key = String(id)
  return PLAYER_ZH[key] || AUTO_PLAYER_ZH[key] || ''
}

function placeholderZh(name) {
  const s = String(name || '').trim()
  if (!s) return ''
  let m
  if ((m = s.match(/^Group\s+([A-Z])\s+Winner$/i))) return `${m[1]} 组第 1`
  if ((m = s.match(/^Group\s+([A-Z])\s+(\d+)(?:st|nd|rd|th)\s+Place$/i))) return `${m[1]} 组第 ${m[2]}`
  // "3rd Place Group A" / "3rd Place Group A/C/D"（成绩最好的小组第三）
  if ((m = s.match(/^(\d+)(?:st|nd|rd|th)\s+Place\s+Group\s+([A-Z](?:\s*\/\s*[A-Z])*)$/i)))
    return `${m[2].toUpperCase().replace(/\s*\/\s*/g, '/')} 组第 ${m[1]}`
  // "Round of 16 3 Winner"
  if ((m = s.match(/^Round\s+of\s+(\d+)\s+(\d+)\s+Winner$/i))) return `${m[1]} 强第 ${m[2]} 场胜者`
  if ((m = s.match(/^([A-Za-z]+)\s+(\d+)\s+Winner$/i)) && KO_ROUND_ZH[m[1].toLowerCase()])
    return `${KO_ROUND_ZH[m[1].toLowerCase()]}第 ${m[2]} 场胜者`
  if ((m = s.match(/^Group\s+([A-Z])$/i))) return `${m[1]} 组`
  // "TBD" / "TBD Home" / "TBD Away"：淘汰赛对阵还没定（解放者杯见过）。
  // 主客两个都叫「待定」——在待定状态下区分主客没有意义，显示了反而像坏数据。
  if (/^TBD(\s+(Home|Away))?$/i.test(s)) return '待定'
  return ''
}

/** 足球 / NBA 队名（按 ESPN team id） */
function espnZh(id) {
  return ESPN_ZH[String(id)] || ''
}

/**
 * 英文名兜底（国家队 + 亚冠俱乐部），查不到就返回空串让调用方回落到原文。
 * 大小写不敏感：ESPN 对同一支队在不同端点会给出 "Ulsan HD" / "Ulsan hd" 两种写法。
 */
/**
 * 大小写 + 变音符号都不敏感 —— 同一个国家/俱乐部上游有各种写法：
 * "Curaçao" / "Curacao"、"Côte d'Ivoire" / "Cote d'Ivoire"、"Ulsan HD" / "Ulsan hd"。
 * 统一剥掉声调符号再比，省得为一个撇号补一条映射。
 */
const foldKey = (s) => String(s)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // 剥声调：Curaçao → Curacao
  .replace(/['’`]/g, '') // 剥撇号：Côte d'Ivoire → Cote dIvoire
  .toLowerCase().trim()

const NAME_LC = {}
Object.keys(NAME_ZH).forEach((k) => { NAME_LC[foldKey(k)] = NAME_ZH[k] })
Object.keys(CLUB_ZH).forEach((k) => { NAME_LC[foldKey(k)] = CLUB_ZH[k] })
Object.keys(YOUTH_ZH).forEach((k) => { NAME_LC[foldKey(k)] = YOUTH_ZH[k] })

function nameZh(name) {
  const s = String(name || '').trim()
  const direct = YOUTH_ZH[s] || NAME_ZH[s] || CLUB_ZH[s] || NAME_LC[foldKey(s)] || ''
  if (direct) return direct
  // "Spain U17" / "China PR U17"：剥掉年龄段后缀查国家队表，再把后缀拼回去
  const m = s.match(/^(.*?)[\s\-]+(U\d{2})$/i)
  if (m) {
    const base = nameZh(m[1])
    if (base) return `${base}${m[2].toUpperCase()}`
  }
  return ''
}

/** 英雄联盟队名（按官方简码） */
function lolZh(code) {
  return LOL_ZH[code] || ''
}

module.exports = {
  ESPN_ZH, NAME_ZH, CLUB_ZH, YOUTH_ZH, LOL_ZH, PLAYER_ZH,
  espnZh, nameZh, placeholderZh, lolZh, playerZh,
}
