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
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactElement } from 'react'
import type {} from 'diorama-plugin-slots'
import { bindMethods, FileIcon, Icon, KeyHint, provideEntry, Slot, useHeldModifier, useKernel, useStore } from 'diorama-ui'
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
  // A commit picked in the history view (contract.md §5, v0.6). What is being
  // shown is a commit, not a tab, so the piece that picks it fills this seat and
  // the right column draws it in place of the tabs while it is picked.
  'seats.git-commit': { kind: 'single' },
} as const

/** Props of one `tabs.content` entry. */
interface ContentProps {
  tab: TabInfo
}

/**
 * The history view's id in `sidebar.views` (contract.md §5.2, v0.6). The
 * `git-changes` piece registers it under that key; this piece only needs to
 * recognise it to know whether the picked commit is still on screen.
 */
const HISTORY_VIEW = 'history'

/**
 * How many tabs can be picked by number (contract.md §3.7, v0.16): ⌘1 … ⌘9
 * switch to the tab at that position — the gesture every editor has, and the
 * one the tab strip advertises while the modifier is held. A tenth tab is
 * reachable by cycling (`⌃Tab` / `⇧⌃Tab`); a two-digit chord is not something
 * a reader's hands do.
 *
 * The chord is `mod+<n>`, **not** `alt+<n>`: v0.15 avoided ⌘1 because the
 * browser also claims it, and that was the wrong trade. An editor's fingers
 * reach for ⌘1; a viewer whose tab keys are Option+digits teaches the wrong
 * reflex. Where the browser takes the key first the page never sees it — the
 * reader still has the click and the cycling keys — but the shortcut is the
 * one they already know (contract.md §3.7「浏览器保留键」).
 */
export const TAB_SLOTS = 9

/** The command that activates the tab at `slot` (1-based). */
export function tabSlotCommand(slot: number): string {
  return `tabs.select:${slot}`
}

/**
 * The page's layout face (the sidebar's chosen view). `layout` publishes it on
 * the page (`globalThis`) because each half is its own build: the store lives
 * in that build, so importing it here would not be the same object. Absent
 * before `layout` applies.
 */
interface LayoutFace {
  viewChoice?: {
    get(): string | undefined
    available(view: string): boolean
    /** Bumped whenever the choice changes (`ViewChoice.getVersion`). */
    getVersion(): number
    /** Notified after every change (`ViewChoice.onChange`). */
    onChange(listener: () => void): () => void
    /** The view the column is showing (`ViewChoice.shown`). */
    shown(): string | undefined
  }
}

function pageViewChoice(): LayoutFace['viewChoice'] {
  try {
    return (globalThis as unknown as { __diorama_layout__?: LayoutFace }).__diorama_layout__?.viewChoice
  } catch {
    return undefined
  }
}

/**
 * Whether the reader is still looking at the picked commit (contract.md §3.8,
 * §5; v0.6). A commit takes the right column without being a tab, so nothing
 * about it changes the URL's path — the two things that end it are:
 *
 * - **a file was opened** after the pick, even the file that is already active
 *   (a reopen changes no tab and no path, so the URL alone would keep the commit
 *   on screen forever). `tabs.openCount` is that signal; the active tab alone is
 *   not enough;
 * - **the sidebar left the history view.** Which view the column shows is page
 *   state `layout` owns, not a tab change, so with no tab open there is nothing
 *   else to observe. A page without `layout` never leaves the view.
 *
 * The pick's own state is recorded during the render that first sees the
 * commit: an effect would run after it, and a check in between would read
 * "nothing picked" and clear the value.
 */
function useCommitHeld(commit: string | undefined, tabs: TabsLike): boolean {
  const id = tabs.activeTab !== undefined ? tabs.activeTab()?.id : tabs.active?.id
  const opens = tabs.openCount ?? 0
  const choice = pageViewChoice()
  const picking = useRef<{ commit: string | undefined; tab: string | undefined; opens: number } | undefined>(undefined)
  if (picking.current === undefined || picking.current.commit !== commit) picking.current = { commit, tab: id, opens }
  // Re-render on every tab change **and** every open ask. `TabsView` renders off
  // `tabs.getSnapshot()`, which an open of the already-active file leaves
  // unchanged; this subscription is what makes that open observable here.
  const tabState = `${id ?? ''}\u0000${opens}`
  useSyncExternalStore(
    useCallback((listener: () => void) => tabs.subscribe?.(listener) ?? (() => {}), [tabs]),
    useCallback(() => tabState, [tabState]),
    useCallback(() => tabState, [tabState]),
  )
  // The sidebar's choice changes without touching the tab set, so it needs its
  // own subscription: "history → files" has to be seen even with no tab open.
  useSyncExternalStore(
    useCallback((listener: () => void) => (choice === undefined ? () => {} : choice.onChange(listener)), [choice]),
    useCallback(() => choice?.getVersion() ?? 0, [choice]),
    useCallback(() => choice?.getVersion() ?? 0, [choice]),
  )
  if (commit === undefined) return false
  // The **chosen** view, not "history is registered": the column falls back to
  // the first view when the chosen one is gone, so a choice naming a missing
  // view is not the history either.
  if (choice !== undefined && choice.shown() !== HISTORY_VIEW) return false
  const held = picking.current
  return held.opens === opens && held.tab === id
}

/** The narrow face of `ctx.tabs` this piece reads (the service itself). */
interface TabsLike {
  activeTab?(): { id: string } | undefined
  active?: { id: string } | undefined
  /** Opens asked for so far (`TabsService.openCount`); absent on an old build. */
  openCount?: number
  subscribe?(listener: () => void): () => void
}

/**
 * The commit the history view has picked, from the URL hash (contract.md §3.8,
 * §5: v0.6). `tabs` does not know what `history` means beyond "a value means
 * the reader is looking at a commit"; the piece that writes it fills the seat.
 * Subscribed, so picking a commit switches the right column and closing the
 * history view (value gone) brings the tabs back.
 *
 * A picked commit lasts while {@link useCommitHeld} holds. Once the reader has
 * left — another file opened, another sidebar view shown — the value goes with
 * it: the hash must say what is on screen, or a refresh would come back to a
 * commit the reader has already left (contract.md §3.8).
 */
function usePickedCommit(tabs: TabsLike): PickedCommit | undefined {
  const { ctx } = useKernel()
  const router = ctx.router as
    | {
        state(key: string): {
          get(): string | undefined
          set(value: string | undefined): void
          onChange(listener: () => void): () => void
        }
      }
    | undefined
  const slot = router?.state('history')
  // The value may name a repository as well as a commit (v0.10):
  // `<repo>:<sha>`, or a bare sha for the mount's own repository — which is
  // every value a v0.6–v0.9 URL holds. This piece does not interpret the
  // parts; it only has to notice that a value is there.
  const value = useSyncExternalStore(
    useCallback((listener: () => void) => slot?.onChange(listener) ?? (() => {}), [slot]),
    useCallback(() => slot?.get(), [slot]),
  )
  const picked = parsePickedCommit(value)
  const held = useCommitHeld(value === undefined || value === '' ? undefined : value, tabs)
  useEffect(() => {
    if (picked !== undefined && !held) slot?.set(undefined)
  }, [picked, held, slot])
  return held ? picked : undefined
}

/** A `#history` value split into repository and commit (v0.10). */
interface PickedCommit {
  /** The repository's mount-relative path (`''` = the mount's own). */
  repo: string
  commit: string
}

/**
 * Decode `#history`. The repository is optional and a repository path never
 * contains `:` (mount paths are POSIX, §3.1), so the first `:` separates the
 * two when there is one.
 */
function parsePickedCommit(value: string | undefined): PickedCommit | undefined {
  if (value === undefined || value === '') return undefined
  const at = value.indexOf(':')
  if (at <= 0) return { repo: '', commit: value }
  return { repo: value.slice(0, at), commit: value.slice(at + 1) }
}

/** The picked commit, drawn in `seats.git-commit` in place of the tabs (v0.6). */
function CommitColumn({ commit, repo }: PickedCommit) {
  const { registry } = useKernel()
  if (registry?.owned?.('seats.git-commit') !== true) return null
  return (
    <section className="diorama-tabs diorama-tabs--commit" data-testid="tabs-commit">
      <Slot
        name="seats.git-commit"
        props={{ commit, repo }}
        empty={null}
        exhausted={errors => (
          <div className="diorama-renderer__error" role="alert">
            {errors.join('\n')}
          </div>
        )}
        fallback={null}
        render={entry => {
          const Commit = entry.component as unknown as (props: { commit: string; repo?: string }) => ReactElement | null
          return <Commit commit={commit} repo={repo} />
        }}
      />
    </section>
  )
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

/** The registry's hint for one command, or `undefined` on a page without it. */
function hintOfCommand(commands: CommandsService | undefined, id: string): string | undefined {
  if (commands === undefined) return undefined
  try {
    return commands.hintFor(id)
  } catch {
    return undefined
  }
}

function TabsView() {
  const { ctx } = useKernel()
  const tabs = ctx.tabs
  const snapshot = useStore(tabs)
  // Shortcut hints (contract.md §3.7, v0.16): while a modifier is held, each
  // tab shows the key that activates it. Both are read here — before any early
  // return, or the hook order would change between renders (docs/m15/spec.md
  // §6 trap 1).
  const commands = ctx.commands as CommandsService | undefined
  const held = useHeldModifier()
  useSyncExternalStore(
    useCallback((listener: () => void) => commands?.subscribe(listener) ?? (() => {}), [commands]),
    useCallback(() => commands?.version ?? 0, [commands]),
    useCallback(() => commands?.version ?? 0, [commands]),
  )
  // A commit being looked at takes the right column; the tabs (and their
  // per-tab state) stay mounted underneath the whole time.
  const commit = usePickedCommit(tabs)
  if (commit !== undefined) return <CommitColumn commit={commit.commit} repo={commit.repo} />
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
        {snapshot.tabs.map((tab, index) => {
          const active = tab.id === snapshot.activeId
          const name = tab.path.slice(tab.path.lastIndexOf('/') + 1)
          // Only the keys a reader needs are shown (contract.md §3.7, v0.16):
          // **the nine tab picks**. Closing, cycling and the rest stay in the
          // shortcut sheet (\`?\`), not on every tab's ✕ — a strip covered in
          // chips stops reading as a strip.
          const slot = index < TAB_SLOTS ? tabSlotCommand(index + 1) : undefined
          const hint = slot === undefined ? undefined : hintOfCommand(commands, slot)
          return (
            <div
              key={tab.id}
              className={`diorama-tabs__tab${active ? ' diorama-tabs__tab--active' : ''}`}
              role="tab"
              aria-selected={active}
              title={tab.path}
              data-tab-id={tab.id}
              data-testid={active ? 'active-tab' : 'tab'}
              // Middle click closes the tab, as every tab strip does. The
              // primary button is left to the label's own click handler.
              onAuxClick={event => {
                if (event.button !== 1) return
                event.preventDefault()
                tabs.close(tab.id)
              }}
              onMouseDown={event => {
                // Stops the middle-click autoscroll puck the browser would
                // otherwise drop on the page before `auxclick` fires.
                if (event.button === 1) event.preventDefault()
              }}
            >
              <button
                type="button"
                className="diorama-tabs__label"
                tabIndex={-1}
                onClick={() => tabs.activate(tab.id)}
              >
                {/* A tab is a file: its icon says which kind, the label which one. */}
                <FileIcon name={name} />
                <span className="diorama-tabs__name">{name}</span>
              </button>
              {/* The chip is a **floating label** over the tab, not a child of
                  its label button: showing it must not widen, shorten or
                  reflow the tab — the strip keeps its geometry while ⌘ is held
                  (contract.md §3.7, v0.16). */}
              <KeyHint label={hint} keys={slot === undefined ? undefined : `mod+${index + 1}`} held={held} />
              <button
                type="button"
                className="diorama-tabs__close"
                aria-label={`关闭 ${name}`}
                tabIndex={-1}
                data-testid="tab-close"
                title={`关闭 ${name}`}
                onClick={event => {
                  event.stopPropagation()
                  tabs.close(tab.id)
                }}
              >
                <Icon name="close" size={14} />
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
  // The tab keys are an **editor's** keys (contract.md §3.7, v0.16): ⌘W closes,
  // ⌘⇧[ / ⌘⇧] step (wrapping), ⌘1…⌘9 pick by position. v0.15 used
  // `mod+alt+*` throughout to stay clear of the browser's own chords; that
  // bought nothing — a reader whose hands know ⌘W does not learn ⌘⌥W — so the
  // familiar chords win even where the browser claims them first (a page cannot
  // prevent ⌘W, ⌘1, ⌘T…; where it eats the key the click and the cycling keys
  // are still there).
  commands.bind({ keys: 'mod+w', command: 'tabs.close' })
  commands.bind({ keys: 'mod+shift+]', command: 'tabs.next' })
  commands.bind({ keys: 'mod+shift+[', command: 'tabs.prev' })
  // ⌃Tab / ⇧⌃Tab stop at the ends: the browser hands these to the page, and
  // "walk to the last tab and stop" is what the key means in an editor.
  commands.bind({ keys: 'ctrl+tab', command: 'tabs.nextEdge' })
  commands.bind({ keys: 'ctrl+shift+tab', command: 'tabs.prevEdge' })

  // ⌘1 … ⌘9 jump to the tab at that position. A slot with no tab behind it is
  // simply not executable, so ⌘5 on three open tabs is a dead key rather than a
  // surprise.
  for (let slot = 1; slot <= TAB_SLOTS; slot++) {
    const position = slot
    commands.register({
      id: tabSlotCommand(position),
      title: `第 ${position} 个标签页`,
      when: () => tabs.count >= position,
      run: () => {
        const target = tabs.getSnapshot().tabs[position - 1]
        if (target !== undefined) tabs.activate(target.id)
      },
    })
    commands.bind({ keys: `mod+${position}`, command: tabSlotCommand(position) })
  }
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
