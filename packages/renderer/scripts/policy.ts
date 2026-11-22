/** The CSP of `index.html`, apart from `build.ts` so that the tests can read it without esbuild. */

/** The policy in `index.html`'s first <meta>, which must be the first element of <head>. */
export function policyOf(html: string): string {
  const head = /<head\b[^>]*>\s*(<meta\b[^>]*>)/i.exec(html)?.[1];
  const m =
    head === undefined
      ? null
      : /^<meta\s+http-equiv\s*=\s*"Content-Security-Policy"\s+content\s*=\s*"([^"]*)"\s*\/?>$/i.exec(
          head,
        );
  if (m?.[1] === undefined) {
    throw new Error('index.html: the CSP <meta> must be the first element of <head>');
  }
  return m[1];
}
