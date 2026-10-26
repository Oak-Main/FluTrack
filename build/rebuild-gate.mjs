// ===========================================================================
// Weekly rebuild gate (.github/workflows/weekly-rebuild.yml).
//
// After the workflow's preflight build has produced dist/ from the live CDC
// feed, decide whether production needs a rebuild: yes when production is
// serving sample data, an older CDC week, or cannot be read; no when it already
// shows this week. Writes `deploy=true|false` and `week=<YYYY-MM-DD>` to
// $GITHUB_OUTPUT when present.   Usage: node build/rebuild-gate.mjs [--force]
// ===========================================================================

import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * @param {{ built: object, deployed: object|null, force?: boolean }} input
 * @returns {{ deploy: boolean, reason: string }}
 */
export function shouldDeploy({ built, deployed, force = false }) {
  if (built?.kind !== 'live') return { deploy: false, reason: `the preflight build is "${built?.kind}" data, not live — refusing to deploy it` };
  if (force) return { deploy: true, reason: 'forced by workflow input' };
  if (!deployed) return { deploy: true, reason: 'production snapshot could not be read' };
  if (deployed.kind !== 'live') return { deploy: true, reason: `production is serving ${deployed.kind} data` };
  if (String(built.weekEnding) > String(deployed.weekEnding)) {
    return { deploy: true, reason: `CDC week ${built.weekEnding} is newer than production's ${deployed.weekEnding}` };
  }
  return { deploy: false, reason: `production already shows CDC week ${deployed.weekEnding}` };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { site } = await import('./lib/site.mjs');
  const built = JSON.parse(readFileSync(resolve(root, 'dist/data/snapshot.json'), 'utf8'));
  let deployed = null;
  try {
    const res = await fetch(`${site.origin}/data/snapshot.json`, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    if (res.ok) deployed = await res.json();
  } catch {
    /* unreadable → deploy */
  }
  const { deploy, reason } = shouldDeploy({ built, deployed, force: process.argv.includes('--force') });
  console.log(`${deploy ? 'DEPLOY' : 'SKIP'}: ${reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${deploy}\nweek=${built.weekEnding}\nreason=${reason}\n`);
  }
}

// pathToFileURL, not a string splice: `file://${argv[1]}` never matches on
// Windows (backslashes, drive letters), where the gate would then exit 0
// without comparing anything. The truthiness guard first: argv[1] is absent
// for eval/REPL-style imports, and pathToFileURL(undefined) throws.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
