/**
 * The Content-Security-Policy main sends as a RESPONSE HEADER with every file `app://nutflix`
 * serves. It is the renderer's own policy, the `<meta>` that is the first element of the
 * renderer's `index.html` (scripts/build.ts and `csp.test.ts` there pin it), read from the file
 * being served, plus `frame-ancestors 'none'`, which a `<meta>` cannot carry. So the two cannot
 * drift: there is no second copy of the policy in this package.
 *
 * `headerPolicy` also refuses a policy that is not strict (fails closed: the app does not start):
 * scripts and styles from `'self'` only, nothing inline, no `eval`, no frames, no plugins.
 */
import { policyOf } from '../../../../packages/renderer/scripts/policy.ts';

export class CspError extends Error {
  override readonly name = 'CspError' as const;
}

/** Directives that must be present, with the one source list each may have. */
const REQUIRED: Readonly<Record<string, string>> = {
  'default-src': "'none'",
  'script-src': "'self'",
  'style-src': "'self'",
  'object-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
  'frame-src': "'none'",
  'worker-src': "'none'",
};

/** `directive -> sources` of a policy. A repeated directive is refused (the first would win, silently). */
export function parsePolicy(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    const name = words[0]?.toLowerCase();
    if (name === undefined) continue;
    if (out.has(name)) throw new CspError(`directive ${name} appears twice`);
    out.set(name, words.slice(1));
  }
  return out;
}

export function assertStrict(policy: string): void {
  const d = parsePolicy(policy);
  for (const [name, want] of Object.entries(REQUIRED)) {
    const got = d.get(name)?.join(' ');
    if (got !== want) throw new CspError(`${name} must be ${want}, not ${got ?? 'absent'}`);
  }
  for (const [name, sources] of d)
    for (const s of sources)
      if (/^'(?:unsafe-inline|unsafe-eval|unsafe-hashes)'$/i.test(s) || s === '*')
        throw new CspError(`${name} allows ${s}`);
  if (d.has('frame-ancestors')) throw new CspError('frame-ancestors belongs to the header only');
}

/** The header value for the page `indexHtml`. Throws `CspError` (or the policy reader's error). */
export function headerPolicy(indexHtml: string): string {
  const policy = policyOf(indexHtml);
  assertStrict(policy);
  return `${policy}; frame-ancestors 'none'`;
}

/** Headers on every `app:` response. After nutflix-pear's `APP_RESPONSE_HEADERS`. */
export function appResponseHeaders(csp: string): Readonly<Record<string, string>> {
  return Object.freeze({
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'no-store',
  });
}
