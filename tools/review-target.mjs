import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../.github/agents.json', import.meta.url), 'utf8'));
export const hubRepo = 'Flame119052/agent-review';
export const validRepo = (repo) => typeof repo === 'string'
  && /^[a-z0-9][a-z0-9-]{0,38}\/(?!\.{1,2}$)[a-z0-9_.-]{1,100}$/i.test(repo)
  && !repo.toLowerCase().endsWith('.git');
export const validSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/i.test(sha);

export function reviewEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const keys = event.client_payload || event.inputs || {
    repository: event.repository?.full_name,
    issue_number: event.issue?.number,
    comment_id: event.comment?.id,
  };
  const { repository: repo, issue_number: issue, comment_id: id } = keys;
  const positiveId = (value) => ['string', 'number'].includes(typeof value)
    && /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));
  return validRepo(repo) && positiveId(issue) && positiveId(id)
    ? { repo, number: Number(issue), id: Number(id) }
    : null;
}

export function liveComment(target, api = targetApi) {
  const { repo, id, number } = target;
  const comment = api(`repos/${repo}/issues/comments/${id}`);
  const parent = `https://api.github.com/repos/${repo}/issues/${number}`;
  return comment?.id === id && comment.issue_url?.toLowerCase() === parent.toLowerCase() ? comment : null;
}

export function tagDigest(comment) {
  return createHash('sha256').update(JSON.stringify([
    comment.id, comment.user?.id, comment.user?.login, comment.updated_at, comment.body,
  ])).digest('hex');
}

// Capture diagnostics, including GitHub error bodies. The workflow prints only fixed failures.
export function targetApi(path, { pages = false, optional = false } = {}) {
  const args = ['api', path, '-H', 'Accept: application/vnd.github+json'];
  if (pages) args.push('--paginate', '--slurp');
  try {
    return JSON.parse(execFileSync('gh', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 30 * 1024 * 1024,
    }));
  } catch (error) {
    if (optional && /\(HTTP 404\)/.test(String(error.stderr || ''))) return null;
    throw new Error('GitHub could not read the review target.');
  }
}

function fileOnDefault(target, path, api) {
  return api(`repos/${target.repo}/contents/${path}?ref=${encodeURIComponent(target.defaultBranch)}`, { optional: true });
}

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;

export function mergeReviewConfig(raw = {}) {
  raw = object(raw);
  const rules = { ...raw, ...object(raw.agents) };
  const models = object(rules.models);
  const allowed = object(rules.allowed || models.allowed || models);
  return {
    ...catalog,
    allowed: Object.fromEntries(Object.entries(catalog.allowed).map(([provider, names]) => [
      provider, strings(allowed[provider])?.filter((name) => names.includes(name)) ?? names,
    ])),
    strong: strings(rules.strong || models.strong)?.filter((name) => catalog.strong.includes(name)) ?? catalog.strong,
    efforts: strings(rules.efforts)?.filter((name) => catalog.efforts.includes(name)) ?? catalog.efforts,
    reserve: object(rules.reserve),
    caps: Object.fromEntries(Object.entries(catalog.caps).map(([key, value]) => [
      key, value && typeof value === 'object' ? { ...value, ...object(rules.caps?.[key]) } : rules.caps?.[key] ?? value,
    ])),
    requireCi: raw.requireCi !== false,
    omitDiffPaths: strings(raw.omitDiffPaths) ?? [],
    sensitivePaths: strings(raw.sensitivePaths) ?? [],
    docsOnlyExtensions: strings(raw.docsOnlyExtensions),
  };
}

export function repositoryTarget(repo, api = targetApi) {
  if (!validRepo(repo)) throw new Error('Invalid repository name.');
  const data = api(`repos/${repo}`);
  if (!validRepo(data?.full_name) || data.full_name.toLowerCase() !== repo.toLowerCase()
      || typeof data.private !== 'boolean' || typeof data.default_branch !== 'string' || !data.default_branch) {
    throw new Error('GitHub could not verify the review target.');
  }
  return { repo: data.full_name, private: data.private, defaultBranch: data.default_branch };
}

export function readReviewConfig(target, api = targetApi) {
  const reviewFile = fileOnDefault(target, '.github/review.json', api);
  const file = reviewFile ?? fileOnDefault(target, '.github/agents.json', api);
  if (!file) return mergeReviewConfig();
  if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
    throw new Error('GitHub did not return a review configuration file.');
  }
  const config = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Invalid review configuration.');
  if (!reviewFile) {
    // Legacy .github/agents.json predates the hub: keep its caps/reserve/paths, but let the hub own allowed/strong models.
    const { allowed: _a, strong: _s, models: _m, agents: _ag, ...rest } = config;
    return mergeReviewConfig(rest);
  }
  return mergeReviewConfig(config);
}

export function ciPassed(target, sha, api = targetApi) {
  if (!validSha(sha)) return false;
  const check = fileOnDefault(target, '.github/workflows/check.yml', api);
  const prefix = `repos/${target.repo}/actions`;
  const path = check ? `${prefix}/workflows/check.yml/runs` : `${prefix}/runs`;
  const runs = api(`${path}?head_sha=${sha}&event=pull_request&per_page=100`, { pages: true });
  const relevant = (runs || []).flatMap((page) => page.workflow_runs || [])
    .filter((run) => run.head_sha === sha && run.event === 'pull_request')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id));
  const latest = new Map();
  for (const run of relevant) if (!latest.has(run.workflow_id)) latest.set(run.workflow_id, run);
  return latest.size > 0 && [...latest.values()].every((run) => run.conclusion === 'success');
}

export function changedPaths(repo, number, api = targetApi, expected) {
  const files = api(`repos/${repo}/pulls/${number}/files?per_page=100`, { pages: true }).flat();
  if (!files.length || (expected !== undefined && files.length !== expected)
      || files.some((file) => typeof file.filename !== 'string' || !file.filename)) {
    throw new Error('GitHub did not return the complete changed-file list.');
  }
  return files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
}

export function queueRecord({ id, head, comment, machine }) {
  return `<!-- agent-review-queue:v1 ${id} ${machine} ${head || '-'} ${tagDigest(comment)} -->`;
}

export function queueFor(body) {
  const match = String(body || '').match(/^<!-- agent-review-queue:v1 ([1-9][0-9]*) (mac|omarchy|vps) (-|[0-9a-f]{40}) ([0-9a-f]{64}) -->$/m);
  if (!match) return null;
  const [, id, machine, head, digest] = match;
  return { id: Number(id), machine, head: head === '-' ? '' : head, digest };
}
