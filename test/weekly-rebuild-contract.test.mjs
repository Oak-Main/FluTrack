import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldDeploy } from '../build/rebuild-gate.mjs';

// The weekly rebuild is a chain of guard rails: a required live preflight, QA,
// a newer-week gate, and a deploy-hook POST that must never fire on a missing
// secret, a skipped gate, or a dry run. That chain lives in workflow YAML, so
// no unit test reaches it — this file pins its contract as text, including the
// order the steps run in. The October 24 2026 run proved why: the gate had a
// live CDC week ready to ship, and the POST step's fail-closed guard was the
// only thing standing between "hook not configured" and a silently skipped
// deployment. These assertions keep that guard from being edited away, and
// keep the POST, dry-run and gate steps from drifting apart.

const yml = readFileSync(new URL('../.github/workflows/weekly-rebuild.yml', import.meta.url), 'utf8');
const GATE = fileURLToPath(new URL('../build/rebuild-gate.mjs', import.meta.url));

const STEP_NAMES = Object.freeze([
  'Preflight — build from the live CDC feed',
  'QA — links, assets, SEO tags, provenance',
  'Compare with production',
  'Trigger Cloudflare Pages production build',
]);

/** The `- name:` labels of a workflow file, in file order. */
const stepOrder = (yaml) => [...yaml.matchAll(/^\s*- name: (.+)$/gm)].map((m) => m[1].trim());

/** Fail unless the named steps appear in exactly the given order. */
function assertStepOrder(yaml, sequence) {
  const positions = sequence.map((name) => stepOrder(yaml).indexOf(name));
  sequence.forEach((name, i) => assert.notEqual(positions[i], -1, `step not found: ${name}`));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i - 1] < positions[i], `steps out of order: "${sequence[i - 1]}" must precede "${sequence[i]}"`);
  }
}

test('the preflight build requires live CDC data before anything else runs', () => {
  assert.match(yml, /LIVE_PRERENDER:\s*require/, 'the preflight step must set LIVE_PRERENDER=require');
  assert.match(yml, /node build\/build\.mjs/);
  assert.match(yml, /node build\/check\.mjs/, 'QA must run on the preflight build');
  assert.match(yml, /node build\/rebuild-gate\.mjs/, 'the gate must run after QA');
});

test('the pipeline runs build, then QA, then gate, then the conditional trigger', () => {
  assertStepOrder(yml, STEP_NAMES);
});

test('the ordering check rejects a reordered workflow, not just an identical one', () => {
  // The gate before the preflight would compare against nothing and QA would
  // run on stale output; the checker must refuse that shape outright.
  const reordered = [
    'jobs:',
    '  rebuild:',
    `    - name: ${STEP_NAMES[3]}`,
    `    - name: ${STEP_NAMES[2]}`,
    `    - name: ${STEP_NAMES[1]}`,
    `    - name: ${STEP_NAMES[0]}`,
    '',
  ].join('\n');
  assert.throws(() => assertStepOrder(reordered, STEP_NAMES), /steps out of order/);
});

test('the deploy hook POST only fires when the gate says deploy and it is not a dry run', () => {
  assert.match(
    yml,
    /if: steps\.gate\.outputs\.deploy == 'true' && !inputs\.dry_run/,
    'the POST step must be conditioned on deploy==true and not dry_run',
  );
});

test('a missing CF_PAGES_DEPLOY_HOOK fails closed before any POST', () => {
  assert.match(yml, /secrets\.CF_PAGES_DEPLOY_HOOK/, 'the step must read the repository secret');
  const guard = yml.indexOf('if [ -z "$DEPLOY_HOOK" ]');
  const post = yml.indexOf('-X POST');
  assert.notEqual(guard, -1, 'the empty-secret guard must exist');
  assert.notEqual(post, -1, 'the deploy-hook POST must exist');
  assert.ok(guard < post, 'the empty-secret guard must run before the POST');
  const guardBody = yml.slice(guard, post);
  assert.match(guardBody, /exit 1/, 'an unset hook must exit non-zero, never fall through to the POST');
  assert.match(guardBody, /CF_PAGES_DEPLOY_HOOK is not set/, 'the error must name the missing secret');
});

test('a failed trigger POST fails the job', () => {
  assert.match(yml, /curl --fail/, 'curl --fail turns a rejected hook into a failed step');
});

test('the dry run never calls the deploy hook', () => {
  assert.match(yml, /if: steps\.gate\.outputs\.deploy == 'true' && inputs\.dry_run/, 'the dry-run step must exist');
  assert.equal((yml.match(/-X POST/g) || []).length, 1, 'exactly one POST exists in the workflow — the trigger step');
  assert.match(yml, /The deploy hook was not called/, 'the dry-run summary must say the hook was skipped');
});

test('a skipped gate never reaches the trigger step', () => {
  const summary = yml.indexOf('name: Summary');
  assert.notEqual(summary, -1);
  assert.match(yml.slice(summary), /deploy != 'true'/, 'the no-deploy summary must key off the gate, not the POST');
});

// --- the gate CLI's own wiring ---------------------------------------------- //

test('importing the gate without an entry argument (eval/REPL) neither throws nor runs it', () => {
  const url = new URL('../build/rebuild-gate.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '', 'the gate must not compare anything on a bare import');
});

test('running the gate as a CLI produces a gate decision, never a silent exit', () => {
  // With a built dist/ present the gate compares it with production and
  // reports a decision either way (production unreadable is still a decision:
  // deploy). Without one it must fail loudly — the old file:// guard made it
  // exit 0 without running anything.
  const out = mkdtempSync(join(tmpdir(), 'rebuild-gate-cli-'));
  try {
    const run = spawnSync(process.execPath, [GATE], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: join(out, 'gate.txt') } });
    if (existsSync(new URL('../dist/data/snapshot.json', import.meta.url))) {
      assert.equal(run.status, 0, run.stderr);
      const recorded = readFileSync(join(out, 'gate.txt'), 'utf8');
      assert.match(recorded, /^deploy=(true|false)\nweek=\d{4}-\d{2}-\d{2}\nreason=/m, 'the gate must write its decision for the workflow');
    } else {
      assert.equal(run.status, 1, 'a missing preflight build must fail the gate, not exit 0 silently');
      assert.match(run.stderr, /ENOENT/);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('force deploys regardless of the week comparison, but never sample data', () => {
  const deployed = { kind: 'live', weekEnding: '2026-10-17' };
  assert.equal(shouldDeploy({ built: { kind: 'live', weekEnding: '2026-10-10' }, deployed, force: true }).deploy, true);
  assert.equal(shouldDeploy({ built: { kind: 'sample', weekEnding: '2026-10-24' }, deployed, force: true }).deploy, false);
});
