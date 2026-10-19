import * as zlib from "node:zlib";

export interface MakeZipEntry {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  declaredSize?: number;
  flags?: number;
  /** Use these bytes as the already-compressed body (CRC 0), so a huge bomb need not be built in memory. */
  precompressed?: Uint8Array;
}

export interface MakeZipOptions {
  /** Entry count written to the end record instead of the real one. */
  eocdCount?: number;
  /** Bytes inserted between the central directory and the end record. */
  gap?: number;
}

let table: Uint32Array | undefined;
function crc32(data: Uint8Array): number {
  const native = (zlib as unknown as { crc32?: (d: Uint8Array) => number }).crc32;
  if (typeof native === "function") return native(data) >>> 0;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of data) crc = (table[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Test-only: builds a zip by hand so tests can forge sizes, flags and methods. Not exported from the package index. */
export function makeZip(entries: MakeZipEntry[], options: MakeZipOptions = {}): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const method = e.method ?? 0;
    const body = e.precompressed
      ? Buffer.from(e.precompressed)
      : method === 8
        ? zlib.deflateRawSync(e.data)
        : Buffer.from(e.data);
    const crc = e.precompressed ? 0 : crc32(e.data);
    const size = e.declaredSize ?? e.data.length;
    const flags = e.flags ?? 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = options.eocdCount ?? entries.length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, Buffer.alloc(options.gap ?? 0), eocd]));
}
