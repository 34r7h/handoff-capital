#!/usr/bin/env node
// Worker side, step 1: a fresh Cubic-LWE seal key pair (n = 729) and a fresh MAYO identity for the
// claim proof. Secrets are written to 0600 files; only public data is printed.
//
//   node worker-keys.mjs [--out <folder>]      (default: keys/worker-<time>/, gitignored)
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, makeWorkerKeys, fmtBytes, RefusedError } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function workerKeys({ argv, log = console.log }) {
  const a = parseArgs(argv);
  const dir = path.resolve(a.out || path.join(here, 'keys', `worker-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  const pub = await makeWorkerKeys(dir);
  log(`xmb address: ${pub.xmb}`);
  log(`seal public key (Cubic-LWE, n = ${pub.n}): ${pub.pkFile} (${fmtBytes(pub.pkBytes)})`);
  log(`secret keys: ${path.join(dir, 'lwe.sk')} and ${path.join(dir, 'mayo.sk')} (mode 0600; never share them)`);
  log('Give the requester the xmb address and the public key file. Use this folder for ONE payout only.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  workerKeys({ argv: process.argv.slice(2) }).then((c) => process.exit(c), (e) => {
    console.error(e instanceof RefusedError ? e.message : `error: ${e.message}`);
    process.exit(2);
  });
}
