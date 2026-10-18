const STORAGE_KEY = 'competition_order_v2'
const LEGACY_STORAGE_KEY = 'schedule_comp_order_v1'

function read(key) {
  try {
    const value = wx.getStorageSync(key)
    return value && typeof value === 'object' ? value : null
  } catch (_) {
    return null
  }
}

function write(order) {
  try {
    wx.setStorageSync(STORAGE_KEY, order)
    return true
  } catch (_) {
    return false
  }
}

function defaultKeys(categories) {
  return (categories || []).reduce((all, category) => all.concat(category.competitions || []), [])
}

function completeOrder(saved, defaults) {
  const available = new Set(defaults)
  const unique = []
  const seen = new Set()
  ;(Array.isArray(saved) ? saved : []).forEach((key) => {
    if (available.has(key) && !seen.has(key)) {
      unique.push(key)
      seen.add(key)
    }
  })
  return unique.concat(defaults.filter((key) => !seen.has(key)))
}

/**
 * 读取跨赛事类别的统一顺序。旧版分类内偏好会在升级后合并迁移，
 * 保留每个类别内的先后次序，类别之间沿用产品默认顺序。
 */
function getOrder(categories) {
  const defaults = defaultKeys(categories)
  const current = read(STORAGE_KEY)
  if (Array.isArray(current)) return completeOrder(current, defaults)

  const legacy = read(LEGACY_STORAGE_KEY)
  if (legacy) {
    const migrated = []
    ;(categories || []).forEach((category) => {
      const keys = category.competitions || []
      migrated.push(...completeOrder(legacy[category.key], keys))
    })
    const result = completeOrder(migrated, defaults)
    write(result)
    return result
  }
  return defaults
}

function orderKeys(keys, categories) {
  const allowed = new Set(keys || [])
  return getOrder(categories).filter((key) => allowed.has(key))
}

function setOrder(keys) {
  return write(Array.from(new Set(keys || [])))
}

function moveItem(items, from, to) {
  const result = (items || []).slice()
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= result.length || to < 0 || to >= result.length) return result
  const moved = result.splice(from, 1)[0]
  result.splice(to, 0, moved)
  return result
}

function moveToFront(items, index) {
  return moveItem(items, index, 0)
}

function resetOrder(categories) {
  const result = write(defaultKeys(categories))
  try { wx.removeStorageSync(LEGACY_STORAGE_KEY) } catch (_) {}
  return result
}

module.exports = { STORAGE_KEY, orderKeys, getOrder, setOrder, resetOrder, moveItem, moveToFront }
