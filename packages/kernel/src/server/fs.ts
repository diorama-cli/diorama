/**
 * `ctx.fs` server half: the only path by which a plugin reaches disk
 * (architecture.md §8, contract.md §3.1). Read-only by construction — there is
 * no write method to call.
 *
 * This is a *service plugin* (contract.md §2.5): `apply` runs once on the root
 * context and registers `FsService` per mount through `ctx.diorama.mounts`, so
 * an external server half would plug in the same way. `describe()` lists the
 * methods the RPC channel may proxy (contract.md §4).
 */
import { watch as watchPath, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fsError } from '../shared/errors.ts'
import { createIgnore, DEFAULT_IGNORE, type IgnoreRules } from '../shared/ignore.ts'
import type { MethodDescriptor } from '../shared/rpc.ts'
import type { FileInfo, FsWatchEvent, RelPath } from '../shared/types.ts'
import type { Mounts } from './plugins.ts'

declare module 'cordis' {
  interface Context {
    /** Read-only view of the mounted directory. Present on mount contexts only. */
    fs: FsService
  }
}

/** Files up to this size are decoded as UTF-8 by `readText` (contract.md §3.1). */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024

/** Files up to this size may be fetched as bytes by `readBytes` (contract.md §3.1). */
export const MAX_BINARY_BYTES = 32 * 1024 * 1024

/**
 * Normalise a plugin-supplied relative path and prove it stays inside the
 * mount root. Absolute paths, `..` escapes and NUL bytes are rejected.
 */
export function resolveInside(root: string, path: RelPath): string {
  if (typeof path !== 'string' || path.includes('\0')) throw fsError('EINVAL')
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw fsError('EINVAL')
  const base = resolve(root)
  const target = resolve(base, path)
  if (target !== base && !target.startsWith(base + sep)) throw fsError('EOUTSIDE')
  return target
}

/** Map a Node fs error to one of the kernel's codes. */
function mapNodeError(error: unknown): never {
  const code = (error as { code?: string } | null)?.code
  switch (code) {
    case 'ENOENT': throw fsError('ENOENT')
    case 'ENOTDIR': throw fsError('ENOTDIR')
    case 'EISDIR': throw fsError('EISDIR')
    case 'EACCES':
    case 'EPERM': throw fsError('EOUTSIDE', 'permission denied')
    default: throw fsError('EIO', undefined, error)
  }
}

/** Join a parent's relative path with a child name, `/`-style. */
function childPath(parent: RelPath, name: string): RelPath {
  return parent === '' ? name : `${parent}/${name}`
}

/** Build the kernel's `FileInfo` from a stat result. */
function toFileInfo(path: RelPath, name: string, kind: FileInfo['kind'], size: number, mtime: number): FileInfo {
  return { path, name, kind, size: kind === 'file' ? size : 0, mtime }
}

const METHODS: MethodDescriptor[] = [
  { name: 'list', arity: 1 },
  { name: 'stat', arity: 1 },
  { name: 'readText', arity: 1 },
  { name: 'readBytes', arity: 1 },
]

/** Per-mount behaviour the kernel hands `FsService` (contract.md §4.1). */
export interface FsServiceOptions {
  /** Ignore patterns hidden from `list`; defaults to `.git` + `node_modules`. */
  ignore?: readonly string[]
  /** Watch debounce window in ms (contract.md §3.1: 300). */
  debounceMs?: number
  /** `false`: `watch` is a no-op (diorama.toml `watch.enabled`). */
  enabled?: boolean
}

/** The contract's default watch window. */
export const DEFAULT_DEBOUNCE_MS = 300

/**
 * Read-only file access rooted at one mounted directory.
 * Instances are created per mount (contract.md §2.5).
 */
export class FsService {
  /** Absolute mount root. Immutable once constructed. */
  readonly root: string

  /** Hidden-name rules: the single enforcement point of `ignore` (contract.md §3.1). */
  readonly ignore: IgnoreRules

  /** Debounce window for `watch` (contract.md §3.1). */
  readonly debounceMs: number
  /** `false` makes `watch` return a no-op disposer (diorama.toml `watch.enabled`). */
  readonly watchEnabled: boolean

  constructor(root: string, options: FsServiceOptions = {}) {
    this.root = resolve(root)
    this.ignore = createIgnore(options.ignore ?? DEFAULT_IGNORE)
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.watchEnabled = options.enabled ?? true
  }

  /** The methods the RPC channel may proxy (contract.md §4). */
  describe(): MethodDescriptor[] {
    return METHODS
  }

  /** List one directory, one level deep, unsorted. `path` defaults to the root. */
  async list(path: RelPath = ''): Promise<FileInfo[]> {
    const abs = resolveInside(this.root, path)
    let dirents
    try {
      dirents = await readdir(abs, { withFileTypes: true })
    } catch (error) {
      mapNodeError(error)
    }
    const entries = await Promise.all(
      dirents.map(async (dirent): Promise<FileInfo | undefined> => {
        try {
          const childAbs = join(abs, dirent.name)
          const childInfo = await stat(childAbs)
          const kind = childInfo.isDirectory() ? 'dir' : childInfo.isFile() ? 'file' : undefined
          if (kind === undefined) return undefined // sockets, fifos, devices: not browsable
          const child = childPath(path, dirent.name)
          // Hidden entries are absent from `list` — files as well as directories
          // (and `stat` still reaches them by path, contract.md §3.1).
          if (this.ignore.matches(child, kind)) return undefined
          return toFileInfo(child, dirent.name, kind, childInfo.size, childInfo.mtimeMs)
        } catch {
          return undefined // vanished between readdir and stat
        }
      }),
    )
    return entries.filter((entry): entry is FileInfo => entry !== undefined)
  }

  /** One path's info; same shape as a `list` element (contract.md §3.1). */
  async stat(path: RelPath): Promise<FileInfo> {
    const abs = resolveInside(this.root, path)
    const info = await this.statsOf(abs)
    const name = path === '' ? '' : path.slice(path.lastIndexOf('/') + 1)
    return toFileInfo(path, name, info.isDirectory() ? 'dir' : 'file', info.size, info.mtimeMs)
  }

  /**
   * Read raw bytes of one file. Larger than `MAX_BINARY_BYTES` → `ETOOLARGE`
   * (the size is checked before reading).
   */
  async readBytes(path: RelPath): Promise<Uint8Array> {
    const abs = resolveInside(this.root, path)
    const info = await this.statsOf(abs)
    if (info.isDirectory()) throw fsError('EISDIR')
    if (info.size > MAX_BINARY_BYTES) {
      throw fsError('ETOOLARGE', `${info.size} bytes exceeds the ${MAX_BINARY_BYTES} byte limit`)
    }
    try {
      return await readFile(abs)
    } catch (error) {
      mapNodeError(error)
    }
  }

  /**
   * Read one file as UTF-8 text. Contents containing a NUL byte are refused as
   * binary (decided 2026-10-18: show "binary file" instead of mojibake), and a
   * file above `MAX_TEXT_BYTES` is `ETOOLARGE`.
   */
  async readText(path: RelPath): Promise<string> {
    const abs = resolveInside(this.root, path)
    const info = await this.statsOf(abs)
    if (info.isDirectory()) throw fsError('EISDIR')
    if (info.size > MAX_TEXT_BYTES) {
      throw fsError('ETOOLARGE', `${info.size} bytes exceeds the ${MAX_TEXT_BYTES} byte limit`)
    }
    let bytes: Uint8Array
    try {
      bytes = await readFile(abs)
    } catch (error) {
      mapNodeError(error)
    }
    if (bytes.includes(0)) throw fsError('EBINARY')
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }

  /**
   * Watch one **directory** (contract.md §3.1): its own entries, one level.
   * Events are merged per `(path, type)` in a window of `debounceMs` (the fs
   * service's option), so an editor's save burst is one `change`. `type` is a
   * hint — a rename can make it ambiguous; readers re-`stat` to decide.
   *
   * Returns the disposer; nothing is watched after it runs.
   */
  watch(path: RelPath, listener: (event: FsWatchEvent) => void): () => void {
    // Validate before touching the OS: a bad path must fail like `list` does.
    const abs = resolveInside(this.root, path)
    if (this.watchEnabled === false) return () => {}
    // One pending event per path: a burst of writes (which may alternate
    // `change` and the rename that follows a save) must collapse to one.
    const pending = new Map<string, FsWatchEvent>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    let closed = false
    let watcher: FSWatcher
    try {
      watcher = watchPath(abs, { persistent: false })
    } catch (error) {
      mapNodeError(error)
    }
    /** One pending event per path, flushed `debounceMs` after the last one. */
    const enqueue = (event: FsWatchEvent): void => {
      if (closed) return
      const key = event.path
      pending.set(key, event)
      const timer = timers.get(key)
      if (timer !== undefined) clearTimeout(timer)
      const handle = setTimeout(() => flush(key), this.debounceMs)
      handle.unref?.()
      timers.set(key, handle)
    }
    const flush = (key: string): void => {
      timers.delete(key)
      const event = pending.get(key)
      if (event === undefined) return
      pending.delete(key)
      if (closed) return
      try {
        listener(event)
      } catch (error) {
        // A listener must not be able to stop the watcher.
        console.error(`[diorama] fs.watch listener failed for ${event.path}:`, error)
      }
    }
    watcher.on('change', (kind, name) => {
      if (name === null || name === undefined) return
      const base = abs.split(/[\\/]/).pop() ?? ''
      // Some platforms report the watched directory itself; it is not an entry.
      if (String(name) === base) return
      const child = path === '' ? String(name) : `${path}/${String(name)}`
      if (this.ignore.matches(child, '')) return
      const next: FsWatchEvent = { type: this.classify(kind), path: child }
      void this.refine(child, next).then(event => event !== undefined && enqueue(event))
    })
    watcher.on('error', error => {
      console.error(`[diorama] fs.watch failed for ${path || '/'}:`, error)
      close()
    })
    void flush
    const close = (): void => {
      if (closed) return
      closed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      pending.clear()
      watcher.close()
    }
    return close
  }

  /** A raw watcher kind, before the existence check narrows it. */
  private classify(kind: string): FsWatchEvent['type'] {
    if (kind === 'change') return 'change'
    // `rename` covers create, delete *and* spurious reports of existing
    // entries (macOS reports the parent on some writes). `refine` decides.
    return 'add'
  }

  /**
   * Narrow a watcher hint to the contract's kind (contract.md §3.1): a
   * `rename` on a path that exists is an `add`/`change`, one that does not is
   * an `unlink`. A `change` on a path that is gone is an `unlink` too.
   */
  private async refine(path: RelPath, event: FsWatchEvent): Promise<FsWatchEvent | undefined> {
    try {
      const info = await stat(resolveInside(this.root, path))
      if (info.isDirectory()) return undefined
      return event.type === 'add' ? { type: 'change', path } : event
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return { type: 'unlink', path }
      return undefined
    }
  }

  private async statsOf(abs: string) {
    try {
      return await stat(abs)
    } catch (error) {
      mapNodeError(error)
    }
  }
}

/** The `fs` server half as a Cordis plugin object. */
export const fsHalf = {
  name: 'fs',
  inject: ['diorama'],
  /**
   * Runs once on the root context; every mount gets its own `FsService`
   * (contract.md §2.5). This is the shape an external server half plugs into.
   */
  apply(ctx: { diorama: { mounts: Mounts } }) {
    // The registry the kernel publishes — never a module-local copy: this half
    // is bundled into the CLI separately from the kernel's own code, and a
    // second `createMounts()` would register on a mount nobody fires.
    ctx.diorama.mounts.onMount((mountCtx, info) => {
      ;(mountCtx as unknown as { provide(name: string, value: unknown): unknown }).provide(
        'fs',
        new FsService(info.root, {
          ignore: info.config?.ignore,
          debounceMs: info.config?.watch.debounceMs,
          enabled: info.config?.watch.enabled,
        }),
      )
      return () => {}
    })
  },
}
