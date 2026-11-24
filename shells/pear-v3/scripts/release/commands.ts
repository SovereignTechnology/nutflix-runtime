/**
 * The exact `pear` command of each release step, as data: `plan*` builds it, a dry run prints it,
 * and the private-DHT proof runs the very same arguments. Flags are the ones Pear 3.7.0's own
 * command definitions declare (`cmd/index.js`); nothing here is guessed.
 *
 * `confirm` is the real link a step acts on, which must be typed back before it runs.
 * `publicDht` says it joins the DHT: on a real machine that is the public one.
 */
import { assertLink, assertVerlink, linkKeyOf, refuse } from './guards.ts';

export interface PlannedCommand {
  readonly step: string;
  /** Arguments after `pear`. */
  readonly args: readonly string[];
  /** The real link this acts on, to be typed back; `null` when it is local. */
  readonly confirm: string | null;
  readonly publicDht: boolean;
}

/** A request or a signer's response: a z32 string, as `pear multisig` prints it. */
const Z32_BLOB = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{16,8192}$/;

function assertBlob(x: string | undefined, what: string): string {
  if (x === undefined || !Z32_BLOB.test(x)) return refuse(`${what} is not a z32 string`);
  return x;
}

/** How long `pear multisig` waits for peers before each check (its default is 5 s). */
export const PEER_UPDATE_TIMEOUT_MS = '60000';

export function planBuild(o: {
  packageJson: string;
  target: string;
  appFlags: readonly string[];
}): PlannedCommand {
  return {
    step: 'build',
    args: ['build', '--package', o.packageJson, '--target', o.target, '--json', ...o.appFlags],
    confirm: null,
    publicDht: false,
  };
}

export function planStage(o: {
  link: string;
  deployment: string;
  /** The production link, if the source has one: a stage never goes there. */
  production?: string | null;
}): PlannedCommand {
  const link = assertLink(o.link, 'the staging link');
  if (o.production != null && linkKeyOf(link) === linkKeyOf(o.production))
    refuse('that is the production link: production changes only by a multisig');
  return {
    step: 'stage',
    args: ['stage', '--json', link, o.deployment],
    confirm: link,
    publicDht: true,
  };
}

export function planProvision(o: {
  source: string;
  target: string;
  production: string;
}): PlannedCommand {
  const source = assertVerlink(o.source, 'the source');
  const target = assertLink(o.target, 'the provision target');
  const production = assertVerlink(o.production, 'the production version');
  if (linkKeyOf(target) === linkKeyOf(production))
    refuse('the provision target is the production link: production changes only by a multisig');
  if (linkKeyOf(target) === linkKeyOf(source))
    refuse('the provision target is the source: use a pre-production link of its own');
  return {
    step: 'provision',
    args: ['provision', '--json', source, target, production],
    confirm: target,
    publicDht: true,
  };
}

export function planMultisigLink(o: { config: string }): PlannedCommand {
  return {
    step: 'multisig link',
    args: ['multisig', 'link', '--config', o.config, '--json'],
    confirm: null,
    publicDht: true,
  };
}

export function planRequest(o: { config: string; verlink: string }): PlannedCommand {
  const verlink = assertVerlink(o.verlink, 'the provisioned version');
  return {
    step: 'multisig request',
    args: [
      'multisig',
      'request',
      '--config',
      o.config,
      '--peer-update-timeout',
      PEER_UPDATE_TIMEOUT_MS,
      '--json',
      verlink,
    ],
    confirm: `pear://${linkKeyOf(verlink)}`,
    publicDht: true,
  };
}

function quorumArgs(
  action: 'verify' | 'commit',
  o: { config: string; source: string; request: string; responses: readonly string[] },
): string[] {
  const source = assertLink(o.source, 'the provisioned link');
  const request = assertBlob(o.request, 'the request');
  if (o.responses.length === 0) refuse('at least one signer response is needed');
  return [
    'multisig',
    action,
    '--config',
    o.config,
    '--peer-update-timeout',
    PEER_UPDATE_TIMEOUT_MS,
    '--json',
    source,
    request,
    ...o.responses.map((r) => assertBlob(r, 'a response')),
  ];
}

export function planVerify(o: {
  config: string;
  source: string;
  request: string;
  responses: readonly string[];
}): PlannedCommand {
  return {
    step: 'multisig verify',
    args: quorumArgs('verify', o),
    confirm: assertLink(o.source, 'the provisioned link'),
    publicDht: true,
  };
}

/**
 * `pear multisig verify` with no responses: Pear checks the request against the source drive's own
 * tree hash at the request's length, and reports that length and the drive it would write to.
 */
export function planVerifyRequest(o: {
  config: string;
  source: string;
  request: string;
}): PlannedCommand {
  const source = assertLink(o.source, 'the provisioned link');
  return {
    step: 'multisig verify (the request, before signing)',
    args: [
      'multisig',
      'verify',
      '--config',
      o.config,
      '--peer-update-timeout',
      PEER_UPDATE_TIMEOUT_MS,
      '--json',
      source,
      assertBlob(o.request, 'the request'),
    ],
    confirm: source,
    publicDht: true,
  };
}

/**
 * `pear provision --dry-run`: it fetches the source version into a temporary drive and reports that
 * version's db and blobs cores (length, tree hash). A dry run reads no target (Pear does not even
 * parse it), so the source's own link stands in for one.
 */
export function planProvisionDryRun(o: { source: string; production: string }): PlannedCommand {
  const source = assertVerlink(o.source, 'the source');
  return {
    step: 'provision --dry-run',
    args: [
      'provision',
      '--dry-run',
      '--json',
      source,
      `pear://${linkKeyOf(source)}`,
      assertVerlink(o.production, 'the production version'),
    ],
    confirm: null,
    publicDht: true,
  };
}

/** `pear info` of a link: its length and fork, and its blobs'. */
export function planInfo(o: { link: string }): PlannedCommand {
  const link = assertLink(o.link, 'the link');
  return { step: 'info', args: ['info', '--json', link], confirm: link, publicDht: true };
}

/** Fetches one version of a drive into an empty folder, from peers. */
export function planDump(o: { verlink: string; dir: string }): PlannedCommand {
  const verlink = assertVerlink(o.verlink, 'the version to fetch');
  return {
    step: 'dump',
    args: ['dump', '--json', verlink, o.dir],
    confirm: `pear://${linkKeyOf(verlink)}`,
    publicDht: true,
  };
}

export function planCommit(o: {
  config: string;
  source: string;
  production: string;
  request: string;
  responses: readonly string[];
}): PlannedCommand {
  const production = assertLink(o.production, 'the production link');
  if (assertLink(o.source, 'the provisioned link') === production)
    refuse('the source of a commit is the pre-production link, not the production link');
  return {
    step: 'multisig commit',
    args: quorumArgs('commit', o),
    confirm: production,
    publicDht: true,
  };
}

export function planSeed(o: { link: string }): PlannedCommand {
  const link = assertLink(o.link, 'the link to seed');
  return {
    step: 'seed',
    args: ['seed', '--no-tty', '--json', link],
    confirm: link,
    publicDht: true,
  };
}

export interface CoreLengths {
  readonly db: number;
  readonly blobs: number;
}

/**
 * The production verlink and lengths in a `pear multisig commit` final record. Pear's `--json` output
 * has no verlink: it is built here the way its human output builds it, and a multisig core does not
 * fork.
 */
export function committed(
  data: Readonly<Record<string, unknown>> | undefined,
  key: string,
): { verlink: string; lengths: CoreLengths } {
  const r = data?.['result'] as
    | {
        db?: { destCore?: { length?: unknown; key?: unknown } };
        blobs?: { destCore?: { length?: unknown } };
      }
    | undefined;
  const db = r?.db?.destCore?.length;
  const blobs = r?.blobs?.destCore?.length;
  if (typeof db !== 'number' || typeof blobs !== 'number' || db <= 0)
    return refuse('pear multisig commit reported no lengths');
  if (r?.db?.destCore?.key !== key)
    return refuse('pear multisig commit wrote to another key than the production link');
  return { verlink: `pear://0.${String(db)}.${key}`, lengths: { db, blobs } };
}

/** A command line a person can read and paste. */
export function renderCommand(bin: string, args: readonly string[]): string {
  const quote = (s: string): string =>
    /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
  return [bin, ...args].map(quote).join(' ');
}
