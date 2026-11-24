/** A small ZIP writer for the tests: the shapes a real package has, and the bad ones. */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipItem {
  readonly name: string;
  readonly data?: string | Buffer;
  /** A POSIX mode: `0o120755` for a symlink, whose `data` is its target. */
  readonly mode?: number;
  readonly deflate?: boolean;
  /** Writes this name in the local header instead. */
  readonly localName?: string;
  /** General purpose flags. */
  readonly flags?: number;
  /** Stores a wrong checksum. */
  readonly badCrc?: boolean;
}

export function zipOf(items: readonly ZipItem[], o: { zip64?: boolean } = {}): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const raw = Buffer.from(item.data ?? '');
    const body = item.deflate === true ? deflateRawSync(raw) : raw;
    const crc = item.badCrc === true ? (crc32(raw) ^ 1) >>> 0 : crc32(raw);
    const name = Buffer.from(item.name);
    const localName = Buffer.from(item.localName ?? item.name);
    const method = item.deflate === true ? 8 : 0;
    const flags = item.flags ?? 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(localName.length, 26);
    chunks.push(local, localName, body);

    const extra = Buffer.alloc(o.zip64 === true ? 28 : 0);
    if (o.zip64 === true) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(o.zip64 === true ? 0xffffffff : body.length, 20);
    c.writeUInt32LE(o.zip64 === true ? 0xffffffff : raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(o.zip64 === true ? 0xffffffff : offset, 42);
    central.push(c, name, extra);
    offset += local.length + localName.length + body.length;
  }
  const cd = Buffer.concat(central);
  const tail: Buffer[] = [];
  if (o.zip64 === true) {
    const r = Buffer.alloc(56);
    r.writeUInt32LE(0x06064b50, 0);
    r.writeBigUInt64LE(44n, 4);
    r.writeUInt16LE(45, 12);
    r.writeUInt16LE(45, 14);
    r.writeBigUInt64LE(BigInt(items.length), 24);
    r.writeBigUInt64LE(BigInt(items.length), 32);
    r.writeBigUInt64LE(BigInt(cd.length), 40);
    r.writeBigUInt64LE(BigInt(offset), 48);
    const l = Buffer.alloc(20);
    l.writeUInt32LE(0x07064b50, 0);
    l.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    l.writeUInt32LE(1, 16);
    tail.push(r, l);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(o.zip64 === true ? 0xffff : items.length, 8);
  end.writeUInt16LE(o.zip64 === true ? 0xffff : items.length, 10);
  end.writeUInt32LE(o.zip64 === true ? 0xffffffff : cd.length, 12);
  end.writeUInt32LE(o.zip64 === true ? 0xffffffff : offset, 16);
  return Buffer.concat([...chunks, cd, ...tail, end]);
}
