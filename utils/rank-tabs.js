/** 保留前三个标签的位置，超出后逐位推进；向回滑出左边界时再回移。 */
function anchor(keys, selected, previous) {
  const index = keys.indexOf(selected)
  if (index < 0) return keys[0] || ''
  const start = Math.max(0, keys.indexOf(previous))
  return keys[index < start ? index : index >= start + 3 ? index - 2 : start]
}
module.exports = { anchor }
