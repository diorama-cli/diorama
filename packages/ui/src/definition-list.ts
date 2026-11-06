/**
 * What ⌘/Ctrl+click on a symbol should do (contract.md §3.12).
 *
 * ## The rule
 *
 * A click must take the reader **somewhere else**. Two answers are merged:
 * where the symbol is **declared** (\`definition\`) and where it is **used**
 * (\`references\`). The place that was clicked is dropped, duplicates are
 * dropped, and what is left decides:
 *
 * - **one** place → go there;
 * - **several** → list them, each labelled *definition* or *usage*;
 * - **none** → do nothing.
 *
 * A definition always wins as the single jump: clicking a usage is a request
 * for "where does this live", and the usages of the same symbol are not what
 * the reader asked for. They stay in the list only when there is no
 * declaration to go to (a click on a declaration, whose own line is dropped).
 *
 * Dropping the clicked place is what makes this work in both directions:
 *
 * | clicked | definition | references | left after dropping self |
 * |---|---|---|---|
 * | a **usage** | the declaration | declaration + all usages | the declaration (and the other overloads) |
 * | a **declaration** | itself | declaration + all usages | **the usages** |
 *
 * Without that step a declaration click answers "you are already here" and
 * highlights itself, which is the complaint that produced this rule.
 *
 * Pure on purpose: `node --test` cannot import a `.tsx` (docs/m4/spec.md §12).
 */

/** One place an answer named (the kernel's `LspLocation`, structurally). */
export interface DefinitionPlace {
  path: string
  /** 1-based line. */
  line: number
  /** 0-based UTF-16 column. */
  character: number
  /** 1-based last line of the range (a whole function, for a declaration). */
  endLine?: number
}

/** Whether a place is where the symbol lives or where it is used. */
export type PlaceKind = 'definition' | 'usage'

/** A place plus how it got here. */
export interface LabelledPlace extends DefinitionPlace {
  kind: PlaceKind
}

/** What a click should do with an answer. */
export type DefinitionChoice =
  | { kind: 'none' }
  | { kind: 'jump'; target: LabelledPlace }
  | { kind: 'choose'; targets: readonly LabelledPlace[] }

/** The key that makes two places "the same place" (path + line). */
function keyOf(place: DefinitionPlace): string {
  return place.path + ':' + place.line
}

/**
 * Merge the two answers and decide.
 *
 * \`self\` is where the reader clicked. A place on that line is the reader's own
 * position and is dropped — including when the server reports a **range** that
 * spans the click (a declaration's body, a whole function), which is why the
 * test is "the range contains the click", not "the range starts there".
 */
export function chooseTargets(
  definitions: readonly DefinitionPlace[],
  references: readonly DefinitionPlace[],
  self: DefinitionPlace,
): DefinitionChoice {
  const seen = new Set<string>()
  const targets: LabelledPlace[] = []

  const add = (place: DefinitionPlace, kind: PlaceKind): void => {
    if (isSelf(place, self)) return
    const key = keyOf(place)
    if (seen.has(key)) return
    seen.add(key)
    targets.push({ ...place, kind })
  }
  // Definitions first: when the same line appears in both answers, the
  // declaration is the more useful label.
  for (const place of definitions) add(place, 'definition')
  for (const place of references) add(place, 'usage')

  if (targets.length === 0) return { kind: 'none' }
  // A declaration is the answer to "where does this live": jump to it even
  // when the server also named the usages. A list is for the case with **no**
  // declaration left — a click on a declaration, where the only places left
  // are the places that use it.
  const definition = targets.find(target => target.kind === 'definition')
  if (definition !== undefined) return { kind: 'jump', target: definition }
  if (targets.length === 1) return { kind: 'jump', target: targets[0] as LabelledPlace }
  return { kind: 'choose', targets }
}

/** Whether \`place\` is where the reader clicked (same file, range covers it). */
export function isSelf(place: DefinitionPlace, self: DefinitionPlace): boolean {
  if (place.path !== self.path) return false
  const end = place.endLine ?? place.line
  // A range that spans the click (a declaration's body) is still "here".
  return self.line >= place.line && self.line <= end
}

/**
 * How a place reads in the list: **just where it is**.
 *
 * No "definition" / "usage" prefix. The list is already the answer to one
 * question — clicking a declaration shows where it is used — so every row is
 * the same kind by construction, and a column of identical words is noise in
 * front of the only thing that differs (the path and the line).
 *
 * @@BT@@kind@@BT@@ stays on the place: the chooser's title and any future surface may need
 * it, and dropping it from the label must not mean dropping it from the data.
 */
export function describePlace(place: LabelledPlace): string {
  return place.path + ':' + place.line
}
