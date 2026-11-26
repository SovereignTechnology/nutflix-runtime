/**
 * The real-host proof, on the PLAYING machine (Y), another network than `seed-side.ts`'s. Never on
 * a CI runner: it joins the public HyperDHT. Run it as a user that is not root.
 *
 *   tunnel     127.0.0.1:RELAY_PORT here becomes the seeding machine's relay, over HyperDHT
 *   install    `pear install <link>` from the PUBLIC DHT, into a home of its own; the installed
 *              AppImage must be, byte for byte, the build the seeding machine staged
 *   sandbox    where this machine lets no unprivileged process make the user namespaces Chromium's
 *              sandbox needs (`--sandbox-off`: a container's seccomp filter), the installed AppImage,
 *              started as a user starts it, must reach the sandbox warning by itself (AppRun's
 *              probe), and, with "Run anyway" stored, run with the sandbox off and say so
 *   seeding    the switch "Seed what you watch" is set in the worker's own file (`seeding.json`,
 *              `watched: true`), as main writes it after the user confirms the native dialog: this
 *              proof has no one to press that button
 *   test 1     the INSTALLED app, started as installed (with an argument where the sandbox is off):
 *              its test root's `play` opens the video and plays it on both paths
 *              (`src/main/play-proof.ts`); what passes is `smoke.ts`'s `launch` on the ready line
 *              and `pear-ci/playback.ts`'s `playProblems` on the app's own measurements
 *   test 3     the app keeps running (it now seeds what it watched and publishes its beacon to the
 *              same relay) until the seeding machine has fetched the clip back from it, or 15 min
 *   test 4     shape (b): the seeding machine's throwaway Pear v2.6.5 line and v2 app link, run
 *              here with `pear run` (`shells/pear-v2/proof/realhost.ts play`), the same clip
 *
 *   node shells/pear-v3/scripts/realhost/play-side.ts --work <dir> --nonce <hex> [--wait-min 30]
 *        [--sandbox-off] [--no-t4]
 *
 * It finds the seeding machine's tunnel on the `--nonce` topic (`topicOf`), then reads the link and
 * the staged build's sha256 from that relay's `INFO_PATH`, waiting up to `--wait-min` for both. It
 * exits 0 only when every test it ran played.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { CLIP_HEIGHT, CLIP_WIDTH, playProblems } from '../pear-ci/playback.ts';
import { PKG_DIR } from '../../packaging/paths.ts';
import { launch, stopLine, type LaunchResult } from '../smoke.ts';
import {
  INFO_PATH,
  MARK_PATH,
  PublicPear,
  RELAY_PORT,
  RELAY_URL,
  STATUS_PATH,
  lookupTunnel,
  topicOf,
  fetchPear,
  field,
  isolatedEnv,
  lastRecord,
  minutesArg,
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
const WAIT_MS = minutesArg(arg('wait-min', '30'), 'wait-min');
/** A dry run on ONE machine (`guest.sh both`): the relay is already on this loopback, no tunnel. */
const LOCAL = argv.includes('--local');
/**
 * This machine lets no unprivileged process make a user namespace (`guest.sh` tried `unshare`):
 * Chromium's sandbox cannot start here, and the app must find that out by itself.
 */
const SANDBOX_OFF = argv.includes('--sandbox-off');
/** Test 4 (shape b) is on unless `--no-t4` says it is not run. */
const T4 = !argv.includes('--no-t4');
const CLIP = { width: CLIP_WIDTH, height: CLIP_HEIGHT };

/** GET `path` on the seeding machine's relay, through the tunnel: its JSON, or null. */
function getJson<T>(path: string): Promise<T | null> {
  return new Promise((r) => {
    const req = request({ host: '127.0.0.1', port: RELAY_PORT, path, timeout: 20_000 }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => {
        try {
          r(JSON.parse(body) as T);
        } catch {
          r(null);
        }
      });
      // A tunnel that drops mid-body: the retry path, not a hang (a later call is a no-op).
      res.on('error', () => {
        r(null);
      });
      res.on('close', () => {
        r(null);
      });
    });
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

interface Status {
  readonly done: boolean;
  readonly reverseDone?: boolean;
  readonly t4?: string;
}

/** The seeding machine's word, or null when it does not answer. */
const status = (): Promise<Status | null> => getJson<Status>(STATUS_PATH);
/** Tells the seeding machine where this one is. */
const mark = async (word: string): Promise<void> => {
  await getJson<unknown>(`${MARK_PATH}${word}`);
};

interface Info {
  link: string;
  appSha256: string;
  addr: string;
  v2?: { line: { key: string; fork: number; length: number }; verlink: string };
}
const info = async (): Promise<Info | null> =>
  (await getJson<{ info: Info | null }>(INFO_PATH))?.info ?? null;

/** Every ready field the sandbox decides, as the app printed it. */
const sandboxFields = (r: LaunchResult): Record<string, unknown> => ({
  sandbox: r.ready?.sandbox,
  rendererSandbox: r.ready?.rendererSandbox,
});

/** Test 4, by `shells/pear-v2/proof/realhost.ts play`: its summary line, or why there is none. */
async function playV2(v2: NonNullable<Info['v2']>, addr: string): Promise<Record<string, unknown>> {
  const script = join(PKG_DIR, '..', 'pear-v2', 'proof', 'realhost.ts');
  const child = spawn(
    process.execPath,
    [
      script,
      'play',
      '--work',
      join(WORK, 'v2'),
      '--line',
      `${v2.line.key}:${String(v2.line.fork)}:${String(v2.line.length)}`,
      '--verlink',
      v2.verlink,
      '--addr',
      addr,
      '--relay',
      RELAY_URL,
    ],
    { cwd: join(PKG_DIR, '..', '..'), stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const got: { summary: Record<string, unknown> | null } = { summary: null };
  createInterface({ input: child.stdout }).on('line', (l) => {
    if (l.startsWith('REALHOST_V2_PLAY ')) {
      try {
        got.summary = JSON.parse(l.slice('REALHOST_V2_PLAY '.length)) as Record<string, unknown>;
      } catch {
        got.summary = { error: 'an unreadable REALHOST_V2_PLAY line' };
      }
    } else process.stdout.write(`${l}\n`);
  });
  const code = await Promise.race([
    new Promise<number | null>((r) => {
      child.once('exit', r);
      child.once('error', () => {
        r(null);
      });
    }),
    sleep(45 * 60_000).then(() => {
      child.kill('SIGTERM');
      return 'timeout' as const;
    }),
  ]);
  return got.summary ?? { error: `no summary (exit ${String(code)})` };
}

/** What test 4 must show, on this side: the v2 runtime, from the line, playing the clip. */
function v2Problems(s: Record<string, unknown>): string[] {
  if (typeof s['error'] === 'string') return [`v2: ${s['error']}`];
  const rt = (s['runtime'] ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  if (rt['pear'] !== '2.6.5') out.push(`v2: Pear ${String(rt['pear'])}, not 2.6.5`);
  if (rt['platformIsTheLine'] !== true) out.push('v2: the platform is not the seeding line');
  if (rt['linkIsTheVerlink'] !== true) out.push('v2: the app runs another link');
  const p = (s['play'] ?? {}) as Record<string, unknown>;
  const ws = p['workerStatus'] as { listening?: number } | null | undefined;
  if (ws?.listening !== 0)
    out.push(`v2: the worker listens (${JSON.stringify(ws)}): not watch only`);
  // The v2 window's network list is 127.0.0.1 alone (`shells/pear-v2/README.md`): not counted here.
  out.push(
    ...playProblems({ ...p, stage: 'measured', offLoopback: 0 }, 'progressive', CLIP).map(
      (x) => `v2 ${x}`,
    ),
  );
  return out;
}

async function main(): Promise<number> {
  mkdirSync(WORK, { recursive: true });
  const summary: Record<string, unknown> = {};
  const verdicts: Record<string, string> = {};
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
    let got: Info | null = null;
    let beat = 0;
    while (got === null) {
      if (Date.now() > deadline) throw new Error('the seeding machine never named a seeded link');
      if (LOCAL && (await status()) !== null) {
        got = await info();
      } else if (!LOCAL && tunnel === undefined) {
        const keys = await lookupTunnel(node, topic).catch(() => []);
        if (keys.length > 1)
          say(`${String(keys.length)} tunnels on the topic; the first answering wins`);
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
      if (tunnel !== undefined) got = await info();
      if (got === null) {
        if (Date.now() - beat > 30_000) {
          beat = Date.now();
          say(
            `waiting for the seeding machine (${tunnel === undefined ? 'no tunnel on the topic yet' : 'tunnel up, link not seeded yet'})`,
          );
        }
        await sleep(5000);
      }
    }
    const { link: LINK, appSha256: APP_SHA, addr: ADDR } = got;
    if (
      !/^pear:\/\/[a-z0-9]{52}$/.test(LINK) ||
      !/^[0-9a-f]{64}$/.test(APP_SHA) ||
      !/^38504:[0-9a-f]{64}:nfx:testnet:1:[a-z0-9-]{1,64}$/.test(ADDR)
    )
      throw new Error('the seeding machine named no link, digest or address of the right shape');
    say(
      `link ${LINK}; staged AppImage sha256 ${APP_SHA}; tunnel remotes ${JSON.stringify(tunnel?.stats.remotes)}`,
    );
    summary['link'] = LINK;

    // ---- test 1 ----------------------------------------------------------------------------------
    try {
      // pear install, from the public DHT
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
        say(
          `pear install attempt ${String(attempt)}: exit ${String(last.code)}, ${String(last.ms)} ms${last.timedOut ? ', timed out' : ''}`,
        );
        if (last.code === 0 && succeeded(last.records)) break;
        say(tail(last.out, 8));
      }
      if (last?.code !== 0 || !succeeded(last.records))
        throw new Error(
          `pear install: ${failureMessage(last?.records ?? []) ?? tail(last?.out ?? '', 6)}`,
        );
      const dest = field(lastRecord(last.records, 'app'), 'dest');
      const peers = last.records.filter((r) => r.tag === 'stats').map((r) => r.data['peers']);
      if (dest === undefined || !existsSync(dest))
        throw new Error(`pear install says ${String(dest)}`);
      accessSync(dest, constants.X_OK);
      const sha = createHash('sha256').update(readFileSync(dest)).digest('hex');
      summary['install'] = {
        ms: last.ms,
        peersSeen: peers.slice(-1),
        sha256MatchesStaged: sha === APP_SHA,
      };
      say(`installed: ${JSON.stringify(summary['install'])}`);
      if (sha !== APP_SHA) throw new Error('the installed AppImage is not the staged build');
      const env = isolatedEnv(home);
      const config = join(home, '.config', 'nutflix-runtime');
      const consent = join(config, 'sandbox-consent.json');

      // Where the sandbox cannot start: the warning, by itself, with nothing stored.
      if (SANDBOX_OFF) {
        const w = await launch(dest, [], 'warning', 240, { env });
        summary['sandboxWarning'] = {
          ok: w.ok,
          reason: w.reason,
          events: w.events,
          stop: stopLine(w.stopped),
        };
        say(
          `no user namespaces here; started as installed: ${JSON.stringify(summary['sandboxWarning'])}`,
        );
        if (!w.ok) say(w.tail.slice(-30).join('\n'));
      }

      // The switch, as main stores it after the native confirmation; "Run anyway", as stored.
      const worker = join(config, 'worker');
      mkdirSync(worker, { recursive: true });
      writeFileSync(
        join(worker, 'seeding.json'),
        `${JSON.stringify({ v: 1, watched: true, videos: {} })}\n`,
      );
      if (SANDBOX_OFF) {
        const choice = { v: 1, choice: 'run-anyway', at: new Date().toISOString() };
        writeFileSync(consent, `${JSON.stringify(choice)}\n`, { mode: 0o600 });
      }

      // The app plays, then seeds until the seeding machine has fetched the clip back (test 3).
      let heldMs = 0;
      const hold = async (): Promise<void> => {
        const until = Date.now() + 15 * 60_000;
        const from = Date.now();
        let b = 0;
        for (;;) {
          const s = await status();
          if (s?.done === true || s?.reverseDone === true || Date.now() > until) break;
          if (Date.now() - b > 30_000) {
            b = Date.now();
            say(
              `seeding; waiting for the seeding machine's fetch (${String(Math.round((Date.now() - from) / 1000))} s)`,
            );
          }
          await sleep(5000);
        }
        heldMs = Date.now() - from;
      };
      // Where the sandbox is off, with an argument: the runtime hands AppRun its arguments.
      const args = SANDBOX_OFF ? ['--no-sandbox'] : [];
      const r = await launch(dest, args, 'ready', 900, {
        env,
        sandbox: SANDBOX_OFF ? 'off' : 'on',
        updates: 'on',
        waitFor: 'play-proof-done',
        collect: ['play-proof', 'play-proof-done'],
        onReady: hold,
      });
      for (const e of r.collected) say(`${e.name} ${JSON.stringify(e.fields)}`);
      say(
        `launch ${JSON.stringify(args)}: ${r.ok ? 'ok' : 'FAIL'} ${r.reason}; events ${r.events.join(', ')}; teardown ${r.teardown.join(', ')}; held ${String(heldMs)} ms; stop: ${stopLine(r.stopped)}`,
      );
      if (!r.ok) say(r.tail.slice(-60).join('\n'));
      const byPath = (p: string): Record<string, unknown> | undefined =>
        r.collected.find((e) => e.name === 'play-proof' && e.fields['path'] === p)?.fields;
      const problems = [
        ...playProblems(byPath('progressive'), 'progressive', CLIP),
        ...playProblems(byPath('webrtc'), 'webrtc', CLIP),
      ];
      const warned = (summary['sandboxWarning'] as { ok?: boolean } | undefined)?.ok;
      if (SANDBOX_OFF && warned !== true)
        problems.push('the installed AppImage did not reach the sandbox warning by itself');
      if (!r.ok) problems.push(`launch: ${r.reason}`);

      // The command the warning names, as a user types it: an argument again, and the choice goes.
      if (SANDBOX_OFF) {
        const f = spawnSync(dest, ['--forget-sandbox-choice'], {
          env,
          timeout: 120_000,
          encoding: 'utf8',
        });
        summary['forgetSwitch'] = {
          exit: f.status,
          forgottenEvent: f.stdout.includes('sandbox-choice-forgotten'),
          consentGone: !existsSync(consent),
        };
        say(`--forget-sandbox-choice: ${JSON.stringify(summary['forgetSwitch'])}`);
        if (f.status !== 0 || existsSync(consent))
          problems.push(
            '--forget-sandbox-choice, as the warning names it, did not forget the choice',
          );
      }
      summary['T1'] = {
        verdict: problems.length === 0 ? 'PASS' : 'FAIL',
        problems,
        launchOk: r.ok,
        reason: r.reason,
        args,
        ready: r.ready,
        sandboxFields: sandboxFields(r),
        progressive: byPath('progressive'),
        webrtc: byPath('webrtc'),
        done: r.collected.find((e) => e.name === 'play-proof-done')?.fields,
        events: r.events,
        teardown: r.teardown,
        heldForReverseMs: heldMs,
        updates: r.updates.slice(-3),
      };
    } catch (e) {
      summary['T1'] = {
        verdict: 'FAIL',
        problems: [e instanceof Error ? e.message.slice(0, 600) : String(e)],
      };
    }
    verdicts['T1'] = (summary['T1'] as { verdict: string }).verdict;
    say(`test 1 on Y: ${JSON.stringify(summary['T1'])}`);
    // The app is stopped: no beacon of it is coming any more.
    await mark(verdicts['T1'] === 'PASS' ? 't1-ended' : 't1-failed');

    // ---- test 4: shape (b) ----------------------------------------------------------------------
    if (T4) {
      let s = await status();
      let b4 = 0;
      while (Date.now() < deadline && s?.t4 !== 'ready' && s?.t4 !== 'failed' && s?.done !== true) {
        if (Date.now() - b4 > 30_000) {
          b4 = Date.now();
          say(`test 4: waiting for the seeding machine's v2 link (${String(s?.t4)})`);
        }
        await sleep(5000);
        s = await status();
      }
      const now = await info();
      if (s?.t4 !== 'ready' || now?.v2 === undefined) {
        summary['T4'] = {
          verdict: 'FAIL',
          problems: [`no v2 link: the seeding machine says ${String(s?.t4)}`],
        };
      } else {
        const v = await playV2(now.v2, ADDR);
        const problems = v2Problems(v);
        summary['T4'] = { verdict: problems.length === 0 ? 'PASS' : 'FAIL', problems, ...v };
      }
      await mark('t4-done');
      verdicts['T4'] = (summary['T4'] as { verdict: string }).verdict;
      say(`test 4 on Y: ${JSON.stringify(summary['T4'])}`);
    }
  } catch (e) {
    summary['error'] = e instanceof Error ? (e.stack ?? e.message) : String(e);
    say(`FAIL ${String(summary['error'])}`);
  } finally {
    await mark('finished').catch(() => undefined);
    if (pear !== undefined) {
      const sc = await pear.run('sidecar-shutdown', ['sidecar', 'shutdown'], 90);
      say(`sidecar shutdown: exit ${String(sc.code)}`);
    }
    await tunnel?.close().catch(() => undefined);
    await node.destroy().catch(() => undefined);
    summary['verdicts'] = verdicts;
    process.stdout.write(`REALHOST_PLAY_SUMMARY ${JSON.stringify(summary)}\n`);
  }
  const failed = Object.values(verdicts).some((v) => v !== 'PASS');
  return summary['error'] === undefined && !failed && verdicts['T1'] !== undefined ? 0 : 1;
}

process.exitCode = await main();
setTimeout(() => process.exit(), 2000).unref();
