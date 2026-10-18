/**
 * Slot names and entry props (contract.md §5, docs/m0/spec.md §1).
 *
 * A slot's *declaration* (kind, render authority) belongs to the entry that
 * occupies its parent seat — see `SlotRegistry.register`. Internal plugins
 * merge into `SlotMap` to get compile-time typing (architecture.md §5).
 *
 * Props rules:
 * - the `root` entry receives `mountCtx`, the page's capability handle;
 * - a child slot's entry receives only its own data, because the entry that
 *   renders the seat already holds `mountCtx`.
 */
import type { ComponentType } from 'react'
import type { FileInfo, MountHandle, TabInfo } from 'diorama-kernel'

/** How the entries of one slot combine. */
export type SlotKind = 'single' | 'keyed' | 'list'

/** Runtime declaration a parent entry makes for each child slot it renders. */
export interface SlotSpec {
  kind: SlotKind
}

/** Slot names of contract.md §5, typed by their entry props. */
export interface SlotMap {
  /** The whole page. Declared by the kernel itself; exactly one entry. */
  root: { mountCtx: MountHandle }
  /** Right-hand frame, declared by the `layout` piece. */
  'layout.main': Record<string, never>
  /** Left navigation column, declared by the `layout` piece. */
  'sidebar.tree': Record<string, never>
  /** Content area below the tab strip, declared by the `tabs` piece. */
  'tabs.content': { tab: TabInfo }
  /** Dispatch seat for file content, declared by `renderer-registry`. */
  'file.renderer': { file: FileInfo; content: Uint8Array; mountCtx: MountHandle }
}

export type SlotName = keyof SlotMap

/** What a registered entry component may render. */
export type SlotComponent<K extends SlotName = SlotName> = ComponentType<SlotMap[K]>

/** A registered entry, as the registry exposes it. */
export interface SlotEntry<K extends SlotName = SlotName> {
  /** Globally unique registration id, conventionally `<plugin-id>:<key>`. */
  id: string
  name: K
  /** Keyed slots only. */
  key?: string
  /** Ascending; ties break on `id`. Default `100`. */
  order: number
  component: SlotComponent<K>
}

/** Registration input for `ctx.slots.register`. */
export interface SlotRegistration<K extends SlotName = SlotName> {
  /** Globally unique across all slots and plugins. */
  id: string
  name: K
  /** Keyed slots only. */
  key?: string
  /** Ascending; ties break on `id` (localeCompare). Default `100`. */
  order?: number
  /** Child slots this entry's component renders and exclusively owns. */
  declare?: Partial<Record<SlotName, SlotSpec>>
}

/** Declaration of the kernel's built-in seats. */
export const BUILTIN_SLOTS: Partial<Record<SlotName, SlotSpec>> = {
  root: { kind: 'single' },
}
