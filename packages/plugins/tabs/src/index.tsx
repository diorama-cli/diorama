/**
 * tabs — the content area (M0: single-tab semantics).
 *
 * Provides `ctx.tabs` (open and switch, never edit — contract.md §3.4) and
 * registers into `layout.main`, declaring the `tabs.content` seat it renders.
 * It does not read files: whatever occupies `tabs.content` draws the active
 * file.
 */
import type { Context } from 'cordis'
import type { ReactElement } from 'react'
import type { TabInfo } from 'diorama-kernel/client'
import { bindMethods, provideEntry, Slot, useKernel, useStore } from 'diorama-ui'
import { createTabsService } from 'diorama-kernel/client'

export const name = 'tabs'
export const inject = ['slots']

/**
 * The content seat. `single` because it already *is* per tab: the component in
 * it dispatches on the tab's file (M2 turns tabs into a real list; the seat
 * stays "the content of the tab being rendered").
 */
const DECLARE = {
  'tabs.content': { kind: 'single' },
} as const

function TabsView() {
  const { ctx } = useKernel()
  const tabs = ctx.tabs
  const snapshot = useStore(tabs)
  const active = snapshot.tabs.find(tab => tab.id === snapshot.activeId)
  if (active === undefined) {
    return (
      <section className="diorama-tabs" data-testid="tabs">
        <div className="diorama-tabs__empty" data-testid="tabs-empty">
          从左侧选择一个文件
        </div>
      </section>
    )
  }
  return (
    <section className="diorama-tabs" data-testid="tabs">
      <div className="diorama-tabs__strip" role="tablist">
        <div
          className="diorama-tabs__tab"
          role="tab"
          aria-selected="true"
          title={active.file.path}
          data-testid="active-tab"
        >
          {active.file.name}
        </div>
      </div>
      <div className="diorama-tabs__content" data-testid="tabs-content">
        <Slot
          name="tabs.content"
          props={{ tab: active }}
          exhausted={errors => <div className="diorama-renderer__error">{errors.join('\n')}</div>}
          render={entry => {
            const Content = entry.component as unknown as (contentProps: { tab: TabInfo }) => ReactElement | null
            return <Content tab={active} />
          }}
        />
      </div>
    </section>
  )
}

export function apply(ctx: Context) {
  // A service face (an object), not a Service subclass: the class would be this
  // half's build, and Cordis' own `hasInstance` check compares class identity.
  // The kernel owns the service classes (`tabs` / `tree`) so every build agrees.
  // Bind: this half runs its own build of the service class, and a consumer in
  // another build may call the methods detached (docs/m0/spec.md §11.3 rule 3).
  ctx.provide('tabs', bindMethods(createTabsService()))
  provideEntry(ctx, { id: 'tabs:content', name: 'layout.main', order: 100, declare: DECLARE }, TabsView)
}
