'use strict';

const { fbRead, fbWrite } = require('./firebase');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');
const crypto    = require('crypto');
const https     = require('https');
const http      = require('http');
const { execFile } = require('child_process');

function rj(fp, def) {
  return fbRead(fp, typeof def === 'function' ? def() : def);
}
function wj(fp, d) { fbWrite(fp, d); }

const ROOT_DIR = path.join(__dirname, '..');

const UPDATE_EXCLUDE = [
  'config.js', '.env', 'KeyHanzPiw.json', 'database',
  'node_modules', '.git', '.github',
];

function isExcludedPath(relPath) {
  const norm = String(relPath || '').split(path.sep).join('/');
  return UPDATE_EXCLUDE.some(ex => norm === ex || norm.startsWith(ex + '/'));
}

function listFilesRecursive(baseDir, sub = '') {
  const abs = path.join(baseDir, sub);
  let out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const relPath = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out = out.concat(listFilesRecursive(baseDir, relPath));
    else out.push(relPath);
  }
  return out;
}

const userContextMap   = new Map();
const USER_CTX_TTL_MS  = 10 * 60 * 1000;

function setUserContext(userId, key, value) {
  const uid = String(userId);
  const ctx = userContextMap.get(uid) || { data: {}, expiresAt: 0 };
  ctx.data[key]  = value;
  ctx.expiresAt  = Date.now() + USER_CTX_TTL_MS;
  userContextMap.set(uid, ctx);
}
function getUserContext(userId, key) {
  const uid = String(userId);
  const ctx = userContextMap.get(uid);
  if (!ctx || Date.now() > ctx.expiresAt) { userContextMap.delete(uid); return undefined; }
  return key !== undefined ? ctx.data[key] : ctx.data;
}
function clearUserContext(userId) { userContextMap.delete(String(userId)); }

setInterval(() => {
  const now = Date.now();
  for (const [uid, ctx] of userContextMap) {
    if (now > ctx.expiresAt) userContextMap.delete(uid);
  }
}, 15 * 60 * 1000);

class PanelQueue {
  constructor(concurrency = 2, retryLimit = 3, retryDelayMs = 3000) {
    this._queue      = [];
    this._active     = 0;
    this._maxActive  = concurrency;
    this._retryLimit = retryLimit;
    this._retryDelay = retryDelayMs;
    this._stats      = { processed: 0, failed: 0 };
  }

  size()     { return this._queue.length; }
  active()   { return this._active; }
  total()    { return this._queue.length + this._active; }
  stats()    { return { ...this._stats }; }

  enqueue(fn, meta = {}) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      this._queue.push({ fn, meta, resolve, reject, tries: 0, id, queuedAt: Date.now() });
      this._run();
    });
  }

  _run() {
    while (this._active < this._maxActive && this._queue.length) {
      const task = this._queue.shift();
      this._active++;
      this._execute(task);
    }
  }

  async _execute(task) {
    try {
      const result = await task.fn();
      this._stats.processed++;
      task.resolve(result);
    } catch (err) {
      task.tries++;
      if (task.tries < this._retryLimit) {
        const delay = this._retryDelay * task.tries + Math.random() * 1000;
        await new Promise(r => setTimeout(r, delay));
        this._queue.unshift(task);
      } else {
        this._stats.failed++;
        task.reject(err);
      }
    } finally {
      this._active--;
      this._run();
    }
  }
}

const panelQueue = new PanelQueue(2, 3, 3000);

function autoDeleteMsg(bot, chatId, messageId, delayMs = 30000) {
  setTimeout(async () => {
    try { await bot.telegram.deleteMessage(chatId, messageId); } catch (_) {}
  }, Math.max(1000, delayMs));
}

async function sendProgress(bot, chatId, steps) {
  let msgId = null;
  const total = steps.length;

  async function update(i, status = 'running', extra = '') {
    const lines = steps.map((s, j) => {
      let icon = j < i ? '✅' : (j === i ? (status === 'error' ? '❌' : '⏳') : '⬜');
      return `${icon} ${j + 1}/${total} <b>${s.label}</b>`;
    });
    if (extra) lines.push('', extra);
    const text = lines.join('\n');
    try {
      if (!msgId) {
        const m = await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
        msgId = m.message_id;
      } else {
        await bot.telegram.editMessageText(chatId, msgId, undefined, text, { parse_mode: 'HTML' });
      }
    } catch (_) {}
  }

  for (let i = 0; i < steps.length; i++) {
    await update(i, 'running');
    try {
      await steps[i].fn();
    } catch (err) {
      await update(i, 'error', `❌ Gagal: ${String(err?.message || err).slice(0, 200)}`);
      return { msgId, error: err };
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const doneLines = steps.map((s, j) => `✅ ${j + 1}/${total} <b>${s.label}</b>`).join('\n');
  try {
    if (msgId)
      await bot.telegram.editMessageText(chatId, msgId, undefined,
        `✅ <b>Selesai!</b>\n\n${doneLines}`, { parse_mode: 'HTML' });
  } catch (_) {}
  return { msgId, error: null };
}

const ACTION_HINTS = {
  cadp:         ['/cekserver', '/listuser', '/top10'],
  cadmin:       ['/cekserver', '/listuser', '/top10'],
  addrole:      ['/listroles', '/listuser', '/cmdstats'],
  delrole:      ['/listroles', '/listuser', '/addrole'],
  delserver:    ['/cekserver', '/stats', '/top10'],
  deluser:      ['/listuser', '/cekserver', '/stats'],
  broadcast:    ['/cmdstats', '/stats', '/panelstats'],
  backup:       ['/stats', '/cekserver', '/monitorstatus'],
  blacklist:    ['/listblacklist', '/listuser'],
  setapikey:    ['/cekserver', '/pterotest', '/monitorstatus'],
  maintenance:  ['/broadcast', '/stats', '/monitorstatus'],
  rolehistory:  ['/listroles', '/addrole', '/delrole'],
  resellerlb:   ['/stats', '/panelstats', '/userstats'],
};

function getQuickHints(action) {
  const cmds = ACTION_HINTS[action] || [];
  if (!cmds.length) return '';
  return `\n\n💡 <i>Mau lanjut ke mana?</i>\n${cmds.map(c => `  • <code>${c}</code>`).join('\n')}`;
}

const ERROR_TYPES = {
  api:        '❌ <b>Gagal API Pterodactyl</b>',
  permission: '🚫 <b>Akses Ditolak</b>',
  input:      '❌ <b>Input Tidak Valid</b>',
  database:   '❌ <b>Gagal Database</b>',
  network:    '❌ <b>Gagal Jaringan</b>',
  server:     '❌ <b>Gagal Server</b>',
  timeout:    '⌛ <b>Timeout — Coba Lagi</b>',
  notfound:   '🔍 <b>Data Tidak Ditemukan</b>',
};
const SOLUTIONS = {
  api:        'Cek API key dengan <code>/setapikey</code> atau <code>/pterotest</code>.',
  permission: 'Pastikan kamu memiliki role yang sesuai. Hubungi owner.',
  input:      'Periksa format perintah, lalu coba lagi.',
  database:   'Bot sedang mengalami masalah internal. Coba beberapa saat lagi.',
  network:    'Cek koneksi server dengan <code>/cekserver</code>.',
  server:     'Cek status server dengan <code>/cekserver</code> atau <code>/monitorstatus</code>.',
  timeout:    'Request terlalu lama. Coba lagi — panel mungkin sudah terbuat.',
  notfound:   'Data tidak ada. Cek input dan coba lagi.',
};

function buildRichError(type, detail = '', extra = {}) {
  const title    = ERROR_TYPES[type]  || '❌ <b>Gagal</b>';
  const solution = SOLUTIONS[type]    || 'Hubungi owner jika masalah berlanjut.';
  const lines    = [title];
  if (detail) lines.push(`\n📋 <i>Alasan:</i> ${detail}`);
  lines.push(`💡 <i>Solusi:</i> ${solution}`);
  if (extra.hint) lines.push(`🔧 <i>Hint:</i> ${extra.hint}`);
  return lines.join('\n');
}

const destructiveTokens = new Map();
const TOKEN_TTL = 15 * 1000;

function createDestructiveToken(userId, action, data = {}) {
  const token = `dest_${userId}_${Date.now()}`;
  destructiveTokens.set(token, {
    userId: String(userId),
    action,
    data,
    expiresAt: Date.now() + TOKEN_TTL,
    createdAt: Date.now(),
  });
  setTimeout(() => destructiveTokens.delete(token), TOKEN_TTL + 1000);
  return token;
}

function consumeDestructiveToken(token, userId) {
  const entry = destructiveTokens.get(token);
  if (!entry) return null;
  if (entry.userId !== String(userId)) return null;
  if (Date.now() > entry.expiresAt) {
    destructiveTokens.delete(token);
    return null;
  }
  destructiveTokens.delete(token);
  return entry;
}

module.exports = function registerUpdateV2(bot, deps) {
  const {
    db, config, E, ROLE_DEFINITIONS, TIER_LABELS,
    isOwner, isPrimaryOwner, htmlEscape,
    eBox, eMulti, renderCard, sendDirectCard,
    richTitle, richTable, richFold, richPara, richQuote, richEscape, makeView,
    getActiveServers, getServerStatus, pteroRequestFor,
    STARTED_USERS_FILE, DB_DIR, progressBar, formatDuration, formatDateId,
    BROADCAST_USERS, backToMenuKeyboard, getUserTier, getUserRoleDisplay,
    hasAccessForPanel, cleanDomain, getMaintenanceStatus,
    safeAnswer, eF, pe, Markup, addStoranEntry,
    readBlacklist, saveBlacklist, readStats,
  } = deps;

  const p = name => path.join(DB_DIR, name);

  const ROLE_HISTORY_FILE     = p('role_history.json');
  const ONBOARDING_FILE       = p('onboarding.json');
  const UPTIME_TRACKER_FILE   = p('uptime_tracker.json');
  const PANEL_DOWN_STATE_FILE = p('panel_down_state.json');
  const AUTO_DELETE_CFG_FILE  = p('auto_delete_config.json');
  const RESELLER_STATS_FILE   = p('reseller_stats.json');
  const GITHUB_CHECK_FILE     = p('github_check.json');
  const FEEDBACK_FILE         = p('feedback.json');
  const RATINGS_FILE          = p('ratings.json');
  const CMD_STATS_FILE        = p('cmd_stats.json');
  const MYPANELS_FILE         = p('mypanels.json');
  const JOIN_TRACKER_FILE     = p('join_leave_tracker.json');
  const QUEUE_STATE_FILE      = p('panel_queue.json');
  const TOP10_DB_FILE         = p('monitor-top10.json');

  const BOT_START_TIME = Date.now();

  function ownerIds() {
    const raw = config.ownerIds ?? config.ownerId;
    return Array.isArray(raw) ? raw.map(String) : [String(raw || '')];
  }
  function nowId() {
    return new Date().toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' });
  }
  function fmtMs(ms) {
    if (!ms || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}h ${h % 24}j ${m % 60}m`;
    if (h > 0) return `${h}j ${m % 60}m ${s % 60}d`;
    if (m > 0) return `${m}m ${s % 60}d`;
    return `${s}d`;
  }
  async function safeSend(chatId, text, extra = {}) {
    try {
      return await bot.telegram.sendMessage(String(chatId), text, { parse_mode: 'HTML', ...extra });
    } catch (_) { return null; }
  }

  function getRoleHistoryFor(userId) {
    const all = rj(ROLE_HISTORY_FILE, {});
    return all[String(userId)] || [];
  }

  function addRoleHistoryEntry(userId, oldRole, newRole, changedBy) {
    const all = rj(ROLE_HISTORY_FILE, {});
    const uid = String(userId);
    if (!all[uid]) all[uid] = [];
    all[uid].unshift({
      oldRole:   oldRole  || null,
      newRole:   newRole  || null,
      changedBy: changedBy ? String(changedBy) : '-',
      at:        new Date().toISOString(),
    });
    if (all[uid].length > 50) all[uid] = all[uid].slice(0, 50);
    wj(ROLE_HISTORY_FILE, all);
  }

  bot.command('rolehistory', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const args     = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const targetId = args[0]
      || (ctx.message?.reply_to_message?.from?.id
          ? String(ctx.message.reply_to_message.from.id) : null);

    if (!targetId)
      return ctx.reply(
        `${'❌'} Format: <code>/rolehistory &lt;userId&gt;</code>\natau reply ke pesan user.`,
        { parse_mode: 'HTML' }
      );

    const history = getRoleHistoryFor(targetId);
    if (!history.length)
      return ctx.reply(
        `${'❓'} Tidak ada riwayat role untuk user <code>${htmlEscape(targetId)}</code>.`,
        { parse_mode: 'HTML' }
      );

    const lines = history.slice(0, 15).map((h, i) => {
      const oldR = h.oldRole ? (ROLE_DEFINITIONS[h.oldRole]?.label || h.oldRole) : '(tidak ada)';
      const newR = h.newRole ? (ROLE_DEFINITIONS[h.newRole]?.label || h.newRole) : '(dihapus)';
      const dt   = new Date(h.at).toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' });
      const by   = h.changedBy !== '-' ? ` oleh <code>${htmlEscape(h.changedBy)}</code>` : '';
      return `<b>${i + 1}.</b> <i>${htmlEscape(oldR)}</i> ➜ <b>${htmlEscape(newR)}</b>\n   📅 ${dt}${by}`;
    });

    const header = eBox(`📋 ROLE HISTORY — User ${targetId} (${history.length} entri)`, []);
    return ctx.reply(header + '\n\n' + lines.join('\n\n'), { parse_mode: 'HTML' });
  });

  function getResellerStats() { return rj(RESELLER_STATS_FILE, {}); }

  function trackResellerPanel(userId) {
    if (!userId) return;
    const data = getResellerStats();
    const uid  = String(userId);
    data[uid]  = (data[uid] || 0) + 1;
    wj(RESELLER_STATS_FILE, data);
  }

  bot.command('resellerlb', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const stats  = getResellerStats();
    const roles  = db.getAllRoles ? db.getAllRoles() : {};
    const sorted = Object.entries(stats)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10);

    if (!sorted.length)
      return ctx.reply(`${'📊'} Belum ada data reseller panel.`, { parse_mode: 'HTML' });

    const MEDALS = ['🥇', '🥈', '🥉'];
    const lines  = sorted.map(([uid, count], i) => {
      const entry  = roles[uid];
      const uname  = entry?.username
        ? `@${htmlEscape(entry.username)}`
        : `<code>${htmlEscape(uid)}</code>`;
      const rank   = MEDALS[i] || `  ${'⭐'} #${i + 1}`;
      const role   = entry?.role ? ` [${htmlEscape(ROLE_DEFINITIONS[entry.role]?.label || entry.role)}]` : '';
      return `${rank} ${uname}${role} — <b>${count} panel</b>`;
    });

    const html = [
      `${'📊'} <b>RESELLER LEADERBOARD — Top 10</b>`,
      `<i>Berdasarkan total panel berhasil dibuat.</i>`,
      `<i>Total reseller tercatat: <b>${Object.keys(stats).length}</b></i>`,
      '',
      ...lines,
    ].join('\n');

    return ctx.reply(html, { parse_mode: 'HTML' });
  });

  bot.command('queuestat', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const qs = panelQueue.stats();
    const html = [
      `${'📶'} <b>PANEL QUEUE STATUS</b>`,
      '',
      `🔄 Antrian aktif    : <b>${panelQueue.active()}</b>`,
      `📋 Menunggu          : <b>${panelQueue.size()}</b>`,
      `✅ Total diproses   : <b>${qs.processed}</b>`,
      `❌ Total gagal      : <b>${qs.failed}</b>`,
      `⚙️ Maks concurrency : <b>2</b>`,
      `🔁 Maks retry       : <b>3×</b>`,
    ].join('\n');
    return ctx.reply(html, { parse_mode: 'HTML' });
  });

  function getUptimeTracker() { return rj(UPTIME_TRACKER_FILE, {}); }
  function saveUptimeTracker(d) { wj(UPTIME_TRACKER_FILE, d); }

  function markServerStart(serverIndex) {
    const tracker = getUptimeTracker();
    const key     = String(serverIndex);
    if (!tracker[key]) tracker[key] = {};
    if (!tracker[key].startedAt) tracker[key].startedAt = new Date().toISOString();
    tracker[key].lastSeenAt  = new Date().toISOString();
    tracker[key].serverIndex = serverIndex;
    saveUptimeTracker(tracker);
  }

  function markServerDown(serverIndex) {
    const tracker = getUptimeTracker();
    const key     = String(serverIndex);
    if (!tracker[key]) tracker[key] = {};
    tracker[key].lastDownAt  = new Date().toISOString();
    tracker[key].serverIndex = serverIndex;
    saveUptimeTracker(tracker);
  }

  function markServerRestart(serverIndex) {
    const tracker = getUptimeTracker();
    const key     = String(serverIndex);
    tracker[key]  = {
      ...(tracker[key] || {}),
      startedAt:     new Date().toISOString(),
      lastRestartAt: new Date().toISOString(),
      serverIndex,
    };
    saveUptimeTracker(tracker);
  }

  setTimeout(() => {
    const servers = getActiveServers();
    const tracker = getUptimeTracker();
    for (const sv of servers) {
      if (!tracker[String(sv.index)]?.startedAt) markServerStart(sv.index);
    }
  }, 3000);

  bot.command('uptimeserver', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const servers  = getActiveServers();
    const tracker  = getUptimeTracker();
    const botUpStr = fmtMs(Date.now() - BOT_START_TIME);

    if (!servers.length)
      return ctx.reply(`${'❌'} Tidak ada server aktif dikonfigurasi.`, { parse_mode: 'HTML' });

    const blocks = servers.map(sv => {
      const entry   = tracker[String(sv.index)];
      const domain  = cleanDomain(sv.domain);
      if (!entry?.startedAt) {
        return `${'🖥️'} <b>Server V${sv.index}</b>\n  🌐 ${htmlEscape(domain)}\n  ⏱ Uptime: <i>Belum ada data</i>`;
      }
      const uptimeMs = Date.now() - new Date(entry.startedAt).getTime();
      const pct      = Math.min(100, Math.round((uptimeMs / (7 * 24 * 60 * 60 * 1000)) * 100));
      const lastDt   = entry.lastDownAt
        ? new Date(entry.lastDownAt).toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' })
        : 'Tidak ada';
      const restartDt = entry.lastRestartAt
        ? new Date(entry.lastRestartAt).toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' })
        : '-';

      return [
        `${'🖥️'} <b>Server V${sv.index}</b>`,
        `  🌐 ${htmlEscape(domain)}`,
        `  ⏱ Uptime : <b>${fmtMs(uptimeMs)}</b> (~${pct}% 7-hari)`,
        `  🕐 Mulai : <i>${new Date(entry.startedAt).toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' })}</i>`,
        `  🔄 Restart Terakhir : <i>${restartDt}</i>`,
        `  ⚠️ Down Terakhir    : <i>${lastDt}</i>`,
      ].join('\n');
    });

    const html = [
      `${'📶'} <b>SERVER UPTIME TRACKER</b>`,
      `<i>Bot Uptime: <b>${botUpStr}</b></i>`,
      `<i>${nowId()}</i>`,
      '',
      ...blocks,
    ].join('\n\n');

    return ctx.reply(html, { parse_mode: 'HTML' });
  });

  bot.command('netstat', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const servers = getActiveServers();
    if (!servers.length)
      return ctx.reply(`${'❌'} Tidak ada server aktif.`, { parse_mode: 'HTML' });

    const prog = await ctx.reply(`${'⌛'} Mengambil data jaringan semua server...`, { parse_mode: 'HTML' });
    const results = [];

    for (const sv of servers) {
      const domain = cleanDomain(sv.domain);
      const key    = String(sv.pltc || '').trim();
      if (!key || !domain) {
        results.push({ index: sv.index, error: 'Config tidak lengkap (pltc kosong)' });
        continue;
      }
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(`${domain}/api/client/servers?per_page=100`, {
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'Application/vnd.pterodactyl.v1+json',
          },
          signal: controller.signal,
        });
        clearTimeout(tid);

        if (!res.ok) { results.push({ index: sv.index, error: `HTTP ${res.status}` }); continue; }

        const data   = await res.json();
        const panels = data?.data || [];
        let rxTotal = 0, txTotal = 0, activeCount = 0;

        for (const panel of panels) {
          const r = panel?.attributes?.resources;
          if (r) {
            rxTotal += r.network_rx_bytes || 0;
            txTotal += r.network_tx_bytes || 0;
            activeCount++;
          }
        }

        results.push({
          index: sv.index,
          rxMB:  (rxTotal / 1024 / 1024).toFixed(2),
          txMB:  (txTotal / 1024 / 1024).toFixed(2),
          panels: panels.length,
          active: activeCount,
        });
      } catch (err) {
        const msg = String(err?.message || err);
        results.push({
          index: sv.index,
          error: msg.includes('abort') ? 'Timeout (>12s)' : msg.slice(0, 60),
        });
      }
    }

    try { await bot.telegram.deleteMessage(ctx.chat.id, prog.message_id); } catch (_) {}

    const lines = results.map(r => {
      if (r.error) {
        return `${'🖥️'} <b>Server V${r.index}</b>\n  ❌ ${htmlEscape(r.error)}`;
      }
      return [
        `${'🖥️'} <b>Server V${r.index}</b> (${r.panels} panel, ${r.active} aktif)`,
        `  📥 IN  : <b>${r.rxMB} MB</b>`,
        `  📤 OUT : <b>${r.txMB} MB</b>`,
        `  🔄 Total: <b>${((Number(r.rxMB) + Number(r.txMB))).toFixed(2)} MB</b>`,
      ].join('\n');
    });

    const html = [
      `${'📶'} <b>PANEL NETWORK STATS</b>`,
      `<i>${nowId()}</i>`,
      `<i>⚠️ Data kumulatif sejak panel terakhir restart — bukan throughput real-time.</i>`,
      '',
      ...lines,
    ].join('\n\n');

    return ctx.reply(html, { parse_mode: 'HTML' });
  });

  const panelDownState = rj(PANEL_DOWN_STATE_FILE, {});
  const DOWN_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  const DOWN_NOTIF_COOLDOWN_MS = 30 * 60 * 1000;

  async function checkPanelDown() {
    const servers  = getActiveServers();
    const ownerCid = ownerIds()[0];
    if (!ownerCid) return;

    for (const sv of servers) {
      const key = String(sv.index);
      try {
        await pteroRequestFor(sv, '/api/application/servers?per_page=1&page=1');
        if (panelDownState[key]?.down) {
          panelDownState[key] = { down: false, notifiedAt: 0, recoveredAt: Date.now() };
          wj(PANEL_DOWN_STATE_FILE, panelDownState);
          markServerRestart(sv.index);
          await safeSend(ownerCid,
            `${'🟢'} <b>SERVER V${sv.index} PULIH!</b>\n\n` +
            `🌐 Domain: <code>${htmlEscape(cleanDomain(sv.domain))}</code>\n` +
            `🕐 Waktu pulih: ${nowId()}`,
          );
        } else {
          panelDownState[key] = { ...(panelDownState[key] || {}), down: false };
          markServerStart(sv.index);
        }
      } catch (_) {
        const state        = panelDownState[key] || { down: false, notifiedAt: 0 };
        const now          = Date.now();
        const cooldownPass = (now - (state.notifiedAt || 0)) > DOWN_NOTIF_COOLDOWN_MS;
        const shouldNotify = !state.down || cooldownPass;

        if (shouldNotify) {
          panelDownState[key] = { down: true, notifiedAt: now };
          wj(PANEL_DOWN_STATE_FILE, panelDownState);
          markServerDown(sv.index);

          const cooldownNote = !state.down
            ? ''
            : `\n<i>⏱ Sudah down sejak ${
                state.notifiedAt
                  ? new Date(state.notifiedAt).toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' })
                  : '—'
              }</i>`;

          await safeSend(ownerCid,
            `${'🔴'} <b>SERVER V${sv.index} DOWN!</b>\n\n` +
            `🌐 Domain: <code>${htmlEscape(cleanDomain(sv.domain))}</code>\n` +
            `⚠️ Status: Tidak dapat dijangkau\n` +
            `🕐 Terdeteksi: ${nowId()}${cooldownNote}\n\n` +
            `<i>Notifikasi berikutnya dalam 30 menit jika masih down.</i>`,
          );
        } else {
          panelDownState[key] = { ...state, down: true };
          wj(PANEL_DOWN_STATE_FILE, panelDownState);
        }
      }
    }
  }

  setInterval(checkPanelDown, DOWN_CHECK_INTERVAL_MS);
  setTimeout(checkPanelDown, 15000);

  function getOnboardingDb() { return rj(ONBOARDING_FILE, {}); }
  function hasCompletedOnboarding(userId) {
    return rj(ONBOARDING_FILE, {})[String(userId)]?.completed === true;
  }
  function setOnboardingStep(userId, step) {
    const db  = getOnboardingDb();
    const uid = String(userId);
    db[uid]   = { ...(db[uid] || {}), step, updatedAt: new Date().toISOString() };
    wj(ONBOARDING_FILE, db);
  }
  function completeOnboarding(userId) {
    const db  = getOnboardingDb();
    db[String(userId)] = { completed: true, completedAt: new Date().toISOString() };
    wj(ONBOARDING_FILE, db);
  }

  const ONBOARDING_STEPS = [
    {
      title: '👋 Selamat Datang!',
      text:  `Halo! Ini adalah <b>Cpanel Jayss X HanzPiw</b> — bot untuk manajemen panel hosting Pterodactyl.\n\n` +
             `<b>Bot ini membantumu:</b>\n` +
             `• 🖥️ Buat panel hosting di server kami\n` +
             `• 👥 Kelola role dan akses\n` +
             `• 📊 Monitor server real-time\n` +
             `• 📢 Broadcast ke semua pengguna`,
    },
    {
      title: '🛡️ Sistem Role & Tier',
      text:  `Bot memiliki <b>3 Tier Akses</b>:\n\n` +
             `🟡 <b>AKMA</b> (Akses Pertama)\n   Reseller, Premium, Admin, Security, Staff\n\n` +
             `🔵 <b>AKME</b> (Akses Menengah)\n   Svip, Manager, Direktur, Komisaris\n\n` +
             `🔴 <b>AKTI</b> (Akses Tinggi)\n   Eksekutif, Pimpinan\n\n` +
             `<i>Role kamu menentukan fitur dan kuota panel yang tersedia.</i>`,
    },
    {
      title: '📱 Command Penting',
      text:  `Command yang paling sering dipakai:\n\n` +
             `<code>/menu</code>      — Menu utama bot\n` +
             `<code>/profile</code>   — Profil & role kamu\n` +
             `<code>/myrole</code>    — Cek role aktif\n` +
             `<code>/mypanel</code>   — Panel yang pernah dibuat\n` +
             `<code>/cekserver</code> — Status semua server\n` +
             `<code>/help</code>      — Daftar lengkap command\n` +
             `<code>/menuku</code>    — Menu kategori interaktif`,
    },
    {
      title: '✅ Siap Digunakan!',
      text:  `Kamu sudah memahami dasar-dasar bot ini.\n\n` +
             `Gunakan <code>/menu</code> untuk mulai, atau <code>/help</code> untuk melihat semua command.\n\n` +
             `Jika butuh bantuan, hubungi owner di <b>${htmlEscape(config.ownerUsername || '@itshanzpiw')}</b>.\n\n` +
             `<b>Selamat menggunakan! 🚀</b>`,
    },
  ];

  function buildOnboardingKb(step) {
    const total = ONBOARDING_STEPS.length;
    const row   = [];
    if (step > 0)           row.push({ text: '⬅ Back',    callback_data: `ob_step_${step - 1}` });
    if (step < total - 1)   row.push({ text: 'Next ➡',   callback_data: `ob_step_${step + 1}` });
    else                    row.push({ text: '✅ Selesai', callback_data: 'ob_done' });
    return Markup.inlineKeyboard([
      row,
      [{ text: '⏭ Skip Semua', callback_data: 'ob_done' }],
    ]);
  }

  async function sendOnboardingStep(ctx, step, edit = false) {
    const s     = ONBOARDING_STEPS[step];
    const total = ONBOARDING_STEPS.length;
    if (!s) return;
    setOnboardingStep(ctx.from.id, step);
    const text = `<b>📚 Panduan Memulai (${step + 1}/${total})</b>\n<b>${s.title}</b>\n\n${s.text}`;
    const kb   = buildOnboardingKb(step);
    if (edit) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb.reply_markup });
        return;
      } catch (_) {}
    }
    return ctx.reply(text, { parse_mode: 'HTML', ...kb });
  }

  bot.action(/^ob_step_(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    const step = parseInt(ctx.match[1], 10);
    if (step >= 0 && step < ONBOARDING_STEPS.length)
      await sendOnboardingStep(ctx, step, true);
  });

  bot.action('ob_done', async (ctx) => {
    await safeAnswer(ctx);
    completeOnboarding(ctx.from.id);
    try { await ctx.deleteMessage(); } catch (_) {}
    await ctx.reply(
      `${'✅'} Panduan selesai! Gunakan /menu untuk mulai atau /menuku untuk menu kategori.`,
      { parse_mode: 'HTML' }
    );
  });

  const GH_CHECK_INTERVAL_MS = 30 * 1000;

  function ghHeaders() {
    const h = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'CpanelHanzPiwBot/2.0' };
    if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    return h;
  }

  async function getChangedFiles(repo, base, head) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/compare/${base}...${head}`, { headers: ghHeaders() });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.files) ? data.files.map(f => ({ filename: f.filename, status: f.status })) : [];
    } catch (_) { return null; }
  }

  async function checkGithubUpdates(isManual = false, manualChatId = null) {
    const cfg  = rj(GITHUB_CHECK_FILE, { repo: null, lastCommit: null });
    const repo = cfg.repo || config.githubRepo || null;
    const ownerCid = ownerIds()[0];

    async function notifyAllOwners(text, extra = {}) {
      for (const cid of ownerIds()) {
        if (cid) await safeSend(cid, text, extra);
      }
    }

    async function sendNotif(text, extra = {}) {
      if (isManual && manualChatId) {
        await safeSend(manualChatId, text, extra);
      } else {
        await notifyAllOwners(text, extra);
      }
    }

    if (!repo) {
      if (isManual && manualChatId)
        await safeSend(manualChatId, `❌ Repo GitHub belum diset. Gunakan <code>/setgithub username/reponame</code> dulu.`);
      return;
    }
    if (!ownerCid) return;

    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(
        `https://api.github.com/repos/${repo}/commits?per_page=1`,
        { headers: ghHeaders(), signal: controller.signal }
      );
      clearTimeout(tid);

      if (!res.ok) return;
      const commits = await res.json();
      if (!Array.isArray(commits) || !commits.length) return;

      const latest   = commits[0];
      const sha      = String(latest?.sha || '');
      if (!sha) return;
      const shaShort = sha.slice(0, 7);
      const msgHead  = String(latest?.commit?.message || '').split('\n')[0].slice(0, 100);
      const author   = latest?.commit?.author?.name || '-';
      const commitDt = latest?.commit?.author?.date || null;
      const prevSha  = cfg.lastCommit;

      if (!prevSha) {
        cfg.lastCommit  = sha;
        cfg.lastChecked = new Date().toISOString();
        wj(GITHUB_CHECK_FILE, cfg);
        if (isManual) {
          await sendNotif(
            `🔔 <b>GITHUB — Baseline Ditetapkan</b>\n\n` +
            `📦 Repo   : <code>${htmlEscape(repo)}</code>\n` +
            `🔖 Commit : <code>${shaShort}</code>\n` +
            `✍️ Oleh   : ${htmlEscape(author)}\n` +
            `📝 Pesan  : ${htmlEscape(msgHead)}\n\n` +
            `<i>Ini adalah commit baseline. Tambahkan commit baru di GitHub lalu cek lagi untuk dapat tombol update.</i>`
          );
        }
        return;
      }

      if (prevSha === sha) {
        cfg.lastChecked = new Date().toISOString();
        wj(GITHUB_CHECK_FILE, cfg);
        if (isManual) {
          await sendNotif(
            `✅ <b>Tidak ada update baru.</b>\n` +
            `📦 Repo: <code>${htmlEscape(repo)}</code>\n` +
            `🔖 Commit terbaru sudah terpasang: <code>${shaShort}</code>\n` +
            `📝 ${htmlEscape(msgHead)}`
          );
        }
        return;
      }

      const changed = await getChangedFiles(repo, prevSha, sha);

      cfg.lastCommit  = sha;
      cfg.lastChecked = new Date().toISOString();
      wj(GITHUB_CHECK_FILE, cfg);

      const dtStr = commitDt
        ? new Date(commitDt).toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' })
        : '-';

      const fileList  = Array.isArray(changed) ? changed : [];
      const fileLines = fileList.length
        ? fileList.slice(0, 15).map(f => `• <code>${htmlEscape(f.filename)}</code> (${f.status})`).join('\n')
        : '<i>Daftar file tidak bisa diambil — cek manual di GitHub.</i>';
      const moreNote  = fileList.length > 15 ? `\n…dan ${fileList.length - 15} file lainnya` : '';
      const touchesSensitive = fileList.some(f => isExcludedPath(f.filename));

      await sendNotif(
        `${'🔔'} <b>UPDATE TERSEDIA!</b>\n\n` +
        `📦 Repo   : <code>${htmlEscape(repo)}</code>\n` +
        `🔖 Commit : <code>${shaShort}</code>\n` +
        `✍️ Oleh   : ${htmlEscape(author)}\n` +
        `📝 Pesan  : ${htmlEscape(msgHead)}\n` +
        `📅 Tanggal: ${dtStr}\n\n` +
        `<b>File berubah:</b>\n${fileLines}${moreNote}\n` +
        (touchesSensitive
          ? `\n${'⚠️'} <i>Ada file sensitif (config/database/dll) yang ikut berubah di repo — file itu TIDAK akan ditimpa otomatis, cek manual kalau perlu.</i>\n`
          : '') +
        `\n<i>Tekan tombol di bawah untuk pasang update ini. Bot akan backup file lama lalu restart otomatis.</i>`,
        Markup.inlineKeyboard([
          [Markup.button.callback(`${'🔄'} Update Sekarang`, `ghupd:${sha}`)],
        ])
      );
    } catch (err) {
      console.error('[GitHub AutoCheck] Error:', err?.message || err);
    }
  }

  async function applyGithubUpdate(chatId, repo, sha) {
    const tmpDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'ghupd-'));
    const zipPath       = path.join(tmpDir, 'src.zip');
    const extractDir    = path.join(tmpDir, 'extracted');
    const backupDir      = path.join(DB_DIR, '_update_backups', `${Date.now()}_${sha.slice(0, 7)}`);
    let srcRoot          = null;
    let filesToApply     = [];
    let needsNpmInstall  = false;

    const steps = [
      {
        label: 'Unduh source dari GitHub',
        fn: async () => {
          const res = await fetch(`https://api.github.com/repos/${repo}/zipball/${sha}`, { headers: ghHeaders() });
          if (!res.ok) throw new Error(`GitHub respon HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(zipPath, buf);
        },
      },
      {
        label: 'Ekstrak file',
        fn: async () => {
          const zip = new AdmZip(zipPath);
          zip.extractAllTo(extractDir, true);
          const rootItems = fs.readdirSync(extractDir);
          if (rootItems.length !== 1) throw new Error('Struktur zip dari GitHub tidak dikenali');
          srcRoot = path.join(extractDir, rootItems[0]);
        },
      },
      {
        label: 'Backup file lama',
        fn: async () => {
          filesToApply = listFilesRecursive(srcRoot).filter(rel => !isExcludedPath(rel));
          if (!filesToApply.length) throw new Error('Tidak ada file untuk dipasang (semua masuk daftar exclude)');
          for (const rel of filesToApply) {
            const liveFile = path.join(ROOT_DIR, rel);
            if (fs.existsSync(liveFile)) {
              const dst = path.join(backupDir, rel);
              fs.mkdirSync(path.dirname(dst), { recursive: true });
              fs.copyFileSync(liveFile, dst);
            }
          }
          needsNpmInstall = filesToApply.includes('package.json');
        },
      },
      {
        label: 'Pasang file baru',
        fn: async () => {
          for (const rel of filesToApply) {
            const src = path.join(srcRoot, rel);
            const dst = path.join(ROOT_DIR, rel);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
          }
        },
      },
      {
        label: 'Install dependencies (kalau package.json berubah)',
        fn: async () => {
          if (!needsNpmInstall) return;
          execSync('npm install --omit=dev', { cwd: ROOT_DIR, stdio: 'ignore', timeout: 5 * 60 * 1000 });
        },
      },
    ];

    const result = await sendProgress(bot, chatId, steps);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

    if (result.error) {
      await safeSend(chatId,
        `${'❌'} Update gagal dipasang sepenuhnya. Bot TIDAK direstart.\n` +
        `Kalau sebagian file sempat ikut berubah dan bot jadi aneh, pakai <code>/setgithub rollback</code>.`
      );
      return;
    }

    const cfg = rj(GITHUB_CHECK_FILE, {});
    cfg.lastCommit  = sha;
    cfg.lastChecked = new Date().toISOString();
    wj(GITHUB_CHECK_FILE, cfg);

    await safeSend(chatId,
      `${'✅'} <b>Update berhasil dipasang!</b>\n` +
      `${filesToApply.length} file diperbarui ke commit <code>${sha.slice(0, 7)}</code>.\n` +
      `Backup file lama: <code>database/_update_backups/${path.basename(backupDir)}</code>\n\n` +
      `♻️ Bot sedang restart, tunggu ±10 detik lalu coba lagi.`
    );

    setTimeout(() => process.exit(0), 1500);
  }

  async function rollbackLastUpdate(chatId) {
    const backupsRoot = path.join(DB_DIR, '_update_backups');
    if (!fs.existsSync(backupsRoot)) {
      return safeSend(chatId, `${'❌'} Belum ada backup update yang tersimpan.`);
    }
    const dirs = fs.readdirSync(backupsRoot)
      .filter(d => { try { return fs.statSync(path.join(backupsRoot, d)).isDirectory(); } catch (_) { return false; } })
      .sort();
    const last = dirs[dirs.length - 1];
    if (!last) return safeSend(chatId, `${'❌'} Belum ada backup update yang tersimpan.`);

    const srcRoot = path.join(backupsRoot, last);
    const result = await sendProgress(bot, chatId, [
      {
        label: `Pulihkan dari backup ${last}`,
        fn: async () => {
          const files = listFilesRecursive(srcRoot);
          for (const rel of files) {
            const src = path.join(srcRoot, rel);
            const dst = path.join(ROOT_DIR, rel);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
          }
        },
      },
    ]);

    if (result.error) return;

    await safeSend(chatId, `${'✅'} Rollback selesai.\n♻️ Bot sedang restart...`);
    setTimeout(() => process.exit(0), 1500);
  }

  bot.command('setgithub', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const sub  = (args[0] || '').toLowerCase();

    if (!sub || sub === 'status') {
      const cfg  = rj(GITHUB_CHECK_FILE, { repo: null, lastCommit: null, lastChecked: null });
      const repo = cfg.repo || config.githubRepo || '-';
      return ctx.reply([
        `${'🔄'} <b>GITHUB AUTO-UPDATE NOTIFIER</b>`,
        '',
        `📦 Repo          : <code>${htmlEscape(repo)}</code>`,
        `🔖 Commit Terakhir: <code>${htmlEscape((cfg.lastCommit || '').slice(0, 7) || 'Belum dicek')}</code>`,
        `📅 Dicek Terakhir : <i>${cfg.lastChecked
          ? new Date(cfg.lastChecked).toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' })
          : 'Belum pernah'}</i>`,
        '',
        'Command:',
        '• <code>/setgithub username/reponame</code> — set repo',
        '• <code>/setgithub check</code> — cek update sekarang',
        '• <code>/setgithub force</code> — paksa apply commit terbaru langsung',
        '• <code>/setgithub status</code> — lihat status',
        '• <code>/setgithub rollback</code> — kembalikan ke backup sebelum update terakhir',
      ].join('\n'), { parse_mode: 'HTML' });
    }

    if (sub === 'check') {
      await ctx.reply(`${'🔄'} Mengecek update GitHub...`, { parse_mode: 'HTML' });
      await checkGithubUpdates(true, ctx.chat.id);
      return;
    }

    if (sub === 'rollback') {
      return rollbackLastUpdate(ctx.chat.id);
    }

    if (sub === 'force') {
      const cfg2  = rj(GITHUB_CHECK_FILE, {});
      const repo2 = cfg2.repo || config.githubRepo;
      if (!repo2)
        return ctx.reply(`${'❌'} Repo belum diset. Gunakan <code>/setgithub username/repo</code> dulu.`, { parse_mode: 'HTML' });

      await ctx.reply(`${'🔄'} Mengambil commit terbaru dari GitHub...`, { parse_mode: 'HTML' });
      try {
        const res2 = await fetch(`https://api.github.com/repos/${repo2}/commits?per_page=1`, { headers: ghHeaders() });
        if (!res2.ok) return ctx.reply(`${'❌'} Gagal fetch GitHub: HTTP ${res2.status}`, { parse_mode: 'HTML' });
        const commits2 = await res2.json();
        if (!Array.isArray(commits2) || !commits2.length)
          return ctx.reply(`${'❌'} Tidak ada commit di repo.`, { parse_mode: 'HTML' });

        const sha2 = String(commits2[0]?.sha || '');
        if (!sha2) return ctx.reply(`${'❌'} Gagal baca SHA commit.`, { parse_mode: 'HTML' });

        cfg2.lastCommit = null;
        wj(GITHUB_CHECK_FILE, cfg2);

        await applyGithubUpdate(ctx.chat.id, repo2, sha2);
      } catch (err) {
        return ctx.reply(`${'❌'} Error: ${htmlEscape(String(err?.message || err).slice(0, 200))}`, { parse_mode: 'HTML' });
      }
      return;
    }

    const repo = args[0];
    if (!repo.includes('/'))
      return ctx.reply(`${'❌'} Format: <code>/setgithub username/reponame</code>`, { parse_mode: 'HTML' });

    const cfg = rj(GITHUB_CHECK_FILE, {});
    cfg.repo        = repo;
    cfg.lastCommit  = null;
    cfg.lastChecked = null;
    wj(GITHUB_CHECK_FILE, cfg);

    return ctx.reply(
      `${'✅'} Repo GitHub diset ke: <code>${htmlEscape(repo)}</code>\n` +
      `Pengecekan otomatis berjalan setiap 1 jam. Kalau ada perubahan file, kamu dapat notifikasi + tombol update.`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^ghupd:([0-9a-f]{7,40})$/, async (ctx) => {
    await safeAnswer(ctx);
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const sha  = ctx.match[1];
    const cfg  = rj(GITHUB_CHECK_FILE, {});
    const repo = cfg.repo || config.githubRepo;
    if (!repo) return ctx.reply(`${'❌'} Repo belum diset.`, { parse_mode: 'HTML' });

    try { await ctx.editMessageReplyMarkup(undefined); } catch (_) {}

    await applyGithubUpdate(ctx.chat.id, repo, sha);
  });

  setInterval(checkGithubUpdates, GH_CHECK_INTERVAL_MS);
  setTimeout(checkGithubUpdates, 10000);

  const AUTO_DEL_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

  function getAutoDeleteConfig() {
    return rj(AUTO_DELETE_CFG_FILE, { enabled: false, inactiveDays: 30, warnDays: 7, lastRun: null });
  }

  async function runAutoDeleteCheck() {
    const cfg = getAutoDeleteConfig();
    if (!cfg.enabled) return;

    const ownerCid   = ownerIds()[0];
    const activity   = db.getAllActivity ? db.getAllActivity() : {};
    const now        = Date.now();
    const cutoffDel  = now - cfg.inactiveDays * 86400000;
    const cutoffWrn  = now - (cfg.inactiveDays - cfg.warnDays) * 86400000;
    let deleted = 0, warned = 0;

    for (const u of Object.values(activity)) {
      if (!u.lastAt) continue;
      const lastTs  = new Date(u.lastAt).getTime();
      const hasRole = db.getUserRole ? db.getUserRole(u.userId) : false;
      if (!hasRole) continue;

      if (lastTs < cutoffDel) {
        const daysInactive = Math.floor((now - lastTs) / 86400000);
        await safeSend(u.userId,
          `${'🗑️'} <b>Role kamu telah dihapus otomatis</b>\n\n` +
          `Karena tidak aktif selama <b>${daysInactive} hari</b> (lebih dari batas ${cfg.inactiveDays} hari).\n\n` +
          `Silakan hubungi owner untuk mendapatkan akses baru: <b>${htmlEscape(config.ownerUsername || '@itshanzpiw')}</b>`,
        );
        if (db.removeUserRole) db.removeUserRole(u.userId);
        deleted++;
        if (ownerCid) await safeSend(ownerCid,
          `${'🗑️'} Auto-delete: role user ` +
          `<code>${u.userId}</code> (<b>${htmlEscape(u.firstName || '-')}</b>) ` +
          `dihapus — tidak aktif ${daysInactive} hari.`,
        );
      } else if (lastTs < cutoffWrn) {
        const daysLeft = Math.ceil((cutoffDel - now) / 86400000);
        await safeSend(u.userId,
          `${'⚠️'} <b>Peringatan: Role Hampir Dihapus!</b>\n\n` +
          `Kamu tidak aktif cukup lama. Role akan dihapus dalam <b>${daysLeft} hari</b> jika tidak ada aktivitas.\n\n` +
          `Gunakan bot ini sekarang untuk mencegah penghapusan otomatis.`,
        );
        warned++;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    cfg.lastRun = new Date().toISOString();
    wj(AUTO_DELETE_CFG_FILE, cfg);

    if (ownerCid && (deleted > 0 || warned > 0)) {
      await safeSend(ownerCid,
        `📋 <b>Auto-Delete Report</b>\n` +
        `🗑️ Role dihapus: <b>${deleted}</b>\n` +
        `⚠️ Peringatan dikirim: <b>${warned}</b>\n` +
        `📅 ${nowId()}`,
      );
    }
  }

  bot.command('autodelete', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const sub  = (args[0] || '').toLowerCase();
    const cfg  = getAutoDeleteConfig();

    if (!sub) {
      const st = cfg.enabled
        ? `🟢 AKTIF (hapus setelah <b>${cfg.inactiveDays} hari</b> tidak aktif)`
        : '🔴 NONAKTIF';
      const lr = cfg.lastRun
        ? new Date(cfg.lastRun).toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' })
        : 'Belum pernah';
      return ctx.reply([
        `${'🗑️'} <b>AUTO-DELETE PANEL SETTING</b>`,
        '',
        `Status     : ${st}`,
        `Warn period: <b>${cfg.warnDays} hari</b> sebelum hapus`,
        `Terakhir run: <i>${lr}</i>`,
        '',
        'Command:',
        '• <code>/autodelete on 30</code>  — aktifkan, 30 hari non-aktif',
        '• <code>/autodelete off</code>     — nonaktifkan',
        '• <code>/autodelete check</code>   — cek kandidat hapus',
        '• <code>/autodelete run</code>     — jalankan sekarang',
        '• <code>/autodelete warn 7</code>  — ubah periode peringatan',
      ].join('\n'), { parse_mode: 'HTML' });
    }

    if (sub === 'off') {
      cfg.enabled = false; wj(AUTO_DELETE_CFG_FILE, cfg);
      return ctx.reply(`${'✅'} Auto-delete <b>dinonaktifkan</b>.`, { parse_mode: 'HTML' });
    }

    if (sub === 'on') {
      const days = parseInt(args[1]) || 30;
      if (days < 7 || days > 365)
        return ctx.reply(`${'❌'} Jumlah hari harus antara 7–365.`, { parse_mode: 'HTML' });
      cfg.enabled = true; cfg.inactiveDays = days;
      wj(AUTO_DELETE_CFG_FILE, cfg);
      return ctx.reply(
        `${'✅'} Auto-delete <b>diaktifkan</b>.\n` +
        `Role yang tidak aktif ><b>${days} hari</b> akan dihapus otomatis.\n` +
        `<i>Peringatan dikirim ${cfg.warnDays} hari sebelum penghapusan.</i>`,
        { parse_mode: 'HTML' }
      );
    }

    if (sub === 'warn') {
      const days = parseInt(args[1]) || 7;
      if (days < 1 || days > 30)
        return ctx.reply(`${'❌'} Periode peringatan harus 1–30 hari.`, { parse_mode: 'HTML' });
      cfg.warnDays = days; wj(AUTO_DELETE_CFG_FILE, cfg);
      return ctx.reply(`${'✅'} Periode peringatan diubah ke <b>${days} hari</b>.`, { parse_mode: 'HTML' });
    }

    if (sub === 'check') {
      if (!cfg.enabled)
        return ctx.reply(`${'⚠️'} Auto-delete belum diaktifkan. Gunakan <code>/autodelete on 30</code>`, { parse_mode: 'HTML' });
      const activity = db.getAllActivity ? db.getAllActivity() : {};
      const now      = Date.now();
      const cutoff   = now - cfg.inactiveDays * 86400000;
      const inactive = Object.values(activity).filter(u => {
        if (!u.lastAt) return false;
        return new Date(u.lastAt).getTime() < cutoff && (db.getUserRole ? db.getUserRole(u.userId) : false);
      });
      if (!inactive.length)
        return ctx.reply(`${'✅'} Tidak ada role yang memenuhi syarat penghapusan.`, { parse_mode: 'HTML' });
      const lines = inactive.slice(0, 10).map(u => {
        const days = Math.floor((now - new Date(u.lastAt).getTime()) / 86400000);
        const name = u.username ? `@${htmlEscape(u.username)}` : htmlEscape(u.firstName || u.userId);
        return `• ${name} (<code>${u.userId}</code>) — <b>${days} hari</b> tidak aktif`;
      });
      return ctx.reply([
        `${'🗑️'} <b>KANDIDAT AUTO-DELETE (${inactive.length})</b>`,
        '',
        ...lines,
        ...(inactive.length > 10 ? [`<i>... dan ${inactive.length - 10} lainnya</i>`] : []),
      ].join('\n'), { parse_mode: 'HTML' });
    }

    if (sub === 'run') {
      await ctx.reply(`${'⌛'} Menjalankan auto-delete check...`, { parse_mode: 'HTML' });
      await runAutoDeleteCheck();
      return ctx.reply(`${'✅'} Auto-delete check selesai.`, { parse_mode: 'HTML' });
    }
  });

  setInterval(runAutoDeleteCheck, AUTO_DEL_CHECK_INTERVAL_MS);
  setTimeout(runAutoDeleteCheck, 90000);

  function getJoinTracker() { return rj(JOIN_TRACKER_FILE, { joined: {}, lastSeen: {} }); }

  function trackUserJoin(userId, firstName, username) {
    const data = getJoinTracker();
    const uid  = String(userId);
    if (data.joined[uid]) return false;
    data.joined[uid]  = {
      firstName: firstName || 'User',
      username:  username  || null,
      at:        new Date().toISOString(),
    };
    wj(JOIN_TRACKER_FILE, data);
    return true;
  }

  function trackUserLastSeen(userId) {
    const data = getJoinTracker();
    const uid  = String(userId);
    if (!data.lastSeen) data.lastSeen = {};
    data.lastSeen[uid] = new Date().toISOString();
  }

  bot.command('joinlog', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const data   = getJoinTracker();
    const joined = Object.entries(data.joined || {});
    if (!joined.length)
      return ctx.reply(`${'❓'} Belum ada user join tercatat.`, { parse_mode: 'HTML' });

    const recent = joined
      .sort(([, a], [, b]) => new Date(b.at) - new Date(a.at))
      .slice(0, 20);

    const lines = recent.map(([uid, info], i) => {
      const name = info.username ? `@${htmlEscape(info.username)}` : htmlEscape(info.firstName || uid);
      const dt   = new Date(info.at).toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' });
      return `${i + 1}. ${name} (<code>${uid}</code>)\n   📅 ${dt}`;
    });

    return ctx.reply([
      `${'👤'} <b>RIWAYAT JOIN USER (${joined.length} total)</b>`,
      '',
      ...lines,
    ].join('\n'), { parse_mode: 'HTML' });
  });

  function buildCatMenuCats(isOwn) {
    const all = {
      panel:    { label: '🖥️ Panel Management',  cmds: ['/cadp', '/cadmin', '/unli', '/delserver', '/deluser', '/mypanel', '/listpanel'] },
      server:   { label: '🌐 Server Management', cmds: ['/cekserver', '/listserver', '/top10', '/netstat', '/uptimeserver', '/monitorstatus'] },
      user:     { label: '👥 User Management',   cmds: ['/addrole', '/delrole', '/listroles', '/listuser', '/ban', '/unban', '/rolehistory'] },
      reseller: { label: '💎 Reseller',          cmds: ['/resellerlb', '/userstats', '/listpanel', '/stats'] },
      stats:    { label: '📊 Statistik',         cmds: ['/stats', '/panelstats', '/cmdstats', '/cmdstats2', '/panelstats2', '/joinlog', '/storan'] },
      owner:    { label: '👑 Owner Tools',       cmds: ['/broadcast', '/backup', '/maintenance', '/setapikey', '/config', '/autodelete', '/setgithub', '/queuestat', '/blockcmd'] },
      info:     { label: 'ℹ️ Informasi',          cmds: ['/help', '/ping', '/version', '/info', '/menuku', '/menu'] },
    };
    return Object.entries(all).filter(([k]) => k !== 'owner' || isOwn);
  }

  bot.command('menuku', async (ctx) => {
    const uid   = String(ctx.from.id);
    const isOwn = isOwner(uid);
    const cats  = buildCatMenuCats(isOwn);
    const btns  = cats.map(([k, c]) => [{ text: c.label, callback_data: `catm_${k}` }]);
    return ctx.reply(
      `${'🏠'} <b>MENU KATEGORI</b>\n<i>Ketuk kategori untuk melihat command yang tersedia:</i>`,
      { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(btns).reply_markup }
    );
  });

  bot.action(/^catm_(\w+)$/, async (ctx) => {
    await safeAnswer(ctx);
    const key   = ctx.match[1];
    const uid   = String(ctx.from.id);
    const isOwn = isOwner(uid);
    const cats  = Object.fromEntries(buildCatMenuCats(true));
    const cat   = cats[key];
    if (!cat) return;
    if (key === 'owner' && !isOwn) {
      return ctx.answerCbQuery('❌ Akses ditolak.', { show_alert: true });
    }
    const lines = cat.cmds.map(c => `• <code>${c}</code>`);
    const text  = `<b>${cat.label}</b>\n\n${lines.join('\n')}`;
    const kb    = Markup.inlineKeyboard([[{ text: '⬅ Kembali ke Kategori', callback_data: 'catm_back' }]]);
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb.reply_markup });
    } catch (_) {
      await ctx.reply(text, { parse_mode: 'HTML', ...kb });
    }
  });

  bot.action('catm_back', async (ctx) => {
    await safeAnswer(ctx);
    const uid   = String(ctx.from.id);
    const isOwn = isOwner(uid);
    const cats  = buildCatMenuCats(isOwn);
    const btns  = cats.map(([k, c]) => [{ text: c.label, callback_data: `catm_${k}` }]);
    try {
      await ctx.editMessageText(
        `${'🏠'} <b>MENU KATEGORI</b>\n<i>Ketuk kategori untuk melihat command yang tersedia:</i>`,
        { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(btns).reply_markup }
      );
    } catch (_) {}
  });

  bot.command('panelstats2', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const stats    = rj(p('panel_stats.json'), { totalPanels: 0, dailyStats: {}, serverStats: {} });
    const feedback = rj(FEEDBACK_FILE, []);
    const ratings  = rj(RATINGS_FILE, []);

    const allRatings   = (ratings.length ? ratings : feedback.filter(f => f.rating > 0));
    const totalRatings = allRatings.length;
    const avgRating    = totalRatings > 0
      ? (allRatings.reduce((s, r) => s + (Number(r.rating) || 0), 0) / totalRatings).toFixed(1)
      : null;
    const ratingDist   = {};
    for (let i = 1; i <= 5; i++) ratingDist[i] = allRatings.filter(r => Number(r.rating) === i).length;

    const distRows = Object.entries(ratingDist)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([r, c]) => {
        const stars = '★'.repeat(Number(r)) + '☆'.repeat(5 - Number(r));
        const pct   = totalRatings > 0 ? ` (${((c / totalRatings) * 100).toFixed(0)}%)` : '';
        return [`${stars}`, `${c}${pct}`];
      });

    const daily30 = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const lbl = d.toLocaleDateString('id-ID');
      daily30.push({ lbl, count: stats.dailyStats?.[lbl] || 0 });
    }
    const max30 = Math.max(...daily30.map(x => x.count), 1);
    const chart30 = daily30.map(x => {
      const h = Math.round((x.count / max30) * 8);
      return ['▁','▂','▃','▄','▅','▆','▇','█'][Math.max(0, h - 1)] || (h === 0 ? '▁' : '█');
    }).join('');

    const html = [
      richTitle('📊', '📊 Panel Stats + Rating Average'),
      richTable(['Metrik', 'Nilai'], [
        ['Total Panel',    `<b>${stats.totalPanels || 0}</b>`],
        ['Total Feedback', `<b>${totalRatings}</b>`],
        ['Avg Rating',     avgRating ? `<b>${avgRating} / 5.0 ⭐</b>` : '<i>Belum ada</i>'],
      ]),
      ...(totalRatings > 0 ? [richFold('⭐ <b>Distribusi Rating</b>', richTable(['Rating', 'Jumlah'], distRows))] : []),
      richFold('📈 <b>30-Day Chart</b>',
        `<pre><code>${chart30}</code></pre><i>(kiri=lama, kanan=hari ini)</i>`
      ),
      richFold('🖥️ <b>Per Server</b>',
        richTable(['Server', 'Panel'],
          Object.entries(stats.serverStats || {})
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([sv, c]) => [`V${sv}`, String(c)])
        )
      ),
    ].join('\n');

    return renderCard(ctx, html, Markup.inlineKeyboard([]));
  });

  bot.command('cmdstats2', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const stats  = rj(CMD_STATS_FILE, {});
    const sorted = Object.entries(stats).sort(([, a], [, b]) => b - a).slice(0, 10);
    if (!sorted.length)
      return ctx.reply(`${'📊'} Belum ada data statistik command.`, { parse_mode: 'HTML' });

    const total   = Object.values(stats).reduce((a, b) => a + b, 0);
    const MEDALS  = ['🥇', '🥈', '🥉'];
    const maxVal  = sorted[0][1] || 1;
    const lines   = sorted.map(([cmd, count], i) => {
      const pct  = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
      const rank = MEDALS[i] || `${'⭐'} #${i + 1}`;
      const bar  = '█'.repeat(Math.round((count / maxVal) * 10)).padEnd(10, '░');
      return `${rank} <code>/${htmlEscape(cmd)}</code>\n   ${bar} <b>${count}×</b> (${pct}%)`;
    });

    return ctx.reply([
      `${'📊'} <b>COMMAND STATS — TOP 10</b>`,
      `<i>Total penggunaan: <b>${total}×</b> dari ${Object.keys(stats).length} command unik</i>`,
      '',
      ...lines,
    ].join('\n'), { parse_mode: 'HTML' });
  });

  bot.action(/^destcount_proceed_(.+)$/, async (ctx) => {
    await safeAnswer(ctx);
    const token  = ctx.match[1];
    const uid    = String(ctx.from.id);
    const entry  = consumeDestructiveToken(token, uid);

    if (!entry) {
      return ctx.editMessageText(
        `${'⚠️'} <b>Token kadaluarsa atau tidak valid.</b>\nSilakan kirim ulang command.`,
        { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([]).reply_markup }
      ).catch(() => ctx.reply(`${'⚠️'} Token kadaluarsa, kirim ulang command.`, { parse_mode: 'HTML' }));
    }

    const { action, data } = entry;
    try { await ctx.deleteMessage(); } catch (_) {}

    if (action === 'delserver') {
      const { fn } = data;
      if (typeof fn === 'function') await fn(ctx);
    } else if (action === 'deluser') {
      const { fn } = data;
      if (typeof fn === 'function') await fn(ctx);
    }
  });

  bot.action(/^destcount_cancel_(.+)$/, async (ctx) => {
    await safeAnswer(ctx, 'Dibatalkan!');
    const token = ctx.match[1];
    const uid   = String(ctx.from.id);
    consumeDestructiveToken(token, uid);
    try {
      await ctx.editMessageText(
        `${'✅'} <b>Aksi destruktif dibatalkan.</b>`,
        { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([]).reply_markup }
      );
    } catch (_) {
      await ctx.reply(`${'✅'} Dibatalkan.`, { parse_mode: 'HTML' });
    }
  });

  bot.use(async (ctx, next) => {
    const uid       = ctx.from?.id;
    const firstName = ctx.from?.first_name;
    const username  = ctx.from?.username;
    if (uid) {
      trackUserJoin(uid, firstName, username);
    }
    return next();
  });

  const notifiedNewUsers = new Set();
  bot.use(async (ctx, next) => {
    const uid    = ctx.from?.id;
    const isStart = ctx.message?.text?.startsWith('/start');
    if (!uid || !isStart || notifiedNewUsers.has(uid)) return next();

    const isNew = trackUserJoin(uid, ctx.from?.first_name, ctx.from?.username);
    if (isNew && !isOwner(uid)) {
      notifiedNewUsers.add(uid);
      const logCid = config.ownerChannelId || ownerIds()[0];
      if (logCid) {
        const name = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name || 'User');
        await safeSend(logCid,
          `${'🔔'} <b>User Baru!</b>\n` +
          `👤 ${htmlEscape(name)} (<code>${uid}</code>)\n` +
          `📅 ${nowId()}`,
        );
      }
    }
    return next();
  });

  return {
    addRoleHistoryEntry,
    trackResellerPanel,
    panelQueue,
    autoDeleteMsg: (msgObj, delayMs = 30000) =>
      autoDeleteMsg(bot, msgObj.chat?.id || msgObj.chatId, msgObj.message_id, delayMs),
    setUserContext,
    getUserContext,
    clearUserContext,
    buildRichError,
    getQuickHints,
    sendProgress: (chatId, steps) => sendProgress(bot, chatId, steps),
    sendOnboardingStep,
    hasCompletedOnboarding,
    trackUserJoin,
    markServerStart,
    markServerDown,
    markServerRestart,
    createDestructiveToken,
    consumeDestructiveToken,
  };
};

module.exports.PanelQueue            = PanelQueue;
module.exports.panelQueue            = panelQueue;
module.exports.autoDeleteMsg         = autoDeleteMsg;
module.exports.sendProgress          = sendProgress;
module.exports.setUserContext        = setUserContext;
module.exports.getUserContext        = getUserContext;
module.exports.clearUserContext      = clearUserContext;
module.exports.buildRichError        = buildRichError;
module.exports.getQuickHints         = getQuickHints;
module.exports.createDestructiveToken  = createDestructiveToken;
module.exports.consumeDestructiveToken = consumeDestructiveToken;


const ROOT       = process.cwd();
const STATE_FILE = path.join(ROOT, 'database', 'update_state.json');

const DEFAULTS = {
  enabled:       false,
  repo:          '',
  branch:        'main',
  token:         '',
  checkEverySec: 30,
  protect:       [],
};

const ALWAYS_PROTECT = [
  'config.js', 'database', 'node_modules',
  '.env', '.git', 'KeyHanzPiw.json', 'tmp',
];

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function getCfg(config) {
  const c = Object.assign({}, DEFAULTS, config.autoUpdate || {});
  c.repo   = String(c.repo || '').trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  c.token         = c.token || process.env.GITHUB_TOKEN || '';
  c.checkEverySec = Math.max(10, Number(c.checkEverySec || c.checkEveryMin * 60 || 30));
  return c;
}

function isConfigured(config) {
  const c = getCfg(config);
  return !!(c.enabled && REPO_RE.test(c.repo));
}

function readState() {
  return fbRead(STATE_FILE, {});
}
function writeState(st) {
  fbWrite(STATE_FILE, st);
}

function localVersion() {
  for (const f of ['version.json', 'package.json']) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).version;
      if (v) return String(v);
    } catch {}
  }
  return '0.0.0';
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function ghRequest(url, reqHeaders, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const chunks = [];
    const req = mod.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: reqHeaders },
      res => {
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Request timeout.')); });
  });
}

async function ghRequestFollow(url, reqHeaders, maxRedirects = 5, timeoutMs = 180000) {
  let cur = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const r = await ghRequest(cur, reqHeaders, timeoutMs);
    if ([301, 302, 307, 308].includes(r.status) && r.headers.location) {
      cur = r.headers.location;
      continue;
    }
    return r;
  }
  throw new Error('Terlalu banyak redirect.');
}

async function fetchRemote(config) {
  if (!isConfigured(config)) throw new Error('Auto update belum dikonfigurasi (isi autoUpdate.repo di config.js).');
  const c  = getCfg(config);
  const st = readState();
  const reqHeaders = {
    'User-Agent': 'CpanelHanzPiw-Updater',
    'Accept':     'application/vnd.github.raw+json',
    ...(c.token                      ? { Authorization:    `Bearer ${c.token}` } : {}),
    ...(st.etag && st.remote         ? { 'If-None-Match':  st.etag             } : {}),
  };
  const r = await ghRequest(
    `https://api.github.com/repos/${c.repo}/contents/version.json?ref=${c.branch}`,
    reqHeaders
  );
  if (r.status === 304 && st.remote) return st.remote;
  if (r.status === 404) throw new Error(`version.json tidak ada di ${c.repo}@${c.branch}.`);
  if (r.status === 401) throw new Error('Token GitHub tidak valid.');
  if (r.status === 403) throw new Error('GitHub rate-limit atau token kurang izin.');
  if (r.status !== 200) throw new Error(`GitHub HTTP ${r.status}.`);
  let j;
  try { j = JSON.parse(r.body.toString()); } catch { throw new Error('version.json di repo bukan JSON valid.'); }
  if (!j.version) throw new Error('version.json harus punya field "version".');
  const remote = {
    version:   String(j.version),
    date:      j.date ? String(j.date) : '',
    changelog: (Array.isArray(j.changelog) ? j.changelog : j.changelog ? [j.changelog] : []).map(String).slice(0, 20),
  };
  const st2 = readState();
  st2.etag   = r.headers.etag || '';
  st2.remote = remote;
  writeState(st2);
  return remote;
}

async function checkForUpdate(config) {
  const remote = await fetchRemote(config);
  const local  = localVersion();
  return { local, remote, hasUpdate: compareVersions(remote.version, local) > 0 };
}

function isProtected(rel, extra = []) {
  return [...ALWAYS_PROTECT, ...extra].some(p => {
    const q = p.replace(/\/+$/, '');
    return rel === q || rel.startsWith(q + '/');
  });
}

// Pindai seluruh folder project secara rekursif, lewati path yang diproteksi
// (termasuk tidak masuk ke dalamnya sama sekali — penting untuk node_modules/.git
// yang bisa berisi ribuan file). Hasilnya daftar path relatif (posix, pakai '/')
// yang sebanding langsung dengan key di Map `files` hasil unduhan GitHub.
function listLocalFiles(baseDir, extra = [], sub = '') {
  const abs = path.join(baseDir, sub);
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (isProtected(rel, extra)) continue;
    if (entry.isSymbolicLink()) continue; // jangan ikut hapus/ubah symlink
    if (entry.isDirectory()) {
      out = out.concat(listLocalFiles(baseDir, extra, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function npmInstall() {
  return new Promise((resolve, reject) => {
    execFile(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund'],
      { cwd: ROOT, timeout: 600000 },
      (err, _, stderr) => {
        if (err) reject(new Error('npm install gagal: ' + String(stderr || err.message).split('\n').slice(-3).join(' ').trim()));
        else resolve();
      }
    );
  });
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

let busy = false;
const isUpdating = () => busy;

async function applyUpdate(config, { force = false, onProgress = null } = {}) {
  if (busy) throw new Error('Update sedang berjalan.');
  busy = true;
  const notify = (stage) => { try { onProgress && onProgress(stage); } catch (_) {} };
  const AdmZip  = require('adm-zip');
  const created = [];
  const backed  = [];
  const stamp   = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(ROOT, 'tmp', 'update_backup', stamp);

  try {
    const c = getCfg(config);
    const { local, remote, hasUpdate } = await checkForUpdate(config);
    if (!hasUpdate && !force) return { status: 'uptodate', from: local, to: remote.version };

    notify('download');
    const extra = c.protect || [];
    const reqHeaders = {
      'User-Agent': 'CpanelHanzPiw-Updater',
      ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
    };
    const zipRes = await ghRequestFollow(
      `https://api.github.com/repos/${c.repo}/zipball/${c.branch}`,
      reqHeaders
    );
    if (zipRes.status !== 200) throw new Error(`Download zip HTTP ${zipRes.status}.`);

    const zip     = new AdmZip(zipRes.body);
    const entries = zip.getEntries().filter(e => !e.isDirectory);
    if (!entries.length) throw new Error('Zip dari GitHub kosong.');

    const prefix = entries[0].entryName.split('/')[0] + '/';
    const files  = new Map();

    for (const e of entries) {
      if (!e.entryName.startsWith(prefix)) continue;
      const rel = path.posix.normalize(e.entryName.slice(prefix.length));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel === '.') continue;
      if (isProtected(rel, extra)) continue;
      const dest = path.resolve(ROOT, rel);
      if (!dest.startsWith(ROOT + path.sep)) continue;
      files.set(rel, e.getData());
    }

    if (!files.has('version.json') || !files.has('bot.js') || !files.has('package.json')) {
      throw new Error('Repo tidak berisi file bot yang valid (bot.js / package.json / version.json tidak ada).');
    }

    // Rekonsiliasi penuh: bandingkan SELURUH file lokal (di luar yang diproteksi)
    // terhadap isi repo GitHub saat ini — bukan cuma yang pernah tercatat di
    // manifest update sebelumnya. Apa pun yang ada di panel tapi tidak ada di
    // repo akan dihapus, persis mengikuti isi repo.
    const removed = listLocalFiles(ROOT, extra).filter(rel => !files.has(rel));

    const backup = rel => {
      const src = path.join(ROOT, rel);
      if (!fs.existsSync(src)) return;
      const dst = path.join(backupRoot, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      backed.push(rel);
    };

    const pkgBefore = fs.existsSync(path.join(ROOT, 'package.json'))
      ? sha256(fs.readFileSync(path.join(ROOT, 'package.json')))
      : '';
    let changed = 0;

    const write = (rel, buf) => {
      const dest   = path.join(ROOT, rel);
      const exists = fs.existsSync(dest);
      if (exists && sha256(fs.readFileSync(dest)) === sha256(buf)) return;
      if (exists) backup(rel); else created.push(rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      changed++;
    };

    notify('sync');
    for (const [rel, buf] of files) if (rel !== 'version.json') write(rel, buf);

    notify('cleanup');
    for (const rel of removed) { backup(rel); fs.rmSync(path.join(ROOT, rel), { force: true }); }

    const pkgChanged = sha256(files.get('package.json')) !== pkgBefore;
    if (pkgChanged) await npmInstall();

    write('version.json', files.get('version.json'));

    writeState({
      ...readState(),
      manifest:   [...files.keys()],
      notified:   remote.version,
      lastUpdate: { from: local, to: remote.version, at: new Date().toISOString() },
    });

    try {
      const bdir = path.join(ROOT, 'tmp', 'update_backup');
      if (fs.existsSync(bdir)) {
        const dirs = fs.readdirSync(bdir).sort();
        for (const d of dirs.slice(0, Math.max(0, dirs.length - 3)))
          fs.rmSync(path.join(bdir, d), { recursive: true, force: true });
      }
    } catch {}

    return {
      status:    'updated',
      from:      local,
      to:        remote.version,
      changed,
      removed:   removed.length,
      npm:       pkgChanged,
      changelog: remote.changelog,
    };
  } catch (err) {
    for (const rel of backed) {
      try { fs.copyFileSync(path.join(backupRoot, rel), path.join(ROOT, rel)); } catch {}
    }
    for (const rel of created) { try { fs.rmSync(path.join(ROOT, rel), { force: true }); } catch {} }
    throw err;
  } finally {
    busy = false;
  }
}

function setPendingNotice(chatId, info) {
  writeState({ ...readState(), pendingNotice: { chatId, ...info } });
}

function startUpdateChecker(telegram, config, getOwners) {
  const st0 = readState();
  if (st0.pendingNotice) {
    const n   = st0.pendingNotice;
    const st1 = readState();
    delete st1.pendingNotice;
    writeState(st1);
    telegram.sendMessage(n.chatId,
      `✅ <b>Update Selesai</b>\n\n<blockquote>📦 Versi : <code>${localVersion()}</code>\n🟢 Status : Bot sudah aktif kembali</blockquote>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  if (!isConfigured(config)) return;

  const c = getCfg(config);

  const run = async () => {
    try {
      const r  = await checkForUpdate(config);
      if (!r.hasUpdate || isUpdating()) return;
      const st = readState();
      if (st.notified === r.remote.version) return;

      const changelog = r.remote.changelog?.length
        ? '\n\n📝 <b>Yang baru:</b>\n' + r.remote.changelog.map(l => `• ${l}`).join('\n')
        : '';
      const msg = `🔔 <b>Update Tersedia!</b>\n\n<blockquote>📦 Sekarang : <code>${r.local}</code>\n🆕 Versi baru : <code>${r.remote.version}</code>${r.remote.date ? ` (${r.remote.date})` : ''}</blockquote>${changelog}\n\nKetik /update untuk memperbarui.`;

      const keyboard = { inline_keyboard: [[{ text: '⬇️ Update Sekarang', callback_data: 'upd_go' }]] };
      let sent = 0;
      for (const id of getOwners()) {
        try {
          await telegram.sendMessage(id, msg, { parse_mode: 'HTML', reply_markup: keyboard });
          sent++;
        } catch {}
      }
      if (sent) writeState({ ...readState(), notified: r.remote.version });
    } catch (e) {
      console.warn('[UPDATE] cek gagal:', e.message);
    }
  };

  setTimeout(run, 30_000).unref?.();
  setInterval(run, c.checkEverySec * 1_000).unref?.();
  console.log(`[UPDATE] Auto update aktif → ${c.repo}@${c.branch}, cek tiap ${c.checkEverySec}s (ETag cached). Versi lokal: ${localVersion()}`);
}

module.exports.isConfigured       = isConfigured;
module.exports.localVersion       = localVersion;
module.exports.compareVersions    = compareVersions;
module.exports.checkForUpdate     = checkForUpdate;
module.exports.applyUpdate        = applyUpdate;
module.exports.isUpdating         = isUpdating;
module.exports.setPendingNotice   = setPendingNotice;
module.exports.startUpdateChecker = startUpdateChecker;
