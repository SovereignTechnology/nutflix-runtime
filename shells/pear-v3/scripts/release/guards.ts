/**
 * What stands between this tool and a real link. Every rule here fails closed:
 *
 *   - A step that would join the public DHT refuses to run on CI, whatever else it is told. GitHub
 *     disabled Actions on another repository of this owner for hosting a peer.
 *   - A step that changes a real link needs `--execute` AND the link typed back on a terminal. Only
 *     a person at a terminal can do the second: it is not a flag, and stdin that is not a TTY is
 *     refused.
 */
import { createInterface } from 'node:readline/promises';

import { VERLINK } from '../../src/update/notice.ts';
import { PLAIN_VERSION } from '../../src/update/status.ts';

export class ReleaseRefusal extends Error {
  override readonly name = 'ReleaseRefusal' as const;
}

export const refuse = (why: string): never => {
  throw new ReleaseRefusal(why);
};

/** `pear://<z32 key>`, unversioned. */
export const LINK = /^pear:\/\/[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;

/** The variables that mean "this is a CI job". Being set at all counts, even to an empty string. */
export const CI_VARIABLES = ['CI', 'GITHUB_ACTIONS'] as const;

export function onCi(env: NodeJS.ProcessEnv): boolean {
  return CI_VARIABLES.some((k) => env[k] !== undefined);
}

export function refuseOnCi(env: NodeJS.ProcessEnv, what: string): void {
  if (onCi(env))
    refuse(`${what} joins the public DHT, and this is a CI job (CI or GITHUB_ACTIONS is set)`);
}

export function assertLink(x: string | undefined, what: string): string {
  if (x === undefined || !LINK.test(x)) return refuse(`${what} must be pear://<key>, unversioned`);
  return x;
}

export function assertVerlink(x: string | undefined, what: string): string {
  if (x === undefined || !VERLINK.test(x))
    return refuse(`${what} must be a versioned link, pear://<fork>.<length>.<key>`);
  return x;
}

export function assertVersion(x: unknown, what: string): string {
  if (typeof x !== 'string' || !PLAIN_VERSION.test(x))
    return refuse(`${what} must be a plain a.b.c version, got ${JSON.stringify(x)}`);
  return x;
}

/** The key part of a link or a versioned link. */
export function linkKeyOf(link: string): string {
  const key = link.slice(link.lastIndexOf('.') + 1).replace(/^pear:\/\//, '');
  return assertLink(`pear://${key}`, 'the link').slice('pear://'.length);
}

/** How the typed-back line is read; tests pass their own. */
export type AskLine = (prompt: string) => Promise<string>;

/** Reads one line from the terminal. Anything but a TTY on stdin is refused. */
export const askOnTerminal: AskLine = async (prompt) => {
  if (!process.stdin.isTTY)
    return refuse('the link has to be typed back on a terminal, and stdin is not one');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
};

/** Asks for `link` to be typed back, and refuses anything but exactly that. */
export async function confirmLink(link: string, ask: AskLine): Promise<void> {
  const typed = await ask(`This changes ${link}. Type that link to go on: `);
  if (typed.trim() !== link) refuse('what was typed is not the link: nothing was done');
}

/**
 * `fn` must be refused by this tool, for this reason. A crash or a timeout is not a refusal, and a
 * negative proof that accepted one would pass with the check broken.
 */
export async function expectRefusal(
  what: string,
  fn: () => unknown,
  reason: RegExp,
): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  if (err === undefined) throw new Error(`${what}: it was accepted`);
  if (!(err instanceof Error)) throw new Error(`${what}: something other than an error was thrown`);
  if (!(err instanceof ReleaseRefusal) || !reason.test(err.message))
    throw new Error(`${what}: it failed for another reason: ${err.message}`);
}
