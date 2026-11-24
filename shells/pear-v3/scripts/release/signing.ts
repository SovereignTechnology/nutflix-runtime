/**
 * The owner signs the macOS and Windows packages with real certificates (`docs/release.md`). That
 * changes their bytes, so a signed package cannot equal CI's digest. What it can be is CI's package
 * with signatures added and NOTHING else changed, and this is that check:
 *
 *   - A macOS bundle: every file, symlink and executable bit equal, except a bundle's or a
 *     framework's own `_CodeSignature/`, the stapled `Contents/CodeResources`, and Mach-O binaries,
 *     whose code must be equal once their signature is taken out (`binary.ts`). Every Mach-O in
 *     the signed bundle, re-signed or not, must then carry a signature that says what
 *     `signing-policy.ts` pins (who, which flags, which entitlements) and that is valid: its code
 *     directories hash the code page by page, and each special slot hashes what it names.
 *   - An `.msix`: every part equal, by sha256, except the signature part, and the content types,
 *     which may differ only by the entries that declare it. The signer must be the pinned
 *     certificate. A code-integrity catalog that signing adds must be a trust list signed by the
 *     same certificate, every member of which is the Authenticode digest of a binary in the
 *     package: a catalog cannot vouch for code the package does not hold.
 *
 * CI's digest is never regenerated from a signed package: it stays the reference.
 */
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { treeManifest } from '../pear-ci/deployment.ts';
import { readRelease, writeReleaseFile, type ReleaseRow } from './assemble.ts';
import {
  assertSignatureValid,
  isMachoFile,
  machoCodeDigest,
  machoSignatures,
  peAuthenticodeDigest,
} from './binary.ts';
import { artifactBytes, digestOf } from './digest.ts';
import { refuse } from './guards.ts';
import { assertPackageArch, assertProductionRoot, packageFacts } from './inspect.ts';
import { catalogMembers, msixSigner, signedContent, type SignerCertificate } from './pkcs7.ts';
import {
  assertMacSignature,
  assertSigningPolicy,
  fingerprintOf,
  productionSigningPolicy,
  type SigningPolicy,
} from './signing-policy.ts';
import { RELEASE_TARGETS, type ReleaseTarget } from './targets.ts';
import { forEachZipFile, type ZipEntry } from './zip.ts';

/**
 * What signing and notarizing a bundle may add or rewrite: an app bundle's own
 * `Contents/_CodeSignature/`, a framework version's `_CodeSignature/`, and the stapled ticket.
 */
export const isBundleSignaturePath = (path: string): boolean =>
  /^(?:.+\.app\/)?Contents\/_CodeSignature\/[^/]+$/.test(path) ||
  /^(?:.+\/)?[^/]+\.framework\/Versions\/[^/]+\/_CodeSignature\/[^/]+$/.test(path) ||
  path === 'Contents/CodeResources';

/** The part of an `.msix` that signing it adds. */
export const MSIX_SIGNATURE = 'AppxSignature.p7x';
export const MSIX_CONTENT_TYPES = '[Content_Types].xml';
/** The code-integrity catalog SignTool may add for the package's binaries. */
export const MSIX_CATALOG = 'AppxMetadata/CodeIntegrity.cat';
const MAX_CATALOG_BYTES = 1024 * 1024;
/** What signing may add to the content types: the signature's own declaration, and nothing else. */
export function isSignatureType(entry: string, catalogAdded = false): boolean {
  const m = /^<(Default|Override)((?:\s+[A-Za-z]+="[^"<>]*")+)\s*\/>$/.exec(entry);
  if (m === null) return false;
  const attrs = new Map(
    [...(m[2] ?? '').matchAll(/([A-Za-z]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]),
  );
  if (attrs.size !== 2) return false;
  const type = attrs.get('ContentType')?.toLowerCase();
  if (type === 'application/vnd.ms-appx.signature')
    return m[1] === 'Default'
      ? attrs.get('Extension')?.toLowerCase() === 'p7x'
      : attrs.get('PartName')?.toLowerCase() === '/appxsignature.p7x';
  if (catalogAdded && type === 'application/vnd.ms-pkiseccat')
    return m[1] === 'Default'
      ? attrs.get('Extension')?.toLowerCase() === 'cat'
      : attrs.get('PartName')?.toLowerCase() === `/${MSIX_CATALOG}`.toLowerCase();
  return false;
}

/**
 * The files a Mach-O at `path` may seal besides its code: its bundle's Info.plist and resource seal,
 * when it is that bundle's main executable (an app's, XPC service's or extension's
 * `Contents/MacOS/*`, or a framework version's own binary). Anything else seals neither.
 */
export function sealedFilesOf(path: string): { infoPlist: string; resources: string } | null {
  const app = /^((?:.+\.(?:app|xpc|appex)\/)?Contents)\/MacOS\/[^/]+$/.exec(path);
  if (app !== null)
    return {
      infoPlist: `${app[1] ?? ''}/Info.plist`,
      resources: `${app[1] ?? ''}/_CodeSignature/CodeResources`,
    };
  // A framework's own binary has the framework's name; other tools beside it seal nothing of it.
  const framework = /^(.+\/([^/]+)\.framework\/Versions\/[^/]+)\/\2$/.exec(path);
  if (framework !== null)
    return {
      infoPlist: `${framework[1] ?? ''}/Resources/Info.plist`,
      resources: `${framework[1] ?? ''}/_CodeSignature/CodeResources`,
    };
  return null;
}

async function compareBundle(
  unsigned: string,
  signed: string,
  policy: SigningPolicy,
): Promise<void> {
  const a = await treeManifest(unsigned);
  const b = await treeManifest(signed);
  for (const [path, x] of a) {
    const y = b.get(path);
    if (y === undefined) {
      if (!isBundleSignaturePath(path)) refuse(`signing removed ${path}`);
      continue;
    }
    if (isBundleSignaturePath(path)) continue;
    if (x.kind !== y.kind) refuse(`signing changed ${path} from a ${x.kind} to a ${y.kind}`);
    if (x.kind === 'link') {
      if (x.target !== y.target) refuse(`signing changed the link ${path}`);
      continue;
    }
    if (x.exec !== y.exec) refuse(`signing changed the executable bit of ${path}`);
    if (x.sha256 === y.sha256) continue;
    const before = machoCodeDigest(readFileSync(join(unsigned, ...path.split('/'))));
    const after = machoCodeDigest(readFileSync(join(signed, ...path.split('/'))));
    if (before === null || after === null || before !== after)
      refuse(`signing changed more than the signature of ${path}`);
  }
  for (const path of b.keys())
    if (!a.has(path) && !isBundleSignaturePath(path)) refuse(`signing added ${path}`);

  // Every Mach-O in the signed bundle, re-signed or left as CI built it: what its signature says
  // is pinned, and the signature must be valid for its code and for what it seals.
  const read = (rel: string): Buffer | null => {
    const e = b.get(rel);
    return e?.kind === 'file' ? readFileSync(join(signed, ...rel.split('/'))) : null;
  };
  for (const [path, e] of b) {
    if (e.kind !== 'file' || !isMachoFile(join(signed, ...path.split('/')))) continue;
    const bytes = readFileSync(join(signed, ...path.split('/')));
    const signatures = machoSignatures(bytes);
    if (signatures === null) return refuse(`the signature of ${path} cannot be read`);
    for (const slice of signatures)
      assertMacSignature(path, slice.fileType, slice.signature, policy);
    const sealed = sealedFilesOf(path);
    assertSignatureValid(
      bytes,
      {
        infoPlist: sealed === null ? null : read(sealed.infoPlist),
        resources: sealed === null ? null : read(sealed.resources),
      },
      path,
    );
  }
}

interface MsixPart {
  readonly sha256: string;
  /** Kept for the parts this reads: the signature, the content types, the catalog. */
  readonly bytes: Buffer;
  /** A Windows binary's Authenticode digests, as `sha1:<hex>` and `sha256:<hex>`. */
  readonly authenticode: readonly string[];
}

function msixParts(file: string): Map<string, MsixPart> {
  const parts = new Map<string, MsixPart>();
  forEachZipFile(file, (e: ZipEntry, bytes) => {
    const kept =
      e.name === MSIX_SIGNATURE || e.name === MSIX_CONTENT_TYPES || e.name === MSIX_CATALOG;
    const authenticode: string[] = [];
    for (const algorithm of ['sha1', 'sha256'] as const) {
      const d = peAuthenticodeDigest(bytes, algorithm);
      if (d !== null) authenticode.push(`${algorithm}:${d}`);
    }
    parts.set(e.name, {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: kept ? bytes : Buffer.alloc(0),
      authenticode,
    });
  });
  return parts;
}

/**
 * The entries of a content-types part, by a key that ignores attribute order, spacing and the case
 * of values (OPC compares part names, extensions and types without case), and the text around them,
 * without the XML declaration.
 */
function contentTypes(text: string): {
  readonly frame: string;
  readonly entries: ReadonlyMap<string, string>;
} {
  const entries = new Map<string, string>();
  const frame = text
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[^<>]*\?>/, '')
    .replace(/<(?:Default|Override)\s[^<>]*\/>/g, (e) => {
      const kind = /^<(\w+)/.exec(e)?.[1] ?? '';
      const attrs = [...e.matchAll(/([A-Za-z]+)\s*=\s*"([^"]*)"/g)]
        .map(([, k = '', v = '']) => `${k}=${v.toLowerCase()}`)
        .sort();
      entries.set(`${kind} ${attrs.join(' ')}`, e.replace(/\s+/g, ' ').replace(/\s*\/>$/, '/>'));
      return '';
    })
    .replace(/\s+/g, '');
  return { frame, entries };
}

export function compareContentTypes(
  unsigned: Buffer | undefined,
  signed: Buffer | undefined,
  catalogAdded: boolean,
): void {
  if (unsigned === undefined || signed === undefined)
    return refuse(`${MSIX_CONTENT_TYPES} is missing`);
  const a = contentTypes(unsigned.toString('utf8'));
  const b = contentTypes(signed.toString('utf8'));
  if (a.frame !== b.frame || [...a.entries.keys()].some((k) => !b.entries.has(k)))
    refuse(`signing changed ${MSIX_CONTENT_TYPES}`);
  for (const [k, e] of b.entries)
    if (!a.entries.has(k) && !isSignatureType(e, catalogAdded))
      refuse(`signing added ${e} to ${MSIX_CONTENT_TYPES}`);
}

const sameSigner = (a: SignerCertificate, b: SignerCertificate): boolean =>
  fingerprintOf(a.sha256) === fingerprintOf(b.sha256) &&
  a.subject === b.subject &&
  a.issuer === b.issuer;

function compareMsix(unsigned: string, signed: string, policy: SigningPolicy): void {
  const a = msixParts(unsigned);
  const b = msixParts(signed);
  const catalog = b.get(MSIX_CATALOG);
  const catalogNew = catalog !== undefined && a.get(MSIX_CATALOG)?.sha256 !== catalog.sha256;
  for (const [name, part] of a) {
    if (name === MSIX_SIGNATURE || name === MSIX_CONTENT_TYPES || name === MSIX_CATALOG) continue;
    const other = b.get(name);
    if (other === undefined) return refuse(`signing removed ${name}`);
    if (other.sha256 !== part.sha256) refuse(`signing changed ${name}`);
  }
  if (a.has(MSIX_CATALOG) && catalog === undefined) refuse(`signing removed ${MSIX_CATALOG}`);
  for (const name of b.keys())
    if (!a.has(name) && name !== MSIX_SIGNATURE && name !== MSIX_CATALOG)
      refuse(`signing added ${name}`);
  compareContentTypes(
    a.get(MSIX_CONTENT_TYPES)?.bytes,
    b.get(MSIX_CONTENT_TYPES)?.bytes,
    catalog !== undefined && !a.has(MSIX_CATALOG),
  );
  const signature = b.get(MSIX_SIGNATURE);
  if (signature === undefined) return refuse(`${signed} has no signature`);
  const pinned = policy.windowsSigner;
  if (pinned === null)
    return refuse(
      `no Windows signing certificate is pinned (${policy.label}): a signed .msix is refused`,
    );
  const signer = msixSigner(signature.bytes);
  if (!sameSigner(signer, pinned))
    refuse(
      `${signed} is signed by ${signer.subject} (${signer.sha256}), not the pinned certificate`,
    );
  if (catalogNew) assertCatalog(catalog.bytes, b, pinned);
}

/** A catalog signing added or replaced: bounded, the pinned signer's, and only this package's code. */
function assertCatalog(
  bytes: Buffer,
  parts: ReadonlyMap<string, MsixPart>,
  pinned: SignerCertificate,
): void {
  if (bytes.length > MAX_CATALOG_BYTES)
    refuse(`${MSIX_CATALOG} is larger than any catalog of a package`);
  const content = signedContent(bytes);
  if (!sameSigner(content.signer, pinned))
    refuse(`${MSIX_CATALOG} is signed by ${content.signer.subject}, not the pinned certificate`);
  const members = catalogMembers(content);
  const known = new Set<string>();
  for (const p of parts.values()) for (const d of p.authenticode) known.add(d);
  for (const m of members)
    if (!known.has(`${m.algorithm}:${m.digest}`))
      refuse(
        `${MSIX_CATALOG} names ${m.algorithm} ${m.digest.slice(0, 16)}…, which is no binary in the package`,
      );
}

/** Refuses unless `signed` is `unsigned` with signatures added, and nothing else changed. */
export async function compareSigned(
  t: ReleaseTarget,
  unsigned: string,
  signed: string,
  policy: SigningPolicy = productionSigningPolicy(),
): Promise<void> {
  if (t.platform === 'linux') return refuse('an AppImage is not signed: it ships as CI built it');
  assertSigningPolicy(policy);
  if (t.platform === 'darwin') {
    if (!lstatSync(signed).isDirectory()) return refuse(`${signed} is not a bundle`);
    await compareBundle(unsigned, signed, policy);
    return;
  }
  if (!lstatSync(signed).isFile()) return refuse(`${signed} is not a file`);
  compareMsix(unsigned, signed, policy);
}

export interface SignedRecord {
  readonly target: string;
  readonly before: string;
  readonly after: string;
  readonly bytes: number;
}

/**
 * Takes in a package the owner signed: CI's unsigned package must still be what was checked, the
 * signed one must differ from it only by signatures, and its root, version, commit and CPU are read
 * again from the signed tree. It then replaces the unsigned package in the deployment.
 */
export async function recordSigned(
  out: string,
  targetName: string,
  signed: string,
  policy: SigningPolicy = productionSigningPolicy(),
): Promise<SignedRecord> {
  const release = readRelease(out);
  const t = RELEASE_TARGETS.find((x) => x.name === targetName);
  if (t === undefined) return refuse(`${targetName} is not a target`);
  if (!signed.endsWith(`/${t.file}`) && !signed.endsWith(`\\${t.file}`))
    return refuse(`the signed package must be named ${t.file}`);
  const row = release.targets.find((x) => x.target === t.name);
  if (row === undefined) return refuse(`release.json has no ${t.name}`);
  if (row.signed !== undefined) return refuse(`${t.name} already has a signed package recorded`);
  if ((await digestOf(row.app)) !== row.ci.digest)
    return refuse(`${row.app} is no longer the package CI built`);

  // Copied first, and every check made on the copy: what is checked is what ships.
  const dir = join(out, 'signed', t.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const app = join(dir, t.file);
  cpSync(signed, app, { recursive: true, verbatimSymlinks: true });
  try {
    await compareSigned(t, row.app, app, policy);
    const facts = packageFacts(app);
    assertProductionRoot(app, facts);
    if (facts.version !== release.version)
      refuse(`${signed} says version ${facts.version}, not ${release.version}`);
    if (facts.commit !== release.commit)
      refuse(`${signed} was built from ${String(facts.commit)}, not ${release.commit}`);
    assertPackageArch(app, t.arch);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const digest = await digestOf(app);
  const bytes = await artifactBytes(app);
  const notice = join(out, 'notice-files', t.noticeName);
  rmSync(notice, { recursive: true, force: true });
  cpSync(app, notice, { recursive: true, verbatimSymlinks: true });
  const targets: ReleaseRow[] = release.targets.map((x) =>
    x.target === t.name ? { ...x, signed: { app, digest, bytes } } : x,
  );
  writeReleaseFile(out, { ...release, targets });
  return { target: t.name, before: row.ci.digest, after: digest, bytes };
}
