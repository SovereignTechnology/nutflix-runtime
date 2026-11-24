/**
 * The parts of Pear v2.6.5 this shell uses, read from its source at the tag and from
 * `pear-electron` 1.7.28. `Pear` here is the Bare side's global; the page reads its own through
 * `src/page/legacy.ts`, which checks what it finds.
 */
interface PearIpc {
  /** A file of the app's drive (`/page/index.html`), or `null`. */
  get(params: { readonly key: string }): Promise<Uint8Array | null>;
}

interface PearVersions {
  readonly platform?: {
    readonly key?: unknown;
    readonly fork?: unknown;
    readonly length?: unknown;
  };
  readonly app?: { readonly key?: unknown; readonly fork?: unknown; readonly length?: unknown };
  readonly runtimes?: { readonly bare?: unknown; readonly pear?: unknown };
}

interface PearConfig {
  /** The app's own directory under the platform's. */
  readonly storage: string;
  readonly link?: string;
  readonly dht?: { readonly bootstrap?: readonly { host: string; port: number }[] | null };
}

interface PearGlobal {
  readonly constructor: { readonly IPC: symbol };
  readonly config: PearConfig;
  versions(): Promise<PearVersions>;
  teardown(fn: () => void | Promise<void>): void;
  exit(code?: number): void;
}

declare const Pear: PearGlobal;

declare module 'pear-electron' {
  export interface UiPipe {
    write(chunk: Uint8Array): boolean;
    end(): unknown;
    destroy(err?: Error): unknown;
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'end' | 'close', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }
  export default class PearElectron {
    start(opts: { readonly bridge: { readonly addr: string } }): Promise<UiPipe>;
  }
}

declare module 'hypercore-id-encoding' {
  const id: { normalize(key: unknown): string };
  export default id;
}
