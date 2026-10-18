/**
 * layout — the split frame.
 *
 * Registers one component into the kernel's `root` seat, declares the two seats
 * it owns (`sidebar.tree`, `layout.main`) and renders them. The left column is
 * drawn only while something occupies `sidebar.tree`; that is how removing the
 * `file-tree` piece leaves exactly the empty right side (M0 acceptance point 3).
 *
 * It deliberately owns no seat state: `Slot` reads seats from the page kernel
 * (the bridge), which is installed before this piece ever renders.
 */
import type { Context } from 'cordis'
import type { MountHandle } from 'diorama-kernel'
import type { ReactElement } from 'react'
import { useSyncExternalStore } from 'react'
import { Slot, useKernel } from 'diorama-ui'

export const name = 'layout'
export const inject = ['slots']

/** Props of the `root` entry. */
export interface LayoutRootProps {
  mountCtx: MountHandle
}

function SeatError({ label, message, testId }: { label: string; message: string; testId: string }) {
  return (
    <div className="diorama-layout__seat-error" role="alert" data-testid={testId}>
      {label}加载失败：{message}
    </div>
  )
}

/** The `sidebar.tree` owner declares (and thereby claims) both of its seats. */
const DECLARE = {
  'sidebar.tree': { kind: 'single' },
  'layout.main': { kind: 'single' },
} as const

function MainColumn() {
  return (
    <main className="diorama-layout__main" data-slot="layout.main">
      <Slot
        name="layout.main"
        empty={null}
        exhausted={errors => <SeatError testId="layout-main-error" label="主区域" message={errors.join('；')} />}
        render={entry => {
          const Main = entry.component as unknown as (props: object) => ReactElement | null
          return <Main />
        }}
      />
    </main>
  )
}

/**
 * The page frame. `useSlots()` answers "does anything occupy `sidebar.tree`?"
 * without rendering it, so the empty state never re-enters the seat it is
 * deciding about (which would loop through React's render pass).
 */
function SplitFrame() {
  const { tree } = useSlots()
  if (tree) {
    return (
      <Slot name="sidebar.tree" render={entry => {
        const Tree = entry.component as unknown as (props: object) => ReactElement | null
        return (
          <div className="diorama-layout diorama-layout--split" data-layout="split">
            <aside className="diorama-layout__sidebar" data-slot="sidebar.tree">
              <Tree />
            </aside>
            <MainColumn />
          </div>
        )
      }} />
    )
  }
  return (
    <div className="diorama-layout" data-layout="main-only">
      <MainColumn />
    </div>
  )
}

/** Seat occupancy (cheap, subscription-backed): used before rendering a seat. */
function useSlots(): { tree: boolean; main: boolean } {
  const { ctx } = useKernel()
  const subscribe = (listener: () => void): (() => void) => ctx.slotRegistry.subscribe(listener)
  const read = (name: 'sidebar.tree' | 'layout.main'): boolean =>
    ctx.slotRegistry.entriesOf(name).length > 0
  const tree = useSyncExternalStore(subscribe, () => read('sidebar.tree'), () => read('sidebar.tree'))
  const main = useSyncExternalStore(subscribe, () => read('layout.main'), () => read('layout.main'))
  return { tree, main }
}

function LayoutRoot(_props: LayoutRootProps) {
  return <SplitFrame />
}

export function apply(ctx: Context) {
  ctx.slots.register({ id: 'layout:root', name: 'root', order: 0, declare: DECLARE }, LayoutRoot)
}
