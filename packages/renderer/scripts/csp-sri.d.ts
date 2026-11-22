// The types of the submodule's `scripts/csp-sri.mjs` (nutflix-pear, pinned): only what build.ts uses.
declare module '*/csp-sri.mjs' {
  export interface Csp {
    readonly meta: string;
    readonly header: string;
  }
  export function processHtml(
    html: string,
    o: { readonly root: string; readonly htmlDir: string; readonly csp: Csp },
  ): {
    readonly html: string;
    readonly headers: string;
    readonly violations: readonly string[];
    readonly assets: readonly {
      readonly tag: string;
      readonly path: string;
      readonly integrity: string;
    }[];
  };
}
