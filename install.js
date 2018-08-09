#!/usr/bin/env node

const { Pool } = require('undici')
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
const minimist = require('minimist')

var tick = 1
var rendered = 0
setInterval(() => tick++, 250).unref()

const pool = new Pool('https://registry.npmjs.org', {
  // magic numbers on what works good on my OS
  // if those high number of connections are not needed
  // they won't be used
  connections: 128,
  pipelining: 2
})

const argv = minimist(process.argv.slice(2), {
  alias: {
    global: 'g',
    save: 's',
    'save-dev': 'S',
    key: 'k',
    production: 'p',
    help: 'h',
    update: 'u',
    quiet: 'q'
  },
  boolean: ['seed', 'quiet', 'update', 'help', 'global', 'save', 'save-dev', 'production']
})

const key = argv.key || '13f46b517a126b5d3f64cd2a7ec386140b06b38be6a7a47ffb5ba9b6461ee563'
const dir = path.join(os.homedir(), '.ims')
const ims = IMS(path.join(dir, 'db'), key, {sparse: !argv.seed})
const localPkg = fs.existsSync('package.json') && require(path.join(process.cwd(), 'package.json'))
const name = argv._[0] || localPkg

if (!name || argv.help && !argv.seed) {
  console.error('Usage: ims <package-name?> [options]')
  console.error('')
  console.error('  --save, -s        saves the dep to package.json')
  console.error('  --save-dev, -S    saves the dev dep to package.json')
  console.error('  --global, -g      installs as a cli tool')
  console.error('  --production, -p  skip dev dependencies')
  console.error('  --update, -u      force update the cache')
  console.error('  --quiet, -q       do not print anything')
  console.error('  --seed            seed all metadata on the dat network')
  console.error('')
  console.error('If <package-name> is omitted the deps from package.json is used')
  process.exit()
}

if (argv.seed) argv.quiet = true

const base = argv.global ? '/usr/local/lib/node_modules' : './node_modules'

var missing = 0
var installed = false
var sw = null
var installs = 0
var downloads = 0
var ended = 0

// ims <name> or --global is always production
if (typeof name === 'string' || argv.global) argv.production = true

const fetching = new Map()
const started = Date.now()
const diffy = require('diffy')()

diffy.render(render)

const opts = {
  production: argv.production,
  ondep: function (pkg, tree) {
    const shard = hashShard(pkg.name + '@' + pkg.version)
    const cache = path.join(dir, 'cache', shard)
    const topLevel = typeof name === 'string' ? !tree.parent : (tree.parent && !tree.parent.parent)

    missing++

    fs.stat(cache, function (err) {
      if (!err) return finish(null)
      fetch(pkg, cache, finish)
    })

    function finish (err) {
      if (err) return onerror(err)

      const nm = path.join(base, '..', pathify(tree))
      const check = path.join(nm, '.ims')
      var pkg = null

      fs.readFile(check, 'utf-8', function (_, stored) {
        if (stored === shard) return done(null)
        fs.unlink(check, function () {
          pump(fs.createReadStream(cache), gunzip(), tar.extract(nm, {map, mapStream}), function (err) {
            if (err) return onerror(err)
            linkBins(pkg, '..', path.join(nm, '../.bin'), function (err) {
              if (err) return onerror(err)
              fs.writeFile(check, shard, done)
            })
          })
        })
      })

      function mapStream (stream, header) {
        if (header.name !== 'package.json') return stream
        if (!topLevel) return stream

        const buf = []
        stream.on('data', data => buf.push(data))
        stream.on('end', function () {
          pkg = JSON.parse(Buffer.concat(buf))
        })

        return stream
      }

      function done (err) {
        if (err) return onerror(err)
        installs++
        renderMaybe()
        if (!--missing && installed) exit()
      }
    }
  }
}

ims.ready(function () {
  if (argv.seed) {
    require('hyperdiscovery')(ims)
    return
  }

  diffy.render()

  sw = require('hyperdiscovery')(ims).once('connection', function () {
    if (!argv.update) return resolve()
    ims.update(resolve)

    function resolve () {
      diffy.render()
      ims.resolve(name, opts, function (err, tree) {
        if (err) return onerror(err)
        installed = true

        if (localPkg && (argv['save-dev'] || argv.save) && !argv.global) {
          const key = argv.save ? 'dependencies' : 'devDependencies'
          const deps = localPkg[key] || {}
          deps[name] = '^' + tree.version
          localPkg[key] = sort(deps)
          fs.writeFileSync('package.json', JSON.stringify(localPkg, null, 2) + '\n')
        }

        if (!missing) exit()
      })
    }
  })

  // always render on connections
  sw.on('connection', () => diffy.render())
})

function map (header) {
  header.name = header.name.replace(/^package\//, '')
  return header
}

function sort (deps) {
  const copy = {}
  for (const k of Object.keys(deps).sort()) copy[k] = deps[k]
  return copy
}

function pathify (tree) {
  const skipLast = typeof name !== 'string'
  var p = ''
  while (tree) {
    p = path.join('node_modules', tree.name, p)
    tree = tree.parent
    if (skipLast && !tree.parent) break
  }
  return p
}

function hashShard (name) {
  const buf = Buffer.alloc(32)
  sodium.crypto_generichash(buf, Buffer.from(name))
  const hex = buf.toString('hex')
  return path.join(hex.slice(0, 2), hex.slice(2, 4), hex.slice(4))
}

function linkBins (pkg, dir, binDir, cb) {
  if (!pkg) return cb(null)

  var missing = 1
  var error = null

  if (!pkg.bin || !pkg.name) return done(null)
  if (/(^\.)|[/\\]/.test(pkg.name)) return done(null)

  const bin = typeof pkg.bin === 'string' ? {[pkg.name]: pkg.bin} : pkg.bin

  for (const k of Object.keys(bin)) {
    if (/(^\.)|[/\\]/.test(k)) continue
    missing++
    link(path.join(dir, pkg.name, bin[k]), k)
  }

  done(null)

  function link (exe, k) {
    fs.symlink(exe, path.join(binDir, k), function (err) {
      if (err && err.code === 'ENOENT') return mkdirp(binDir, retry)
      if (err && err.code !== 'EEXIST') return done(err)
      fs.chmod(path.join(binDir, exe), 0o755, done)
    })

    function retry (err) {
      if (err) return done(err)
      link(exe, k)
    }
  }

  function done (err) {
    if (err) error = err
    if (--missing) return
    cb(error)
  }
}

function exit () {
  diffy.render()

  if (!argv.global) return done(null)

  const pkg = require(path.join(base, name, 'package.json'))
  linkBins(pkg, '../lib/node_modules', '/usr/local/bin', done)

  function done (err) {
    if (err) return onerror(err)
    ended = Date.now()
    diffy.render()
    setImmediate(() => process.exit())
  }
}

function onerror (err) {
  if (err) throw err
}

function renderMaybe () {
  if (tick === rendered) return
  rendered = tick
  diffy.render()
}

function render () {
  if (argv.quiet) return ''

  const time = ended ? '(took ' + (ended - started) + 'ms)' : ''
  const latest = ims.db.version ? '(Latest version: ' + ims.db.version + ')' : ''

  return trim(`
    Connected to ${sw ? sw.connections.length : 0} peer(s) ${latest}
    Downloaded ${downloads} new module tarballs
    Installed ${installs} modules to ${base} ${time}
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
    renderMaybe()
    pool.request({
      method: 'GET',
      path: '/' + pkg.name + '/-/' + pkg.name + '-' + pkg.version + '.tgz'
    }, function (err, res) {
      if (err) return done(err)
      if (res.statusCode !== 200) return done(new Error('Bad response (' + res.statusCode + ')'))

      pump(res.body, fs.createWriteStream(cache + '.tmp'), function (err) {
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
