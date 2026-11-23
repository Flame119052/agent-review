import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizeReview, runGate } from './agent-gate.mjs';
import { parseRequest, routeReview, tierForPaths } from './agent-review.mjs';
import { ciPassed, queueFor, queueRecord, readReviewConfig, reviewEvent, tagDigest } from './review-target.mjs';
import { judgeTag, pollRepos, readConfig, targetsFor } from './review-watch/watch.mjs';

const now = Date.parse('2026-11-23T12:00:00Z');
const sha = 'a'.repeat(40);
const repo = 'example/target';
const target = { repo, defaultBranch: 'trunk' };
const root = `repos/${repo}`;
const event = { client_payload: { repository: repo, issue_number: 7, comment_id: 123,
  body: '@review pr machine=github', private: false, author: 'someone-else' } };
const validTag = '@review pr provider=codex model=gpt-6.1-sol author=none';
const comment = (body = validTag) => ({
  id: 123, body, updated_at: new Date(now).toISOString(),
  issue_url: `https://api.github.com/${root}/issues/7`, user: { login: 'owner', id: 12 },
});
const env = { AGENT_ALLOWLIST: ' owner , other ' };
const run = (head_sha = sha, conclusion = 'success') => ({
  id: 3, workflow_id: 1, head_sha, conclusion, event: 'pull_request', created_at: new Date(now).toISOString(),
});
const file = (config) => ({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(config)).toString('base64') });

function fixture({ privateRepo = false, message = comment(), head = { sha, repo: { full_name: repo, fork: false } },
  config = null, legacy = null, runs = [run()], issue = { pull_request: {}, body: 'PRIVATE_ISSUE_BODY' } } = {}) {
  const calls = [];
  const posted = [];
  const answers = {
    [root]: { full_name: repo, default_branch: 'trunk', private: privateRepo },
    [`${root}/issues/comments/123`]: message,
    [`${root}/issues/7`]: issue,
    [`${root}/pulls/7`]: { head },
    [`${root}/contents/.github/review.json?ref=trunk`]: config && file(config),
    [`${root}/contents/.github/agents.json?ref=trunk`]: legacy && file(legacy),
    [`${root}/contents/.github/workflows/check.yml?ref=trunk`]: null,
    [`${root}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100`]: [{ workflow_runs: runs }],
  };
  const api = (path) => {
    calls.push(path);
    assert.ok(Object.hasOwn(answers, path), path);
    return answers[path];
  };
  return { api, calls, answers, posted, publish: (_target, body) => posted.push(body), now };
}

function usage(machine, minutes) {
  return JSON.stringify({
    version: 1, machine, takenAt: new Date(now - minutes * 60000).toISOString(),
    providers: [{ provider: 'codex', instance: 'codex', windows: [{ kind: 'session', leftPercent: 79 }] }],
  });
}

test('both tags authorize a public review using the live comment', () => {
  for (const tag of ['@review', '@tess-review']) {
    const mock = fixture({ message: comment(validTag.replace('@review', tag)) });
    assert.equal(parseRequest(validTag.replace('@review', tag)).model, 'gpt-6.1-sol');
    assert.equal(runGate(event, env, mock).allowed, 'true');
    assert.equal(mock.calls[1], `${root}/issues/comments/123`);
    assert.deepEqual(mock.posted, []);
  }
});

test('a spoofed payload cannot change the live tag, user, parent issue, or visibility', () => {
  const privateTarget = fixture({ privateRepo: true, message: comment(`${validTag} machine=vps`) });
  assert.deepEqual(runGate(event, env, privateTarget), {});
  assert.match(privateTarget.posted[0], /Review queued for `vps`/);
  assert.equal(queueFor(privateTarget.posted[0]).head, sha);
  for (const message of [
    { ...comment(), body: 'ordinary conversation' },
    { ...comment(), user: { login: 'outside' } },
    { ...comment(), issue_url: `https://api.github.com/${root}/issues/8` },
    { ...comment(), id: 124 },
  ]) {
    const mock = fixture({ message });
    assert.equal(authorizeReview(event, env, mock.api), null);
    assert.equal(mock.calls.length, 2);
  }
});

test('invalid repo syntax and comment IDs make no network calls', () => {
  for (const repository of ['https://github.com/example/target', 'example/../target', 'example/..', 'example/target?x=1', 'example/target\n']) {
    const mock = fixture();
    assert.deepEqual(runGate({ client_payload: { ...event.client_payload, repository } }, env, mock), {});
    assert.deepEqual(mock.calls, []);
  }
  assert.equal(reviewEvent({ client_payload: { ...event.client_payload, comment_id: '3e2' } }), null);
});

test('the hub checks forks before CI, including an approach request on a fork PR', () => {
  for (const headRepo of [null, { full_name: 'outside/target', fork: true }, { full_name: repo }]) {
    for (const role of ['pr', 'approach']) {
      const mock = fixture({ head: { sha, repo: headRepo }, message: comment(validTag.replace(' pr ', ` ${role} `)) });
      assert.deepEqual(runGate(event, env, mock), {});
      assert.match(mock.posted[0], /comes from a fork/);
      assert.ok(!mock.calls.some((call) => call.includes('/actions/')));
    }
  }
});

test('the gate requires green CI for the exact head unless the default-branch config opts out', () => {
  for (const runs of [[], [run('b'.repeat(40))], [run(sha, 'failure')]]) {
    const mock = fixture({ runs });
    assert.deepEqual(runGate(event, env, mock), {});
    assert.match(mock.posted[0], /CI has not passed/);
  }
  const waived = fixture({ config: { requireCi: false }, runs: [] });
  assert.equal(runGate(event, env, waived).allowed, 'true');
  assert.ok(!waived.calls.some((call) => call.includes('/actions/')));
  assert.equal(tierForPaths(['README.md'], readReviewConfig(target, waived.api)), 'normal');
});

test('CI prefers check.yml and requires the latest run for each applicable workflow', () => {
  const runs = [run(), { ...run(sha, null), id: 4 }];
  assert.equal(ciPassed(target, sha, (path) => {
    if (path.includes('/contents/')) return file({});
    assert.match(path, /workflows\/check\.yml\/runs/);
    return [{ workflow_runs: runs }];
  }), false);
});

test('private explicit GitHub receives a fixed refusal with zero hosted outputs', () => {
  const mock = fixture({ privateRepo: true, message: comment(`${validTag} machine=github prompt="PRIVATE_COMMENT"`) });
  assert.deepEqual(runGate(event, env, mock), {});
  assert.match(mock.posted[0], /Private repositories cannot run on the public GitHub-hosted review runner/);
  assert.doesNotMatch(mock.posted[0], /PRIVATE_|example\/target/);
  assert.equal(mock.calls.length, 2);
});

test('private automatic routing uses Mac, Omarchy, VPS, then the offline refusal', () => {
  for (const [ages, expected] of [
    [[25, 15, 5], 'mac'], [[31, 15, 5], 'omarchy'], [[31, 31, 30], 'vps'], [[31, 31, 31], ''],
  ]) {
    const snapshots = Object.fromEntries(['mac', 'omarchy', 'vps'].map((name, index) => [
      `USAGE_SNAPSHOT_${name.toUpperCase()}`, usage(name, ages[index]),
    ]));
    for (const suffix of ['', ' machine=auto']) {
      const mock = fixture({ privateRepo: true, message: comment(validTag + suffix) });
      assert.deepEqual(runGate(event, { ...env, ...snapshots }, mock), {});
      if (expected) assert.equal(queueFor(mock.posted[0]).machine, expected);
      else assert.match(mock.posted[0], /No private-review machine .*currently reporting online/);
    }
  }
  assert.deepEqual(routeReview({}, false), { machine: 'github' });
  assert.deepEqual(routeReview({ machine: 'vps' }, true), { machine: 'vps' });
  assert.deepEqual(routeReview({}, true, { USAGE_SNAPSHOT_MAC: usage('vps', 2) }, now), { refusal: 'private-machines-offline' });
});

test('default branch config supports a legacy catalog, restrictions, caps and path overrides', () => {
  const defaults = readReviewConfig(target, fixture().api);
  assert.ok(defaults.allowed.codex.includes('gpt-6.1-sol'));
  assert.equal(tierForPaths(['README.md'], defaults), 'docs');
  assert.equal(tierForPaths(['installer/updater.sh'], defaults), 'normal');
  assert.equal(tierForPaths(['security/README.md'], defaults), 'sensitive');
  const custom = fixture({ config: { sensitivePaths: ['pkg/*/policy/**'], docsOnlyExtensions: ['.txt'],
    models: { codex: ['gpt-6.1-sol', 'unlisted-endpoint'] }, caps: { timeout_s: 360 } } });
  const rules = readReviewConfig(target, custom.api);
  assert.equal(tierForPaths(['pkg/a/policy/readme.txt'], rules), 'sensitive');
  assert.equal(tierForPaths(['help.txt'], rules), 'docs');
  assert.equal(tierForPaths(['README.md'], rules), 'normal');
  assert.deepEqual(rules.allowed.codex, ['gpt-6.1-sol']);
  assert.equal(rules.caps.timeout_s, 360);
  assert.equal(rules.caps.codex.max_tokens, defaults.caps.codex.max_tokens);
  assert.equal(custom.calls.length, 1);
  const legacy = readReviewConfig(target, fixture({ legacy: { allowed: { codex: ['gpt-6.1-terra'] } } }).api);
  assert.deepEqual(legacy.allowed.codex, ['gpt-6.1-terra']);
});

test('the shell gate and hosted picker keep private target data and errors out of stdout, stderr and outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-hub-fixture-'));
  try {
    const body = comment(`${validTag} machine=github prompt="PRIVATE_TITLE"`);
    const mock = fixture({ privateRepo: true, message: body });
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const answers = ${JSON.stringify(mock.answers)};
if (process.argv[2] === 'issue') {
  fs.writeFileSync(${JSON.stringify(join(dir, 'posted'))}, fs.readFileSync(0));
  console.log('PRIVATE_GH_STDOUT');
  console.error('PRIVATE_GH_STDERR');
} else if (process.env.FIXTURE_API_FAILURE) {
  console.error('PRIVATE_API_FAILURE');
  process.exit(1);
} else {
  console.log(JSON.stringify(answers[process.argv[3]]));
}`, { mode: 0o755 });
    const eventPath = join(dir, 'event');
    const outputs = join(dir, 'output');
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(outputs, '');
    const fixtureEnv = { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 'fixture',
      GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputs };
    const gate = spawnSync('bash', ['tools/agent-gate.sh'], { env: fixtureEnv, encoding: 'utf8' });
    assert.equal(gate.status, 0, gate.stderr);
    assert.equal(gate.stdout + gate.stderr + readFileSync(outputs, 'utf8'), '');
    assert.match(readFileSync(join(dir, 'posted'), 'utf8'), /Private repositories cannot run/);
    const worker = spawnSync(process.execPath, ['tools/agent-review.mjs', 'pick'], {
      env: { ...fixtureEnv, REVIEW_HUB_JOB: '1' }, encoding: 'utf8',
    });
    assert.equal(worker.status, 1);
    assert.doesNotMatch(worker.stdout + worker.stderr, /PRIVATE_|example\/target/);
    const failure = spawnSync('bash', ['tools/agent-gate.sh'], {
      env: { ...fixtureEnv, FIXTURE_API_FAILURE: '1' }, encoding: 'utf8',
    });
    assert.equal(failure.status, 1);
    assert.doesNotMatch(failure.stdout + failure.stderr, /PRIVATE_|example\/target/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watcher accepts a matching queue author and revision and rejects a forged or edited request', () => {
  const mock = fixture({ privateRepo: true });
  const message = comment();
  const config = { ...target, machine: 'mac', queueLogin: 'review-bot' };
  const receipt = { issue_url: message.issue_url, user: { login: 'review-bot' },
    body: queueRecord({ id: 123, head: sha, comment: message, machine: 'mac' }) };
  const io = { issue: () => ({ pull_request: {} }), pull: () => mock.answers[`${root}/pulls/7`],
    agentConfig: () => readReviewConfig(target, mock.api), ci: () => 'success', files: () => ['src/worker.js'],
    usage: () => null };
  const judge = (current, queue) => judgeTag({ config, request: parseRequest(current.body), comment: current, receipt: queue,
    now, allowlist: ['owner'], io });
  assert.equal(judge(message, receipt).outcome, 'start');
  assert.equal(judge(message, { ...receipt, user: { login: 'impersonator' } }).outcome, 'skip');
  assert.equal(judge({ ...message, body: validTag + ' effort=high' }, receipt).outcome, 'skip');
  assert.equal(queueFor(receipt.body).digest, tagDigest(message));
});

test('one watcher polls multiple repos, keeps separate state, and continues after one fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-watch-fixture-'));
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ machine: 'vps', queueLogin: 'review-bot', stateDir: dir }));
    writeFileSync(join(dir, 'repos.txt'), '# targets\nexample/a\nexample/b\nEXAMPLE/a\n');
    const config = readConfig({}, configPath);
    assert.equal(targetsFor(config)[0].slotDir, targetsFor(config)[1].slotDir);
    assert.notEqual(targetsFor(config)[0].statePath, targetsFor(config)[1].statePath);
    assert.deepEqual(readConfig({ REVIEW_WATCH_REPOS: 'example/x, example/y' }, configPath).repos, ['example/x', 'example/y']);
    const polled = [];
    const results = pollRepos({ config, now, io: {
      threads: () => [],
      allowlist: () => ['owner'],
      comments({ repo: targetRepo }) {
        polled.push(targetRepo.toLowerCase());
        if (targetRepo.toLowerCase() === 'example/a') throw new Error('fixture failure');
        return [];
      },
    } });
    assert.deepEqual(polled, ['example/a', 'example/b']);
    assert.equal(results[0].failed, true);
    assert.equal(results[1].pending, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
