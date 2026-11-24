/**
 * A small DER writer for the tests: Mach-O entitlements, a certificate made in the test (Ed25519,
 * self-signed, its key never written anywhere), a PKCS#7 SignedData around it, a code-integrity
 * catalog, and a minimal PE file.
 */
import { X509Certificate, generateKeyPairSync, sign } from 'node:crypto';

export function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : n < 0x10000
          ? Buffer.from([0x82, n >> 8, n & 0xff])
          : Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}

export const seq = (...p: Buffer[]): Buffer => der(0x30, ...p);
export const set = (...p: Buffer[]): Buffer => der(0x31, ...p);
export const octets = (b: Buffer | string): Buffer => der(0x04, Buffer.from(b));
export const utf8 = (s: string): Buffer => der(0x0c, Buffer.from(s, 'utf8'));
export const int = (n: number): Buffer => der(0x02, Buffer.from([n]));
export const bool = (v: boolean): Buffer => der(0x01, Buffer.from([v ? 0xff : 0]));
export const utcTime = (s: string): Buffer => der(0x17, Buffer.from(s, 'latin1'));
export const explicit = (n: number, ...p: Buffer[]): Buffer => der(0xa0 + n, ...p);

export function oid(dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [a * 40 + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128))
      chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

/** Entitlements as `codesign` writes them in DER. */
export function entitlementsDer(e: Readonly<Record<string, boolean>>): Buffer {
  const pairs = Object.entries(e).map(([k, v]) => seq(utf8(k), bool(v)));
  return der(0x70, int(1), der(0xb0, ...pairs));
}

export function entitlementsXml(e: Readonly<Record<string, boolean>>): string {
  const body = Object.entries(e)
    .map(([k, v]) => `  <key>${k}</key>\n  <${String(v)}/>\n`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}</dict>\n</plist>\n`;
}

const ED25519 = '1.3.101.112';
const SHA256 = '2.16.840.1.101.3.4.2.1';
const SIGNED_DATA = '1.2.840.113549.1.7.2';

export interface TestCertificate {
  readonly der: Buffer;
  readonly x509: X509Certificate;
  readonly name: Buffer;
  readonly serial: number;
}

/** A self-signed certificate for `cn`, made now; its private key is dropped on return. */
export function testCertificate(cn: string, serial = 0x42): TestCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const name = seq(set(seq(oid('2.5.4.3'), utf8(cn))));
  const tbs = seq(
    explicit(0, int(2)),
    int(serial),
    seq(oid(ED25519)),
    name,
    seq(utcTime('250101000000Z'), utcTime('350101000000Z')),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign(null, tbs, privateKey);
  const cert = seq(tbs, seq(oid(ED25519)), der(0x03, Buffer.from([0]), signature));
  return { der: cert, x509: new X509Certificate(cert), name, serial };
}

/** PKCS#7 SignedData carrying `content` of `contentType`, "signed" by `cert` (not verified). */
export function signedData(contentType: string, content: Buffer, cert: TestCertificate): Buffer {
  const signer = seq(
    int(1),
    seq(cert.name, int(cert.serial)),
    seq(oid(SHA256)),
    seq(oid(ED25519)),
    octets(Buffer.alloc(64, 7)),
  );
  return seq(
    oid(SIGNED_DATA),
    explicit(
      0,
      seq(
        int(1),
        set(seq(oid(SHA256))),
        seq(oid(contentType), explicit(0, content)),
        explicit(0, cert.der),
        set(signer),
      ),
    ),
  );
}

/** An `AppxSignature.p7x`. */
export const p7x = (cert: TestCertificate): Buffer =>
  Buffer.concat([
    Buffer.from('PKCX'),
    signedData('1.3.6.1.4.1.311.2.1.4', seq(seq(oid('1.3.6.1.4.1.311.2.1.30')), octets('x')), cert),
  ]);

/**
 * A code-integrity catalog naming these Authenticode digests, laid out as SignTool writes one for a
 * package (v2: each member's identifier is its digest; a SHA-256 member also carries indirect data
 * naming it, a SHA-1 member does not), or as a v1 catalog (a tag, and the digest inside).
 */
export function catalog(
  members: readonly {
    readonly algorithm: 'sha1' | 'sha256';
    readonly digest: string;
    /** Indirect data naming another digest than the identifier. */
    readonly inside?: string;
  }[],
  cert: TestCertificate,
  o: { readonly v1?: boolean } = {},
): Buffer {
  const alg = { sha1: '1.3.14.3.2.26', sha256: SHA256 };
  const memberInfo = seq(oid('1.3.6.1.4.1.311.12.2.3'), set(der(0xa0)));
  const indirect = (algorithm: 'sha1' | 'sha256', digest: string): Buffer =>
    seq(
      oid('1.3.6.1.4.1.311.2.1.4'),
      set(
        seq(
          seq(oid('1.3.6.1.4.1.311.2.1.15'), seq()),
          seq(seq(oid(alg[algorithm]), der(0x05)), octets(Buffer.from(digest, 'hex'))),
        ),
      ),
    );
  const list = members.map((m, i) =>
    o.v1 === true
      ? seq(octets(`member-${String(i)}`), set(indirect(m.algorithm, m.inside ?? m.digest)))
      : m.algorithm === 'sha1' && m.inside === undefined
        ? seq(octets(Buffer.from(m.digest, 'hex')), set(memberInfo))
        : seq(
            octets(Buffer.from(m.digest, 'hex')),
            set(memberInfo, indirect(m.algorithm, m.inside ?? m.digest)),
          ),
  );
  const ctl = seq(
    seq(oid('1.3.6.1.4.1.311.12.1.1')),
    octets('list'),
    utcTime('250101000000Z'),
    seq(oid(o.v1 === true ? '1.3.6.1.4.1.311.12.1.2' : '1.3.6.1.4.1.311.12.1.3'), der(0x05)),
    seq(...list),
  );
  return signedData('1.3.6.1.4.1.311.10.1', ctl, cert);
}

/** A minimal PE32+ file: headers, and one section of `fill`. */
export function peFile(fill = 0x90, checksum = 0): Buffer {
  const f = Buffer.alloc(0x400);
  f.write('MZ', 0, 'latin1');
  f.writeUInt32LE(0x40, 0x3c);
  f.writeUInt32LE(0x00004550, 0x40);
  f.writeUInt16LE(0x8664, 0x44);
  f.writeUInt16LE(1, 0x46);
  f.writeUInt16LE(240, 0x54);
  const opt = 0x58;
  f.writeUInt16LE(0x20b, opt);
  f.writeUInt32LE(0x200, opt + 60);
  f.writeUInt32LE(checksum, opt + 64);
  f.writeUInt32LE(16, opt + 108);
  const section = opt + 240;
  f.write('.text', section, 'latin1');
  f.writeUInt32LE(0x200, section + 16);
  f.writeUInt32LE(0x200, section + 20);
  f.fill(fill, 0x200);
  return f;
}
