const npmData = require('./npm-data')
const fs = require('fs')
const hyperdiscovery = require('hyperdiscovery')
const IMS = require('./')

const ims = new IMS(process.env.HOME + '/npm.db')
const db = ims.db

db.ready(function () {
  hyperdiscovery(ims)
})

var state = ''
var id = ''
var inc = 0

setInterval(function () {
  if (id === toId()) return
  id = toId()
  console.log('state:', state)
  console.log('feed:', db.feed)
}, 5000)

runImport()

function toId () {
  return state + '@' + db.feed.length
}

function runImport () {
  console.log('start import', inc++)
  fs.readFile(process.env.HOME + '/npm.db/seq', 'utf-8', function (_, seq) {
    seq = Number(seq || '0')
    npmData(seq, ondata, function (err) {
      console.log('end import', --inc, err)
      setTimeout(runImport, 1000)
    })
  })
}

function ondata (data, next) {
  if (data.deleted) return deleteAll(data.id, next)

  var i = 0
  loop(null)

  function loop (err) {
    if (err) return next(err)
    if (i === data.versions.length) return note(data.seq, next)

    const n = mapVersion(data.id, data.versions[i++])

    state = 'preget'
    db.get(n.key, function (_, node) {
      state = 'postget'
      if (node) return loop(null)
      state = 'precopy'
      hasCopy(data.id, n.value, function (err, seq) {
        state = 'postcopy'
        if (err) return next(err)
        if (seq) n.value = {sameDependencies: seq}
        state = 'preput'
        db.put(n.key, n.value, function () {
          state = 'postput'
          loop()
        })
      })
    })
  }
}

function hasCopy (id, v, cb) {
  const ite = db.iterator(id)

  ite.next(function loop (err, node) {
    if (err) return cb(err)
    if (!node) return cb(null, 0)
    if (deps(node.value) === deps(v)) return cb(null, node.seq)
    ite.next(loop)
  })
}

function deps (v) {
  return JSON.stringify({
    dependencies: v.dependencies,
    devDependencies: v.devDependencies
  })
}

function mapDeps (d) {
  if (!d) return null

  const list = []
  for (const k of Object.keys(d)) {
    if (typeof d[k] !== 'string') continue
    list.push({
      name: k,
      range: d[k]
    })
  }
  return list
}

function mapVersion (id, v) {
  const deps = mapDeps(v.dependencies)
  const devDeps = mapDeps(v.devDependencies)

  return {
    key: id + '/' + v.version,
    value: {
      dependencies: deps,
      devDependencies: devDeps
    }
  }
}

function deleteAll (prefix, cb) {
  const ite = db.iterator(prefix)

  ite.next(function loop (err, node) {
    if (err) return cb(err)
    if (!node) return cb(null)
    db.del(node.key, function (err) {
      if (err) return cb(err)
      ite.next(loop)
    })
  })
}

function note (seq, cb) {
  fs.writeFile(process.env.HOME + '/npm.db/seq.tmp', '' + seq, function (err) {
    if (err) return cb(err)
    fs.rename(process.env.HOME + '/npm.db/seq.tmp', process.env.HOME + '/npm.db/seq', cb)
  })
}
