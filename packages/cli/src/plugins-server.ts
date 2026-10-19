/**
 * Server halves of the M0 static assembly — the one place that names which
 * built-in plugins exist.
 *
 * Why this module, and why it imports *lazy*:
 * - It belongs to the Node program only (`tsconfig.server.json`). The browser
 *   halves are checked in their own package projects; keeping this list here
 *   means the server program never compiles React code.
 * - The imports are lazy so the type-only module declarations of a browser
 *   half do not join the server Program. Only the plugin's own `name` /
 *   `apply` exports are read at runtime.
 *
 * Removing a package from this list is a deliberate change; adding an id that
 * is not in `BUILTIN_PLUGIN_IDS` (or a kernel service id) is a type error.
 */
import type { BuiltinPluginId, KernelServiceId } from 'diorama-kernel/server'

type HalfLoader = () => Promise<unknown>

const halves: Record<BuiltinPluginId | KernelServiceId, HalfLoader> = {
  // Each package's main entry is the Node-facing ESM build; the browser
  // artifact (`./client`) is a closure factory the page loads separately.
  'slots': () => import('diorama-plugin-slots'),
  // The kernel's own fs service: the only plugin with a real server half, and
  // the shape an external server half plugs into (contract.md §2.5, §9).
  'fs': () => import('diorama-kernel/server').then(kernel => kernel.fsHalf),
  // The repository view (contract.md §3.2): provided per mount, only when the
  // directory is inside a git working tree.
  'git': () => import('diorama-kernel/server').then(kernel => kernel.gitHalf),
  'layout': () => import('diorama-plugin-layout'),
  'file-tree': () => import('diorama-plugin-file-tree'),
  'tabs': () => import('diorama-plugin-tabs'),
  'renderer-registry': () => import('diorama-plugin-renderer-registry'),
  'plaintext': () => import('diorama-plugin-plaintext'),
  'markdown': () => import('diorama-plugin-markdown'),
  'code': () => import('diorama-plugin-code'),
  'palette': () => import('diorama-plugin-palette'),
  // The changes view and the diff reader. Not `git`: that id is the kernel's
  // server service (contract.md §3.2); a client piece is its own plugin.
  'git-changes': () => import('diorama-plugin-git'),
}

/** Resolve the server-half module of one plugin id. */
export async function loadServerHalf(id: string): Promise<unknown> {
  const load = (halves as Record<string, HalfLoader | undefined>)[id]
  return load === undefined ? undefined : await load()
}

/** Every id this build carries a server half for. */
export function assembledPluginIds(): string[] {
  return Object.keys(halves)
}
