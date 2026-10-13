/**
 * Shared semantic palette for the production surfaces.
 *
 * `DESIGN.md` section 5 defines one semantic role set and forbids raw hex
 * from driving UI; the three surfaces that render inventory UI resolve the
 * same roles, so the literals live here once instead of being triplicated.
 *
 * Two role borders exist because they carry different accessibility
 * contracts:
 *
 * - `separator` draws decorative dividers and static outlines (item row
 *   separators, the draft-tag outline). WCAG 1.4.11 does not apply to
 *   decoration, so its value is free to stay visually light.
 * - `controlBorder` draws the boundary of an interactive control (search
 *   field, text inputs, quantity steppers, chips) where it is the only
 *   extent cue, so it must meet the 3:1 contrast floor against BOTH
 *   `background` and `surface` in both schemes. `__tests__/contrast-floor.test.tsx`
 *   guards that floor against the real rendered styles.
 */
export interface PaletteBase {
  background: string;
  text: string;
  secondary: string;
  surface: string;
  separator: string;
  controlBorder: string;
  accent: string;
  accentOn: string;
  error: string;
}

export const LIGHT: PaletteBase = {
  background: '#FFFFFF',
  text: '#1A1C19',
  secondary: '#5C5F58',
  surface: '#F4F2EC',
  separator: '#C9C5B8',
  controlBorder: '#8A8578',
  accent: '#2F6B3A',
  accentOn: '#FFFFFF',
  error: '#B3261E',
};

export const DARK: PaletteBase = {
  background: '#121212',
  text: '#F2F1ED',
  secondary: '#AEB0AD',
  surface: '#1C1C1E',
  separator: '#38383A',
  controlBorder: '#6E6E73',
  accent: '#7BC79A',
  accentOn: '#0B2E18',
  error: '#FFB4AB',
};
