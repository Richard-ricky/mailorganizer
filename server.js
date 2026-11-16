const express = require('express');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const sanitizeHtml = require('sanitize-html');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DAY = 86400000;
const IDLE_MS = 10 * 60 * 1000;            // close an unused mailbox connection after 10 minutes
const SESSION_MS = 8 * 60 * 60 * 1000;     // sign out after 8 hours...
const AUTO_SESSION_MS = 7 * DAY;           // ...or 7 days while automatic filing is on
const AUTO_EVERY_MS = 60 * 1000;           // how often new mail is checked for filing
const AUTO_BATCH = 300;                    // most emails filed per check
const MAX_SENDERS = 40;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Sessions live in memory only. Passwords are never written to disk.
// Each session keeps ONE open IMAP connection, so searches skip the slow connect + login step.
const sessions = new Map();

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- helpers ---------- */
const orAll = (list) => (list.length === 1 ? list[0] : { or: [list[0], orAll(list.slice(1))] });
const cleanName = (n) => String(n || '').replace(/[\\/.*%#&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

function matches(msg, member) {
  const m = member.toLowerCase();
  if (m.startsWith('@')) return msg.address.endsWith(m);
  if (!m.includes('@')) return msg.address.endsWith('@' + m) || msg.name.toLowerCase().includes(m);
  return msg.address === m;
}

/* ---------- safe email display ---------- */
// Email HTML is untrusted. Scripts, forms, frames, external styles and tracking pixels are removed,
// remote images are blocked unless the reader asks for them, and the page shows it in a locked-down frame as well.
const SAFE_STYLE = /^(?!.*(url\(|expression|javascript|@import|behavior))[^;{}]*$/i;
const STYLE_PROPS = ['color', 'background-color', 'background', 'font-size', 'font-weight', 'font-style', 'font-family', 'text-align', 'text-decoration', 'line-height',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'border-collapse', 'border-color', 'border-style', 'border-width',
  'width', 'max-width', 'min-width', 'height', 'vertical-align', 'letter-spacing', 'text-transform', 'white-space', 'list-style-type'];
const ALLOWED_STYLES = { '*': Object.fromEntries(STYLE_PROPS.map((k) => [k, [SAFE_STYLE]])) };

function hostOf(href) {
  try { return new URL(href).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function cleanHtml(html, { images = false, cidMap = {} } = {}) {
  let remote = 0;
  const out = sanitizeHtml(html, {
    allowedTags: ['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup', 'dd', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'title'],
      font: ['color', 'face', 'size'],
      '*': ['style', 'align', 'valign', 'bgcolor', 'width', 'height', 'colspan', 'rowspan', 'border', 'cellpadding', 'cellspacing', 'dir', 'lang']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedStyles: ALLOWED_STYLES,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (tag, attribs) => ({ tagName: 'a', attribs: { href: attribs.href || '', title: attribs.title || hostOf(attribs.href), target: '_blank', rel: 'noopener noreferrer' } }),
      img: (tag, attribs) => {
        let src = String(attribs.src || '').trim();
        const w = parseInt(attribs.width, 10), h = parseInt(attribs.height, 10);
        const tiny = (w > 0 && w <= 2) || (h > 0 && h <= 2);            // 1x1 tracking pixels
        if (/^cid:/i.test(src)) src = cidMap[src.slice(4).replace(/^<|>$/g, '')] || '';
        else if (/^https?:/i.test(src)) { if (tiny) src = ''; else { remote++; if (!images) src = ''; } }
        else if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) src = '';
        return { tagName: 'img', attribs: { src, alt: attribs.alt || '', width: attribs.width || '', height: attribs.height || '' } };
      }
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src
  });
  return { html: out, remote };
}

/* ---------- priority scoring ---------- */
// Everything here runs on your computer and is explained to you: each email gets up to three plain-English reasons.
const URGENT = /\b(urgent|asap|deadline|due (today|tomorrow|soon|by)|action required|overdue|final notice|invoice|payment|confirm(ation)?|interview|meeting|exam|results?|reminder)\b/i;
const PROMO = /(\bsale\b|% off|\bdiscount\b|\bdeals?\b|\boffers?\b|webinar|newsletter|unsubscribe|promo|coupon|free shipping|limited time|new arrivals)/i;
const AUTOMATED = /(^|[^a-z])(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer|notifications?|newsletter|marketing|alerts?)@/i;

function scoreMessage(m, ctx) {
  const parts = [];
  const add = (pts, why) => { if (pts) parts.push([pts, why || null]); };
  const sent = ctx.sent[m.address] || 0;
  const opens = ctx.opens[m.address] || 0;
  const skipped = ctx.dismissed[m.address] || 0;
  const important = !!ctx.important[m.address];
  const muted = !!ctx.muted[m.address];
  const automated = AUTOMATED.test(m.address);
  const ageHours = Math.max(0, ctx.now - new Date(m.date).getTime()) / 36e5;

  add(15 * Math.exp(-ageHours / 48));                                   // newer mail ranks higher
  if (m.unread) add(5);
  if (sent > 0) add(Math.min(25, 12 + 3 * Math.log2(1 + sent)), `You email them (${sent}×)`);
  if (opens > 0) add(Math.min(12, 4 * Math.log2(1 + opens)), 'You often open their mail');
  if (skipped > 0) add(-Math.min(30, 8 * Math.log2(1 + skipped)), 'You usually skip these');
  if (important) add(40, 'You marked them important');
  if (muted) add(-40, 'You marked them as noise');
  const group = (ctx.groups || []).find((g) => g.members.some((x) => matches(m, x)));
  if (group) add(6, `In your group ${group.name}`);
  if (m.direct && m.recipients <= 3) add(10, 'Sent directly to you');
  if (m.recipients > 8) add(-8, 'Sent to many people');
  if (/^\s*(re|fw|fwd):/i.test(m.subject) && sent > 0) add(8, 'Ongoing conversation');
  if (URGENT.test(m.subject)) add(8, 'Urgent or deadline wording');
  if (/\?/.test(m.subject)) add(3);
  if (m.bulk) add(-25, 'Looks like a newsletter or mailing list');
  if (automated) add(-12, 'Automated sender');
  if (PROMO.test(m.subject)) add(-12, 'Promotional wording');

  let score = Math.round(Math.max(0, Math.min(100, 20 + parts.reduce((n, p) => n + p[0], 0))));
  let tier = score >= 55 ? 'focus' : score >= 32 ? 'updates' : 'noise';
  // Bulk and automated mail from people you never write to or read stays out of your way
  if ((m.bulk || automated) && sent === 0 && opens < 3 && !important) { score = Math.min(score, 31); tier = 'noise'; }
  if (muted) tier = 'noise';
  if (important) tier = 'focus';

  // Explain the verdict: noise shows what pushed it down, "needs you" shows what pushed it up
  const named = parts.filter((p) => p[1]);
  const aligned = named.filter((p) => (tier === 'noise' ? p[0] < 0 : tier === 'focus' ? p[0] > 0 : true));
  const why = (aligned.length ? aligned : named).sort((a, b) => Math.abs(b[0]) - Math.abs(a[0])).slice(0, 3).map((p) => p[1]);
  return { score, tier, why };
}

function buildCtx(store, me) {
  const L = store.learn;
  return { me: String(me).toLowerCase(), now: Date.now(), sent: L.sent, opens: L.opens, dismissed: L.dismissed, important: L.important, muted: L.muted, groups: store.groups };
}

// Keep the learning tables small: drop the least-used entries
function trimMap(map, max) {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  keys.sort((a, b) => (Number(map[a]) || 0) - (Number(map[b]) || 0)).slice(0, keys.length - max).forEach((k) => delete map[k]);
}

/* ---------- connection handling ---------- */
function newClient(cfg) {
  const c = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false
  });
  c.on('error', () => {}); // dropped connections are handled by reconnecting on the next request
  return c;
}

async function ensureClient(s) {
  if (s.client && s.client.usable) return s.client;
  if (!s.connecting) {
    s.connecting = (async () => {
      const c = newClient(s.cfg);
      await c.connect();
      s.client = c;
      return c;
    })().finally(() => { s.connecting = null; });
  }
  return s.connecting;
}

function closeClient(s) {
  const c = s.client;
  s.client = null;
  if (c) c.logout().catch(() => { try { c.close(); } catch (e) {} });
}

// Run work inside one mailbox. Retries once if the connection had dropped.
async function withMailbox(s, mailbox, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      const client = await ensureClient(s);
      const lock = await client.getMailboxLock(mailbox);
      try {
        s.lastUsed = Date.now();
        await client.noop().catch(() => {}); // refresh: a long-lived connection can have a stale view of new mail
        return await fn(client);
      } finally {
        lock.release();
      }
    } catch (err) {
      if (attempt === 0 && !(s.client && s.client.usable)) { s.client = null; continue; }
      throw err;
    }
  }
}

async function getDelim(s) {
  if (!s.delim) {
    const client = await ensureClient(s);
    s.delim = ((await client.list())[0] || {}).delimiter || '/';
  }
  return s.delim;
}

// '' means the inbox; anything else is a group's folder: Groups/<name>
async function folderPath(s, folder) {
  const name = cleanName(folder);
  return name ? `Groups${await getDelim(s)}${name}` : 'INBOX';
}

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    const limit = s.autoEnabled ? AUTO_SESSION_MS : SESSION_MS;
    if (now - s.created > limit) { closeClient(s); sessions.delete(token); }
    else if (s.client && now - s.lastUsed > IDLE_MS) closeClient(s);
  }
}, 60000).unref();

function requireSession(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = sessions.get(token);
  if (!s) return res.status(401).json({ error: 'Not signed in.' });
  req.s = s;
  req.token = token;
  next();
}

function fail(res, err, folder) {
  console.error(err);
  const text = String(err.responseText || err.message || '');
  if (folder && /nonexist|not exist|doesn.t exist|unknown mailbox|no such mailbox|not found/i.test(text + ' ' + (err.serverResponseCode || ''))) {
    return res.status(404).json({ error: 'That group has no folder yet. File some emails into it first.' });
  }
  res.status(500).json({ error: err.responseText || err.message || 'Something went wrong.' });
}

/* ---------- saved data: groups, searches, filing records, automatic filing state ---------- */
function storeFile(cfg) {
  const id = crypto.createHash('sha256').update(cfg.host + '|' + cfg.user).digest('hex').slice(0, 16);
  return path.join(DATA_DIR, id + '.json');
}

function readStore(cfg) {
  const base = {
    groups: [], searches: [],
    filed: { uidValidity: '', groups: {} },
    auto: { enabled: false, lastUid: 0, uidValidity: '', totalFiled: 0 },
    log: [],
    learn: { sent: {}, sentAt: 0, opens: {}, dismissed: {}, important: {}, muted: {} }
  };
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(cfg), 'utf8'));
    if (Array.isArray(raw)) return { ...base, groups: raw }; // version 1 stored only groups
    return { ...base, ...raw, auto: { ...base.auto, ...(raw.auto || {}) }, filed: { ...base.filed, ...(raw.filed || {}) }, learn: { ...base.learn, ...(raw.learn || {}) } };
  } catch (e) {
    return base;
  }
}

function writeStore(cfg, store) {
  fs.writeFileSync(storeFile(cfg), JSON.stringify(store, null, 2));
}

function cleanGroups(list) {
  return (Array.isArray(list) ? list : [])
    .filter((g) => g && typeof g.name === 'string' && g.name.trim())
    .slice(0, 100)
    .map((g) => ({
      name: g.name.trim().slice(0, 60),
      members: [...new Set((Array.isArray(g.members) ? g.members : []).map((m) => String(m).trim().toLowerCase()).filter(Boolean))].slice(0, 500),
      move: g.move === true,          // take filed emails out of the inbox
      markRead: g.markRead === true   // mark filed emails as read
    }));
}

function cleanSearches(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x.name === 'string' && x.name.trim())
    .slice(0, 30)
    .map((x) => ({
      name: x.name.trim().slice(0, 60),
      from: String(x.from || '').slice(0, 300),
      q: String(x.q || '').slice(0, 200),
      folder: cleanName(x.folder),
      unread: !!x.unread,
      range: ['1h', '24h', 'today', '7d'].includes(x.range) ? x.range : null,
      since: x.range ? '' : String(x.since || ''),
      before: x.range ? '' : String(x.before || '')
    }));
}

/* ---------- filing (shared by the button and the automatic job) ---------- */
function syncFiledValidity(client, store) {
  const uv = String(client.mailbox.uidValidity);
  if (store.filed.uidValidity !== uv) store.filed = { uidValidity: uv, groups: {} };
}

// Put emails (by inbox UID) into Groups/<name>. Emails already filed there are skipped.
async function fileIntoGroup(client, store, delim, group, uids, { move = false, markRead = false } = {}) {
  const name = cleanName(group);
  if (!name || !uids.length) return null;
  const dest = `Groups${delim}${name}`;
  try { await client.mailboxCreate(dest); } catch (e) { /* folder already exists */ }

  const done = new Set(store.filed.groups[name] || []);
  const fresh = uids.filter((u) => !done.has(u));
  if (fresh.length) {
    const range = fresh.join(',');
    if (markRead) await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
    if (move) await client.messageMove(range, dest, { uid: true });
    else await client.messageCopy(range, dest, { uid: true });
    fresh.forEach((u) => done.add(u));
    store.filed.groups[name] = [...done].slice(-5000);
  }
  return { group: name, filed: fresh.length, skipped: uids.length - fresh.length };
}

// UID of the newest email in the selected mailbox (0 when empty)
async function newestUid(client) {
  const m = await client.fetchOne('*', { uid: true }).catch(() => null);
  return m && m.uid ? m.uid : 0;
}

/* ---------- automatic filing ---------- */
// Looks only at mail that arrived since the last check, so it stays quick however big the inbox is.
async function runAutoFile(s) {
  if (s.autoBusy) return;
  const store = readStore(s.cfg);
  s.autoEnabled = !!store.auto.enabled;
  if (!store.auto.enabled) return;
  s.autoBusy = true;
  try {
    const delim = await getDelim(s);
    const summary = await withMailbox(s, 'INBOX', async (client) => {
      syncFiledValidity(client, store);
      const uv = String(client.mailbox.uidValidity);
      if (store.auto.uidValidity !== uv) {
        // First run, or the server renumbered the mailbox: start from the newest email
        store.auto.uidValidity = uv;
        store.auto.lastUid = await newestUid(client);
        return { total: 0, items: [] };
      }

      const last = store.auto.lastUid;
      let uids = (await client.search({ uid: `${last + 1}:*` }, { uid: true })) || [];
      uids = uids.filter((u) => u > last).sort((a, b) => a - b).slice(0, AUTO_BATCH);
      if (!uids.length) return { total: 0, items: [] };

      const groups = store.groups.filter((g) => g.members.length);
      const byGroup = new Map();
      for await (const m of client.fetch(uids.join(','), { uid: true, envelope: true }, { uid: true })) {
        const f = (m.envelope.from && m.envelope.from[0]) || {};
        const msg = { address: (f.address || '').toLowerCase(), name: f.name || '' };
        for (const g of groups) {
          if (g.members.some((x) => matches(msg, x))) {
            if (!byGroup.has(g.name)) byGroup.set(g.name, []);
            byGroup.get(g.name).push(m.uid);
          }
        }
      }

      // Copy first, then do the groups that move mail out of the inbox
      const ordered = groups.filter((g) => byGroup.has(g.name)).sort((a, b) => Number(a.move) - Number(b.move));
      const moved = new Set();
      const items = [];
      for (const g of ordered) {
        let list = byGroup.get(g.name);
        if (g.move) list = list.filter((u) => !moved.has(u));
        const r = await fileIntoGroup(client, store, delim, g.name, list, { move: g.move, markRead: g.markRead });
        if (r) {
          if (g.move) list.forEach((u) => moved.add(u));
          items.push({ ...r, move: g.move });
          writeStore(s.cfg, store); // save after each group so a failure part-way never files twice
        }
      }
      store.auto.lastUid = uids[uids.length - 1];
      return { total: items.reduce((n, i) => n + i.filed, 0), items };
    });

    const now = new Date().toISOString();
    summary.items.filter((i) => i.filed).forEach((i) => store.log.push({ t: now, group: i.group, count: i.filed, move: i.move }));
    store.log = store.log.slice(-50);
    store.auto.totalFiled += summary.total;
    writeStore(s.cfg, store);
    if (summary.total) s.unread = null;
    s.auto = { lastRun: now, lastFiled: summary.total, error: null };
  } catch (err) {
    console.error('Automatic filing failed:', err.message);
    s.auto = { lastRun: new Date().toISOString(), lastFiled: 0, error: err.responseText || err.message };
  } finally {
    s.autoBusy = false;
  }
}

setInterval(() => {
  for (const s of sessions.values()) if (s.autoEnabled) runAutoFile(s).catch(() => {});
}, AUTO_EVERY_MS).unref();

// Unread count per group (looks in the group's folder when it moves mail out of the inbox). Cached for 30 seconds.
async function unreadSummary(s, groups) {
  if (s.unread && Date.now() - s.unread.t < 30000) return s.unread.v;
  const v = {};
  for (const g of groups.filter((x) => x.members.length).slice(0, 30)) {
    try {
      const crit = g.move ? { seen: false } : { seen: false, ...orAll(g.members.slice(0, MAX_SENDERS).map((f) => ({ from: f }))) };
      const box = g.move ? await folderPath(s, g.name) : 'INBOX';
      v[g.name] = await withMailbox(s, box, async (c) => ((await c.search(crit, { uid: true })) || []).length);
    } catch (e) {
      v[g.name] = 0;
    }
  }
  s.unread = { t: Date.now(), v };
  return v;
}

/* ---------- learning ---------- */
function recordOpen(cfg, address) {
  if (!address) return;
  try {
    const store = readStore(cfg);
    store.learn.opens[address] = (store.learn.opens[address] || 0) + 1;
    trimMap(store.learn.opens, 2000);
    writeStore(cfg, store);
  } catch (e) { /* learning is a bonus; never block reading mail */ }
}

// Who do you write to? People in your Sent folder are the strongest sign of who matters.
async function refreshSentLearning(s, force = false) {
  const cfg = s.cfg;
  if (s.learning) return;
  const first = readStore(cfg);
  if (!force && first.learn.sentAt && Date.now() - first.learn.sentAt < 6 * 3600 * 1000) return;
  s.learning = true;
  try {
    const client = await ensureClient(s);
    const boxes = await client.list();
    const sentBox = boxes.find((b) => b.specialUse === '\\Sent') || boxes.find((b) => /^(sent|sent items|sent mail|\[gmail\]\/sent mail)$/i.test(b.path));
    if (!sentBox) return;
    const me = cfg.user.toLowerCase();
    const counts = {};
    await withMailbox(s, sentBox.path, async (c) => {
      const uids = ((await c.search({ all: true }, { uid: true })) || []).sort((a, b) => a - b).slice(-400);
      if (!uids.length) return;
      for await (const m of c.fetch(uids.join(','), { uid: true, envelope: true }, { uid: true })) {
        for (const a of [...(m.envelope.to || []), ...(m.envelope.cc || [])]) {
          const addr = (a.address || '').toLowerCase();
          if (addr && addr !== me) counts[addr] = (counts[addr] || 0) + 1;
        }
      }
    });
    const store = readStore(cfg); // re-read so nothing saved meanwhile is overwritten
    store.learn.sent = counts;
    store.learn.sentAt = Date.now();
    writeStore(cfg, store);
  } catch (err) {
    console.error('Could not learn from Sent mail:', err.message);
  } finally {
    s.learning = false;
  }
}

setInterval(() => {
  for (const s of sessions.values()) refreshSentLearning(s).catch(() => {});
}, 10 * 60 * 1000).unref();

/* ---------- routes ---------- */
app.post('/api/login', async (req, res) => {
  const { host, port, secure, user, pass } = req.body || {};
  if (!host || !user || !pass) return res.status(400).json({ error: 'Enter the server, email address and password.' });
  const cfg = { host, port: Number(port) || 993, secure: secure !== false, user, pass };
  const s = { cfg, client: null, connecting: null, created: Date.now(), lastUsed: Date.now(), bodies: new Map(), unread: null, auto: null, autoEnabled: false };
  try {
    await ensureClient(s); // keep this connection open for later searches
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, s);
    s.autoEnabled = !!readStore(cfg).auto.enabled;
    res.json({ token, user });
    refreshSentLearning(s).catch(() => {});             // learn who you write to
    if (s.autoEnabled) runAutoFile(s).catch(() => {}); // catch up on mail that arrived while the app was closed
  } catch (err) {
    res.status(401).json({ error: 'Could not sign in. Check the server, address and app password. ' + (err.responseText || '') });
  }
});

app.post('/api/logout', requireSession, (req, res) => {
  closeClient(req.s);
  sessions.delete(req.token);
  res.json({ ok: true });
});

// Search a mailbox. One IMAP search covers every sender, so a group of 20 people is still one request.
app.get('/api/messages', requireSession, async (req, res) => {
  const folder = cleanName(req.query.folder);
  try {
    const { q, since, before, unread } = req.query;
    const senders = [].concat(req.query.from || []).map((x) => String(x).trim()).filter(Boolean).slice(0, MAX_SENDERS);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const sinceD = since ? new Date(since) : null;
    const beforeD = before ? new Date(before) : null;

    const text = q ? { or: [{ subject: String(q) }, { body: String(q) }] } : null;
    const branches = senders.length
      ? senders.map((f) => ({ from: f, ...(text || {}) }))
      : text ? [text] : [];

    const criteria = {};
    if (branches.length) Object.assign(criteria, orAll(branches));
    if (unread === 'true') criteria.seen = false;
    // IMAP dates are whole days, so widen the window here and trim by exact time below.
    if (sinceD) criteria.since = new Date(sinceD.getTime() - DAY);
    if (beforeD) criteria.before = new Date(beforeD.getTime() + 2 * DAY);
    if (!Object.keys(criteria).length) criteria.all = true;

    const ctx = buildCtx(readStore(req.s.cfg), req.s.cfg.user);
    const box = await folderPath(req.s, folder);
    const result = await withMailbox(req.s, box, async (client) => {
      const uids = (await client.search(criteria, { uid: true })) || [];
      uids.sort((a, b) => a - b);
      const take = Math.min(uids.length, limit + 60);
      const recent = uids.slice(uids.length - take);
      const out = [];
      if (recent.length) {
        const query = { uid: true, envelope: true, flags: true, internalDate: true, headers: ['list-unsubscribe', 'list-id', 'precedence', 'auto-submitted'] };
        for await (const m of client.fetch(recent.join(','), query, { uid: true })) {
          const f = (m.envelope.from && m.envelope.from[0]) || {};
          const to = m.envelope.to || [], cc = m.envelope.cc || [];
          const has = (list) => list.some((a) => (a.address || '').toLowerCase() === ctx.me);
          const h = m.headers ? m.headers.toString().toLowerCase() : '';
          out.push({
            uid: m.uid,
            subject: m.envelope.subject || '(no subject)',
            name: f.name || '',
            address: (f.address || '').toLowerCase(),
            date: new Date(m.envelope.date || m.internalDate).toISOString(),
            unread: !m.flags.has('\\Seen'),
            recipients: to.length + cc.length,
            direct: has(to),
            cc: has(cc),
            bulk: /list-unsubscribe:|list-id:|precedence:\s*(bulk|list|junk)|auto-submitted:\s*auto-/.test(h)
          });
        }
      }
      return { out, moreOnServer: uids.length > take };
    });

    const filtered = result.out
      .filter((m) => (!sinceD || new Date(m.date) >= sinceD) && (!beforeD || new Date(m.date) <= beforeD))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const page = filtered.slice(0, limit);
    page.forEach((m) => {
      Object.assign(m, scoreMessage(m, ctx));
      delete m.recipients; delete m.direct; delete m.cc; delete m.bulk;
    });
    res.json({ messages: page, hasMore: result.moreOnServer || filtered.length > limit });
  } catch (err) {
    fail(res, err, folder);
  }
});

// Read one message as plain text (cached, so reopening is instant)
app.get('/api/message/:uid', requireSession, async (req, res) => {
  const folder = cleanName(req.query.folder);
  try {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid)) return res.status(400).json({ error: 'Bad message id.' });
    const key = `${folder}:${uid}`;
    const cache = req.s.bodies;
    if (cache.has(key)) { recordOpen(req.s.cfg, cache.get(key).address); return res.json(cache.get(key)); }

    const box = await folderPath(req.s, folder);
    const result = await withMailbox(req.s, box, async (client) => {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return null;
      const parsed = await simpleParser(msg.source);
      const sender = parsed.from && parsed.from.value && parsed.from.value[0] ? parsed.from.value[0] : {};

      // Pictures embedded in the email itself are safe to show; remote pictures are held back
      const cidMap = {}; let embedded = 0;
      for (const a of parsed.attachments || []) {
        if (a.cid && /^image\/(png|jpe?g|gif|webp)$/i.test(a.contentType) && a.size <= 600000 && embedded + a.size <= 3000000) {
          cidMap[String(a.cid).replace(/^<|>$/g, '')] = `data:${a.contentType};base64,${a.content.toString('base64')}`;
          embedded += a.size;
        }
      }
      let html = null, htmlImages = null, remoteImages = 0;
      if (parsed.html && parsed.html.length < 700000) {
        const safe = cleanHtml(parsed.html, { images: false, cidMap });
        html = safe.html; remoteImages = safe.remote;
        if (remoteImages) htmlImages = cleanHtml(parsed.html, { images: true, cidMap }).html;
      }
      const files = (parsed.attachments || [])
        .map((a, index) => ({ index, name: a.filename || 'attachment', type: a.contentType, size: a.size, inline: !!(a.cid && cidMap[String(a.cid).replace(/^<|>$/g, '')]) }))
        .filter((f) => !f.inline)
        .map(({ index, name, type, size }) => ({ index, name, type, size }));
      return {
        subject: parsed.subject || '(no subject)',
        from: parsed.from ? parsed.from.text : '',
        fromName: sender.name || '',
        address: String(sender.address || '').toLowerCase(),
        to: parsed.to ? parsed.to.text : '',
        date: parsed.date,
        text: (parsed.text || (html ? '' : '(no text content)')).slice(0, 60000),
        html, htmlImages, remoteImages, files
      };
    });
    if (!result) return res.status(404).json({ error: 'Message not found.' });
    cache.set(key, result);
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    recordOpen(req.s.cfg, result.address);
    res.json(result);
  } catch (err) {
    fail(res, err, folder);
  }
});

// Download one attachment. Always sent as a plain download so it can never run inside this app.
app.get('/api/attachment/:uid/:index', requireSession, async (req, res) => {
  const folder = cleanName(req.query.folder);
  try {
    const uid = Number(req.params.uid), index = Number(req.params.index);
    if (!Number.isInteger(uid) || !Number.isInteger(index)) return res.status(400).json({ error: 'Bad request.' });
    const box = await folderPath(req.s, folder);
    const file = await withMailbox(req.s, box, async (client) => {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return null;
      const parsed = await simpleParser(msg.source);
      const a = (parsed.attachments || [])[index];
      return a && a.size <= 25 * 1024 * 1024 ? { name: a.filename || 'attachment', content: a.content } : null;
    });
    if (!file) return res.status(404).json({ error: 'Attachment not found or too large.' });
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'X-Content-Type-Options': 'nosniff'
    });
    res.send(file.content);
  } catch (err) {
    fail(res, err, folder);
  }
});

// Mark emails read or unread
app.post('/api/flags', requireSession, async (req, res) => {
  const folder = cleanName(req.body.folder);
  try {
    const uids = (Array.isArray(req.body.uids) ? req.body.uids : []).map(Number).filter(Number.isInteger).slice(0, 500);
    if (!uids.length) return res.json({ ok: true, changed: 0 });
    const box = await folderPath(req.s, folder);
    await withMailbox(req.s, box, async (client) => {
      const range = uids.join(',');
      if (req.body.seen === false) await client.messageFlagsRemove(range, ['\\Seen'], { uid: true });
      else await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
    });
    req.s.unread = null;
    res.json({ ok: true, changed: uids.length });
  } catch (err) {
    fail(res, err, folder);
  }
});

// Groups and saved searches
app.get('/api/store', requireSession, (req, res) => {
  const { groups, searches } = readStore(req.s.cfg);
  res.json({ groups, searches });
});

app.put('/api/store', requireSession, (req, res) => {
  try {
    const store = readStore(req.s.cfg);
    if (req.body.groups) store.groups = cleanGroups(req.body.groups);
    if (req.body.searches) store.searches = cleanSearches(req.body.searches);
    writeStore(req.s.cfg, store);
    req.s.unread = null;
    res.json({ groups: store.groups, searches: store.searches });
  } catch (err) {
    fail(res, err);
  }
});

// File the emails you are looking at into Groups/<name> folders
app.post('/api/organise', requireSession, async (req, res) => {
  try {
    const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 100);
    const store = readStore(req.s.cfg);
    const delim = await getDelim(req.s);

    const results = await withMailbox(req.s, 'INBOX', async (client) => {
      syncFiledValidity(client, store);
      const out = [];
      for (const item of items) {
        const uids = (Array.isArray(item.uids) ? item.uids : []).map(Number).filter(Number.isInteger);
        const r = await fileIntoGroup(client, store, delim, item.group, uids, { move: item.move === true, markRead: item.markRead === true });
        if (r) out.push(r);
      }
      return out;
    });

    writeStore(req.s.cfg, store);
    req.s.unread = null;
    res.json({ results });
  } catch (err) {
    fail(res, err);
  }
});

// Teach the priority ranking: dismiss, important, noise, or reset for some senders
app.post('/api/learn', requireSession, (req, res) => {
  try {
    const event = String(req.body.event || '');
    const addrs = [...new Set((Array.isArray(req.body.addresses) ? req.body.addresses : []).map((a) => String(a).trim().toLowerCase()).filter((a) => a.includes('@')))].slice(0, 200);
    if (!['dismiss', 'important', 'noise', 'reset'].includes(event)) return res.status(400).json({ error: 'Unknown action.' });
    const store = readStore(req.s.cfg);
    const L = store.learn;
    for (const a of addrs) {
      if (event === 'dismiss') L.dismissed[a] = (L.dismissed[a] || 0) + 1;
      if (event === 'important') { L.important[a] = true; delete L.muted[a]; delete L.dismissed[a]; }
      if (event === 'noise') { L.muted[a] = true; delete L.important[a]; }
      if (event === 'reset') { delete L.important[a]; delete L.muted[a]; delete L.dismissed[a]; }
    }
    trimMap(L.dismissed, 2000);
    writeStore(req.s.cfg, store);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

/* ---------- automatic filing controls and status ---------- */
app.post('/api/auto', requireSession, async (req, res) => {
  try {
    const store = readStore(req.s.cfg);
    if (req.body.enabled === true) {
      // Start from now: only mail that arrives from this point on is filed automatically
      await withMailbox(req.s, 'INBOX', async (client) => {
        store.auto.enabled = true;
        store.auto.uidValidity = String(client.mailbox.uidValidity);
        store.auto.lastUid = await newestUid(client);
      });
    } else {
      store.auto.enabled = false;
    }
    writeStore(req.s.cfg, store);
    req.s.autoEnabled = store.auto.enabled;
    res.json({ enabled: store.auto.enabled });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/auto/run', requireSession, async (req, res) => {
  await runAutoFile(req.s);
  res.json({ auto: req.s.auto });
});

// One small request the page polls: automatic filing state, recent activity, unread per group
app.get('/api/status', requireSession, async (req, res) => {
  try {
    const store = readStore(req.s.cfg);
    const unread = await unreadSummary(req.s, store.groups);
    res.json({
      auto: {
        enabled: store.auto.enabled,
        totalFiled: store.auto.totalFiled,
        lastRun: req.s.auto ? req.s.auto.lastRun : null,
        lastFiled: req.s.auto ? req.s.auto.lastFiled : 0,
        error: req.s.auto ? req.s.auto.error : null,
        log: store.log.slice(-15).reverse()
      },
      unread,
      learn: { contacts: Object.keys(store.learn.sent).length, opened: Object.keys(store.learn.opens).length, important: Object.keys(store.learn.important).length, muted: Object.keys(store.learn.muted).length }
    });
  } catch (err) {
    fail(res, err);
  }
});

// Localhost only: this app holds mailbox passwords in memory.
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Mail organiser running at http://localhost:${PORT}`);
  });
}
module.exports = { scoreMessage, buildCtx, cleanHtml };