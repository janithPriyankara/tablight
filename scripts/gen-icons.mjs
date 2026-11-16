// Generates the PNG icons (pine square + three stacked tabs, as LogoMark). Output is committed.
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
  // Three tabs filed one behind the other (back to front, fading in), on a pine square. Matches LogoMark.
  const cards = [
    { x0: 0.40, y0: 0.18, x1: 0.82, y1: 0.58, ink: 0.38 },
    { x0: 0.30, y0: 0.29, x1: 0.72, y1: 0.69, ink: 0.66 },
    { x0: 0.19, y0: 0.40, x1: 0.61, y1: 0.81, ink: 1 },
  ];
  const BG = [0x22, 0x67, 0x5a];
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let a = 0, ink = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / s, y = (py + (sy + 0.5) / SS) / s;
        if (!inRound(x, y, 0, 0, 1, 1, 0.22)) continue;
        a++;
        // The front-most card under this point wins (later cards cover earlier ones).
        for (let k = cards.length - 1; k >= 0; k--) {
          const c = cards[k];
          if (inRound(x, y, c.x0, c.y0, c.x1, c.y1, 0.07)) {
            ink += c.ink;
            break;
          }
        }
      }
      const n = SS * SS;
      const t = a ? ink / a : 0;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      for (let ch = 0; ch < 3; ch++) raw[o + ch] = Math.round(BG[ch] + (255 - BG[ch]) * t);
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
