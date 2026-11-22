/**
 * What main prints. One line per event on stdout: `NUTFLIX_SHELL <event> <json fields>`. CI reads
 * these lines; so can a person with a terminal. Fields are booleans, numbers and short fixed
 * strings: never a path, a key, a URL or anything a remote peer or the page chose.
 */
import { EVENT_PREFIX, READY_PREFIX } from '../shared/ids.ts';

export type Fields = Readonly<Record<string, string | number | boolean>>;
export type Emit = (line: string) => void;

const stdout: Emit = (line) => {
  process.stdout.write(`${line}\n`);
};

export function event(name: string, fields: Fields = {}, emit: Emit = stdout): void {
  emit(`${EVENT_PREFIX} ${name} ${JSON.stringify(fields)}`);
}

/** The line CI waits for. Printed once, after the window loaded, the renderer mounted and the worker answered `status`. */
export function readyLine(fields: Fields, emit: Emit = stdout): void {
  emit(`${READY_PREFIX} ${JSON.stringify(fields)}`);
}
