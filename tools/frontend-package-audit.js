/** Conservative on-disk package audit. The WeChat upload report remains authoritative. */
const fs = require('node:fs')
const path = require('node:path')

function audit(root = path.resolve(__dirname, '..')) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  const subpackages = app.subPackages || app.subpackages || []
  const excluded = file => (config.packOptions.ignore || []).some(rule => rule.type === 'folder'
    ? file === rule.value || file.startsWith(rule.value + '/') : file === rule.value)
  function walk(dir = '') {
    return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
      const file = dir ? `${dir}/${entry.name}` : entry.name
      if (excluded(file)) return []
      if (entry.isSymbolicLink()) throw new Error(`Unexcluded link: ${file}`)
      if (entry.isDirectory()) return walk(file)
      const pack = subpackages.find(p => file.startsWith(p.root + '/'))
      return [{ file, bytes: fs.statSync(path.join(root, file)).size, package: pack ? pack.root : 'main' }]
    })
  }
  const files = walk()
  const packages = ['main', ...subpackages.map(p => p.root)].map(name => ({
    name, bytes: files.filter(f => f.package === name).reduce((sum, f) => sum + f.bytes, 0),
  })).map(p => ({ ...p, limit: 2 * 1024 * 1024, remaining: 2 * 1024 * 1024 - p.bytes }))
  return { method: 'Uncompressed source bytes after packOptions.ignore; not the WeChat upload report',
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0), packages, files }
}

if (require.main === module) {
  const result = audit()
  console.log(JSON.stringify(result, null, 2))
  if (result.packages.some(p => p.remaining < 0)) process.exitCode = 1
}
module.exports = { audit }
