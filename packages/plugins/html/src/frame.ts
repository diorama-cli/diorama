/**
 * Small pure helpers of the `html` renderer (contract.md §5.1): the extensions
 * it claims and the numbers in its header. DOM-free on purpose — `node --test`
 * cannot load `.tsx`, so anything a unit test needs lives here.
 */

/** Extensions this renderer claims. One owner per extension (contract §5.1 rule 2). */
export const HTML_EXTENSIONS = ['html', 'htm'] as const

/** The two ways the `html` renderer shows a file. */
export type HtmlMode = 'preview' | 'source'

/** Size for the header line (the same phrasing the other renderers use). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Lines in a text, counting a trailing newline as ending the last line. */
export function lineCount(text: string): number {
  if (text === '') return 0
  let lines = 1
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') lines++
  return text.endsWith('\n') ? lines - 1 : lines
}
