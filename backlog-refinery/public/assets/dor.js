// SSW's Definition of Ready, computed per card. Shared by the browser and server.mjs, so it must stay free of DOM and Node APIs.
// Readiness is judged from the board and the records on disk; a check only reads Met once the board shows it.

export const LEVELS = ['Urgent', 'High', 'Medium', 'Low'];
export const SCALE = [2, 4, 8, 16];

const CRITERIA_HEADING = /^[ \t]{0,3}#{1,6}[ \t]*(?:[^\n\w]*(?:acceptance|done when|definition of done)\b|[^\n]*acceptance criteria)[^\n]*$/im;
const ANY_HEADING = /^[ \t]{0,3}#{1,6}[ \t]/m;
const LIST_LINE = /^(?:[-*+]|\d+[.)])\s/;

export function acceptanceCriteria(body) {
  const text = String(body || '');
  const m = CRITERIA_HEADING.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = ANY_HEADING.exec(rest);
  const lines = (next ? rest.slice(0, next.index) : rest).split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  return { items: lines.filter(l => LIST_LINE.test(l)).length };
}

export function prioLevel(raw) {
  const m = /Urgent|High|Medium|Low/.exec(String(raw || ''));
  return m ? m[0] : null;
}

// One gitmoji per issue type. With the gitmoji switch on, a title must lead with its type's gitmoji to meet Detail.
export const GITMOJI = {
  feature: ['✨', 'Feature'], bug: ['🐛', 'Bug'], refactor: ['♻️', 'Refactor'], chore: ['🧹', 'Chore'], docs: ['📝', 'Docs'],
  security: ['🔒', 'Security'], auth: ['🛂', 'Auth'], secrets: ['🔐', 'Secrets'], ui: ['💄', 'UI'], ux: ['🚸', 'UX'],
  perf: ['⚡', 'Performance'], infra: ['🧱', 'Infrastructure'], analytics: ['📊', 'Analytics'], spike: ['🔭', 'Spike'],
};
const bare = e => String(e || '').replace(/\uFE0F/g, '');
const BY_EMOJI = Object.fromEntries(Object.entries(GITMOJI).map(([k, [e]]) => [bare(e), k]));
// The type a title's leading gitmoji claims, or null when it leads with none from the set.
export function titleType(title) {
  const m = /^\s*(\p{Extended_Pictographic})/u.exec(String(title || ''));
  return m ? BY_EMOJI[bare(m[1])] || null : null;
}

// Held work stays out of Ready. planFor() in server.mjs uses this same test, so the card and the plan agree.
export const isHeld = it => (it.labels || []).some(l => /blocked|on hold/i.test(l)) || !!(it.sug && it.sug.hold);

// Refinement never moves an item out of a working column; planFor() strips its status steps there too.
export const isWorking = col => !!col && !/Triage|Backlog/.test(col);

const CLOSE = new Set(['close-not-planned', 'close-superseded']);
const REWRITE = new Set(['rewrite-and-estimate', 'rewrite-body']);
const SIZES = new Set(['set-estimate', 'rewrite-and-estimate']);
const TEXT_OPS = new Set(['edit-title', 'edit-body']);
// Statuses a poster writes into carry-posted.json once an op needs nothing more from Claude.
const SETTLED = new Set(['ok', 'skipped', 'for you', 'unticked']);

export const isClose = a => CLOSE.has(a);

// it: an /api/board item. r: { d, g, pk, cd, ck, cp }, the records for this id with unsent local saves already laid over them.
// intent: the open card's working choices { est, useBody, note }, so the score follows what approving would record.
// opts: which optional additions to the four checks are switched on: { gitmoji, evidence } (config.json "dor").
export function readiness(it, r = {}, intent = null, opts = {}) {
  const sug = it.sug || {};
  const d = r.d || {};
  const g = r.g || null;
  const pk = r.pk && r.pk.priority ? r.pk : null;
  const cd = r.cd || null;
  const ck = r.ck || {};
  const cp = r.cp || null;

  const decisionOpen = !!it.hasSug && d.decision == null;
  const R = decisionOpen ? sug.action : null;
  const A = d.action || sug.action;
  const pendingAccept = d.decision === 'accept' && !d.applied;
  const closing = decisionOpen ? CLOSE.has(R) : d.decision === 'accept' && CLOSE.has(A);
  const note = decisionOpen && intent && String(intent.note || '').trim() && !['needs-decision', 'split'].includes(R);
  const onReadyBoard = /Backlog - Ready|In progress|In review/.test(it.col || '');
  const ops = (cd && cd.ops) || [];
  const off = new Set(ck.off || []);
  const opStatus = n => ((cp && cp.ops && cp.ops[String(n)]) || {}).status || null;
  const carryOpen = ops.length > 0 && ck.decision == null;
  const carryWaiting = ops.length > 0 && ck.decision === 'approve' && ops.some((o, n) => !off.has(n) && !SETTLED.has(opStatus(n)));
  const carryFailed = carryWaiting && ops.some((o, n) => opStatus(n) === 'failed');
  const textOps = ops.map((o, n) => n).filter(n => TEXT_OPS.has(ops[n].kind) && ops[n].target === it.url);
  const level = it.prioLevel || null;
  const gradeOpen = !!g && !pk && !level && !g.applied_at;
  const sugEst = Number(sug.estimate) || 0;
  const est = Number(it.est) || 0;
  const sizable = decisionOpen && (SIZES.has(R) || REWRITE.has(R));
  const chosen = sizable ? (intent && 'est' in intent ? Number(intent.est) || 0 : SIZES.has(R) ? sugEst : 0) : 0;
  const keepsBody = REWRITE.has(R) && intent && intent.useBody === false;

  let crit;
  if (note) crit = { state: 'draft', caption: 'Your note' };
  else if (decisionOpen && R === 'needs-decision') crit = { state: 'draft', caption: 'Decide first' };
  else if (decisionOpen && REWRITE.has(R) && !keepsBody) crit = { state: 'draft', caption: 'Draft body' };
  else if (sizable && !it.ac && chosen > 0) crit = { state: 'draft', caption: 'Claude drafts criteria' };
  else if (pendingAccept && (REWRITE.has(A) || A === 'needs-decision')) crit = { state: 'claude', caption: 'With Claude' };
  else if (it.ac) crit = { state: 'met', caption: it.ac.items ? `${it.ac.items} ${it.ac.items === 1 ? 'criterion' : 'criteria'}` : 'Criteria in prose' };
  else crit = { state: 'missing', caption: 'No acceptance criteria' };

  // The title half of Detail: the agent's typing wins, else the title's own gitmoji stands for the type.
  const ty = r.ty && GITMOJI[r.ty.type] ? r.ty.type : null;
  const want = ty || titleType(it.title);
  const fits = t => { const have = titleType(t); return !!have && (!ty || have === ty); };
  const selfTitle = textOps.map(n => ({ n, op: ops[n] })).find(x => x.op.kind === 'edit-title');
  const draftTitle = selfTitle ? (((ck.edits || {})[String(selfTitle.n)] || {}).body ?? selfTitle.op.body) : null;
  const decisionTitle = decisionOpen && REWRITE.has(R) && !keepsBody ? String((intent && intent.title) || sug.title || '') : '';
  let title = null;
  if (opts.gitmoji && !fits(it.title)) {
    const label = want ? `${GITMOJI[want][0]} ${GITMOJI[want][1]}` : 'a gitmoji';
    if (draftTitle && fits(draftTitle) && carryOpen) title = { state: 'draft', caption: `Retitle with ${label}` };
    else if (decisionTitle && fits(decisionTitle)) title = { state: 'draft', caption: `Retitle with ${label}` };
    else if (draftTitle && fits(draftTitle) && carryWaiting) title = { state: 'claude', caption: `Retitle with ${label}` };
    else title = { state: 'missing', caption: `Title needs ${label}` };
    title.want = want;
  }
  const RANK = { missing: 3, draft: 2, claude: 1, met: 0 };
  let detail;
  if (closing) detail = { state: 'none', caption: 'Not needed when closing' };
  else if (!title || RANK[crit.state] >= RANK[title.state]) detail = title && title.state !== 'met' && crit.state !== 'met' ? { ...crit, caption: `${crit.caption}. ${title.caption}` } : { ...crit };
  else detail = crit.state === 'met' ? { ...title } : { ...title, caption: `${crit.caption}. ${title.caption}` };
  if (detail.state === 'met' && opts.gitmoji && want) detail.caption = `${detail.caption}, ${GITMOJI[want][0]} title`;
  detail.title = title;

  // Evidence: 30-day usage and error counts, gathered by an agent pass into data/evidence.json.
  const ev = r.ev && r.ev.checked_at ? r.ev : null;
  const evSuggests = ev && LEVELS.includes(ev.suggested) && ev.confidence !== 'low' ? ev.suggested : null;
  // A pick made before the evidence does not silence it; one made after it is your answer to it.
  const answered = !!pk && (!pk.applied_at || (!!pk.at && !!ev && pk.at > ev.checked_at));
  const evidenceOpen = !!opts.evidence && !!evSuggests && evSuggests !== level && !answered;
  let value;
  if (closing) value = { state: 'none', caption: 'Not needed when closing' };
  else if (evidenceOpen) value = { state: 'draft', level: evSuggests, caption: `Draft: ${evSuggests}`, fromEvidence: true };
  else if (pk && !pk.applied_at && pk.priority !== level) value = { state: 'claude', level: pk.priority, caption: pk.priority };
  else if (pk && pk.applied_at && !level) value = { state: 'claude', level: pk.priority, caption: `${pk.priority}, board not refreshed` };
  else if (level && opts.evidence && !ev) value = { state: 'missing', level, caption: `${level}, no evidence checked`, noEvidence: true };
  else if (level) value = { state: 'met', level, caption: level };
  else if (gradeOpen) value = { state: 'draft', level: g.suggested, caption: `Draft: ${g.suggested}` };
  else if (g && g.applied_at) value = { state: 'claude', level: g.suggested, caption: `${g.suggested}, board not refreshed` };
  else value = { state: 'missing', caption: 'No priority' };

  let effort = null;
  if (closing) effort = { state: 'none', caption: 'Not needed when closing' };
  else if (note) effort = null;
  else if (decisionOpen && R === 'split') effort = { state: 'draft', split: true, caption: 'Split it' };
  else if (sizable && chosen > 0 && chosen !== est) effort = { state: 'draft', value: chosen, caption: `Draft: ${chosen}` };
  else if (pendingAccept) {
    const chosen = 'estimate' in d ? Number(d.estimate) || 0 : sugEst;
    if (A === 'split') effort = { state: 'claude', split: true, caption: 'Split' };
    else if (SIZES.has(A) && chosen > 0 && chosen !== est) effort = { state: 'claude', value: chosen, caption: String(chosen) };
  }
  if (!effort) effort = est > 0 ? { state: 'met', value: est, caption: String(est), offScale: !SCALE.includes(est) } : { state: 'missing', caption: 'Not sized' };

  // Approved is met by the board, not by any accept: a decision Claude carried out into Not Ready is not approved as ready.
  let approved;
  if (decisionOpen) approved = { state: 'draft', caption: 'Your click' };
  else if (d.decision === 'accept' && A === 'verify-first') approved = { state: 'missing', caption: 'Waiting on a code check', at: d.at };
  else if (pendingAccept || (d.decision === 'accept' && onReadyBoard)) approved = { state: 'met', caption: 'Your click', at: d.at };
  else if (d.decision === 'skip' || d.decision === 'defer') approved = { state: 'skipped', caption: 'Skipped', at: d.at };
  else if (onReadyBoard) approved = { state: 'met', caption: 'On the board' };
  else if (isHeld(it)) approved = { state: 'missing', caption: 'Held', at: d.at };
  else approved = { state: 'missing', caption: d.decision === 'accept' ? 'Not approved as ready' : 'No click yet', at: d.at };

  const checks = { detail, value, effort, approved };
  const list = [detail, value, effort, approved];
  const met = list.filter(c => c.state === 'met').length;

  // Detail, Priority and Effort met with only the click missing is one click from Ready, so it is your move.
  const approveReady = !decisionOpen && !carryOpen && !gradeOpen && !pendingAccept && !carryWaiting && !isWorking(it.col)
    && approved.state === 'missing' && A !== 'verify-first' && A !== 'split' && !isHeld(it) && [detail, value, effort].every(c => c.state === 'met');

  let pile;
  if (decisionOpen || carryOpen || gradeOpen || evidenceOpen || approveReady) pile = 'turn';
  else if (pendingAccept || carryWaiting || list.some(c => c.state === 'claude')) pile = 'claude';
  else if (isWorking(it.col)) pile = 'progress';
  else if (approved.state === 'skipped') pile = 'skipped';
  else if (met === 4) pile = 'ready';
  else pile = 'draft';

  let kind;
  if (decisionOpen) {
    kind = closing ? 'close' : R === 'leave-as-is' ? 'leave' : R === 'needs-decision' ? 'decide'
      : R === 'split' ? 'split' : R === 'verify-first' ? 'verify' : 'refine';
  } else if (carryOpen) kind = 'text';
  else if (gradeOpen || evidenceOpen) kind = 'value';
  else if (approveReady) kind = 'approve';
  else kind = pile;

  // Playable: approving now leaves no check Missing, so Claude's turn would finish the card.
  const playable = pile === 'turn' && !closing && !note && [detail, value, effort].every(c => c.state !== 'missing');

  return {
    checks, met, pile, kind, playable, closing, decisionOpen, reopened: decisionOpen && !!d.prior, approveReady,
    R, A, pendingAccept, carryOpen, carryWaiting, carryFailed, textOps, gradeOpen: gradeOpen || evidenceOpen, ev,
  };
}
