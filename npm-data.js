const ndjson = require('ndjson')
const get = require('simple-get')
const each = require('stream-each')
const pump = require('pump')

module.exports = sync

function sync (since, ondata, cb) {
  const url = `https://replicate.npmjs.com/_changes?feed=continuous&include_docs=true&since=${since}`

  get({url, timeout: 30000}, function (err, res) {
    if (err) return cb(err)
    each(pump(res, ndjson.parse()), parse, cb)
  })

  function parse (data, next) {
    if (data.id[0] === '_') return next()
    ondata({seq: data.seq, id: data.id, deleted: !!data.deleted, versions: mapVersions(data.doc.versions)}, next)
  }
}

function mapVersions (v) {
  if (!v) return null

  const list = []
  for (const k of Object.keys(v)) {
    list.push({
      version: k,
      dependencies: v[k].dependencies || null,
      devDependencies: v[k].devDependencies || null
    })
  }

  return list
}
