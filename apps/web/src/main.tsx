/**
 * Page bootstrap (docs/m0/spec.md §10.3).
 *
 *   read /plugin.json → load every client half → boot the Cordis tree → render.
 *
 * Halves are self-contained closure factories that register themselves with the
 * page loader (`window.__ModuleLoader__`, a queue until the shell takes over).
 * The shell renders through its own copy of `diorama-ui`; page state — the
 * handle, the slot views — reaches both sides through the kernel's page bridge
 * (`window.__diorama_page__`), so no module identity is shared by hand.
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import {
  bootClient,
  createMountHandle,
  type BootResult,
  type MountHandle,
  type MountManifest,
} from 'diorama-kernel/client'
import { DioramaRoot, FailurePanel, type MountHealth, type PageKernel } from 'diorama-ui'
import 'diorama-ui/styles.css'

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; page: PageKernel; health: MountHealth }
  | { kind: 'failed'; error: string }

/** The mount's health as `/plugin.json` reports it (contract.md §4.1, §11.1). */
function healthOf(manifest: { state?: string; lastError?: { message?: string } }): MountHealth {
  return manifest.state === 'degraded'
    ? { state: 'degraded', ...(manifest.lastError?.message === undefined ? {} : { message: manifest.lastError.message }) }
    : { state: 'ok' }
}

/** One half's registration, as the page loader collected it. */
interface HalfRegistration {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/**
 * The page's module table (contract.md §8): the only modules a half may
 * `require`. Both React specifiers are here — halves use the JSX runtime *and*
 * React itself (error boundaries need `React.Component`), and the page keeps
 * exactly one copy of each.
 */
const PLATFORM: Record<string, unknown> = {
  'react': React,
  'react/jsx-runtime': ReactJsxRuntime,
}

async function loadHalfScript(id: string, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.onload = () => {
      script.remove()
      resolve()
    }
    script.onerror = () => {
      script.remove()
      reject(new Error(`diorama modules: could not load ${url} for half "${id}"`))
    }
    document.head.appendChild(script)
  })
}

interface PageBoot {
  result: BootResult
  page: PageKernel
  failures: { id: string; message: string }[]
  health: MountHealth
  /** Late health changes (the gateway broadcasts `mount.state`, contract.md §11.1). */
  onHealth(listener: (health: MountHealth) => void): () => void
}

/** Fetch the boot graph, load every half, boot Cordis. */
async function boot(): Promise<PageBoot> {
  const response = await fetch('/plugin.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`GET /plugin.json failed: ${response.status} ${response.statusText}`)
  const manifest = (await response.json()) as Omit<MountManifest, 'baseUrl'>

  // 1. Fetch the halves; each registers its factory with the page loader queue.
  const loadFailures: { id: string; message: string }[] = []
  for (const plugin of manifest.plugins) {
    try {
      await loadHalfScript(plugin.id, plugin.clientUrl)
    } catch (error) {
      loadFailures.push({ id: plugin.id, message: describe(error) })
      console.error(`[diorama] error: ${describe(error)}`)
    }
  }

  // 2. Take over the loader: later halves register straight into this map.
  const registrations = new Map<string, HalfRegistration>()
  const install = (registration: HalfRegistration): void => {
    if (registrations.has(registration.id)) throw new Error(`diorama modules: "${registration.id}" registered twice`)
    registrations.set(registration.id, registration)
  }
  const scope = window as unknown as {
    __ModuleLoader__: { load: (registration: HalfRegistration) => void }
    __diorama_halves__?: HalfRegistration[]
  }
  for (const registration of scope.__diorama_halves__ ?? []) install(registration)
  scope.__ModuleLoader__ = { load: install }

  const halves = new Map<string, Record<string, unknown>>()
  for (const plugin of manifest.plugins) {
    if (loadFailures.some(failure => failure.id === plugin.id)) continue
    const registration = registrations.get(plugin.id)
    if (registration === undefined) {
      loadFailures.push({ id: plugin.id, message: `half "${plugin.id}" never registered` })
      continue
    }
    try {
      halves.set(plugin.id, registration.factory(specifier => {
        const platform = PLATFORM[specifier]
        if (platform === undefined) throw new Error(`diorama modules: "${plugin.id}" requires "${specifier}", which is not a platform module`)
        return platform
      }))
    } catch (error) {
      loadFailures.push({ id: plugin.id, message: describe(error) })
    }
  }

  const { defaultSlotOrder } = (await import('diorama-plugin-slots')) as { defaultSlotOrder: unknown }
  const mountHandle: MountHandle = createMountHandle({ ...manifest, baseUrl: window.location.origin })
  const result = await bootClient({
    manifest: { ...manifest, baseUrl: window.location.origin },
    mount: mountHandle,
    resolve: id => {
      const half = halves.get(id)
      if (half === undefined) throw new Error(`plugin "${id}" has no loaded client half`)
      return half
    },
    // The `slots` piece has registered by now (half order): give its seat table
    // the page's ordering before any other piece registers into a seat.
    onBeforePlugins: (ctx, mount) => {
      void mount
      const page = ctx as unknown as { get(name: string): unknown }
      const registry = page.get('slotRegistry') as { useOrder(order: unknown): void } | undefined
      if (registry === undefined) throw new Error('the boot graph loaded no "slots" piece; cannot render')
      registry.useOrder(defaultSlotOrder)
    },
  })
  const ctx = result.ctx as unknown as { get(name: string): unknown }
  const views = ctx.get('views') as PageKernel['views'] | undefined
  if (views === undefined) throw new Error('the boot graph loaded no "slots" piece; cannot render')
  // The kernel has already installed the page handle at this point; the renderer
  // reads it from the bridge, not from this object.
  const page: PageKernel = { views, ctx: result.ctx, mount: result.mount, failures: [] }
  const health = healthOf(manifest as unknown as { state?: string; lastError?: { message?: string } })
  const listeners = new Set<(health: MountHealth) => void>()
  // The gateway also pushes `mount.state` on a degraded/recovered transition
  // (contract.md §11.1): the banner appears and disappears without a reload.
  mountHandle.rpc.on('mount.state', payload => {
    const status = payload as { state?: string; lastError?: { message?: string } }
    const next = healthOf(status)
    for (const listener of [...listeners]) listener(next)
  })
  return {
    result,
    page,
    failures: [...loadFailures, ...result.failures],
    health,
    onHealth(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function App(): React.ReactElement | null {
  const [phase, setPhase] = React.useState<Phase>({ kind: 'loading' })
  React.useEffect(() => {
    let live = true
    let stopHealth: (() => void) | undefined
    boot().then(
      ({ page, failures, health, onHealth }) => {
        if (!live) return
        setPhase({ kind: 'ready', page: { ...page, failures }, health })
        stopHealth = onHealth(next => {
          if (live) setPhase(current => (current.kind === 'ready' ? { ...current, health: next } : current))
        })
      },
      (error: unknown) => {
        console.error(error)
        if (live) setPhase({ kind: 'failed', error: describe(error) })
      },
    )
    return () => {
      live = false
      stopHealth?.()
    }
  }, [])
  switch (phase.kind) {
    case 'loading':
      return null
    case 'failed':
      return (
        <FailurePanel title="diorama 启动失败">
          <pre className="diorama-failure__list">{phase.error}</pre>
        </FailurePanel>
      )
    case 'ready':
      return <DioramaRoot failures={phase.page.failures} health={phase.health} />
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const container = document.getElementById('root')
if (container === null) throw new Error('diorama shell: #root is missing')
createRoot(container).render(<App />)
