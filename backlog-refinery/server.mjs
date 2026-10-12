// Backlog Refinery. Reads the Needs Triage column live, keeps decisions on disk, and
// writes a plan for Claude to action. This server never writes to GitHub.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { acceptanceCriteria, prioLevel, isHeld } from './public/assets/dor.js';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
// REFINERY_DATA points a second instance at a copy of data/, so the client can be exercised without touching the real decisions.
const DATA = process.env.REFINERY_DATA || path.join(ROOT, 'data');
const CONFIG = path.join(ROOT, 'config.json');
if (!fs.existsSync(CONFIG)) {
  console.error('config.json not found. Copy config.example.json to config.json, fill in your owner and project number, then start again. See README.md.');
  process.exit(1);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) {
  console.error(`config.json is not valid JSON: ${e.message}`);
  process.exit(1);
}
const PORT = Number(process.env.PORT || cfg.port || 4380);
// Stage mode (?stage) deals only cards from the repos listed here. Empty by default, so it shows nothing until you name your public repos.
const STAGE = { repos: [], hideLabels: ['security'], ids: [], ...(cfg.stage || {}) };
// Which optional additions to the Definition of Ready are on; REFINERY_DOR overrides config.json for a test instance.
const DOR = process.env.REFINERY_DOR != null ? Object.fromEntries(process.env.REFINERY_DOR.split(',').filter(Boolean).map(k => [k, true])) : (cfg.dor || {});

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 1));
const safe = id => id.replace(/[^A-Za-z0-9_.-]/g, '_');
const audit = entry => fs.appendFileSync(path.join(DATA, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');

const BLANK = { action: 'verify-first', estimate: 0, estimate_reason: '', body: '', body_summary: '', title: '', title_reason: '', close_target: '', close_reason: '',
  needs_info: ['No suggestion generated yet for this item.'], confidence: 'low', rationale: 'Arrived after the last suggestion pass.' };

async function gh(args, opts = {}) {
  const { stdout } = await run('gh', args, { maxBuffer: 64 * 1024 * 1024, ...opts });
  return stdout;
}

// ---- board ----------------------------------------------------------------
let cache = { at: 0, items: null };
let boardInflight = null;

// One GitHub read at a time: the phone and the laptop asking together would otherwise each pay for the 15 second fetch.
function fetchBoard(force = false) {
  const ttl = (cfg.boardCacheMinutes || 10) * 60_000;
  if (!force && cache.items && Date.now() - cache.at < ttl) return Promise.resolve(cache.items);
  if (!boardInflight) boardInflight = loadBoard(force).finally(() => { boardInflight = null; });
  return boardInflight;
}

async function loadBoard(force = false) {
  const ttl = (cfg.boardCacheMinutes || 10) * 60_000;
  if (!force && cache.items && Date.now() - cache.at < ttl) return cache.items;

  // Both columns, because refinement moves items into Not Ready and they still need working.
  // The status string must match the board's option name exactly, emoji included; otherwise the CLI silently returns nothing.
  // A verify sweep can exhaust the GitHub GraphQL budget for an hour, so the last good fetch is
  // kept on disk and served, marked stale, until GitHub answers again.
  let board = [], created = {}, stale = null;
  try {
  for (const status of (cfg.statuses || [cfg.triageStatus]).filter(Boolean)) {
    const raw = await gh(['project', 'item-list', String(cfg.projectNumber), '--owner', cfg.owner,
      '--limit', '600', '--format', 'json', '--query', `status:"${status}"`]);
    const got = JSON.parse(raw).items || [];
    if (got.length >= 600) console.warn(`WARNING: "${status}" hit the 600 limit, results may be truncated`);
    if (got.length === 0) console.warn(`WARNING: "${status}" returned nothing, check the status name in config.json matches the board exactly`);
    for (const i of got) { i.boardStatus = status; board.push(i); }
  }

  // created dates come from the repos the board's items live in, not the board
  const repos = [...new Set(board.map(b => ((b.content || {}).repository || '').split('/').pop()).filter(Boolean))];
  for (const repo of repos) {
    try {
      const j = JSON.parse(await gh(['issue', 'list', '-R', `${cfg.owner}/${repo}`, '--state', 'open', '--limit', '1000', '--json', 'number,createdAt']));
      for (const i of j) created[`${repo}#${i.number}`] = i.createdAt.slice(0, 10);
    } catch (e) { console.warn('created-date fetch failed for', repo, e.message); }
  }
  writeJson('board-snapshot.json', { at: Date.now(), board, created });
  } catch (e) {
    const snap = readJson('board-snapshot.json', null);
    if (!snap) throw e;
    console.warn('board fetch failed, serving snapshot from', new Date(snap.at).toISOString(), e.message.split('\n')[0]);
    board = snap.board; created = snap.created; stale = snap.at;
  }

  const sugg = readJson('suggestions.json', {});
  const dupes = readJson('dupes.json', {});
  const deep = readJson('deep.json', {});
  // Items you actually worked, plus anything the verification touched, plus the live triage column.
  // Widening the fetch to more columns can pull in hundreds of items nobody asked about, and they
  // swamp the undecided queue and make finished work look unfinished.
  const scope = new Set(readJson('scope.json', []));
  const meta = readJson('meta.json', {});

  const items = [];
  for (const b of board) {
    const c = b.content || {};
    if (!c.number) continue;
    const repo = (c.repository || '').split('/').pop();
    const id = `${repo}#${c.number}`;
    items.push({
      id, repo, num: c.number, itemId: b.id, title: b.title || c.title || '',
      url: `https://github.com/${cfg.owner}/${repo}/issues/${c.number}`,
      priority: b.priority ?? null, prioLevel: prioLevel(b.priority), hasSug: !!sugg[id], ac: acceptanceCriteria(c.body),
      created: created[id] || (meta[id] || {}).created || null,
      urgency: (meta[id] || {}).urgency || 0,
      est: b.estimate ?? null, col: b.boardStatus || b.status || null, body: (c.body || '').slice(0, 6000), labels: b.labels || [],
      deep: deep[id] || null, sug: sugg[id] || BLANK, dupes: dupes[id] || [], inScope: scope.has(id),
    });
  }
  const order = { 'close-superseded': 0, 'close-not-planned': 0, 'set-estimate': 1, 'rewrite-and-estimate': 2, 'rewrite-body': 3,
    'split': 4, 'needs-decision': 5, 'verify-first': 6, 'leave-as-is': 7 };
  items.sort((a, b) => (order[a.sug.action] ?? 9) - (order[b.sug.action] ?? 9) || (b.urgency - a.urgency) || String(a.created).localeCompare(String(b.created)));
  // A stale board re-asks GitHub after a minute instead of waiting out the full TTL.
  cache = { at: stale ? Date.now() - ttl + 60_000 : Date.now(), items, stale };
  return items;
}

// ---- plan ------------------------------------------------------------------
// The app decides nothing and applies nothing. Accepted decisions become a plan file that a
// Claude session reads and actions, with the usual handshake on any text.
function planFor(item, d) {
  const action = d.action || item.sug.action;
  const est = d.estimate !== undefined ? d.estimate : (item.sug.estimate || null);
  const steps = [];
  const text = {};
  if (action === 'set-estimate') {
    if (est) steps.push({ kind: 'estimate', value: est });
    // Ready needs acceptance criteria under the Definition of Ready, so sizing alone never readies an item that has none.
    // item.ac comes from dor.js on the full body, so the plan and the card's Detail check always agree.
    // Held work (labelled blocked or on hold) is sized but never readied, the same rule as the rewrite branch below.
    if (item.ac && !isHeld(item)) steps.push({ kind: 'status', value: 'ready' });
    else if (/Triage/.test(item.col || '') || isHeld(item)) steps.push({ kind: 'status', value: 'notReady' });
  } else if (action === 'rewrite-and-estimate') {
    if (est) steps.push({ kind: 'estimate', value: est });
    text.body = d.body ?? item.sug.body ?? '';
  } else if (action === 'rewrite-body') {
    text.body = d.body ?? item.sug.body ?? '';
  }
  // A title only goes out when it differs from the live one, so an unchanged title is never re-posted.
  if (action === 'rewrite-and-estimate' || action === 'rewrite-body') {
    const title = (d.title ?? item.sug.title ?? '').trim();
    if (title && title !== item.title.trim()) text.title = title;
    // A rewritten, estimated item is refined, so it leaves triage; without this step accepted rewrites
    // pile up in Needs Triage and Not Ready. Held work (or a recorded blocker) goes to Not Ready;
    // an item never checked against the code stays put until verified.
    const held = isHeld(item);
    const sized = est || item.est;
    if (sized && held) steps.push({ kind: 'status', value: 'notReady' });
    else if (sized && item.deep === 'verified') steps.push({ kind: 'status', value: 'ready' });
  } else if (action === 'close-superseded' || action === 'close-not-planned') {
    steps.push({ kind: 'close', reason: 'not planned' });
    const target = d.close_target ?? item.sug.close_target ?? '';
    text.comment = (d.close_reason ?? item.sug.close_reason ?? '') + (target ? `\n\nSuperseded by ${target}` : '');
    if (target) text.superseded_by = target;
  } else if (action === 'needs-decision' || action === 'split') {
    // Accepting a decision means doing it, not parking it: otherwise accepted recommendations pile up in
    // Not Ready with nothing done. The decision text is for Claude to carry out, drafting any posts.
    steps.push({ kind: 'status', value: 'notReady' });
    const call = (d.note ?? item.sug.recommended_decision ?? '').trim()
      || (action === 'split' ? (item.sug.rationale || '').trim() : '');
    if (call) text[action === 'split' ? 'split' : 'decision'] = call;
  }
  // Refinement only moves items between triage and the backlog. A needs-decision accept once pulled
  // an In progress item out from under the person working it, so any other column keeps its place.
  if (item.col && !/Triage|Backlog/.test(item.col)) {
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i].kind === 'status') steps.splice(i, 1);
  }
  return {
    id: item.id, url: `https://github.com/${cfg.owner}/${item.repo}/issues/${item.num}`,
    itemId: item.itemId, repo: item.repo, num: item.num, title: item.title,
    action, steps, text, note: d.note || '', edited: !!d.edited, decidedAt: d.at,
  };
}

function planMarkdown(p) {
  const lines = [`# Refinery plan, ${p.generatedAt}`, '', `${p.items.length} accepted decisions, none applied yet.`, '',
    'Board steps are approved by the accept. Anything under **text** is a draft and goes through the normal', 'show-in-chat handshake before it is posted.', ''];
  for (const it of p.items) {
    lines.push(`## ${it.id}  ${it.title}`, it.url, `action: ${it.action}${it.edited ? ' (edited)' : ''}`);
    for (const s of it.steps) lines.push(`- ${s.kind}${s.value ? ': ' + s.value : ''}${s.reason ? ': ' + s.reason : ''}`);
    if (it.text.decision) lines.push('', '### text.decision (carry this out)', '', it.text.decision);
    if (it.text.split) lines.push('', '### text.split (split it this way)', '', it.text.split);
    if (it.text.title) lines.push('', '### text.title', '', it.text.title);
    if (it.text.body) lines.push('', '### text.body', '', it.text.body.trim());
    if (it.text.comment) lines.push('', '### text.comment', '', it.text.comment.trim());
    if (it.note) lines.push('', `note: ${it.note}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function buildPlan(ids) {
  const items = await fetchBoard();
  const decisions = readJson('decisions.json', {});
  const targets = items.filter(i => (decisions[i.id] || {}).decision === 'accept' && !(decisions[i.id] || {}).applied && (!ids || ids.includes(i.id)));
  const plan = { generatedAt: new Date().toISOString(), items: targets.map(i => planFor(i, decisions[i.id])) };
  writeJson('plan.json', plan);
  fs.writeFileSync(path.join(DATA, 'PLAN.md'), planMarkdown(plan));
  audit({ plan: plan.items.length });
  return plan;
}

// ---- http -----------------------------------------------------------------
// no-store throughout: the page and the board both change under the user while the tab is open,
// and a stale cached copy looks like the app ignoring an edit.
// The board response is about 2MB, so it is gzipped for the phone on the tailnet whenever the client accepts it.
const send = (res, code, body, type = 'application/json') => {
  let out = type === 'application/json' ? JSON.stringify(body) : body;
  const headers = { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', vary: 'accept-encoding' };
  if (res.gzip && out.length > 1024) { out = zlib.gzipSync(out); headers['content-encoding'] = 'gzip'; }
  res.writeHead(code, headers); res.end(out);
};
const ASSETS = path.join(ROOT, 'public', 'assets');
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });

// Loopback plus this machine's Tailscale address, so a phone on the tailnet can reach it by IP
// without depending on MagicDNS. A tailnet address only routes inside the tailnet, so this is not
// exposed on whatever wifi the laptop joins.
const TAILSCALE = process.env.TAILSCALE_BIN || 'tailscale';
const tailscaleIp = () => {
  try { return execFileSync(TAILSCALE, ['ip', '-4'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0] || null; }
  catch { return null; }
};

// Tailscale serve can mount the app under /backlog-refinery/, so that prefix is accepted and stripped;
// the client uses relative URLs, which resolve under either root.
const PREFIX = '/backlog-refinery';
const handler = async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === PREFIX) { res.writeHead(301, { location: PREFIX + '/' + u.search }); return res.end(); }
  if (u.pathname.startsWith(PREFIX + '/')) u.pathname = u.pathname.slice(PREFIX.length);
  res.gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  try {
    if (req.method === 'GET' && u.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (req.method === 'GET' && u.pathname === '/') return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), 'text/html');
    if (req.method === 'GET' && u.pathname.startsWith('/assets/')) {
      const file = path.resolve(ASSETS, '.' + decodeURIComponent(u.pathname.slice('/assets'.length)));
      const type = TYPES[path.extname(file)];
      if (!file.startsWith(ASSETS + path.sep) || !type || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(file, 'utf8'), type);
    }
    if (req.method === 'GET' && u.pathname === '/api/board') {
      const items = await fetchBoard(u.searchParams.has('refresh'));
      const decisions = readJson('decisions.json', {});
      // Everything below the original four keys is read fresh on each request, outside the board cache, so a pick
      // made on the laptop shows on the phone at once.
      const planned = {};
      for (const i of items) {
        if ((decisions[i.id] || {}).decision !== 'accept' || decisions[i.id].applied) continue;
        try { planned[i.id] = planFor(i, decisions[i.id]); } catch (e) { console.warn('planFor failed for', i.id, e.message); }
      }
      const plan = readJson('plan.json', null);
      return send(res, 200, { owner: cfg.owner, fetchedAt: new Date(cache.stale || cache.at).toISOString(), stale: !!cache.stale, items, decisions,
        prio: readJson('priorities.json', {}), prioPicks: readJson('priority-decisions.json', {}),
        carry: { drafts: readJson('carry-drafts.json', {}), picks: readJson('carry-decisions.json', {}), posted: readJson('carry-posted.json', {}) },
        planned, lastPlan: plan ? { generatedAt: plan.generatedAt, count: (plan.items || []).length } : null, stage: STAGE,
        evidence: readJson('evidence.json', {}), types: readJson('types.json', {}), dor: DOR });
    }
    if (req.method === 'GET' && u.pathname === '/api/decisions') return send(res, 200, readJson('decisions.json', {}));
    if (req.method === 'PUT' && u.pathname.startsWith('/api/decisions/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/decisions/'.length));
      const all = readJson('decisions.json', {});
      const patch = await readBody(req);
      const undoing = patch.undo === true; delete patch.undo;
      // Skip, undo and reopen cannot take back what Claude has already applied; the client is told and shows the record.
      if ((undoing || patch.decision === 'skip' || ('decision' in patch && patch.decision === null)) && (all[id] || {}).applied) {
        return send(res, 409, { error: 'Claude already applied this decision', record: all[id] });
      }
      all[id] = { ...(all[id] || {}), ...patch, id, at: new Date().toISOString() };
      writeJson('decisions.json', all);
      return send(res, 200, all[id]);
    }
    if (req.method === 'POST' && u.pathname === '/api/plan') {
      const { ids } = await readBody(req);
      const plan = await buildPlan(ids);
      return send(res, 200, { ...plan, files: [path.join(DATA, 'plan.json'), path.join(DATA, 'PLAN.md')] });
    }
    if (req.method === 'GET' && u.pathname === '/api/plan') return send(res, 200, readJson('plan.json', { generatedAt: null, items: [] }));
    // What accepting would hand Claude, from the same planFor() the real plan uses. Writes nothing.
    if (req.method === 'POST' && u.pathname === '/api/plan/preview') {
      const { id, patch } = await readBody(req);
      const item = (cache.items || await fetchBoard()).find(i => i.id === id);
      if (!item) return send(res, 404, { error: 'not on the board' });
      return send(res, 200, planFor(item, { ...(readJson('decisions.json', {})[id] || {}), ...(patch || {}) }));
    }
    // Called by the Claude session after it has actioned items, so they drop out of the next plan.
    if (req.method === 'POST' && u.pathname === '/api/applied') {
      const { ids } = await readBody(req);
      const all = readJson('decisions.json', {});
      const at = new Date().toISOString();
      for (const id of ids || []) if (all[id]) all[id].applied = at;
      writeJson('decisions.json', all);
      audit({ applied: ids });
      cache.at = 0;
      return send(res, 200, { applied: ids, at });
    }
    // Drafted texts that carry out accepted decisions. The app records your approval, your edits and any op
    // you untick; Claude posts approved items when asked, exactly as recorded here.
    if (req.method === 'GET' && u.pathname === '/api/carry') {
      const drafts = readJson('carry-drafts.json', {});
      const picks = readJson('carry-decisions.json', {});
      const items = Object.entries(drafts).map(([id, v]) => ({ id, ...v, pick: picks[id] || null }));
      return send(res, 200, { items });
    }
    if (req.method === 'PUT' && u.pathname.startsWith('/api/carry/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/carry/'.length));
      const patch = await readBody(req);
      const undoing = patch.undo === true; delete patch.undo;
      const picks = readJson('carry-decisions.json', {});
      if ((undoing || patch.decision === 'skip' || ('decision' in patch && patch.decision === null)) && Object.keys((readJson('carry-posted.json', {})[id] || {}).ops || {}).length) {
        return send(res, 409, { error: 'Claude already posted part of this', record: picks[id] || null });
      }
      // Edits merge per op, so a client holding an older edits map cannot wipe a trim Claude wrote to another op.
      if (patch.edits) patch.edits = { ...((picks[id] || {}).edits || {}), ...patch.edits };
      picks[id] = { ...(picks[id] || {}), ...patch, at: new Date().toISOString() };
      writeJson('carry-decisions.json', picks);
      audit({ carry: id, decision: picks[id].decision || null });
      return send(res, 200, picks[id]);
    }
    // Priority calls Claude could not make alone. Suggestions come from the grading run; the app only
    // records your pick, and Claude applies picks to the board when asked, like everything else here.
    if (req.method === 'GET' && u.pathname === '/api/priorities') {
      const sug = readJson('priorities.json', {});
      const picks = readJson('priority-decisions.json', {});
      const board = new Map((await fetchBoard()).map(i => [i.id, i]));
      const items = Object.entries(sug).filter(([, v]) => v.needs_owner).map(([id, v]) => {
        const b = board.get(id) || {};
        const [repo, num] = id.split('#');
        return { id, url: `https://github.com/${cfg.owner}/${repo}/issues/${num}`, title: b.title || id, estimate: b.est ?? null,
          ...v, pick: picks[id] || null };
      });
      return send(res, 200, { items });
    }
    if (req.method === 'PUT' && u.pathname.startsWith('/api/priorities/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/priorities/'.length));
      const body = await readBody(req);
      // Only an explicit priority: null clears a pick; a body without the key is a client fault, not a delete.
      if (!('priority' in body)) return send(res, 400, { error: 'priority is required; send null to clear' });
      const { priority } = body;
      const picks = readJson('priority-decisions.json', {});
      if (body.undo === true && (picks[id] || {}).applied_at) return send(res, 409, { error: 'Claude already applied this priority', record: picks[id] });
      if (priority) picks[id] = { priority, at: new Date().toISOString() }; else delete picks[id];
      writeJson('priority-decisions.json', picks);
      audit({ priority: id, pick: priority || null });
      return send(res, 200, picks[id] || {});
    }
    if (req.method === 'GET' && u.pathname === '/api/audit') {
      const p = path.join(DATA, 'audit.jsonl');
      const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').slice(-200) : [];
      return send(res, 200, lines.map(l => JSON.parse(l)));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e.message || e) });
  }
};

const listen = host => new Promise(resolve => {
  const srv = http.createServer(handler);
  srv.once('error', e => { console.error(`listen ${host}:${PORT} failed: ${e.message}`); resolve(null); });
  srv.listen(PORT, host, () => { console.log(`Backlog Refinery on http://${host === '127.0.0.1' ? 'localhost' : host}:${PORT}`); resolve(srv); });
});
const answers = ip => fetch(`http://${ip}:${PORT}/healthz`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false);

// The tailnet listener heals itself: a server that started before Tailscale was up, whose address moved, or whose
// socket stopped answering, binds again within a minute, so the phone never needs the laptop to restart it.
let tailnet = { ip: null, srv: null };
async function keepTailnet() {
  // A failed lookup keeps the current address; only a listener that stops answering is torn down.
  const ip = tailscaleIp() || tailnet.ip;
  if (ip && ip === tailnet.ip && tailnet.srv && tailnet.srv.listening && await answers(ip)) return;
  if (tailnet.srv) { tailnet.srv.close(); console.warn(`rebinding the tailnet listener (was ${tailnet.ip}, now ${ip || 'no address'})`); }
  tailnet = { ip: null, srv: null };
  if (ip) tailnet = { ip, srv: await listen(ip) };
}
listen('127.0.0.1');
keepTailnet();
setInterval(keepTailnet, Number(process.env.TAILNET_CHECK_MS) || 60_000);
