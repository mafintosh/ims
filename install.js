#!/usr/bin/env node

const get = require('simple-get')
const path = require('path')
const mkdirp = require('mkdirp')
const fs = require('fs')
const sodium = require('sodium-universal')
const pump = require('pump')
const tar = require('tar-fs')
const gunzip = require('gunzip-maybe')
const os = require('os')
const IMS = require('./')
const trim = require('diffy/trim+newline')

const dir = path.join(os.homedir(), '.ims')
const ims = IMS(path.join(dir, 'db'), '13f46b517a126b5d3f64cd2a7ec386140b06b38be6a7a47ffb5ba9b6461ee563')
const name = process.argv[2] || require(path.join(process.cwd(), 'package.json'))

var missing = 0
var installed = false
var sw = null
var installs = 0
var downloads = 0
var ended = 0

const fetching = new Map()
const started = Date.now()
const diffy = require('diffy')()

diffy.render(render)

const opts = {
  ondep: function (pkg, tree) {
    const shard = hashShard(pkg.name + '@' + pkg.version)
    const cache = path.join(dir, 'cache', shard)

    missing++

    fs.stat(cache, function (err) {
      if (!err) return finish(null)
      fetch(pkg, cache, finish)
    })

    function finish (err) {
      if (err) return onerror(err)

      const nm = pathify(tree)
      const check = path.join(nm, '.ims')

      fs.readFile(check, 'utf-8', function (_, stored) {
        if (stored === shard) return done(null)
        fs.unlink(check, function () {
          pump(fs.createReadStream(cache), gunzip(), tar.extract(nm, {map}), function (err) {
            if (err) return onerror(err)
            fs.writeFile(check, shard, done)
          })
        })
      })

      function done (err) {
        if (err) return onerror(err)
        installs++
        diffy.render()
        if (!--missing && installed) exit()
      }
    }
  }
}

ims.ready(function () {
  diffy.render()
  sw = require('hyperdiscovery')(ims).once('connection', function () {
    diffy.render()
    ims.resolve(name, opts, function (err, tree) {
      if (err) return onerror(err)
      installed = true
      if (!missing) exit()
    })
  })
})

function map (header) {
  header.name = header.name.replace(/^package\//, '')
  return header
}

function pathify (tree) {
  var p = ''
  while (tree) {
    p = path.join('node_modules', tree.name, p)
    tree = tree.parent
  }
  return p
}

function hashShard (name) {
  const buf = Buffer.alloc(32)
  sodium.crypto_generichash(buf, Buffer.from(name))
  const hex = buf.toString('hex')
  return path.join(hex.slice(0, 2), hex.slice(2, 4), hex.slice(4))
}

function exit () {
  ended = Date.now()
  diffy.render()
  setImmediate(() => process.exit())
}

function onerror (err) {
  if (err) throw err
}

function render () {
  const time = ended ? '(took ' + (ended - started) + 'ms)' : ''
  const latest = ims.db.version ? '(Latest version: ' + ims.db.version + ')' : ''

  return trim(`
    Connected to ${sw ? sw.connections.length : 0} peer(s) ${latest}
    Downloaded ${downloads} new module tarballs
    Installed ${installs} modules to ./node_modules ${time}
  `)
}

function fetch (pkg, cache, cb) {
  if (fetching.has(cache)) {
    fetching.get(cache).push(cb)
    return
  }

  fetching.set(cache, [cb])

  mkdirp(path.dirname(cache), function (err) {
    if (err) return done(err)

    downloads++
    diffy.render()
    get('https://registry.npmjs.org/' + pkg.name + '/-/' + pkg.name + '-' + pkg.version + '.tgz', function (err, res) {
      if (err) return done(err)
      if (res.statusCode !== 200) return done(new Error('Bad response (' + res.statusCode + ')'))

      pump(res, fs.createWriteStream(cache + '.tmp'), function (err) {
        if (err) return done(err)
        fs.rename(cache + '.tmp', cache, done)
      })
    })
  })

  function done (err) {
    for (const cb of fetching.get(cache)) cb(err)
    fetching.delete(cache)
  }
}
