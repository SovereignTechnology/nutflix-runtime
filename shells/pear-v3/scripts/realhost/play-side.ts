/**
 * The real-host proof, on the PLAYING machine (Y), another network than `seed-side.ts`'s. Never on
 * a CI runner: it joins the public HyperDHT. Run it as a user that is not root (Chromium's sandbox
 * stays on, as the ready line must say).
 *
 *   tunnel     127.0.0.1:RELAY_PORT here becomes the seeding machine's relay, over HyperDHT
 *   install    `pear install <link>` from the PUBLIC DHT, into a home of its own; the installed
 *              AppImage must be, byte for byte, the build the seeding machine staged
 *   seeding    the switch "Seed what you watch" is set in the worker's own file (`seeding.json`,
 *              `watched: true`), as main writes it after the user confirms the native dialog: this
 *              proof has no one to press that button
 *   play       the INSTALLED app, as installed: its test root's `play` opens the video and plays it
 *              on both paths (`src/main/play-proof.ts`); what passes is `pear-ci/playback.ts`'s
 *              `playProblems`, on the app's own measurements
 *   reverse    the app keeps running (it now seeds what it watched and publishes its beacon to the
 *              same relay) until the seeding machine says it is done, or 15 minutes
 *
 *   node shells/pear-v3/scripts/realhost/play-side.ts --work <dir> --nonce <hex> [--wait-min 30]
 *
 * It finds the seeding machine's tunnel on the `--nonce` topic (`topicOf`), then reads the link and
 * the staged build's sha256 from that relay's `INFO_PATH`, waiting up to `--wait-min` for both.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';

import { CLIP_HEIGHT, CLIP_WIDTH, playProblems } from '../pear-ci/playback.ts';
import { launch, stopLine } from '../smoke.ts';
import {
  INFO_PATH,
  PublicPear,
  RELAY_PORT,
  STATUS_PATH,
  lookupTunnel,
  topicOf,
  fetchPear,
  field,
  isolatedEnv,
  lastRecord,
  natFacts,
  publicNode,
  say,
  sleep,
  succeeded,
  failureMessage,
  tail,
  tunnelClient,
} from './common.ts';

const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string): string => {
  const i = argv.indexOf(`--${name}`);
  const v = i === -1 ? dflt : argv[i + 1];
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
const WORK = resolve(arg('work'));
const NONCE = arg('nonce');
const WAIT_MS = Number(arg('wait-min', '30')) * 60_000;

/** GET `path` on the seeding machine's relay, through the tunnel: its JSON, or null. */
function getJson<T>(path: string): Promise<T | null> {
  return new Promise((r) => {
    const req = request(
      { host: '127.0.0.1', port: RELAY_PORT, path, timeout: 20_000 },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString('utf8')));
        res.on('end', () => {
          try {
            r(JSON.parse(body) as T);
          } catch {
            r(null);
          }
        });
      },
    );
    req.on('error', () => {
      r(null);
    });
    req.on('timeout', () => {
      req.destroy();
      r(null);
    });
    req.end();
  });
}

/** The seeding machine's word: `{ done }`, or null when it does not answer. */
const status = (): Promise<{ done: boolean } | null> => getJson<{ done: boolean }>(STATUS_PATH);

async function main(): Promise<number> {
  mkdirSync(WORK, { recursive: true });
  const summary: Record<string, unknown> = {};
  const node = await publicNode();
  summary['natY'] = natFacts(node);
  say(`this machine on the public DHT: ${JSON.stringify(summary['natY'])}`);
  const deadline = Date.now() + WAIT_MS;
  let tunnel: Awaited<ReturnType<typeof tunnelClient>> | undefined;
  let pear: PublicPear | undefined;
  try {
    // ---- the seeding machine: its tunnel on the topic, then its relay through it ------------------
    const t = Date.now();
    const topic = topicOf(NONCE);
    let info: { link: string; appSha256: string } | null = null;
    let beat = 0;
    while (info === null) {
      if (Date.now() > deadline) throw new Error('the seeding machine never named a seeded link');
      if (tunnel === undefined) {
        const keys = await lookupTunnel(node, topic).catch(() => []);
        if (keys.length > 1) say(`${String(keys.length)} tunnels on the topic; the first answering wins`);
        for (const k of keys) {
          const c = await tunnelClient(node, k, RELAY_PORT);
          if ((await status()) !== null) {
            tunnel = c;
            summary['tunnel'] = { key: k, foundMs: Date.now() - t };
            say(`tunnel up: ${JSON.stringify(summary['tunnel'])}`);
            break;
          }
          await c.close();
        }
      }
      if (tunnel !== undefined) {
        const got = await getJson<{ info: { link: string; appSha256: string } | null }>(INFO_PATH);
        info = got?.info ?? null;
      }
      if (info === null) {
        if (Date.now() - beat > 30_000) {
          beat = Date.now();
          say(`waiting for the seeding machine (${tunnel === undefined ? 'no tunnel on the topic yet' : 'tunnel up, link not seeded yet'})`);
        }
        await sleep(5000);
      }
    }
    const LINK = info.link;
    const APP_SHA = info.appSha256;
    if (!/^pear:\/\/[a-z0-9]{52}$/.test(LINK) || !/^[0-9a-f]{64}$/.test(APP_SHA))
      throw new Error('the seeding machine named no link or digest of the right shape');
    say(`link ${LINK}; staged AppImage sha256 ${APP_SHA}; tunnel remotes ${JSON.stringify(tunnel?.stats.remotes)}`);
    summary['link'] = LINK;

    // ---- pear install, from the public DHT ---------------------------------------------------------
    const fetched = await fetchPear('linux-x64', join(WORK, 'tools'));
    say(`pear CLI ${fetched.asset} sha256 ${fetched.sha256} (pinned, checked)`);
    const home = join(WORK, 'home');
    pear = new PublicPear(fetched.bin, home, join(WORK, 'logs'));
    for (const d of [join('.local', 'bin'), join('.local', 'share', 'applications')])
      mkdirSync(join(home, d), { recursive: true });
    let last: Awaited<ReturnType<PublicPear['run']>> | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      last = await pear.run(
        `install-${String(attempt)}`,
        ['install', '--json', '--timeout', '300', LINK],
        900,
      );
      say(`pear install attempt ${String(attempt)}: exit ${String(last.code)}, ${String(last.ms)} ms`);
      if (last.code === 0 && succeeded(last.records)) break;
      say(tail(last.out, 8));
    }
    if (last === undefined || last.code !== 0 || !succeeded(last.records))
      throw new Error(`pear install: ${failureMessage(last?.records ?? []) ?? tail(last?.out ?? '', 6)}`);
    const dest = field(lastRecord(last.records, 'app'), 'dest');
    const peers = last.records.filter((r) => r.tag === 'stats').map((r) => r.data['peers']);
    if (dest === undefined || !existsSync(dest)) throw new Error(`pear install says ${String(dest)}`);
    const got = createHash('sha256').update(readFileSync(dest)).digest('hex');
    summary['install'] = {
      ms: last.ms,
      peersSeen: peers.slice(-1),
      sha256MatchesStaged: got === APP_SHA,
    };
    say(`installed: ${JSON.stringify(summary['install'])}`);
    if (got !== APP_SHA) throw new Error('the installed AppImage is not the staged build');

    // ---- the switch, as main stores it after the native confirmation --------------------------------
    const worker = join(home, '.config', 'nutflix-runtime', 'worker');
    mkdirSync(worker, { recursive: true });
    writeFileSync(join(worker, 'seeding.json'), `${JSON.stringify({ v: 1, watched: true, videos: {} })}\n`);

    // ---- the installed app plays, then seeds ------------------------------------------------------------
    let heldMs = 0;
    const r = await launch(dest, [], 'ready', 900, {
      env: isolatedEnv(home),
      updates: 'on',
      waitFor: 'play-proof-done',
      collect: ['play-proof', 'play-proof-done'],
      onReady: async () => {
        // The app is still running: it seeds what it watched. Keep it until X has fetched it back.
        const until = Date.now() + 15 * 60_000;
        const from = Date.now();
        let beat = 0;
        for (;;) {
          const s = await status();
          if (s?.done === true || Date.now() > until) break;
          if (Date.now() - beat > 30_000) {
            beat = Date.now();
            say(`seeding; waiting for the seeding machine to finish (${String(Math.round((Date.now() - from) / 1000))} s)`);
          }
          await sleep(5000);
        }
        heldMs = Date.now() - from;
      },
    });
    for (const e of r.collected) say(`${e.name} ${JSON.stringify(e.fields)}`);
    say(`launch: ${r.ok ? 'ok' : 'FAIL'} ${r.reason}; events ${r.events.join(', ')}; held ${String(heldMs)} ms; stop: ${stopLine(r.stopped)}`);
    if (!r.ok) say(r.tail.slice(-60).join('\n'));
    const byPath = (p: string): Record<string, unknown> | undefined =>
      r.collected.find((e) => e.name === 'play-proof' && e.fields['path'] === p)?.fields;
    const clip = { width: CLIP_WIDTH, height: CLIP_HEIGHT };
    const problems = [
      ...playProblems(byPath('progressive'), 'progressive', clip),
      ...playProblems(byPath('webrtc'), 'webrtc', clip),
    ];
    summary['play'] = {
      launchOk: r.ok,
      reason: r.reason,
      ready: r.ready,
      progressive: byPath('progressive'),
      webrtc: byPath('webrtc'),
      done: r.collected.find((e) => e.name === 'play-proof-done')?.fields,
      problems,
      heldForReverseMs: heldMs,
      updates: r.updates.slice(-3),
    };
    say(`test 1 on Y: ${problems.length === 0 && r.ok ? 'PLAYED' : 'NOT PLAYED'} ${JSON.stringify(problems)}`);
  } catch (e) {
    summary['error'] = e instanceof Error ? (e.stack ?? e.message) : String(e);
    say(`FAIL ${String(summary['error'])}`);
  } finally {
    if (pear !== undefined) {
      const sc = await pear.run('sidecar-shutdown', ['sidecar', 'shutdown'], 90);
      say(`sidecar shutdown: exit ${String(sc.code)}`);
    }
    await tunnel?.close().catch(() => undefined);
    await node.destroy().catch(() => undefined);
    process.stdout.write(`REALHOST_PLAY_SUMMARY ${JSON.stringify(summary)}\n`);
  }
  return summary['error'] === undefined ? 0 : 1;
}

process.exitCode = await main();
setTimeout(() => process.exit(), 2000).unref();
