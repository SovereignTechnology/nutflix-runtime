/**
 * The exact `pear` command of each release step, as data: `plan*` builds it, a dry run prints it,
 * and the private-DHT proof runs the very same arguments. Flags are the ones Pear 3.7.0's own
 * command definitions declare (`cmd/index.js`); nothing here is guessed.
 *
 * `confirm` is the real link a step acts on, which must be typed back before it runs.
 * `publicDht` says it joins the DHT: on a real machine that is the public one.
 */
import { releaseRoot } from '../../packaging/update-root.ts';
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

export function planStage(o: { link: string; deployment: string }): PlannedCommand {
  const link = assertLink(o.link, 'the staging link');
  const production = releaseRoot().upgrade;
  if (production !== null && linkKeyOf(link) === linkKeyOf(production))
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

/** A command line a person can read and paste. */
export function renderCommand(bin: string, args: readonly string[]): string {
  const quote = (s: string): string =>
    /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
  return [bin, ...args].map(quote).join(' ');
}
