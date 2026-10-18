/**
 * A tiny semver *range* evaluator for contract version checks (contract.md §6).
 *
 * Supported: exact (`0.2.0`, `0.2`), comparators (`>=`, `>`, `<=`, `<`, `=`),
 * caret (`^0.2.1`), tilde (`~0.2.1`), whitespace-separated AND (`,` too), and a
 * leading `v`. OR (`||`) and hyphen ranges are NOT supported: a range that does
 * not parse is an error, which the loader reports instead of guessing.
 *
 * `0.x` uses the same rules as everywhere: `^0.2.1` means `>=0.2.1 <0.3.0`.
 */

interface Version {
  major: number
  minor: number
  patch: number
}

interface Comparator {
  /** What the author wrote, for messages. */
  text: string
  test(version: Version): boolean
}

const VERSION = /^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? '0'),
    patch: Number(match[3] ?? '0'),
  }
}

function compare(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

function at(major: number, minor: number, patch: number): Version {
  return { major, minor, patch }
}

function range(low: Version, high: Version): (version: Version) => boolean {
  return version => compare(version, low) >= 0 && compare(version, high) < 0
}

function comparator(token: string): Comparator | undefined {
  const operator = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token)
  if (operator === null) return undefined
  const symbol = operator[1] ?? ''
  const version = parseVersion(operator[2] ?? '')
  if (version === undefined) return undefined
  const { major, minor, patch } = version
  let test: (version: Version) => boolean
  switch (symbol) {
    case '>=':
      test = value => compare(value, version) >= 0
      break
    case '>':
      test = value => compare(value, version) > 0
      break
    case '<=':
      test = value => compare(value, version) <= 0
      break
    case '<':
      test = value => compare(value, version) < 0
      break
    case '^': {
      // Next breaking version: the leftmost non-zero component.
      const upper = major > 0 ? at(major + 1, 0, 0) : minor > 0 ? at(0, minor + 1, 0) : at(0, 0, patch + 1)
      const allow = range(at(major, minor, patch), upper)
      test = value => allow(value)
      break
    }
    case '~':
    default: {
      if (symbol === '~') {
        const upper = at(major, minor + 1, 0)
        const allow = range(at(major, minor, patch), upper)
        test = value => allow(value)
      } else if (operator[2]?.includes('.') === true) {
        test = value => compare(value, version) === 0
      } else {
        // `0` or `0.2` written bare means exactly that version.
        test = value => compare(value, version) === 0
      }
    }
  }
  return { text: token, test }
}

/** Parse a range into its comparators; `undefined` when the range is invalid. */
export function parseRange(rangeText: string): Comparator[] | undefined {
  const trimmed = rangeText.trim()
  if (trimmed === '') return undefined
  if (trimmed.includes('||') || /\s-\s/.test(trimmed)) return undefined
  const tokens = trimmed.replace(/,/g, ' ').split(/\s+/).filter(token => token !== '')
  const comparators: Comparator[] = []
  for (const token of tokens) {
    const parsed = comparator(token)
    if (parsed === undefined) return undefined
    comparators.push(parsed)
  }
  return comparators
}

/** Whether `version` (e.g. the kernel's `0.2`) satisfies `rangeText`. */
export function satisfies(version: string, rangeText: string): boolean {
  const parsedVersion = parseVersion(version)
  const comparators = parseRange(rangeText)
  if (parsedVersion === undefined || comparators === undefined) return false
  return comparators.every(item => item.test(parsedVersion))
}

/** Why a range does not accept a version (for fail-loud messages). */
export function explainMismatch(version: string, rangeText: string): string {
  const comparators = parseRange(rangeText)
  if (comparators === undefined) return `"${rangeText}" is not a valid version range`
  if (parseVersion(version) === undefined) return `kernel version "${version}" is not a valid version`
  return `requires contract ${rangeText}, but the kernel provides ${version}`
}
