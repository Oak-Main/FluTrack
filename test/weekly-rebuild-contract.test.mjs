import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The weekly rebuild is a chain of guard rails: a required live preflight, a
// newer-week gate, and a deploy-hook POST that must never fire on a missing
// secret, a skipped gate, or a dry run. That chain lives in workflow YAML, so
// no unit test reaches it — this file pins its contract as text. The October
// 24 2026 run proved why: the gate had a live CDC week ready to ship, and the
// POST step's fail-closed guard was the only thing standing between "hook not
// configured" and a silently skipped deployment. These assertions keep that
// guard from being edited away, and keep the POST, dry-run and gate steps from
// drifting apart.

const yml = readFileSync(new URL('../.github/workflows/weekly-rebuild.yml', import.meta.url), 'utf8');

test('the preflight build requires live CDC data before anything else runs', () => {
  assert.match(yml, /LIVE_PRERENDER:\s*require/, 'the preflight step must set LIVE_PRERENDER=require');
  assert.match(yml, /node build\/build\.mjs/);
  assert.match(yml, /node build\/check\.mjs/, 'QA must run on the preflight build');
  assert.match(yml, /node build\/rebuild-gate\.mjs/, 'the gate must run after QA');
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
