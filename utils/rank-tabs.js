/** 前两项靠左，其余选中项双向切换时都保持在第三个位置。 */
function anchor(keys, selected) {
  const index = keys.indexOf(selected)
  if (index < 0) return keys[0] || ''
  return keys[Math.max(0, index - 2)]
}
module.exports = { anchor }
