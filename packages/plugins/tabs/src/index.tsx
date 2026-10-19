/**
 * tabs — the tab strip and the per-tab content seats (contract.md §3.4, §5).
 *
 * Provides `ctx.tabs` (open, switch, close — never edit) and registers into
 * `layout.main`, declaring the `tabs.content` seat it renders. Since v0.3 that
 * seat is **keyed by tab id** and gets **one seat per open tab**: hidden tabs
 * stay mounted (hidden with `display: none`, not unmounted), so every tab's
 * scroll position and renderer state are its own.
 *
 * It does not read files: whatever occupies `tabs.content` draws the tab's
 * file.
 */
import type { Context } from 'cordis'
import type { ReactElement } from 'react'
import type {} from 'diorama-plugin-slots'
import { bindMethods, provideEntry, Slot, useKernel, useStore } from 'diorama-ui'
import { createTabsService, type CommandsService, type TabInfo } from 'diorama-kernel/client'

export const name = 'tabs'
export const inject = ['slots']

/**
 * The content seats, one per tab, keyed by tab id (contract.md §5), plus the
 * diff seat: a tab whose `view` is `diff` draws its file there instead of in
 * the content seat, so content renderers never see a diff tab (contract.md §3.4).
 */
const DECLARE = {
  'tabs.content': { kind: 'keyed' },
  'seats.git-diff': { kind: 'single' },
} as const

/** Props of one `tabs.content` entry. */
interface ContentProps {
  tab: TabInfo
}

/** One tab's seat: the diff seat for `view: 'diff'`, else `tabs.content`. */
function TabContent({ tab }: ContentProps) {
  const { registry } = useKernel()
  if (tab.view === 'diff') {
    // The diff seat is optional: without the piece that fills it, say so
    // instead of drawing the file as content (a diff tab shows a diff).
    if (registry?.owned?.('seats.git-diff') !== true) {
      return (
        <div className="diorama-renderer__empty" role="status" data-testid="tab-diff-empty">
          没有 diff 渲染器
        </div>
      )
    }
    return (
      <Slot
        name="seats.git-diff"
        props={{ tab }}
        empty={
          <div className="diorama-renderer__empty" role="status" data-testid="tab-diff-empty">
            没有 diff 渲染器
          </div>
        }
        exhausted={errors => (
          <div className="diorama-renderer__error" role="alert">
            {errors.join('\n')}
          </div>
        )}
        fallback={<div className="diorama-renderer__error">diff 渲染失败</div>}
        render={entry => {
          const Diff = entry.component as unknown as (props: { tab: TabInfo }) => ReactElement | null
          return <Diff tab={tab} />
        }}
      />
    )
  }
  // Only look a seat up when a piece declared it: the registry refuses (and
  // warns about) lookups of undeclared seats (contract.md §3.3), and a page
  // without the `renderer-registry` piece has no entries under this seat.
  if (registry?.owned?.('tabs.content') !== true) {
    return (
      <div className="diorama-renderer__empty" role="status" data-testid="tab-content-empty">
        没有内容插件
      </div>
    )
  }
  return (
    <Slot
      name="tabs.content"
      slotKey={tab.id}
      props={{ tab }}
      empty={
        <div className="diorama-renderer__empty" role="status" data-testid="tab-content-empty">
          没有内容插件
        </div>
      }
      exhausted={errors => (
        <div className="diorama-renderer__error" role="alert">
          {errors.join('\n')}
        </div>
      )}
      fallback={<div className="diorama-renderer__error">内容渲染失败</div>}
      render={entry => {
        const Content = entry.component as unknown as (contentProps: ContentProps) => ReactElement | null
        return <Content tab={tab} />
      }}
    />
  )
}

function TabsView() {
  const { ctx } = useKernel()
  const tabs = ctx.tabs
  const snapshot = useStore(tabs)
  if (snapshot.tabs.length === 0) {
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
        {snapshot.tabs.map(tab => {
          const active = tab.id === snapshot.activeId
          const name = tab.path.slice(tab.path.lastIndexOf('/') + 1)
          return (
            <div
              key={tab.id}
              className={`diorama-tabs__tab${active ? ' diorama-tabs__tab--active' : ''}`}
              role="tab"
              aria-selected={active}
              title={tab.path}
              data-tab-id={tab.id}
              data-testid={active ? 'active-tab' : 'tab'}
            >
              <button
                type="button"
                className="diorama-tabs__label"
                tabIndex={-1}
                onClick={() => tabs.activate(tab.id)}
              >
                {name}
              </button>
              <button
                type="button"
                className="diorama-tabs__close"
                aria-label={`关闭 ${name}`}
                tabIndex={-1}
                data-testid="tab-close"
                onClick={event => {
                  event.stopPropagation()
                  tabs.close(tab.id)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      <div className="diorama-tabs__panes">
        {snapshot.tabs.map(tab => (
          <div
            key={tab.id}
            className="diorama-tabs__content"
            data-testid="tabs-content"
            data-tab-id={tab.id}
            // Hidden tabs stay mounted: each keeps its own scroll and renderer
            // state (contract.md §5).
            style={tab.id === snapshot.activeId ? undefined : { display: 'none' }}
          >
            <TabContent tab={tab} />
          </div>
        ))}
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
  const tabs = bindMethods(createTabsService())
  ctx.provide('tabs', tabs)
  provideEntry(ctx, { id: 'tabs:content', name: 'layout.main', order: 100, declare: DECLARE }, TabsView)

  // Commands own the tab keyboard (contract.md §3.7): the palette lists the
  // same registry, so they are registered here, not at the key listener.
  // `commands` is kernel *client* infrastructure (contract.md §3.7). The same
  // module is also loaded as this piece's server half, where it does not exist,
  // so it is read opportunistically and the server half stops here.
  const commands = clientCommands(ctx)
  if (commands === undefined) return
  commands.contribute({ activeTab: () => (tabs.active === undefined ? undefined : toContextTab(tabs.active)) })
  const many = (): boolean => tabs.count > 1
  const step = (delta: 1 | -1, wrap: boolean): void => {
    if (!wrap) {
      const list = tabs.getSnapshot().tabs
      const index = list.findIndex(tab => tab.id === tabs.getSnapshot().activeId)
      const target = list[index + delta]
      if (target !== undefined) tabs.activate(target.id)
      return
    }
    if (delta === 1) tabs.next()
    else tabs.prev()
  }
  commands.register({
    id: 'tabs.close',
    title: '关闭当前标签页',
    when: () => tabs.count > 0,
    run: () => tabs.close(),
  })
  commands.register({ id: 'tabs.next', title: '下一个标签页', when: many, run: () => step(1, true) })
  commands.register({ id: 'tabs.prev', title: '上一个标签页', when: many, run: () => step(-1, true) })
  commands.register({ id: 'tabs.nextEdge', title: '下一个标签页（到末尾停）', when: many, run: () => step(1, false) })
  commands.register({ id: 'tabs.prevEdge', title: '上一个标签页（到开头停）', when: many, run: () => step(-1, false) })
  commands.bind({ keys: 'mod+alt+w', command: 'tabs.close' })
  commands.bind({ keys: 'mod+alt+arrowright', command: 'tabs.next' })
  commands.bind({ keys: 'mod+alt+arrowleft', command: 'tabs.prev' })
  commands.bind({ keys: 'ctrl+tab', command: 'tabs.nextEdge' })
  commands.bind({ keys: 'ctrl+shift+tab', command: 'tabs.prevEdge' })
}

/** `CommandContext.activeTab` carries the path, the id, and nothing else. */
function toContextTab(tab: TabInfo): { id: string; path: string } {
  return { id: tab.id, path: tab.path }
}

/**
 * `ctx.commands` when this context is a page (client kernel), else `undefined`.
 * One module serves both halves, and Cordis throws on reading a service that is
 * neither provided nor injected — so the server half asks instead of assuming.
 */
function clientCommands(ctx: Context): CommandsService | undefined {
  try {
    return (ctx as unknown as { commands?: CommandsService }).commands
  } catch {
    return undefined
  }
}
