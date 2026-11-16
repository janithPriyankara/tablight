// Generates simple PNG icons (rounded square + 2x2 tile glyph). Output is committed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const inRound = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
function render(size) {
  const SS = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const s = size;
  const tiles = [
    [0.22, 0.22], [0.54, 0.22],
    [0.22, 0.54], [0.54, 0.54],
  ];
  const tw = 0.24;
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let a = 0, tileCov = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / s, y = (py + (sy + 0.5) / SS) / s;
        if (inRound(x, y, 0, 0, 1, 1, 0.22)) {
          a++;
          if (tiles.some(([tx, ty]) => inRound(x, y, tx, ty, tx + tw, ty + tw, 0.05))) tileCov++;
        }
      }
      const n = SS * SS;
      const t = a ? tileCov / a : 0;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = Math.round(37 + (255 - 37) * t);
      raw[o + 1] = Math.round(99 + (255 - 99) * t);
      raw[o + 2] = Math.round(235 + (255 - 235) * t);
      raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `${size}.png`), render(size));
  console.log(`wrote ${size}.png`);
}
