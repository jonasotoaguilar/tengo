/**
 * Brand-asset contract for U7 (identity, made reproducible).
 *
 * This suite asserts the observable contract through the public interface:
 * every file `app.json` points at exists, is a real PNG with the exact pixel
 * dimensions the platform requires, the splash and adaptive-icon backgrounds
 * are approved token values (never the stray Expo-template `#E6F4FE`), and
 * `scripts/generate-assets.mjs` reproduces the committed bytes exactly when
 * re-run into a temp dir.
 *
 * Out of scope by spec: how a launcher renders the icon on a device, and any
 * TalkBack-visible label for it. Those need device observation, never host
 * tests.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DARK, LIGHT } = require('../src/theme/tokens');

jest.setTimeout(180_000);

const REPO_ROOT = path.resolve(__dirname, '..');
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'generate-assets.mjs');

/** [repo-relative path, width, height] for every shipped brand asset. */
const EXPECTED: Array<[string, number, number]> = [
  ['assets/icon.png', 1024, 1024],
  ['assets/android-icon-foreground.png', 512, 512],
  ['assets/android-icon-background.png', 512, 512],
  ['assets/android-icon-monochrome.png', 432, 432],
  ['assets/splash-icon.png', 1024, 1024],
  ['assets/favicon.png', 48, 48],
];

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Approved semantic values: identity colors come from tokens, never raw. */
const APPROVED_COLORS = new Set(
  [...Object.values(LIGHT), ...Object.values(DARK)].map((c) =>
    String(c).toUpperCase(),
  ),
);

interface AdaptiveIconConfig {
  foregroundImage?: string;
  backgroundImage?: string;
  monochromeImage?: string;
  backgroundColor?: string;
}

interface SplashPluginConfig {
  image?: string;
  backgroundColor?: string;
}

interface ExpoConfig {
  icon?: string;
  android?: { adaptiveIcon?: AdaptiveIconConfig };
  web?: { favicon?: string };
  plugins?: unknown[];
  splash?: SplashPluginConfig;
}

function readAppJson(): ExpoConfig {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'app.json'), 'utf8'))
    .expo as ExpoConfig;
}

function readPngInfo(abs: string) {
  const bytes = fs.readFileSync(abs);
  return {
    bytes,
    signature: bytes.subarray(0, 8),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function splashConfig(expo: ExpoConfig): SplashPluginConfig | null {
  const plugins = Array.isArray(expo.plugins) ? expo.plugins : [];
  for (const entry of plugins) {
    if (Array.isArray(entry) && entry[0] === 'expo-splash-screen') {
      return (entry[1] ?? {}) as SplashPluginConfig;
    }
    if (entry === 'expo-splash-screen') {
      return {};
    }
  }
  return expo.splash ?? null;
}

describe('brand assets (U7 identity)', () => {
  test('every asset app.json references exists with PNG signature and exact dimensions', () => {
    const expo = readAppJson();
    const referenced = [
      expo.icon,
      expo.android?.adaptiveIcon?.foregroundImage,
      expo.android?.adaptiveIcon?.backgroundImage,
      expo.android?.adaptiveIcon?.monochromeImage,
      expo.web?.favicon,
    ];
    for (const ref of referenced) {
      expect(typeof ref).toBe('string');
      expect(fs.existsSync(path.join(REPO_ROOT, ref))).toBe(true);
    }

    for (const [rel, width, height] of EXPECTED) {
      const info = readPngInfo(path.join(REPO_ROOT, rel));
      expect(info.signature.equals(PNG_SIGNATURE)).toBe(true);
      expect([info.width, info.height]).toEqual([width, height]);
    }
  });

  test('adaptive-icon background is an approved token value, not the template stray', () => {
    const expo = readAppJson();
    const backgroundColor =
      expo.android?.adaptiveIcon?.backgroundColor ?? '(missing)';
    expect(backgroundColor.toUpperCase()).not.toBe('#E6F4FE');
    expect(APPROVED_COLORS.has(backgroundColor.toUpperCase())).toBe(true);
  });

  test('splash is configured through expo-splash-screen with a generated icon and an approved background', () => {
    const expo = readAppJson();
    const splash = splashConfig(expo);
    expect(splash).not.toBeNull();
    if (splash === null) {
      throw new Error('expo-splash-screen config is missing from app.json');
    }
    expect(typeof splash.image).toBe('string');
    const imageAbs = path.join(REPO_ROOT, splash.image);
    expect(fs.existsSync(imageAbs)).toBe(true);
    const info = readPngInfo(imageAbs);
    expect(info.signature.equals(PNG_SIGNATURE)).toBe(true);
    expect(
      APPROVED_COLORS.has(String(splash.backgroundColor).toUpperCase()),
    ).toBe(true);
  });

  test('the generator is wired as an npm script and reads the token palette', () => {
    expect(fs.existsSync(GENERATOR)).toBe(true);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    );
    const scripts = Object.values(pkg.scripts ?? {}).map(String);
    expect(
      scripts.some((cmd) => cmd.includes('scripts/generate-assets.mjs')),
    ).toBe(true);
    const source = fs.readFileSync(GENERATOR, 'utf8');
    expect(source).toMatch('tokens.ts');
  });

  test('regenerating into a temp dir reproduces byte-identical assets', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tengo-brand-'));
    try {
      const run = spawnSync(process.execPath, [GENERATOR, '--out', outDir], {
        encoding: 'utf8',
      });
      expect(run.status).toBe(0);
      for (const [rel] of EXPECTED) {
        const committed = fs.readFileSync(path.join(REPO_ROOT, rel));
        const regenerated = fs.readFileSync(
          path.join(outDir, path.basename(rel)),
        );
        expect(regenerated.equals(committed)).toBe(true);
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
