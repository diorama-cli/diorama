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
import type { FileInfo, FileMatcher, MountHandle, TabInfo } from 'diorama-kernel'

/** How the entries of one slot combine. */
export type SlotKind = 'single' | 'keyed' | 'list'

/** Runtime declaration a parent entry makes for each child slot it renders. */
export interface SlotSpec {
  kind: SlotKind
}

/** A `file.renderer` entry's claim on a file (contract.md §5.1). */
export interface MatchedSlotSpec extends SlotSpec {
  matcher?: FileMatcher
}

/** Props one `sidebar.views` entry receives (contract.md §5.2). */
export interface SidebarViewProps {
  /** Whether this view is the active one (inactive views stay mounted, hidden). */
  active: boolean
}

/**
 * What a `sidebar.views` entry tells the switcher about itself (contract.md
 * §5.2). These are entry fields, not custom properties: the registry rebuilds
 * its public entry objects on every change and keeps only the fields it knows.
 */
export interface SidebarViewMeta {
  /** Label shown in the switcher (tooltip and accessible name). */
  readonly title?: string
  /** Inline SVG markup for the switcher button; absent = the title's first character. */
  readonly icon?: string
}

/** Props one `seats.git-diff` entry receives (contract.md §3.4). */
export interface TabDiffProps {
  /** The tab whose file is shown as a diff. */
  tab: TabInfo
}

/** Props one `file.renderer` entry receives (contract.md §5.1). */
export interface FileRendererProps {
  file: FileInfo
  /** The kernel's pre-read text (absent for binary or oversized files). */
  text?: string
  /** The kernel's pre-read bytes (present when the file is not text). */
  bytes?: Uint8Array
  /** MIME type inferred from the path (contract.md §5.1). */
  mime: string
}

/** Slot names of contract.md §5, typed by their entry props. */
export interface SlotMap {
  /** The whole page. Declared by the kernel itself; exactly one entry. */
  root: { mountCtx: MountHandle }
  /** Right-hand frame, declared by the `layout` piece. */
  'layout.main': Record<string, never>
  /**
   * One view of the left column, keyed by view id (`files`, `changes`, …).
   * `layout` declares the seat and draws the switcher (contract.md §5.2).
   */
  'sidebar.views': SidebarViewProps
  /** Content area below the tab strip, declared by the `tabs` piece. */
  'tabs.content': { tab: TabInfo }
  /** Dispatch seat for file content, declared by `renderer-registry`. */
  'file.renderer': FileRendererProps
  /**
   * A `view: 'diff'` tab's content (contract.md §3.4): declared by `tabs`,
   * filled by the piece that draws diffs. One entry; the content renderers
   * never see diff tabs.
   */
  'seats.git-diff': TabDiffProps
  /** Overlay above the frame, declared by `layout` (palette, command panels). */
  'layout.overlay': Record<string, never>
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
  /** `file.renderer` only: how this entry claims a file (contract.md §5.1). */
  matcher?: FileMatcher
  /** `sidebar.views` only: what the switcher shows (contract.md §5.2). */
  title?: string
  icon?: string
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
  /** `file.renderer` only: how this entry claims a file. Absent = fallback. */
  matcher?: FileMatcher
  /** `sidebar.views` only: label and icon for the switcher (contract.md §5.2). */
  title?: string
  icon?: string
  /**
   * Runtime props check for external entries (contract.md §10). Optional at the
   * type level; the rule is enforced when external plugin sources land.
   */
  props?: unknown
  /** Child slots this entry's component renders and exclusively owns. */
  declare?: Partial<Record<SlotName, SlotSpec>>
}

/** Declaration of the kernel's built-in seats. */
export const BUILTIN_SLOTS: Partial<Record<SlotName, SlotSpec>> = {
  root: { kind: 'single' },
}
