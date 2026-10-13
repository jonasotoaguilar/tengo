/// <reference types="node" />
/**
 * i18n audit guard (M5 hardening; ROADMAP.md section 7 requires no hardcoded
 * UI text with en/es parity in `src/i18n/resources.ts`).
 *
 * What this guard does:
 * 1. Scans the listed production surfaces line by line and fails with
 *    `path:line` for every user-visible string that is a bare literal
 *    instead of a `t(...)` call. Covered string classes:
 *    - single-line JSX text nodes that are plain string literals
 *      (`<Text ...>Copy</Text>`, detected as `>Copy</`), plus
 *      pretty-printed copy on its own line between a `>` line and a `<`
 *      line (word characters and sentence punctuation only, so code lines
 *      containing `= ; ( ) { } :` never match);
 *    - `placeholder=`, `accessibilityLabel=`, `accessibilityHint=`, and
 *      `title=`/`label=` props whose value is a quoted literal (either
 *      `prop="copy"` or `prop={'copy'}`). Expression values such as
 *      `prop={t('key')}`, `prop={rowLabel}`, or `prop={location.name}`
 *      (verbatim data or already-translated copy) are allowed.
 * 2. Asserts the en/es parity observable at runtime: the Spanish key set
 *    equals the English key set in both directions, and no key in either
 *    language maps to an empty or whitespace-only string.
 *
 * What this guard deliberately does NOT do (kept narrow on purpose):
 * - It is a line scanner, not a general JSX parser: it cannot see string
 *   concatenation across lines, template literals, or copy built
 *   programmatically (e.g. `String(...)` helpers). It only covers the
 *   listed files, so it proves nothing about hardcoded copy elsewhere.
 * - Comments (`//` and block comments) and `import` lines are skipped, so
 *   copy mentioned only in prose comments is not flagged.
 * - DEV-only fixture files under `src/dev/**` are explicitly out of scope
 *   (none of the listed surfaces lives there; the filter below documents
 *   the exclusion if the list ever grows).
 *
 * Fail-closed: a listed source file that is missing or cannot be read
 * fails the test naming that file instead of silently passing.
 *
 * Documented, non-translatable exceptions: the glyph constants in
 * `src/components/ItemForm.tsx` — `DECREMENT_GLYPH` (`−`),
 * `INCREMENT_GLYPH` (`+`), and `REMOVE_GLYPH` (`✕`) — render fixed symbols
 * whose accessible names come from i18n (`itemFormDecrement`,
 * `itemFormIncrement`, `itemFormRemoveCategory`), so the glyphs themselves
 * must never be added to the translation resources. The scanner allows
 * exactly these three glyphs as literal values and literal JSX text.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { en, es } from '../src/i18n/resources';

/** Production surfaces this guard scans, relative to the repo root. */
const PRODUCTION_SURFACES = [
  'src/components/InventoryList.tsx',
  'src/components/EntityManager.tsx',
  'src/components/ItemForm.tsx',
  'src/screens/ItemFormScreen.tsx',
  'src/screens/InventoryContainer.tsx',
  'src/screens/useItemFormController.ts',
] as const;

/**
 * Documented non-translatable exceptions (see header): the stepper and
 * draft-remove glyphs in `src/components/ItemForm.tsx`, which carry i18n
 * accessible names and must never enter the translation resources.
 */
const NON_TRANSLATABLE_GLYPHS = new Set(['−', '+', '✕']);

/**
 * User-visible copy props that must go through `t(...)`. `testID`,
 * `accessibilityRole`, `returnKeyType`, `keyboardType`, colors, and other
 * configuration tokens are intentionally absent: they are not user-visible
 * copy. The trailing `=` in the pattern keeps `placeholderTextColor=` and
 * `aria-labelledby=` out of the match. `hint=` is the `TextAction`
 * shorthand that flows into `accessibilityHint`, so it is covered too.
 */
const LITERAL_COPY_PROP =
  /(?:^|[\s{(,])(placeholder|accessibilityLabel|accessibilityHint|title|label|hint)\s*=\s*("[^"\n]*"|'[^'\n]*'|\{\s*"[^"\n]*"\s*\}|\{\s*'[^'\n]*'\s*\})/;

/** Single-line JSX text node: `>Copy</` with no expression braces inside. */
const JSX_TEXT_NODE = />((?:[^<>{}\n])*?)<\//g;

/**
 * Pretty-printed copy on its own line: only word characters and sentence
 * punctuation, so code lines (which contain `= ; ( ) { } :` and friends)
 * can never match. Applied only between a line ending in `>` and a line
 * starting with `<`.
 */
const STANDALONE_COPY_LINE = /^[\p{L}\p{N}\s.,!?…'"“”‘’—–\-−+✕]+$/u;
const HAS_WORD_CHARACTER = /[\p{L}\p{N}]/u;

function stripBlockCommentsPreservingLines(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    const newlines = match.match(/\n/g);
    return newlines ? newlines.join('') : '';
  });
}

/** Strip a trailing `//` comment, ignoring `//` inside string literals. */
function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote !== null) {
      if (char === '\\') {
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

function unwrapLiteral(raw: string): string {
  const trimmed = raw.trim();
  const inner = trimmed.startsWith('{') ? trimmed.slice(1, -1).trim() : trimmed;
  const first = inner[0];
  const last = inner[inner.length - 1];
  if (
    inner.length >= 2 &&
    ((first === '"' && last === '"') || (first === "'" && last === "'"))
  ) {
    return inner.slice(1, -1);
  }
  return inner;
}

function scanSurface(
  relativePath: string,
  source: string,
  violations: string[],
): void {
  const withoutBlocks = stripBlockCommentsPreservingLines(source);
  const lines = withoutBlocks.split('\n');
  const codeLines = lines.map((line) => {
    const stripped = stripLineComment(line);
    return stripped.trimStart().startsWith('import ') ? '' : stripped;
  });

  lines.forEach((_original, index) => {
    const lineNumber = index + 1;
    const code = codeLines[index];
    if (code.trim() === '') return;

    const propMatch = LITERAL_COPY_PROP.exec(code);
    if (propMatch) {
      const copy = unwrapLiteral(propMatch[2]).trim();
      if (copy !== '' && !NON_TRANSLATABLE_GLYPHS.has(copy)) {
        violations.push(
          `${relativePath}:${lineNumber}: bare literal ${propMatch[1]}= without t()`,
        );
      }
      return;
    }

    JSX_TEXT_NODE.lastIndex = 0;
    let flaggedTextOnLine = false;
    for (const textMatch of code.matchAll(JSX_TEXT_NODE)) {
      const copy = textMatch[1].trim();
      if (
        copy !== '' &&
        HAS_WORD_CHARACTER.test(copy) &&
        !NON_TRANSLATABLE_GLYPHS.has(copy)
      ) {
        violations.push(
          `${relativePath}:${lineNumber}: bare JSX text "${copy}" without t()`,
        );
        flaggedTextOnLine = true;
      }
    }
    if (flaggedTextOnLine) return;

    // Pretty-printed copy on its own line: `>`, then copy, then `<...`.
    const trimmed = code.trim();
    if (
      STANDALONE_COPY_LINE.test(trimmed) &&
      HAS_WORD_CHARACTER.test(trimmed) &&
      !NON_TRANSLATABLE_GLYPHS.has(trimmed)
    ) {
      const prev = codeLines
        .slice(0, index)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .pop();
      const next = codeLines
        .slice(index + 1)
        .map((entry) => entry.trim())
        .find((entry) => entry !== '');
      if (prev?.endsWith('>') === true && next?.startsWith('<') === true) {
        violations.push(
          `${relativePath}:${lineNumber}: bare JSX text "${trimmed}" without t()`,
        );
      }
    }
  });
}

describe('i18n audit guard (ROADMAP M5: no hardcoded UI text)', () => {
  test('production surfaces render user-visible copy only through t()', () => {
    // DEV-only fixtures are explicitly out of scope for this guard.
    const surfaces = PRODUCTION_SURFACES.filter(
      (surface) => !surface.startsWith('src/dev/'),
    );
    if (surfaces.length === 0) {
      throw new Error('i18n audit: no production surfaces configured');
    }

    const unreadable: string[] = [];
    const violations: string[] = [];
    for (const relativePath of surfaces) {
      let source: string;
      try {
        source = fs.readFileSync(
          path.resolve(__dirname, '..', relativePath),
          'utf8',
        );
      } catch {
        unreadable.push(relativePath);
        continue;
      }
      scanSurface(relativePath, source, violations);
    }

    if (unreadable.length > 0) {
      throw new Error(
        `i18n audit: cannot read source file(s): ${unreadable.join(', ')}`,
      );
    }
    expect(`hardcoded copy violations:\n${violations.join('\n')}`).toBe(
      'hardcoded copy violations:\n',
    );
  });

  test('scanSurface flags literal copy props and stays silent on config tokens', () => {
    // The `hint=` shorthand flows into `accessibilityHint`, so a literal
    // there is hardcoded UI copy and must be flagged.
    const hintViolations: string[] = [];
    scanSurface('probe', '  hint="Hardcoded"\n', hintViolations);
    expect(hintViolations).toHaveLength(1);
    expect(hintViolations[0]).toContain('hint=');

    // Configuration tokens that are not user-visible copy stay silent.
    const silent: string[] = [];
    scanSurface(
      'probe',
      '  aria-labelledby="x"\n  placeholderTextColor={c}\n  testID="a"\n',
      silent,
    );
    expect(silent).toEqual([]);

    // A bare glyph assignment has no prop or JSX context and stays silent.
    const glyph: string[] = [];
    scanSurface('probe', "const G = '✕';\n", glyph);
    expect(glyph).toEqual([]);
  });

  test('Spanish key set equals English key set with no blank copy', () => {
    const enBundle = en as Record<string, unknown>;
    const esBundle = es as unknown as Record<string, unknown>;
    const enKeys = Object.keys(enBundle).sort();
    const esKeys = Object.keys(esBundle).sort();

    const missingInEs = enKeys.filter((key) => !(key in esBundle));
    const extraInEs = esKeys.filter((key) => !(key in enBundle));
    expect({
      missingInEs,
      extraInEs,
    }).toEqual({ missingInEs: [], extraInEs: [] });

    const blankKeys = enKeys.filter((key) => {
      const enValue = enBundle[key];
      const esValue = esBundle[key];
      return (
        typeof enValue !== 'string' ||
        enValue.trim() === '' ||
        typeof esValue !== 'string' ||
        (esValue as string).trim() === ''
      );
    });
    expect(blankKeys).toEqual([]);
  });
});
