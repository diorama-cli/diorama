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
  type RevealOptions,
  type RevealTarget,
} from './reveal.ts'
export {
  clampTarget,
  formatLineSpec,
  LINE_NUMBERS_ICON,
  LINE_NUMBER_TOGGLE_COMMAND,
  LINE_NUMBER_TOGGLE_TITLE,
  LINE_NUMBERS_DEFAULT,
  LINE_NUMBERS_STORAGE_KEY,
  lineNumbersShown,
  lineNumbersStore,
  parseLineSpec,
  setLineNumbers,
  splitLineSuffix,
  toggleLineNumbers,
  type LineTarget,
} from './line-numbers.ts'
export {
  closeOverlay,
  hideOverlay,
  overlayOpen,
  overlayPayload,
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
export { KeyHint, useHeldModifier, type KeyHintProps } from './keys.tsx'
export { ContextMenu, type ContextMenuProps, type MenuItem } from './contextmenu.tsx'
export { inRevealed, LineRow, RevealBand } from './lines.tsx'
export { selectionSlices, slicesOfSelection, watchSelection, type SelectionSlice } from './selection.ts'
export {
  highlighter,
  highlighterStore,
  publishHighlighter,
  useHighlighter,
  type Highlighter,
} from './highlight.ts'
export {
  markdownRenderer,
  markdownStore,
  publishMarkdown,
  useMarkdown,
  type MarkdownRenderer,
} from './markdown.ts'
export { hoverBlock, hoverIsEmpty, type HoverBlock } from './hover-card.ts'
export {
  chooseTargets,
  describePlace,
  isSelf,
  type DefinitionChoice,
  type DefinitionPlace,
  type LabelledPlace,
  type PlaceKind,
} from './definition-list.ts'
export { lspNav, lspNavStore, NO_LSP_NAV, publishLspNav, useLspNav, type LspNav } from './lsp-nav.ts'
export { isWordChar, wordTextAt } from './lsp-position.ts'
export {
  caretOf,
  HOVER_DELAY_MS,
  HOVER_GRACE_MS,
  jump,
  positionAt,
  TEXT_ROWS,
  useLspGestures,
  wordAt,
  type GestureOptions,
  type GestureSurface,
  type LspFace,
  type NavLocation,
  type NavTarget,
  type RowGeometry,
  type TabsFace,
  type TextPosition,
} from './lsp-gestures.tsx'
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
