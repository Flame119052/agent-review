import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { headFacts, marker, parseRequest, queuedComment, reviewRefusalText, routeReview, tagLine } from './agent-review.mjs';
import {
  ciPassed, liveComment, queueRecord, readReviewConfig, repositoryTarget, reviewEvent, tagDigest, targetApi, validSha,
} from './review-target.mjs';

export function authorizeReview(event, env, api = targetApi, now = Date.now()) {
  const source = reviewEvent(event);
  if (!source) return null;
  const target = { ...source, ...repositoryTarget(source.repo, api) };
  const comment = liveComment(target, api);
  const allowlist = String(env.AGENT_ALLOWLIST || '').split(',').map((user) => user.trim()).filter(Boolean);
  if (!comment || !allowlist.includes(comment.user?.login) || comment.body?.includes(marker)) return null;
  const role = tagLine(comment.body).split(/\s+/)[1];
  if (!role) return null;
  const request = parseRequest(comment.body);
  const route = routeReview(request, target.private, env, now);
  const facts = { ...target, role, comment, request };
  if (route.refusal) return { ...facts, refusal: route.refusal };

  const issue = api(`repos/${target.repo}/issues/${target.number}`);
  if (role === 'pr' && !issue?.pull_request) return { ...facts, refusal: 'not-a-pull-request' };
  let head = '';
  let pull = null;
  if (issue?.pull_request) {
    pull = api(`repos/${target.repo}/pulls/${target.number}`);
    const checked = headFacts(pull, target.repo);
    if (checked.problem || !validSha(checked.sha)) return { ...facts, refusal: 'fork-pr' };
    head = checked.sha;
  }
  const config = readReviewConfig(target, api);
  if (head && config.requireCi && !ciPassed(target, head, api)) return { ...facts, refusal: 'ci-not-passed' };
  return { ...facts, machine: route.machine, head, pull, issue, config };
}

export function workflowReview(env = process.env) {
  const facts = authorizeReview(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')), env);
  if (!facts || facts.private || facts.refusal || facts.machine !== 'github'
    || workflowDigest(facts) !== env.REVIEW_GATE_DIGEST) {
    throw new Error('The public review request changed or is no longer eligible.');
  }
  return facts;
}

const workflowDigest = (facts) => tagDigest({
  ...facts.comment, body: JSON.stringify([facts.comment.body, facts.head, facts.pull?.base?.sha, facts.config, facts.defaultBranch, facts.repo, facts.number]),
});

function post(facts, body) {
  execFileSync('gh', ['issue', 'comment', String(facts.number), '-R', facts.repo, '--body-file', '-'], {
    input: body, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function runGate(event, env, { api = targetApi, publish = post, now = Date.now() } = {}) {
  const facts = authorizeReview(event, env, api, now);
  if (!facts) return {};
  if (facts.refusal) {
    publish(facts, reviewRefusalText(facts.refusal));
    return {};
  }
  if (facts.machine !== 'github') {
    publish(facts, `${queuedComment({ machine: facts.machine })}\n\n${queueRecord(facts)}`);
    return {};
  }
  return { allowed: 'true', digest: workflowDigest(facts) };
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    if (!process.env.GH_TOKEN) throw new Error('Missing target token.');
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const output = Object.entries(runGate(event, process.env)).map(([key, value]) => `${key}=${value}\n`).join('');
    if (output) appendFileSync(process.env.GITHUB_OUTPUT, output);
  } catch {
    console.error('Could not verify or notify the review target. Check the target token and repository access.');
    process.exitCode = 1;
  }
}
