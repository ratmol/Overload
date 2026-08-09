/**
 * Generates the PNG launcher icons from the same drawing as icon.svg.
 *
 * Written by hand rather than pulled from a rasteriser because the icon is
 * four rectangles and a line, and a build-time image dependency for that is a
 * worse trade than forty lines of PNG encoder. Run it when the mark changes:
 *
 *   node scripts/icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PAPER = [0xf5, 0xf2, 0xea];
const GRID = [0xcf, 0xd5, 0xda];
const INK = [0x1a, 0x18, 0x14];
const INK_FAINT = [0xc9, 0xc5, 0xbc];
const MARK = [0xc0, 0x39, 0x2b];

/** The drawing, in 512-unit space. Scaled to whatever size is asked for. */
function draw(size) {
  const px = new Uint8Array(size * size * 3);
  const u = (v) => Math.round((v / 512) * size);

  const set = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    px[i] = rgb[0];
    px[i + 1] = rgb[1];
    px[i + 2] = rgb[2];
  };
  const rect = (x, y, w, h, rgb) => {
    for (let j = u(y); j < u(y + h); j++) for (let i = u(x); i < u(x + w); i++) set(i, j, rgb);
  };

  rect(0, 0, 512, 512, PAPER);
  for (const y of [128, 256, 384]) rect(0, y, 512, 4, GRID);
  for (const x of [128, 256, 384]) rect(x, 0, 4, 512, GRID);

  rect(96, 150, 320, 26, INK);
  rect(96, 243, 320, 26, INK);
  rect(96, 336, 200, 26, INK_FAINT);
  rect(84, 157, 344, 12, MARK);

  return px;
}

function png(size) {
  const raw = draw(size);
  // Each scanline is prefixed with a filter byte. Filter 0 = none; the image is
  // flat colour, so nothing smarter would compress meaningfully better.
  const withFilter = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    withFilter[y * (size * 3 + 1)] = 0;
    Buffer.from(raw.subarray(y * size * 3, (y + 1) * size * 3)).copy(
      withFilter,
      y * (size * 3 + 1) + 1,
    );
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(withFilter, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-180.png', 180],
]) {
  writeFileSync(join(out, name), png(size));
  console.log(`wrote public/${name}`);
}
