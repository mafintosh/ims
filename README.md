# ims

Install My Stuff - an opinionated npm module installer

```
npm install -g ims
```

IMS is a npm module installer that uses an p2p cache hosted on the Dat network to resolve all dependencies as fast as possible.

The cache is stored in a [hypertrie](https://github.com/mafintosh/hypertrie) which makes it fast to update and always get the latest version while minimising the amount of roundtrips, compared to `npm install`.

The module tarballs themself are still downloaded from the npm registry

## Usage

``` sh
# installs hypercore to ./node_modules
ims hypercore
```

For more options do `ims --help`

```
Usage: ims <package-name?> [options]

  --save, -s        saves the dep to package.json
  --save-dev, -S    saves the dev dep to package.json
  --global, -g      installs as a cli tool
  --production, -p  skip dev dependencies

If <package-name> is omitted the deps from package.json is used
```

IMS stores its cache in `~/.ims`.

Note that it uses sparse files for its database format so use `ls -sh` to list the *actual* size of the cache.

## License

MIT
