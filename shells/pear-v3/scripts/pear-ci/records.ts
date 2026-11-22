/**
 * Reading what the Pear CLI prints with `--json` (one JSON object per line: `{cmd, tag, data}`),
 * and what its sidecar writes to `pear.log` about the DHT it was told to use.
 */

export interface PearRecord {
  readonly cmd?: string;
  readonly tag: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** The JSON objects among the lines of `text`; anything else (banners, stack traces) is skipped. */
export function parseRecords(text: string): PearRecord[] {
  const out: PearRecord[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const j: unknown = JSON.parse(line);
      if (typeof j !== 'object' || j === null) continue;
      const o = j as Record<string, unknown>;
      if (typeof o['tag'] !== 'string') continue;
      const data = o['data'];
      out.push({
        ...(typeof o['cmd'] === 'string' ? { cmd: o['cmd'] } : {}),
        tag: o['tag'],
        data:
          typeof data === 'object' && data !== null && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : {},
      });
    } catch {
      // not a record
    }
  }
  return out;
}

/** The last record with `tag`, if any. */
export function lastRecord(records: readonly PearRecord[], tag: string): PearRecord | undefined {
  for (let i = records.length - 1; i >= 0; i--) if (records[i]?.tag === tag) return records[i];
  return undefined;
}

/** A string field of a record's data. */
export function field(r: PearRecord | undefined, name: string): string | undefined {
  const v = r?.data[name];
  return typeof v === 'string' ? v : undefined;
}

/** `final.data.success === true`, the way every Pear op ends. */
export function succeeded(records: readonly PearRecord[]): boolean {
  return lastRecord(records, 'final')?.data['success'] === true;
}

/** The first `error` record's message, or the failing `final`'s. */
export function failureMessage(records: readonly PearRecord[]): string | undefined {
  const e = records.find((r) => r.tag === 'error');
  const m = e?.data['message'] ?? e?.data['code'];
  if (typeof m === 'string') return m;
  const f = lastRecord(records, 'final');
  return f?.data['success'] === false ? JSON.stringify(f.data).slice(0, 300) : undefined;
}

export interface BootstrapProof {
  /** The sidecar logged that it was given a bootstrap. */
  readonly set: boolean;
  /** The lines that say so, and what it did about known nodes. */
  readonly lines: readonly string[];
  /** It read its known-nodes cache: that only happens when no bootstrap was given. */
  readonly readKnownNodes: boolean;
  /** The bootstrap line names this address. */
  readonly names: boolean;
}

/**
 * What the sidecar's own log says about its DHT (`subsystems/sidecar/index.js`, `#ensureSwarm`):
 * `DHT bootstrap set <nodes>` when `--dht-bootstrap` reached it, and `DHT known-nodes read from
 * database` only when it did not (it then starts from the cache and the public bootstrap).
 */
export function bootstrapProof(logText: string, bootstrap: string): BootstrapProof {
  const lines = logText
    .split(/\r?\n/)
    .filter((l) => /DHT bootstrap set|DHT known-nodes/.test(l))
    .map((l) => l.trim().slice(0, 300));
  const [host = '', port = ''] = bootstrap.split(':');
  const setLines = lines.filter((l) => l.includes('DHT bootstrap set'));
  return {
    set: setLines.length > 0,
    lines,
    readKnownNodes: lines.some((l) => l.includes('known-nodes read from database')),
    names: setLines.some((l) => l.includes(host) && l.includes(port)),
  };
}

/** `127.0.0.1:49737` or `127.0.0.1:49737,127.0.0.1:1`: loopback only, or it throws. */
export function assertLoopbackBootstrap(bootstrap: string): void {
  const nodes = bootstrap.split(',');
  if (nodes.length === 0 || nodes.some((n) => !/^127\.0\.0\.1:\d{2,5}$/.test(n)))
    throw new Error(`the private bootstrap must be 127.0.0.1:<port> only, got ${bootstrap}`);
}
