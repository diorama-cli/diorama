/**
 * The slice of the effective configuration the **page** reads (contract.md
 * §4.1, §5.1). Lives in the shared layer: the server's `EffectiveConfig` has
 * many more fields (host, port, ignore, …) and none of them mean anything in a
 * browser, so the handle carries only what a piece can act on.
 *
 * The whole config already travels in `/plugin.json` (the server sends
 * `EffectiveConfig`); this type names the part the page is allowed to rely on.
 */
export interface MountConfig {
  /** HTML preview (contract.md §5.1). */
  html: {
    /**
     * Whether the preview runs a page's scripts without asking, per file.
     * Defaults to `false`: an HTML file is not trusted because it was opened.
     */
    scripts: boolean
  }
}
