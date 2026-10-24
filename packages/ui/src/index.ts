export {
  bindMethods,
  describeError,
  EntryBoundary,
  isPageBooted,
  kernelVersion,
  provideEntry,
  Slot,
  SlotEntryView,
  subscribeKernel,
  useKernel,
  useKeyedSeat,
  useSeat,
  useStore,
  type KernelContextValue,
  type SlotPropsSeat,
  type Store,
} from './slot.tsx'
export { DioramaRoot, FailurePanel, rootProps, type MountHealth, type PageKernel } from './root.tsx'
export {
  clearReveal,
  reveal,
  revealStore,
  useReveal,
  useRevealLine,
  type RevealedLine,
  type RevealTarget,
} from './reveal.ts'
export {
  closeOverlay,
  hideOverlay,
  overlayOpen,
  overlayStore,
  showOverlay,
  toggleOverlay,
} from './overlay.ts'
export {
  clampPane,
  MAX_PANE_PX,
  MIN_PANE_PX,
  PANE_STEP_PX,
  readPaneSize,
  storePaneSize,
  usePaneSize,
} from './splitpane.ts'
export { Splitter, type SplitterProps } from './splitter.tsx'
export {
  highlighter,
  highlighterStore,
  publishHighlighter,
  useHighlighter,
  type Highlighter,
} from './highlight.ts'
export {
  baseName,
  fileGlyph,
  FALLBACK_FILE,
  FALLBACK_FOLDER,
  glyphNameForFile,
  glyphNameForFolder,
  iconSvg,
  iconTable,
  publishIcons,
  type ButtonGlyph,
  type FileGlyph,
  type IconTable,
} from './icons/page.ts'
export { FileIcon, Icon, type FileIconProps, type IconProps } from './icons/Icon.tsx'
