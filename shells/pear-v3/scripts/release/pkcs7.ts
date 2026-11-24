/**
 * The signer of an `.msix` and of its code-integrity catalog. `AppxSignature.p7x` is the four bytes
 * `PKCX` and a PKCS#7 SignedData; `AppxMetadata/CodeIntegrity.cat` is a PKCS#7 SignedData whose
 * content is a certificate trust list (CTL). This finds the one signer's certificate and, for a
 * catalog, the digest each member names. It does not verify a signature: Windows does that when it
 * installs the package, and a signature that does not verify is refused there.
 */
import { X509Certificate } from 'node:crypto';

import { bytesOf, children, elementOf, readTlv, type Tlv } from './der.ts';
import { refuse } from './guards.ts';

export interface SignerCertificate {
  readonly sha256: string;
  readonly subject: string;
  readonly issuer: string;
}

export interface SignedContent {
  /** The content type, dotted. */
  readonly contentType: string;
  readonly signer: SignerCertificate;
  readonly der: Buffer;
  /** The content itself (inside its `[0] EXPLICIT`), if any. */
  readonly content: Tlv | undefined;
}

/** Microsoft's certificate trust list, the content of a catalog. */
export const OID_CTL = '1.3.6.1.4.1.311.10.1';

/** A serial number as hex, without leading zeros, so DER's and Node's spellings compare. */
const serialOf = (hex: string): string => hex.toUpperCase().replace(/^0+/, '');

export function oidOf(b: Buffer): string {
  if (b.length === 0) return refuse('DER: an empty object identifier');
  const first = b[0] ?? 0;
  const parts = [Math.floor(first / 40), first % 40];
  let n = 0;
  for (let i = 1; i < b.length; i++) {
    const c = b[i] ?? 0;
    n = n * 128 + (c & 0x7f);
    if ((c & 0x80) === 0) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join('.');
}

/** A PKCS#7 SignedData with exactly one signer, whose certificate it carries. */
export function signedContent(der: Buffer): SignedContent {
  const info = readTlv(der, 0);
  if (info.tag !== 0x30 || info.end !== der.length) return refuse('not one PKCS#7 structure');
  const [oid, wrapped] = children(der, info);
  if (oid?.tag !== 0x06 || wrapped?.tag !== 0xa0) return refuse('the signature is not PKCS#7');
  const [signedData] = children(der, wrapped);
  if (signedData?.tag !== 0x30) return refuse('the signature is not PKCS#7 SignedData');
  const parts = children(der, signedData);
  const encap = parts[2];
  const certSet = parts.find((p) => p.tag === 0xa0);
  const signerInfos = parts[parts.length - 1];
  if (encap?.tag !== 0x30 || certSet === undefined || signerInfos?.tag !== 0x31)
    return refuse('the signature carries no content type, certificate or signer');
  const [type, explicit] = children(der, encap);
  if (type?.tag !== 0x06) return refuse('the signed content has no type');
  // PKCS#7 puts the content itself under [0]; CMS wraps it in an OCTET STRING first.
  let content = explicit?.tag === 0xa0 ? children(der, explicit)[0] : undefined;
  if (content?.tag === 0x04) content = readTlv(der, content.start, content.end);
  const signers = children(der, signerInfos);
  if (signers.length !== 1) return refuse(`the signature has ${String(signers.length)} signers`);
  const [, sid] = children(der, signers[0] ?? signerInfos);
  if (sid?.tag !== 0x30) return refuse('the signer is not named by issuer and serial number');
  const [, serial] = children(der, sid);
  if (serial?.tag !== 0x02) return refuse('the signer has no serial number');
  const want = serialOf(bytesOf(der, serial).toString('hex'));
  const matches = children(der, certSet)
    .filter((c) => c.tag === 0x30)
    .map((c) => new X509Certificate(elementOf(der, c)))
    .filter((c) => serialOf(c.serialNumber) === want);
  const [cert, ...others] = matches;
  if (cert === undefined || others.length > 0)
    return refuse('the signer’s certificate is not in the signature');
  return {
    contentType: oidOf(bytesOf(der, type)),
    signer: { sha256: cert.fingerprint256, subject: cert.subject, issuer: cert.issuer },
    der,
    content,
  };
}

/** The certificate that signed an `.msix` (`AppxSignature.p7x`). */
export function msixSigner(p7x: Buffer): SignerCertificate {
  if (p7x.toString('latin1', 0, 4) !== 'PKCX') return refuse('the signature part is not PKCX');
  return signedContent(p7x.subarray(4)).signer;
}

const OID_INDIRECT_DATA = '1.3.6.1.4.1.311.2.1.4';
const DIGESTS: Readonly<Record<string, 'sha1' | 'sha256'>> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
};

export interface CatalogMember {
  readonly algorithm: 'sha1' | 'sha256';
  /** Hex. */
  readonly digest: string;
}

/**
 * The digest each member of a catalog names. A CTL is a SEQUENCE of: an optional version, the
 * usage, an optional identifier and sequence number, one or two times, the members' algorithm, the
 * members, and optional extensions. A member is its identifier and a SET of attributes; one of them
 * is the indirect data that holds the digest. A member without exactly one is refused.
 */
export function catalogMembers(c: SignedContent): CatalogMember[] {
  if (c.contentType !== OID_CTL || c.content?.tag !== 0x30)
    return refuse('the catalog is not a certificate trust list');
  const der = c.der;
  const fields = children(der, c.content);
  let i = 0;
  if (fields[i]?.tag === 0x02) i++;
  if (fields[i]?.tag !== 0x30) return refuse('the catalog has no usage');
  i++;
  if (fields[i]?.tag === 0x04) i++;
  if (fields[i]?.tag === 0x02) i++;
  if (fields[i]?.tag !== 0x17 && fields[i]?.tag !== 0x18) return refuse('the catalog has no date');
  i++;
  if (fields[i]?.tag === 0x17 || fields[i]?.tag === 0x18) i++;
  if (fields[i]?.tag !== 0x30) return refuse('the catalog has no member algorithm');
  i++;
  const subjects = fields[i];
  if (subjects === undefined || subjects.tag === 0xa0) return [];
  if (subjects.tag !== 0x30) return refuse('the catalog’s members are not a list');
  return children(der, subjects).map((m) => {
    const [, attributes, ...rest] = m.tag === 0x30 ? children(der, m) : [];
    if (attributes?.tag !== 0x31 || rest.length > 0)
      return refuse('a catalog member is not an identifier and its attributes');
    const indirect = children(der, attributes).filter((a) => {
      const [oid] = a.tag === 0x30 ? children(der, a) : [];
      return oid?.tag === 0x06 && oidOf(bytesOf(der, oid)) === OID_INDIRECT_DATA;
    });
    const [attribute, ...twice] = indirect;
    if (attribute === undefined || twice.length > 0)
      return refuse('a catalog member does not name exactly one digest');
    const [, values] = children(der, attribute);
    const [value, ...more] = values?.tag === 0x31 ? children(der, values) : [];
    const [, digestInfo] = value?.tag === 0x30 && more.length === 0 ? children(der, value) : [];
    const [algorithm, digest] = digestInfo?.tag === 0x30 ? children(der, digestInfo) : [];
    const [oid] = algorithm?.tag === 0x30 ? children(der, algorithm) : [];
    const name = oid?.tag === 0x06 ? DIGESTS[oidOf(bytesOf(der, oid))] : undefined;
    if (name === undefined || digest?.tag !== 0x04)
      return refuse('a catalog member’s digest is not SHA-1 or SHA-256');
    const hex = bytesOf(der, digest).toString('hex');
    if (hex.length !== (name === 'sha1' ? 40 : 64))
      return refuse('a catalog member’s digest has the wrong length');
    return { algorithm: name, digest: hex };
  });
}
