/**
 * `ctx.fs` server half: the only path by which a plugin reaches disk
 * (architecture.md §8, contract.md §3.1). Read-only by construction — there
 * is no write method to call.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fsError } from '../shared/errors.ts'
import type { FileInfo, RelPath } from '../shared/types.ts'

declare module 'cordis' {
  interface Context {
    /** Read-only view of the mounted directory. Present on mount contexts only. */
    fs: FsService
  }
}

/** Files up to this size are decoded as UTF-8 by `readText`. */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024

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

/**
 * Read-only file access rooted at one mounted directory.
 * Instances are created per mount in the mount's fork context (contract.md §2.5).
 */
export class FsService {
  /** Absolute mount root. Immutable once constructed. */
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  /** List one directory, one level deep, unsorted. `path` defaults to the root. */
  async list(path: RelPath = ''): Promise<FileInfo[]> {
    const abs = resolveInside(this.root, path)
    let info
    try {
      info = await stat(abs)
    } catch (error) {
      mapNodeError(error)
    }
    if (!info.isDirectory()) throw fsError('ENOTDIR')
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
          return {
            path: childPath(path, dirent.name),
            name: dirent.name,
            kind,
            size: kind === 'file' ? childInfo.size : 0,
            mtime: childInfo.mtimeMs,
          }
        } catch {
          return undefined // vanished between readdir and stat
        }
      }),
    )
    return entries.filter((entry): entry is FileInfo => entry !== undefined)
  }

  /** Read raw bytes of one file. */
  async readBytes(path: RelPath): Promise<Uint8Array> {
    const abs = resolveInside(this.root, path)
    try {
      const info = await stat(abs)
      if (info.isDirectory()) throw fsError('EISDIR')
      if (info.size > MAX_TEXT_BYTES) throw fsError('EIO', `file is larger than ${MAX_TEXT_BYTES} bytes`)
      return await readFile(abs)
    } catch (error) {
      if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code in {
        EISDIR: 1, ENOENT: 1, ENOTDIR: 1,
      }) throw error
      mapNodeError(error)
    }
  }

  /**
   * Read one file as UTF-8 text. Contents containing a NUL byte are refused as
   * binary (decided 2026-10-18: show "binary file" instead of mojibake).
   */
  async readText(path: RelPath): Promise<string> {
    const bytes = await this.readBytes(path)
    if (bytes.includes(0)) throw fsError('EBINARY')
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

export type { FileInfo } from '../shared/types.ts'
