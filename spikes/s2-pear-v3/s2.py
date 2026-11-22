#!/usr/bin/env python3
"""Spike S2 helper: reads the NDJSON that the pear CLI and the instrumented worker write.

Run with `python3 -I` (the inputs are untrusted). Subcommands:
  jlast FILE KEY                 last value of KEY found anywhere in the NDJSON records
  count FILE EV                  number of worker records with ev == EV
  wait FILE EV N TIMEOUT         wait until count(EV) >= N; exit 1 on timeout
  waitfor FILE FROM TIMEOUT EV [K=V ...]
                                 wait for a record from index FROM with ev == EV and K == V
  show FILE [FROM]               print worker records from line FROM, progress events condensed
  npxlock CACHE                  pear / pear-install versions and integrity from the npx cache
"""
import glob
import json
import os
import sys
import time


def records(path):
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    except FileNotFoundError:
        pass
    return out


def find_key(obj, key, found):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                found.append(v)
            find_key(v, key, found)
    elif isinstance(obj, list):
        for v in obj:
            find_key(v, key, found)


def jlast(path, key):
    found = []
    for r in records(path):
        find_key(r, key, found)
    if not found:
        sys.exit(1)
    v = found[-1]
    print(v if isinstance(v, str) else json.dumps(v))


def count(path, ev):
    return sum(1 for r in records(path) if r.get("ev") == ev)


def wait(path, ev, n, timeout):
    end = time.time() + float(timeout)
    while time.time() < end:
        if count(path, ev) >= int(n):
            return 0
        time.sleep(1)
    return 1


def waitfor(path, start, timeout, ev, conds):
    """Wait for a record at index >= start with ev == EV and every KEY=VALUE equal (as strings)."""
    want = dict(c.split("=", 1) for c in conds)
    end = time.time() + float(timeout)
    while time.time() < end:
        for r in records(path)[int(start):]:
            if r.get("ev") == ev and all(str(r.get(k)) == v for k, v in want.items()):
                return 0
        time.sleep(1)
    return 1


def show(path, start=0):
    recs = records(path)[int(start):]
    i = 0
    while i < len(recs):
        r = recs[i]
        if r.get("ev") == "updater-event" and r.get("name") == "updating-progress":
            j = i
            while j < len(recs) and recs[j].get("ev") == "updater-event" and recs[j].get("name") == "updating-progress":
                j += 1
            run = recs[i:j]
            print(json.dumps(run[0], sort_keys=True))
            if len(run) > 2:
                print(f"  ... {len(run) - 2} more updating-progress events ...")
            if len(run) > 1:
                print(json.dumps(run[-1], sort_keys=True))
            i = j
            continue
        print(json.dumps(r, sort_keys=True))
        i += 1
    return len(recs) + int(start)


def npxlock(cache):
    for lock in glob.glob(os.path.join(cache, "_npx", "*", "package-lock.json")):
        d = json.load(open(lock))
        for k, v in d.get("packages", {}).items():
            if k in ("node_modules/pear", "node_modules/pear-install", "node_modules/hyperdrive",
                     "node_modules/hyperswarm", "node_modules/corestore"):
                print(k, v.get("version"), v.get("integrity"))


def main(argv):
    cmd = argv[1]
    if cmd == "jlast":
        jlast(argv[2], argv[3])
    elif cmd == "count":
        print(count(argv[2], argv[3]))
    elif cmd == "wait":
        sys.exit(wait(argv[2], argv[3], argv[4], argv[5]))
    elif cmd == "waitfor":
        sys.exit(waitfor(argv[2], argv[3], argv[4], argv[5], argv[6:]))
    elif cmd == "show":
        print("next-line", show(argv[2], argv[3] if len(argv) > 3 else 0))
    elif cmd == "npxlock":
        npxlock(argv[2])
    else:
        sys.exit("unknown subcommand " + cmd)


if __name__ == "__main__":
    main(sys.argv)
