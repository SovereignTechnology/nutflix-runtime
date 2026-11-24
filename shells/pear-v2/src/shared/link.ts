/**
 * Which link this app was started from (ADR 0001 decision 2, amendment item 1). Pear v2 updates
 * an app started from its plain `pear://<key>` link whenever that key releases, with no notice and
 * no second key. So this build runs its worker only from a versioned link,
 * `pear://<fork>.<length>.<key>`, the form a signed release notice names. A local directory or
 * `file:` run (development, the proof) is allowed. Anything else counts as unversioned.
 */
export type LinkKind = 'versioned' | 'unversioned' | 'local';

const VERSIONED = /^pear:\/\/\d+\.\d+\.[ybndrfg8ejkmcpqxot1uwisza345h769]{52}(?:\/|$)/;

export function linkKind(link: unknown): LinkKind {
  if (typeof link !== 'string') return 'unversioned';
  if (link.startsWith('pear://')) return VERSIONED.test(link) ? 'versioned' : 'unversioned';
  if (link.startsWith('file:///') || (link.startsWith('/') && !link.startsWith('//')))
    return 'local';
  return 'unversioned';
}

/** What the window says, as text, when it will not run from this link. */
export const UNVERSIONED_REFUSAL =
  'Nutflix will not run from this link. It is unversioned, so Pear v2 would update it with no signed notice. Run the versioned link, pear://<fork>.<length>.<key>, that the SovTech release notice names: see this app’s README. Better still, use the Pear v3 app: pear install.';
