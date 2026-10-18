// 生成 status.json：各 App 的运行记录、版本、发布状态、备份信息。
// 由 .github/workflows/status.yml 每 30 分钟运行，结果推到 status 分支，总控台网页直接读取。
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(new URL('../apps.json', import.meta.url)));
const OWNER = cfg.owner;
const TOKEN = process.env.GITHUB_TOKEN;
const H = {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(TOKEN ? {Authorization: `Bearer ${TOKEN}`} : {})};
const BAD = ['failure', 'timed_out', 'startup_failure', 'action_required'];
const IGNORE = ['cancelled', 'skipped', 'neutral', 'stale'];
let rate = null;

async function gh(path) {
  const r = await fetch('https://api.github.com' + path, {headers: H});
  if (r.headers.get('x-ratelimit-remaining')) rate = +r.headers.get('x-ratelimit-remaining');
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}
async function text(url) {
  try { const r = await fetch(url, {redirect: 'follow'}); return r.ok ? await r.text() : null; } catch { return null; }
}

const log = (() => { try { return JSON.parse(fs.readFileSync(new URL('../backups/log.json', import.meta.url))); } catch { return {entries: []}; } })();

async function versionOf(repo, pagesUrl, branch) {
  const live = await text(pagesUrl + 'version.json?t=' + Date.now());
  if (live) { try { const j = JSON.parse(live); const v = j.version || j.build; if (v) return {label: String(v), source: '线上 version.json'}; } catch {} }
  const pkg = await text(`https://raw.githubusercontent.com/${OWNER}/${repo}/${branch}/package.json`);
  if (pkg) { try { const v = JSON.parse(pkg).version; if (v && v !== '0.0.0') return {label: v, source: 'package.json'}; } catch {} }
  return {label: null, source: '没有标版本号'};
}

async function one(repo) {
  const key = repo.name.toLowerCase();
  const meta = cfg.apps[key] || {};
  const pagesUrl = `https://${OWNER}.github.io/${repo.name}/`;
  const branch = repo.default_branch || 'main';
  const out = {
    repo: repo.name, key, title: meta.name || repo.name, desc: meta.desc || repo.description || '',
    url: repo.homepage || pagesUrl, pushed_at: repo.pushed_at, size_kb: repo.size,
    maxGap: meta.maxGap || null, adapter: meta.adapter || null, phone: meta.phone || {kind: 'unknown', text: '还没登记这个 App 的本机数据情况'},
    deployIgnoreBot: !!meta.deployIgnoreBot, errors: []
  };
  try {
    const d = await gh(`/repos/${OWNER}/${repo.name}/actions/runs?per_page=50`);
    out.runs = (d.workflow_runs || []).map(r => ({
      id: r.id, wid: r.workflow_id, name: r.name, path: r.path, event: r.event, status: r.status, conclusion: r.conclusion,
      created_at: r.created_at, started: r.run_started_at, updated_at: r.updated_at, url: r.html_url, sha: r.head_sha,
      msg: (r.head_commit && r.head_commit.message || '').split('\n')[0].slice(0, 80)
    }));
  } catch (e) { out.runs = null; out.errors.push('读取任务记录失败'); }

  // 定时配置
  out.crons = {};
  const paths = [...new Set((out.runs || []).map(r => r.path).filter(p => p && p.startsWith('.github/workflows/')))];
  for (const p of paths) {
    const y = await text(`https://raw.githubusercontent.com/${OWNER}/${repo.name}/${branch}/${p}`);
    if (y) out.crons[p] = [...y.matchAll(/cron:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
  }

  // 失败的步骤
  out.failSteps = {};
  const seen = new Set();
  for (const r of out.runs || []) {
    if (seen.has(r.wid) || r.status !== 'completed' || IGNORE.includes(r.conclusion)) continue;
    seen.add(r.wid);
    if (!BAD.includes(r.conclusion)) continue;
    try {
      const j = await gh(`/repos/${OWNER}/${repo.name}/actions/runs/${r.id}/jobs`);
      const job = (j.jobs || []).find(x => BAD.includes(x.conclusion)) || (j.jobs || [])[0];
      const step = job && (job.steps || []).find(s => BAD.includes(s.conclusion));
      out.failSteps[r.id] = step ? `出错的步骤：「${step.name}」` : '没找到具体出错步骤';
    } catch { out.failSteps[r.id] = '没读到出错步骤'; }
  }

  // 提交记录
  try {
    const c = await gh(`/repos/${OWNER}/${repo.name}/commits?per_page=60&sha=${branch}`);
    out.commits = c.map(x => ({
      sha: x.sha.slice(0, 7), date: x.commit.committer.date,
      msg: x.commit.message.split('\n')[0].slice(0, 90),
      bot: /\[bot\]$/.test((x.author && x.author.login) || '') || /\[bot\]|github-actions/.test(x.commit.author.name || '')
    }));
  } catch { out.commits = []; out.errors.push('读取提交记录失败'); }

  out.version = await versionOf(repo.name, pagesUrl, branch);
  const t0 = Date.now();
  try { const r = await fetch(pagesUrl, {redirect: 'follow'}); out.site = {ok: r.ok, code: r.status}; }
  catch { out.site = {ok: false, code: 0}; }
  out.site.ms = Date.now() - t0;

  // 备份
  const hist = log.entries.map(e => e.apps && e.apps[repo.name] ? {date: e.date, at: e.at, ...e.apps[repo.name]} : null).filter(Boolean);
  out.backup = {latest: hist[0] || null, history: hist.slice(0, 14).map(h => ({date: h.date, bytes: h.bytes, sha: h.sha}))};
  return out;
}

const repos = (await gh(`/users/${OWNER}/repos?per_page=100&sort=pushed`))
  .filter(r => !r.fork && !r.archived && (r.has_pages || cfg.apps[r.name.toLowerCase()]));
const apps = [];
for (const r of repos) apps.push(await one(r));
const last = log.entries[0] || null;
const status = {
  generated_at: new Date().toISOString(), rate_left: rate,
  backup: last ? {date: last.date, at: last.at, tag: last.tag, total_bytes: last.total_bytes, all_url: last.all_url, count: Object.keys(last.apps || {}).length, retention: cfg.retentionDays, days: log.entries.length} : null,
  apps
};
process.stdout.write(JSON.stringify(status));
