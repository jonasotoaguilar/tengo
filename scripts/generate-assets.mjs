#!/usr/bin/env node
/**
 * Deterministic brand-asset generator for U7 (identity, made reproducible).
 *
 * Why this file exists: the app must ship an icon, an adaptive icon, a splash
 * and a favicon without downloaded binaries or host image tools (none of
 * ImageMagick, PIL, ffmpeg, rsvg or inkscape exist on this host), so the
 * script encodes PNGs itself with Node's built-in `zlib` plus its own CRC32
 * and a small shape rasterizer (rounded rect, circle, bar fills, 4x
 * supersampling for smooth edges).
 *
 * Source of truth: `src/theme/tokens.ts`. The script parses the approved
 * LIGHT/DARK literals at runtime and refuses to run if they cannot be read,
 * so identity colors can never drift from the semantic palette. The only
 * non-token color is the monochrome silhouette, which reuses the approved
 * `accentOn` value (white); see DESIGN.md for the derivation record.
 *
 * Determinism: no timestamps, no randomness, fixed deflate settings, fixed
 * paint order. Same input produces byte-identical output; the
 * `__tests__/brand-assets.test.ts` suite regenerates into a temp dir and
 * compares bytes against the committed assets.
 *
 * Usage: `node scripts/generate-assets.mjs [--out <dir>]`
 * (default out is `<repo>/assets`). Wired as `npm run generate:assets`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const TOKENS_PATH = path.join(REPO_ROOT, 'src', 'theme', 'tokens.ts');

const SUPERSAMPLE = 4;

// ---------------------------------------------------------------------------
// Palette: parsed from the approved tokens, never invented here.
// ---------------------------------------------------------------------------

function parseBlock(source, name) {
  const block = source.match(
    new RegExp(`export const ${name}[^{]*\\{([^}]+)\\}`, 'm'),
  );
  if (!block) {
    throw new Error(`generate-assets: cannot find "${name}" in ${TOKENS_PATH}`);
  }
  const values = {};
  for (const match of block[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
    values[match[1]] = match[2];
  }
  return values;
}

function mustHex(palette, role) {
  const value = palette[role];
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(
      `generate-assets: palette role "${role}" is missing or not #RRGGBB in ${TOKENS_PATH}`,
    );
  }
  return value;
}

function hexToRgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

const tokensSource = fs.readFileSync(TOKENS_PATH, 'utf8');
const light = parseBlock(tokensSource, 'LIGHT');

// Approved semantic values (see DESIGN.md for the derivation record).
const ACCENT = hexToRgb(mustHex(light, 'accent')); // tile + splash mark
const ACCENT_ON = hexToRgb(mustHex(light, 'accentOn')); // mark on the tile
const TILE = ACCENT;
const TILE_MARK = ACCENT_ON;
const SPLASH_MARK = ACCENT;

// ---------------------------------------------------------------------------
// Shape rasterizer: analytic inside-tests with bounding-box early-outs,
// coverage from SUPERSAMPLE x SUPERSAMPLE binary subsamples per pixel.
// ---------------------------------------------------------------------------

function roundedRectShape(cx, cy, hw, hh, r, color) {
  return {
    color,
    minX: cx - hw,
    maxX: cx + hw,
    minY: cy - hh,
    maxY: cy + hh,
    inside(px, py) {
      const dx = Math.abs(px - cx);
      const dy = Math.abs(py - cy);
      if (dx > hw || dy > hh) {
        return false;
      }
      const qx = dx - (hw - r);
      const qy = dy - (hh - r);
      if (qx <= 0 || qy <= 0) {
        return true;
      }
      return qx * qx + qy * qy <= r * r;
    },
  };
}

function circleShape(cx, cy, r, color) {
  return {
    color,
    minX: cx - r,
    maxX: cx + r,
    minY: cy - r,
    maxY: cy + r,
    inside(px, py) {
      const dx = px - cx;
      const dy = py - cy;
      return dx * dx + dy * dy <= r * r;
    },
  };
}

/**
 * The Tengo mark: a storage-bin outline (rounded-rect ring) holding two
 * shelf bars with one item (filled circle) resting on the upper shelf.
 * Unit space is centered at (cx, cy) with box half-width `s`; every part
 * uses the same color so unions merge into one silhouette.
 */
function binMark(cx, cy, s, color) {
  const ringOuter = roundedRectShape(cx, cy, s, s, 0.28 * s, color);
  const ringInner = roundedRectShape(
    cx,
    cy,
    0.72 * s,
    0.72 * s,
    0.16 * s,
    null,
  );
  const shelfTop = roundedRectShape(
    cx,
    cy - 0.15 * s,
    0.72 * s,
    0.09 * s,
    0.09 * s,
    color,
  );
  const shelfBottom = roundedRectShape(
    cx,
    cy + 0.42 * s,
    0.72 * s,
    0.09 * s,
    0.09 * s,
    color,
  );
  const item = circleShape(cx - 0.3 * s, cy - 0.4 * s, 0.18 * s, color);
  // The ring is "outer minus inner": the inner shape carries a null color so
  // it erases instead of painting.
  return [ringOuter, ringInner, shelfTop, shelfBottom, item];
}

function render(size, base, shapes) {
  const out = Buffer.alloc(size * size * 4);
  const n = SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let covered = 0;
      for (let sy = 0; sy < n; sy += 1) {
        for (let sx = 0; sx < n; sx += 1) {
          const px = x + (sx + 0.5) / n;
          const py = y + (sy + 0.5) / n;
          let paint = null;
          for (const shape of shapes) {
            if (
              px < shape.minX ||
              px > shape.maxX ||
              py < shape.minY ||
              py > shape.maxY
            ) {
              continue;
            }
            if (shape.inside(px, py)) {
              paint = shape.color;
            }
          }
          if (paint !== null) {
            rSum += paint[0];
            gSum += paint[1];
            bSum += paint[2];
            covered += 1;
          } else if (base !== null) {
            rSum += base[0];
            gSum += base[1];
            bSum += base[2];
          }
        }
      }
      const total = n * n;
      const off = (y * size + x) * 4;
      out[off] = Math.round(rSum / total);
      out[off + 1] = Math.round(gSum / total);
      out[off + 2] = Math.round(bSum / total);
      // Solid base: opaque everywhere; transparent base: alpha = coverage.
      out[off + 3] = base !== null ? 255 : Math.round((covered / total) * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder: 8-bit RGBA, one unfiltered scanline per row, fixed
// deflate level. No ancillary chunks, so no timestamps can leak in.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(
    crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])),
    0,
  );
  return Buffer.concat([header, data, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    raw[y * (1 + size * 4)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor with alpha
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Asset definitions: [file name, size, base, mark color, mark scale].
// The mark scale is the box half-width as a fraction of the canvas size.
// The foreground mark stays inside the adaptive-icon safe zone (dialog
// circle ~66% of the canvas); the splash mark keeps generous padding
// because the system centers it over the splash background.
// ---------------------------------------------------------------------------

const ASSETS = [
  { file: 'icon.png', size: 1024, base: TILE, mark: TILE_MARK, scale: 0.3 },
  {
    file: 'android-icon-foreground.png',
    size: 512,
    base: null,
    mark: TILE_MARK,
    scale: 0.28,
  },
  {
    file: 'android-icon-background.png',
    size: 512,
    base: TILE,
    mark: null,
    scale: 0,
  },
  {
    file: 'android-icon-monochrome.png',
    size: 432,
    base: null,
    mark: TILE_MARK,
    scale: 0.3,
  },
  {
    file: 'splash-icon.png',
    size: 1024,
    base: null,
    mark: SPLASH_MARK,
    scale: 0.2,
  },
  { file: 'favicon.png', size: 48, base: TILE, mark: TILE_MARK, scale: 0.32 },
];

function main() {
  const args = process.argv.slice(2);
  let outDir = path.join(REPO_ROOT, 'assets');
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out' && i + 1 < args.length) {
      outDir = path.resolve(args[i + 1]);
      i += 1;
    } else {
      throw new Error(`generate-assets: unknown argument "${args[i]}"`);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const asset of ASSETS) {
    const center = asset.size / 2;
    const shapes =
      asset.mark === null
        ? []
        : binMark(center, center, asset.scale * asset.size, asset.mark);
    const png = encodePng(asset.size, render(asset.size, asset.base, shapes));
    const dest = path.join(outDir, asset.file);
    fs.writeFileSync(dest, png);
    process.stdout.write(
      `${asset.file} ${asset.size}x${asset.size} ${png.length} bytes\n`,
    );
  }
}

main();
