const hypertrie = require('hypertrie')
const semver = require('semver')
const messages = require('./messages')

module.exports = (storage, key, opts) => new IMS(storage, key, opts)

class IMS {
  constructor (storage, key, opts) {
    if (!opts) opts = {}

    const self = this

    this.db = hypertrie(storage, key, {
      valueEncoding: messages.Package,
      sparse: opts.sparse !== false,
      maxRequests: 512
    })

    if (this.db.feed.sparse) update()

    this.db.feed.on('peer-add', function (peer) {
      peer.stream.on('extension', function (name, data) {
        switch (name) {
          case 'ims/resolve': return onresolve(data)
          case 'ims/seqs': return onseqs(data)
        }
      })

      function onresolve (data) {
        const { name, range, production } = messages.ResolveRequest.decode(data)
        self._seqs(name, range || '*', production, onsendseqs)
      }

      function onseqs (data) {
        const { seqs } = messages.ResolveResult.decode(data)
        const len = Math.min(8192, seqs.length)
        const feed = self.db.feed

        for (var i = 0; i < len; i++) {
          if (feed.bitfield && feed.bitfield.get(seqs[i])) continue
          feed.get(seqs[i], noop)
        }
      }

      function onsendseqs (err, seqs) {
        if (err) return
        const res = []
        for (const seq of seqs.values()) {
          if (peer.remoteBitfield && peer.remoteBitfield.get(seq)) continue
          res.push(seq)
        }
        if (!res.length) return
        peer.stream.extension('ims/seqs', messages.ResolveResult.encode({seqs: res}))
      }
    })

    this.key = this.db.key
    this.discoveryKey = this.db.discoveryKey
    this.ready(noop)

    function update () {
      self.db.feed.update(update)
    }
  }

  ready (cb) {
    if (!cb) cb = noop

    const self = this

    this.db.ready(function (err) {
      if (err) return cb(err)
      self.key = self.db.key
      self.discoveryKey = self.db.discoveryKey
      cb(null)
    })
  }

  replicate (opts) {
    return this.db.replicate({
      live: true,
      extensions: [
        'ims/resolve',
        'ims/seqs'
      ]
    })
  }

  _extension (name, data) {
    for (const peer of this.db.feed.peers) {
      peer.stream.extension(name, data)
    }
  }

  _seqs (name, range, prod, cb) {
    const self = this
    const seen = new Set()
    const seqs = new Set()

    visit(name, range, prod, cb)

    function visit (name, range, prod, cb) {
      self.getLatest(name, range, {seqs}, function (err, node) {
        if (err) return cb(err)
        if (!node || seen.has(node.key)) return cb(null, seqs)
        seen.add(node.key)

        var missing = 0
        var error = null

        ondeps(node.value.dependencies)
        if (!prod) ondeps(node.value.devDependencies)

        if (!missing) cb(null, seqs)

        function ondeps (deps) {
          for (var i = 0; i < deps.length; i++) {
            missing++
            visit(deps[i].name, deps[i].range, true, ondone)
          }
        }

        function ondone (err) {
          if (err) error = err
          if (--missing) return
          cb(error, seqs)
        }
      })
    }
  }

  resolve (name, opts, cb) {
    if (typeof opts === 'function') return this.resolve(name, null, opts)
    if (!cb) cb = noop
    if (!opts) opts = {}

    const self = this
    const ondep = opts.ondep || noop
    const range = opts.range || '*'
    const production = !!opts.production
    const root = {parent: null, name: null, version: null, range, deps: new Map(), toJSON}

    var missing = 0
    var error = null

    if (typeof name === 'string') {
      this._extension('ims/resolve', messages.ResolveRequest.encode({name, production, range}))
      root.name = name
      missing++
      visit(name, range, root, onvisit)
      return
    }

    const deps = depsToArray(name.dependencies).concat(production ? [] : depsToArray(name.devDependencies))
    root.name = name.name
    root.version = name.version || null

    // TODO: support only sending one msg here with the resolves as an array
    for (const {name, range} of deps) {
      this._extension('ims/resolve', messages.ResolveRequest.encode({name, production, range}))
    }

    missing += visitDeps(root, deps, onvisit)

    function onvisit (err) {
      if (err) error = err
      if (--missing) return
      if (error) return cb(error)
      cb(null, root)
    }

    function visit (name, range, tree, cb) {
      const prod = tree !== root || production

      self.getLatest(name, range, function (err, node) {
        if (err) return cb(err)
        if (!node) return cb(new Error('Module not found'))

        const pkg = parse(node.key)
        const visited = inTree(tree, pkg.name, pkg.version)

        tree.range = range
        tree.version = pkg.version

        if (visited) {
          tree.parent.deps.delete(tree.name)
          return cb(null)
        }

        ondep(pkg, tree)

        var error = null
        var missing = 1

        missing += visitDeps(tree, node.value.dependencies, ondone)
        if (!prod) missing += visitDeps(tree, node.value.devDependencies, ondone)

        ondone(null)

        function ondone (err) {
          if (err) error = err
          if (--missing) return
          if (error) return cb(error)
          cb(null)
        }
      })
    }

    function visitDeps (tree, deps, ondone) {
      for (var i = 0; i < deps.length; i++) {
        const dep = {
          parent: tree,
          name: deps[i].name,
          version: null,
          deps: new Map()
        }
        tree.deps.set(dep.name, dep)
        visit(dep.name, deps[i].range, dep, ondone)
      }

      return deps.length
    }
  }

  getLatest (name, range, opts, cb) {
    if (typeof opts === 'function') return this.getLatest(name, range, null, opts)

    const db = this.db
    const seqs = opts ? opts.seqs : null

    db.ready(function (err) {
      if (err) return cb(err)
      if (db.version) return run(null)
      db.feed.update(run)
    })

    function run (err) {
      if (err) return cb(err)

      const ite = db.iterator(name)

      var latest = null
      var latestNode = null

      ite.next(function loop (err, node) {
        if (err) return cb(err)
        if (!node) return cb(null, latestNode)
        if (!node.value.sameDependencies) return onnode(node)

        db.getBySeq(node.value.sameDependencies, function (err, n) {
          if (err) return cb(err)
          if (seqs) seqs.add(n.seq)
          node.value = n.value
          onnode(node)
        })

        function onnode (node) {
          if (seqs) seqs.add(node.seq)
          const pkg = parse(node.key)
          const v = pkg.version
          if (semver.satisfies(v, range) && (!latest || semver.gt(v, latest))) {
            latest = v
            latestNode = node
          }

          ite.next(loop)
        }
      })
    }
  }
}

function noop () {}

function parse (key) {
  const parts = key.split('/')
  return parts.length === 3
    ? {name: parts[0] + '/' + parts[1], version: parts[2]}
    : {name: parts[0], version: parts[1]}
}

function inTree (tree, name, version) {
  while (tree) {
    if (tree.name === name && tree.version === version) return true
    const dep = tree.deps.get(name)
    if (dep && dep.version === version) return true
    tree = tree.parent
  }
  return false
}

function depsToArray (deps) {
  if (!deps) return []
  const ks = Object.keys(deps)
  const res = []
  for (var i = 0; i < ks.length; i++) {
    const name = ks[i]
    res.push({name, range: deps[name]})
  }
  return res
}

function toJSON () {
  const deps = {}
  for (const [k, v] of this.deps) deps[k] = toJSON.call(v)

  return {
    name: this.name,
    version: this.version,
    range: this.range,
    deps
  }
}
