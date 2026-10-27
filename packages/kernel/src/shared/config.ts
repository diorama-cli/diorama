/**
 * The slice of the effective configuration the **page** reads (contract.md
 * §4.1, §5.1). Lives in the shared layer: the server's `EffectiveConfig` has
 * many more fields (host, port, ignore, …) and none of them mean anything in a
 * browser, so the handle carries only what a piece can act on.
 *
 * The whole config already travels in `/plugin.json` (the server sends
 * `EffectiveConfig`); this type names the part the page is allowed to rely on.
 */

/**
 * The theme a page starts with when nobody has chosen one (`[ui] theme`,
 * contract.md §4.1). Spelled out once so the server's `defaultConfig()`, the
 * page's `DEFAULT_MOUNT_CONFIG` and the shell's pre-paint bootstrap cannot
 * drift apart.
 */
export const DEFAULT_THEME_PREFERENCE = 'system'

/**
 * What a theme preference may look like: `system`, `light`, `dark`, or the id
 * of a theme a piece registers. Same charset as a hash value and a command id
 * (`ctx.theme`, contract.md §3.10) — anything else could not be spelled in the
 * URL, so it is refused when the file is read rather than ignored at paint time.
 */
export const THEME_PREFERENCE_PATTERN = /^[A-Za-z0-9_.-]+$/

export interface MountConfig {
  /** HTML preview (contract.md §5.1). */
  html: {
    /**
     * Whether the preview runs a page's scripts without asking, per file.
     * Defaults to `false`: an HTML file is not trusted because it was opened.
     */
    scripts: boolean
  }
  /** Page preferences (contract.md §4.1, §3.10). */
  ui: {
    /**
     * The theme the page starts with when the reader has chosen nothing:
     * `system`, `light`, `dark`, or a registered theme's id. A choice the
     * reader makes (palette, `mod+alt+t`, a shared `#theme=…` link) always wins
     * over it — the file says where to start, not what to show.
     */
    theme: string
  }
}
