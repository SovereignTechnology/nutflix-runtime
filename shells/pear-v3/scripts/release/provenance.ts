/**
 * Where a release comes from. A release is built only from packages of one successful `ci.yml` run
 * of a push to `main` in this repository, and this module asks GitHub so, read-only:
 *
 *   - the run: this repository, this workflow, event `push`, branch `main`, the commit given,
 *     completed, successful;
 *   - its artifacts: GitHub's digest of each one, compared with the bytes on this disk, so that a
 *     package of another run, or a mix of runs, is refused.
 *
 * If GitHub cannot be reached the answer is no: there is no offline path. Access goes through the
 * `gh` CLI, pinned to github.com, so this tool never holds a token.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, rmSync } from 'node:fs';

import { sha256File } from '../pear-ci/deployment.ts';
import { refuse } from './guards.ts';

export const RELEASE_REPO = 'SovereignTechnology/nutflix-runtime';
export const RELEASE_WORKFLOW = '.github/workflows/ci.yml';
export const RELEASE_BRANCH = 'main';
export const GITHUB_HOST = 'github.com';

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** A read-only view of the GitHub API. */
export interface GitHubApi {
  /** The JSON at `path`; it rejects if GitHub cannot be asked. */
  get(path: string): Promise<unknown>;
  /** The bytes at `path`, into `file`. */
  download(path: string, file: string): Promise<void>;
}

/**
 * A `gh api` call: GET only, always github.com, whatever `GH_HOST` or `gh`'s own default says.
 * `token` is given to `gh` alone; with none, `gh` uses its own sign-in.
 */
export function ghCommand(
  path: string,
  token?: string,
  base: NodeJS.ProcessEnv = process.env,
): { readonly args: string[]; readonly env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...base };
  // `--hostname` already wins over these; they are dropped so nothing else reads them either.
  Reflect.deleteProperty(env, 'GH_HOST');
  Reflect.deleteProperty(env, 'GH_ENTERPRISE_TOKEN');
  Reflect.deleteProperty(env, 'GITHUB_ENTERPRISE_TOKEN');
  if (token !== undefined && token !== '') {
    Reflect.deleteProperty(env, 'GITHUB_TOKEN');
    env['GH_TOKEN'] = token;
  }
  return { args: ['api', '--hostname', GITHUB_HOST, '--method', 'GET', path], env };
}

export function makeGhApi(token?: string): GitHubApi {
  return {
    get: (path) => {
      const c = ghCommand(path, token);
      const r = spawnSync('gh', c.args, {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: c.env,
      });
      if (r.error !== undefined || r.status !== 0)
        return Promise.reject(
          new Error(
            `GitHub could not be asked for ${path}: ${(r.stderr || String(r.error)).slice(0, 200)}`,
          ),
        );
      return Promise.resolve(JSON.parse(r.stdout) as unknown);
    },
    download: (path, file) =>
      new Promise((resolvePromise, reject) => {
        const fd = openSync(file, 'w');
        const c = ghCommand(path, token);
        const child = spawn('gh', c.args, { stdio: ['ignore', fd, 'pipe'], env: c.env });
        let err = '';
        child.stderr?.on('data', (d: Buffer) => {
          err += d.toString('utf8');
        });
        child.once('error', (e) => {
          closeSync(fd);
          reject(e);
        });
        child.once('exit', (code) => {
          closeSync(fd);
          if (code === 0) resolvePromise();
          else reject(new Error(`GitHub could not send ${path}: ${err.slice(0, 200)}`));
        });
      }),
  };
}

/** The API with the `gh` CLI's own sign-in: what the release tool uses. */
export const ghApi: GitHubApi = makeGhApi();

async function ask(api: GitHubApi, path: string): Promise<Record<string, unknown>> {
  let v: unknown;
  try {
    v = await api.get(path);
  } catch (e) {
    return refuse(
      `GitHub could not be reached, and a release is not checked offline: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    return refuse(`GitHub answered ${path} with something else`);
  return v as Record<string, unknown>;
}

const fullName = (x: unknown): unknown =>
  typeof x === 'object' && x !== null ? (x as { full_name?: unknown }).full_name : undefined;

export function assertCommit(x: string | undefined, what: string): string {
  if (x === undefined || !COMMIT.test(x)) return refuse(`${what} must be a full 40-hex git sha`);
  return x;
}

export function parseRunId(x: string | undefined): number {
  if (x === undefined || !/^[1-9][0-9]{0,18}$/.test(x) || !Number.isSafeInteger(Number(x)))
    return refuse('--run must be a GitHub Actions run id');
  return Number(x);
}

/** Refuses unless `run` is a successful `ci.yml` run of a push of `commit` to `main` here. */
export async function verifyMainRun(api: GitHubApi, run: number, commit: string): Promise<void> {
  assertCommit(commit, 'the commit');
  const r = await ask(api, `repos/${RELEASE_REPO}/actions/runs/${String(run)}`);
  const workflow = await ask(api, `repos/${RELEASE_REPO}/actions/workflows/ci.yml`);
  const no = (why: string): never => refuse(`run ${String(run)} is not a release build: ${why}`);
  if (r['id'] !== run) no('GitHub answered with another run');
  if (fullName(r['repository']) !== RELEASE_REPO) no('it is not in this repository');
  if (fullName(r['head_repository']) !== RELEASE_REPO) no('it was built from a fork');
  if (r['path'] !== RELEASE_WORKFLOW || workflow['path'] !== RELEASE_WORKFLOW)
    no(`its workflow is ${JSON.stringify(r['path'])}`);
  if (typeof workflow['id'] !== 'number' || r['workflow_id'] !== workflow['id'])
    no('its workflow is not this repository’s ci.yml');
  if (r['event'] !== 'push') no(`it was triggered by ${JSON.stringify(r['event'])}, not a push`);
  if (r['head_branch'] !== RELEASE_BRANCH)
    no(`it built ${JSON.stringify(r['head_branch'])}, not ${RELEASE_BRANCH}`);
  if (r['head_sha'] !== commit) no(`it built ${String(r['head_sha'])}, not ${commit}`);
  if (r['status'] !== 'completed') no(`it has not completed (${String(r['status'])})`);
  if (r['conclusion'] !== 'success') no(`it did not succeed (${String(r['conclusion'])})`);
  // A tag named `main` would also report `main` as the run's branch.
  const tags = await askList(api, `repos/${RELEASE_REPO}/git/matching-refs/tags/${RELEASE_BRANCH}`);
  if (tags.some((t) => t['ref'] === `refs/tags/${RELEASE_BRANCH}`))
    no(`a tag named ${RELEASE_BRANCH} exists, so its runs cannot be told from the branch's`);
  // And the commit is in main's history.
  const c = await ask(api, `repos/${RELEASE_REPO}/compare/${RELEASE_BRANCH}...${commit}`);
  if ((c['status'] !== 'identical' && c['status'] !== 'behind') || c['ahead_by'] !== 0)
    no(`${commit} is not in ${RELEASE_BRANCH}'s history (compare says ${String(c['status'])})`);
}

async function askList(api: GitHubApi, path: string): Promise<Record<string, unknown>[]> {
  let v: unknown;
  try {
    v = await api.get(path);
  } catch (e) {
    return refuse(
      `GitHub could not be reached, and a release is not checked offline: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(v)) return refuse(`GitHub answered ${path} with something else`);
  return v as Record<string, unknown>[];
}

export interface RunArtifact {
  readonly id: number;
  readonly name: string;
  /** The sha256 of the artifact's zip, in hex, as GitHub reports it. */
  readonly sha256: string;
}

/** The named artifacts of `run`, each exactly once, unexpired, and belonging to that run. */
export async function runArtifacts(
  api: GitHubApi,
  run: number,
  commit: string,
  names: readonly string[],
): Promise<Map<string, RunArtifact>> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await ask(
      api,
      `repos/${RELEASE_REPO}/actions/runs/${String(run)}/artifacts?per_page=100&page=${String(page)}`,
    );
    const list = r['artifacts'];
    if (!Array.isArray(list)) return refuse('GitHub listed no artifacts');
    rows.push(...(list as Record<string, unknown>[]));
    if (list.length < 100) break;
  }
  const out = new Map<string, RunArtifact>();
  for (const name of names) {
    const found = rows.filter((a) => a['name'] === name);
    const a = found[0];
    if (found.length !== 1 || a === undefined)
      return refuse(`run ${String(run)} has ${String(found.length)} artifacts named ${name}`);
    const owner = a['workflow_run'] as { id?: unknown; head_sha?: unknown } | undefined;
    if (owner?.id !== run || owner.head_sha !== commit)
      return refuse(`${name} does not belong to run ${String(run)} at ${commit}`);
    if (a['expired'] !== false) return refuse(`${name} has expired`);
    const digest = a['digest'];
    const id = a['id'];
    if (typeof digest !== 'string' || !DIGEST.test(digest) || typeof id !== 'number')
      return refuse(`GitHub reports no digest for ${name}`);
    out.set(name, { id, name, sha256: digest.slice('sha256:'.length) });
  }
  return out;
}

/** Refuses unless the zip on disk is the artifact GitHub holds for that run. */
export async function assertArtifactBytes(file: string, artifact: RunArtifact): Promise<void> {
  const got = await sha256File(file);
  if (got !== artifact.sha256)
    refuse(
      `${file} is not ${artifact.name} of this run: sha256 ${got}, GitHub says ${artifact.sha256}`,
    );
}

/** Downloads one artifact's zip and checks it against GitHub's digest. */
export async function downloadArtifact(
  api: GitHubApi,
  artifact: RunArtifact,
  file: string,
): Promise<void> {
  try {
    await api.download(`repos/${RELEASE_REPO}/actions/artifacts/${String(artifact.id)}/zip`, file);
  } catch (e) {
    rmSync(file, { force: true });
    refuse(`GitHub could not be reached: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await assertArtifactBytes(file, artifact);
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }
}
