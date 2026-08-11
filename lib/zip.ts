// Minimal ZIP writer — "store" method (no compression), no dependencies.
// Enough to bundle a handful of small text files (gateway scripts + systemd
// units) into a single archive the browser can download. Not a general zip
// library: no compression, no zip64, assumes small files.

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number) =>
  new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

// Fixed DOS timestamp (1980-01-01 00:00) so the archive is deterministic and
// doesn't depend on the clock — the files carry no meaningful mtime anyway.
const DOS_TIME = u16(0);
const DOS_DATE = u16(33); // (0 << 9) | (1 << 5) | 1

export function zipStore(files: { name: string; content: string }[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.content);
    const crc = crc32(data);

    const local = concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed to extract
      u16(0), // general purpose flag
      u16(0), // compression method: store
      DOS_TIME,
      DOS_DATE,
      u32(crc),
      u32(data.length), // compressed size
      u32(data.length), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra field length
      nameBytes,
    ]);
    parts.push(local, data);

    central.push(
      concat([
        u32(0x02014b50), // central directory header signature
        u16(20), // version made by
        u16(20), // version needed
        u16(0), // flags
        u16(0), // compression: store
        DOS_TIME,
        DOS_DATE,
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0), // extra length
        u16(0), // comment length
        u16(0), // disk number start
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset), // offset of local header
        nameBytes,
      ])
    );

    offset += local.length + data.length;
  }

  const centralBytes = concat(central);
  const end = concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // disk number
    u16(0), // disk with central directory
    u16(files.length), // records on this disk
    u16(files.length), // total records
    u32(centralBytes.length),
    u32(offset), // offset of central directory
    u16(0), // comment length
  ]);

  // Flatten to a single ArrayBuffer-backed view and hand the Blob its `.buffer`
  // (a plain ArrayBuffer). Passing the Uint8Arrays directly trips TS 5.7+, which
  // types them as Uint8Array<ArrayBufferLike> — not a valid BlobPart.
  const body = concat([...parts, centralBytes, end]);
  return new Blob([body.buffer as ArrayBuffer], { type: "application/zip" });
}
