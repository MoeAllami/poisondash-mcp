/**
 * Just enough PNG and .npz encoding for the mock backend to return real,
 * decodable files -- a sample image an MCP client can render, and a sanitized
 * export numpy can open -- without pulling in a dependency.
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** Deterministic PRNG (mulberry32), so a sample index always renders the same image. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "latin1");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return out;
}

/** Encode an 8-bit RGB pixel buffer (width * height * 3 bytes) as a PNG. */
export function encodePng(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // colour type: truecolour
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    // Each scanline is prefixed with filter type 0 (none).
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A 32x32 CIFAR-sized stand-in for a dataset sample: a smooth gradient whose
 * hue depends on the sample, with a bright corner patch on poisoned samples so
 * the "trigger" is visible when an agent inspects a flagged image.
 */
export function sampleRgb(seed, index, poisoned) {
  const size = 32;
  const rand = rng(seed * 100003 + index);
  const base = [rand() * 255, rand() * 255, rand() * 255];
  const rgb = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 3;
      const shade = (x + y) / (2 * size);
      for (let c = 0; c < 3; c += 1) {
        const noise = (rand() - 0.5) * 30;
        rgb[o + c] = Math.max(0, Math.min(255, base[c] * (0.4 + shade) + noise));
      }
      if (poisoned && x >= size - 6 && y >= size - 6) {
        rgb[o] = (x + y) % 2 === 0 ? 255 : 0;
        rgb[o + 1] = (x + y) % 2 === 0 ? 255 : 0;
        rgb[o + 2] = (x + y) % 2 === 0 ? 255 : 0;
      }
    }
  }
  return { width: size, height: size, rgb };
}

/** Serialize a typed array as a v1.0 .npy member. */
function npy(array, descr, shape) {
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  const preludeLength = 10;
  const padding = 64 - ((preludeLength + header.length + 1) % 64);
  header += " ".repeat(padding === 64 ? 0 : padding) + "\n";

  const out = Buffer.alloc(preludeLength + header.length + array.byteLength);
  out.write("\x93NUMPY", 0, "latin1");
  out.writeUInt8(1, 6);
  out.writeUInt8(0, 7);
  out.writeUInt16LE(header.length, 8);
  out.write(header, preludeLength, "latin1");
  Buffer.from(array.buffer, array.byteOffset, array.byteLength).copy(out, preludeLength + header.length);
  return out;
}

/** Build a stored (uncompressed) ZIP -- which is what an .npz is. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "latin1");
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const entry = Buffer.alloc(46 + nameBuf.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    nameBuf.copy(entry, 46);
    central.push(entry);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

/** An .npz holding `x` (N x 32 x 32 x 3 uint8 images) and `y` (N int64 labels). */
export function makeNpz(seed, indices, labelOf) {
  const n = indices.length;
  const x = new Uint8Array(n * 32 * 32 * 3);
  const y = new BigInt64Array(n);
  indices.forEach((index, i) => {
    x.set(sampleRgb(seed, index, false).rgb, i * 32 * 32 * 3);
    y[i] = BigInt(labelOf(index));
  });
  return zip([
    ["x.npy", npy(x, "|u1", [n, 32, 32, 3])],
    ["y.npy", npy(y, "<i8", [n])],
  ]);
}

/** Best-effort sample count of an uploaded .npz: the leading dimension of its first member. */
export function npzSampleCount(buffer) {
  const match = /'shape':\s*\((\d+)/.exec(buffer.subarray(0, 4096).toString("latin1"));
  return match ? Number(match[1]) : undefined;
}
