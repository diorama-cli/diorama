#!/usr/bin/env node
/**
 * Assemble the single published package (docs/m8/spec.md §3).
 *
 * The CLI bundle inlines every built-in plugin's *code* (tsdown `alwaysBundle`),
 * but three kinds of files still have to be **carried next to it** at runtime:
 *
 * | carried | read by | why it is not in the bundle |
 * |---|---|---|
 * | `plugins/<id>/package.json` | `builtinPackageJson` → `readManifest` | the kernel reads `id` / `contract` / `client.entry` from a real file at boot, and hashes the client entry |
 * | `plugins/<id>/client.cjs` | `GET /plugins/<id>.js` | the browser loads each half as its own `<script>`; they are closure factories, not modules |
 * | `web/` | `assetsRoot()` | the page shell is a Vite build (`index.html` + `assets/`), served as static files |
 *
 * It also copies the repository `README.md` in, because npm only shows a
 * package's own README — without one the registry page reads "No README data
 * found". Its relative links are rewritten to the repository first: npmjs.com
 * renders the file at a URL where `docs/contract.md` does not exist.
 *
 * Run after `pnpm build` (`pnpm pack:prepare`). It is idempotent: every target
 * directory is replaced, so a removed plugin does not linger.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rewriteReadme, unresolvedLinks } from './readme-for-npm.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = join(repo, 'packages/cli')
const pluginsOut = join(cliDir, 'plugins')
const webOut = join(cliDir, 'web')
const readmeOut = join(cliDir, 'README.md')

/** Read the ids from the kernel's own list, so this cannot drift from the boot graph. */
function builtinPluginIds() {
  const source = readFileSync(join(repo, 'packages/kernel/src/server/plan.ts'), 'utf8')
  const block = /export const BUILTIN_PLUGIN_IDS = \[([\s\S]*?)\] as const/.exec(source)
  if (block === null) throw new Error('plan.ts: could not find BUILTIN_PLUGIN_IDS')
  return [...block[1].matchAll(/'([^']+)'/g)].map(match => match[1])
}

/** Plugin directory name → package directory (they differ: `git-changes` ships `diorama-plugin-git`). */
function pluginDirOf(id) {
  const direct = join(repo, 'packages/plugins', id)
  if (existsSync(join(direct, 'package.json'))) return direct
  throw new Error(`no package for built-in plugin "${id}" (looked in ${direct})`)
}

const ids = builtinPluginIds()
rmSync(pluginsOut, { recursive: true, force: true })
mkdirSync(pluginsOut, { recursive: true })

for (const id of ids) {
  const from = pluginDirOf(id)
  const to = join(pluginsOut, id)
  mkdirSync(to, { recursive: true })
  // The manifest is the contract between the kernel and the piece: keep it
  // verbatim (its `client.entry` is resolved relative to this directory).
  const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'))
  const clientEntry = manifest.diorama?.client?.entry
  if (typeof clientEntry !== 'string') throw new Error(`${id}: manifest declares no client entry`)
  writeFileSync(join(to, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const clientFile = join(from, clientEntry)
  if (!existsSync(clientFile)) throw new Error(`${id}: client entry ${clientEntry} is missing (run "pnpm build")`)
  cpSync(clientFile, join(to, clientEntry))
  process.stdout.write(`  plugins/${id}/${clientEntry}\n`)
  // A half may also ship files *beside* it (a vendored library's stylesheet and
  // fonts, contract.md §5.1). `lib/vendor/` is the only such directory today;
  // the browser asks for it under `/plugins/<id>/vendor/`.
  const vendor = join(from, 'lib/vendor')
  if (existsSync(vendor)) {
    cpSync(vendor, join(to, 'lib/vendor'), { recursive: true })
    process.stdout.write(`  plugins/${id}/lib/vendor/\n`)
  }
}

/**
 * Drop source maps from the carried shell: they are half the unpacked size
 * (~1.5 MB of a 4.6 MB tarball) and only help someone debugging the shell
 * itself, who has the repository.
 */
function dropMaps(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) dropMaps(path)
    else if (entry.name.endsWith('.map')) rmSync(path)
  }
}

// The page shell: `assetsRoot()` looks for `web/index.html` first.
const dist = join(repo, 'apps/web/dist')
if (!existsSync(join(dist, 'index.html'))) throw new Error('apps/web/dist/index.html is missing (run "pnpm build")')
rmSync(webOut, { recursive: true, force: true })
cpSync(dist, webOut, { recursive: true })
dropMaps(webOut)
const assets = readdirSync(join(webOut, 'assets'))
process.stdout.write(`  web/ (index.html + ${assets.length} assets)\n`)

// `README.md` and `LICENSE` are npm's "always included" files, but only from
// the package directory: the repository keeps them at the root, so without
// this the registry page has no README and the tarball no licence.
const cliManifest = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'))
const source = readFileSync(join(repo, 'README.md'), 'utf8')
const published = rewriteReadme(source, {
  repositoryUrl: cliManifest.repository.url,
  branch: process.env.DIORAMA_README_BRANCH ?? 'main',
})
const unresolved = unresolvedLinks(published)
if (unresolved.length > 0) {
  throw new Error(`README.md: relative links survived the rewrite: ${unresolved.join(', ')}`)
}
writeFileSync(readmeOut, published)
cpSync(join(repo, 'LICENSE'), join(cliDir, 'LICENSE'))
process.stdout.write(`  README.md (${source.length} → ${published.length} bytes, links absolute) + LICENSE\n`)

console.log(`assembled ${ids.length} plugin manifests, the page shell, README and LICENSE into packages/cli`)
