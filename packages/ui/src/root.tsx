/**
 * Root mount: draw the page's `root` seat, and stand in when there is none.
 *
 * The shell (not a plugin) owns this fallback: if the plugin that was supposed
 * to occupy `root` failed to load, the page must still say so instead of
 * showing a blank background (docs/m0/spec.md §3.3, acceptance point 2).
 */
import type { ReactNode } from 'react'
import type { MountHandle } from 'diorama-kernel/client'
import { describeError, Slot, useKernel, type KernelContextValue } from './slot.tsx'

/** Everything the page renderer needs; assembled by the shell. */
export interface PageKernel extends KernelContextValue {
  /** Plugins the shell could not boot; listed above the page. */
  failures: readonly { id: string; message: string }[]
}

/** Props the `root` entry receives. */
export function rootProps(mount: MountHandle): { mountCtx: MountHandle } {
  return { mountCtx: mount }
}

/** A full-page failure panel. */
export function FailurePanel({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="diorama-failure" role="alert">
      <h1 className="diorama-failure__title">{title}</h1>
      {children}
    </div>
  )
}

/** Render the page. The shell has installed its page kernel before rendering. */
export function DioramaRoot({ failures = [] }: { failures?: PageKernel['failures'] }) {
  const kernel = useKernel()
  const props = rootProps(kernel.mount)
  return (
    <>
      {failures.length > 0 && (
        <div className="diorama-banner" role="status">
          {failures.map(failure => (
            <div key={failure.id}>
              插件 <code>{failure.id}</code> 未能加载：{failure.message}
            </div>
          ))}
        </div>
      )}
      <Slot
        name="root"
        props={props}
        // Components, not elements: an element literal is a new node every render
        // and remounts whatever it contains (React update-depth loop).
        empty={<NoInterface />}
        exhausted={errors => (
          <FailurePanel title="界面插件加载失败">
            <ul className="diorama-failure__list">
              {errors.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
          </FailurePanel>
        )}
        render={entry => {
          const RootComponent = entry.component as unknown as (entryProps: typeof props) => ReactNode
          return <RootComponent {...props} />
        }}
      />
    </>
  )
}

/** Shown when the `root` seat is empty: the page has no interface at all. */
function NoInterface() {
  return <FailurePanel title="没有可用的界面" />
}

export { describeError }
