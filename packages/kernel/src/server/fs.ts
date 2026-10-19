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
}

/**
 * Read-only file access rooted at one mounted directory.
 * Instances are created per mount (contract.md §2.5).
 */
export class FsService {
  /** Absolute mount root. Immutable once constructed. */
  readonly root: string

  /** Hidden-name rules: the single enforcement point of `ignore` (contract.md §3.1). */
  readonly ignore: IgnoreRules

  constructor(root: string, options: FsServiceOptions = {}) {
    this.root = resolve(root)
    this.ignore = createIgnore(options.ignore ?? DEFAULT_IGNORE)
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
   * Watch one path for changes (contract.md §3.1). The signature is final;
   * events arrive from M2 (plan.md), so M1 returns the disposer and emits
   * nothing rather than pretending to watch.
   */
  watch(_path: RelPath, _listener: (event: FsWatchEvent) => void): () => void {
    return () => {}
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
        new FsService(info.root, { ignore: info.config?.ignore }),
      )
      return () => {}
    })
  },
}
