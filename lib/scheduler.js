'use strict';
// ============================================================
// scheduler-new.js — Automated schedulers
// Features: #09(activity), #10(new user notif), #12(suspend),
//           #54(data retention), #57(daily report),
//           #58(weekly cleanup), #61(recovery notif), #62(integrity)
// ============================================================
const { fbRead, fbWrite } = require('./firebase');
const path = require('path');
const os   = require('os');

function rj(fp, def) {
  return fbRead(fp, typeof def === 'function' ? def() : def);
}
function wj(fp, d) {
  fbWrite(fp, d);
}

// ── censorDomain: sensor sebagian domain agar tidak terekspos ──
function censorDomain(urlStr) {
  try {
    const urlObj = new URL(String(urlStr || ''));
    const censorSeg = seg => {
      if (seg.length <= 1) return '*';
      if (seg.length === 2) return seg[0] + '*';
      return seg[0] + '*'.repeat(seg.length - 2) + seg[seg.length - 1];
    };
    const censored = urlObj.hostname.split('.').map(censorSeg).join('.');
    return urlObj.protocol + '//' + censored;
  } catch (_) {
    const s = String(urlStr || '');
    if (s.length <= 6) return '*'.repeat(s.length);
    return s.slice(0, 3) + '*'.repeat(Math.max(1, s.length - 5)) + s.slice(-2);
  }
}

module.exports = function startSchedulers(bot, deps) {
  const {
    config, db, E, ROLE_DEFINITIONS, TIER_LABELS,
    isOwner, htmlEscape, formatDateId,
    getActiveServers, pteroRequestFor, getServerStatus,
    cleanDomain, progressBar, formatDuration,
    richTitle, richTable, richPara, richFold, richQuote,
    DB_DIR, STARTED_USERS_FILE,
  } = deps;

  // ── Path helpers ─────────────────────────────────────────────
  const p = name => path.join(DB_DIR, name);

  const STATS_FILE         = p('panel_stats.json');
  const OFFLINE_FILE       = p('offline_tracker.json');
  const DAILY_CFG_FILE     = p('daily_report_config.json');
  const AUDIT_FILE         = p('audit_log.json');
  const FAILED_FILE        = p('failed_attempts.json');
  const INTEGRITY_FILE     = p('integrity_log.json');
  const PEAK_HOURS_FILE    = p('peak_hours.json');
  const CMD_STATS_FILE     = p('cmd_stats.json');
  const RECOVERY_FILE      = p('server_recovery.json');
  const MYPANELS_FILE      = p('mypanels.json');
  const ROLES_FILE         = p('roles.json');
  const ACTIVITY_FILE      = p('user_activity.json');

  // ── Helpers ──────────────────────────────────────────────────
  function ownerChatId() {
    return String(config.ownerChannelId || config.ownerId || '');
  }
  function getStartedUsers() {
    const raw = rj(STARTED_USERS_FILE, []);
    return Array.isArray(raw) ? raw : Object.keys(raw);
  }
  function nowId() {
    return new Date().toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' });
  }
  function toMb(b)  { return (b / 1024 / 1024).toFixed(0) + 'MB'; }
  function toGb(kb) { return (kb / 1024 / 1024).toFixed(1) + 'GB'; }
  function fmtMs(ms) {
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m ${s % 60}s`;
  }
  async function safeSend(chatId, text, extra = {}) {
    try { return await bot.telegram.sendMessage(String(chatId), text, { parse_mode: 'HTML', ...extra }); }
    catch (_) { return null; }
  }

  // ============================================================
  // FEATURE 57 — Daily Report (07:00 WIB)
  // ============================================================
  async function sendDailyReport() {
    const cfg = rj(DAILY_CFG_FILE, { enabled: false });
    if (!cfg.enabled) return;
    const oid = ownerChatId();
    if (!oid) return;

    const stats  = rj(STATS_FILE, { totalPanels: 0, dailyStats: {}, serverStats: {}, tierStats: {} });
    const roles  = rj(ROLES_FILE, { users: {} });
    const users  = Object.values(roles.users || {});
    const today  = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
    const panels = rj(MYPANELS_FILE, { panels: {} });
    const activity = rj(ACTIVITY_FILE, {});

    const todayPanels  = stats.dailyStats?.[today] || 0;
    const totalUsers   = users.length;
    const activeToday  = Object.values(activity).filter(u => {
      if (!u.lastAt) return false;
      const d = new Date(u.lastAt).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
      return d === today;
    }).length;

    // Tier breakdown
    const tierCount = {};
    users.forEach(u => {
      const def = ROLE_DEFINITIONS[u.role];
      if (def) tierCount[def.tier] = (tierCount[def.tier] || 0) + 1;
    });

    // Server stats
    const ramTotal  = os.totalmem(), ramUsed = ramTotal - os.freemem();
    const servers   = getActiveServers();

    // 7-day panel chart (ASCII)
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const lbl = d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
      last7.push({ label: lbl, count: stats.dailyStats?.[lbl] || 0 });
    }
    const maxCount = Math.max(1, ...last7.map(d => d.count));
    const chart = last7.map(d => {
      const bar = '█'.repeat(Math.round((d.count / maxCount) * 10)).padEnd(10, '░');
      const day = d.label.split('/').slice(0, 2).join('/');
      return `${day} ${bar} ${d.count}`;
    }).join('\n');

    const msg = [
      `${'📊'} <b>Daily Report — ${today}</b>`,
      `<i>${config.botName || 'Cpanel HanzPiw X Jayss'}</i>`,
      '',
      `<blockquote>`,
      `👥 <b>Users:</b> ${totalUsers} total | ${activeToday} active today`,
      `📦 <b>Panels Created Today:</b> ${todayPanels}`,
      `📦 <b>Total Panels (All Time):</b> ${stats.totalPanels || 0}`,
      `🖥️ <b>Servers Active:</b> ${servers.length}`,
      `💾 <b>RAM:</b> ${toMb(ramUsed)} / ${toMb(ramTotal)} (${Math.round(ramUsed / ramTotal * 100)}%)`,
      ``,
      Object.entries(tierCount).map(([t, c]) => `${TIER_LABELS[t] || t}: ${c}`).join(' | '),
      `</blockquote>`,
      '',
      `<b>📈 Panel 7-Day Chart:</b>`,
      `<blockquote><code>${chart}</code></blockquote>`,
    ].join('\n');

    await safeSend(oid, msg);

    // Log
    const audit = rj(AUDIT_FILE, []);
    audit.unshift({ action: 'daily_report_sent', actor: 'scheduler', target: oid, at: new Date().toISOString() });
    if (audit.length > 500) audit.splice(500);
    wj(AUDIT_FILE, audit);
  }

  // Schedule at 07:00 WIB every day
  function scheduleDailyReport() {
    const now = new Date();
    const wib = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    let nextRun = new Date(wib);
    nextRun.setHours(7, 0, 0, 0);
    if (nextRun <= wib) nextRun.setDate(nextRun.getDate() + 1);
    const delay = nextRun - wib;
    setTimeout(() => {
      sendDailyReport().catch(e => console.error('[DAILY_REPORT]', e.message));
      setInterval(() => sendDailyReport().catch(e => console.error('[DAILY_REPORT]', e.message)), 24 * 3600 * 1000);
    }, delay);
  }

  // ============================================================
  // FEATURE 58 — Weekly DB Cleanup (Sunday 02:00 WIB)
  // ============================================================
  async function weeklyCleanup() {
    let panelsRemoved = 0, auditTrimmed = 0, failsTrimmed = 0;
    try {
      const panels = rj(MYPANELS_FILE, { panels: {} });
      const cutoff = Date.now() - 90 * 86400000;
      for (const uid of Object.keys(panels.panels || {})) {
        const before = panels.panels[uid].length;
        panels.panels[uid] = panels.panels[uid].filter(px => new Date(px.createdAt).getTime() > cutoff);
        panelsRemoved += before - panels.panels[uid].length;
      }
      wj(MYPANELS_FILE, panels);

      const audit = rj(AUDIT_FILE, []);
      if (audit.length > 500) { auditTrimmed = audit.length - 500; wj(AUDIT_FILE, audit.slice(0, 500)); }

      const fails   = rj(FAILED_FILE, {});
      const weekAgo = Date.now() - 7 * 86400000;
      for (const uid of Object.keys(fails)) {
        const before = fails[uid].length;
        fails[uid] = fails[uid].filter(a => new Date(a.at).getTime() > weekAgo);
        failsTrimmed += before - fails[uid].length;
        if (!fails[uid].length) delete fails[uid];
      }
      wj(FAILED_FILE, fails);

    } catch (e) { console.error('[WEEKLY_CLEANUP]', e.message); }

    const oid = ownerChatId();
    if (oid) {
      await safeSend(oid,
        `${'🗑️'} <b>Weekly DB Cleanup — ${nowId()}</b>\n\n` +
        `<blockquote>` +
        `📦 Old panel entries removed: ${panelsRemoved}\n` +
        `📋 Audit log trimmed: ${auditTrimmed} entries\n` +
        `🚫 Failed attempts cleaned: ${failsTrimmed} entries` +
        `</blockquote>`
      );
    }
  }

  function scheduleWeeklyCleanup() {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const next = new Date(now);
    // Next Sunday
    next.setDate(now.getDate() + (7 - now.getDay()) % 7 || 7);
    next.setHours(2, 0, 0, 0);
    const delay = next - now;
    setTimeout(() => {
      weeklyCleanup().catch(e => console.error('[WEEKLY_CLEANUP]', e.message));
      setInterval(() => weeklyCleanup().catch(e => console.error('[WEEKLY_CLEANUP]', e.message)), 7 * 24 * 3600 * 1000);
    }, delay);
  }

  // ============================================================
  // FEATURE 61 — Server Recovery Notification
  // ============================================================
  const serverDownSince = new Map(); // serverIndex → { downAt, notified }

  async function checkServerRecovery() {
    const servers = getActiveServers();
    const oid     = ownerChatId();
    if (!servers.length || !oid) return;

    const recovery = rj(RECOVERY_FILE, {});

    for (const sv of servers) {
      const key = `v${sv.index}`;
      let isOnline = false;
      try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 8000);
        const res  = await fetch(`${cleanDomain(sv.domain)}/api/application/users?per_page=1`, {
          headers: { Authorization: `Bearer ${sv.plta}`, Accept: 'Application/vnd.pterodactyl.v1+json' },
          signal: ctrl.signal,
        });
        clearTimeout(tid);
        isOnline = res.ok || res.status === 403;
      } catch (_) {}

      if (!isOnline) {
        // Server went down
        if (!serverDownSince.has(key)) {
          serverDownSince.set(key, { downAt: Date.now(), notified: false });
          // Notify owner server is down
          await safeSend(oid,
            `${'🔴'} <b>Server V${sv.index} is DOWN!</b>\n` +
            `Domain: <code>${censorDomain(cleanDomain(sv.domain))}</code>\n` +
            `Time: ${nowId()}`
          );
        }
      } else {
        // Server is online
        if (serverDownSince.has(key)) {
          const info = serverDownSince.get(key);
          const downDur = fmtMs(Date.now() - info.downAt);
          serverDownSince.delete(key);

          // Send recovery notification
          await safeSend(oid,
            `${'🟢'} <b>Server V${sv.index} is BACK ONLINE!</b>\n` +
            `Downtime: <b>${downDur}</b>\n` +
            `Domain: <code>${censorDomain(cleanDomain(sv.domain))}</code>\n` +
            `Time: ${nowId()}`
          );

          // Log
          recovery[key] = { recoveredAt: new Date().toISOString(), downDur };
          wj(RECOVERY_FILE, recovery);
        }
      }
    }
  }

  // ============================================================
  // FEATURE 62 — Scheduled DB Integrity Check (daily 03:00 WIB)
  // ============================================================
  async function scheduledIntegrityCheck() {
    const oid = ownerChatId();
    let issues = [];
    try {
      const roles   = rj(ROLES_FILE, { users: {} });
      const started = getStartedUsers();
      const panels  = rj(MYPANELS_FILE, { panels: {} });
      const startedSet = new Set(started.map(String));
      const userRoles  = roles.users || {};

      for (const [uid] of Object.entries(userRoles)) {
        if (!startedSet.has(uid)) {
          issues.push({ type: 'role_no_start', detail: `User ${uid} has role but no /start` });
        }
      }
      for (const [uid, ps] of Object.entries(panels.panels || {})) {
        if (!userRoles[uid]) {
          issues.push({ type: 'orphan_panel', detail: `User ${uid} has ${ps.length} panels but no role` });
        }
      }
    } catch (e) {
      issues.push({ type: 'check_error', detail: e.message });
    }

    wj(INTEGRITY_FILE, { checkedAt: new Date().toISOString(), issues, total: issues.length });

    if (oid && issues.length > 0) {
      await safeSend(oid,
        `${'⚠️'} <b>DB Integrity Check — ${issues.length} issue(s) found</b>\n` +
        `Time: ${nowId()}\n\n` +
        issues.slice(0, 5).map(i => `• <b>${i.type}</b>: ${htmlEscape(i.detail)}`).join('\n') +
        (issues.length > 5 ? `\n<i>...and ${issues.length - 5} more. See /dbcheck</i>` : '')
      );
    } else if (oid) {
      await safeSend(oid, `${'✅'} DB Integrity Check OK — No issues at ${nowId()}`);
    }
  }

  function scheduleIntegrityCheck() {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    setTimeout(() => {
      scheduledIntegrityCheck().catch(e => console.error('[INTEGRITY]', e.message));
      setInterval(() => scheduledIntegrityCheck().catch(e => console.error('[INTEGRITY]', e.message)), 24 * 3600 * 1000);
    }, delay);
  }

  // ============================================================
  // FEATURE 54 — Auto Data Retention (30-day inactive logs)
  // ============================================================
  async function dataRetentionClean() {
    const cutoff = Date.now() - 30 * 86400000;
    try {
      // Clean old cmd_stats that are just numbers (keep as-is)
      // Clean old poll votes from expired polls
      const pollsFile = path.join(DB_DIR, 'polls.json');
      const polls = rj(pollsFile, {});
      let cleaned = 0;
      for (const [id, poll] of Object.entries(polls)) {
        if (poll.closesAt && new Date(poll.closesAt).getTime() < cutoff) {
          delete polls[id]; cleaned++;
        }
      }
      if (cleaned) wj(pollsFile, polls);

      // Clean old feedback (older than 30 days if replied)
      const feedbackFile = path.join(DB_DIR, 'feedback.json');
      const fbs = rj(feedbackFile, []);
      const kept = fbs.filter(f => {
        if (!f.replied) return true;
        return new Date(f.at).getTime() > cutoff;
      });
      if (kept.length < fbs.length) wj(feedbackFile, kept);

    } catch (e) { console.error('[RETENTION]', e.message); }
  }

  // ============================================================
  // FEATURE 10 — New User Notification (enhanced /start hook)
  // Already partially implemented in bot.js via started_users.json
  // This adds DM notification to owner channel for every new user
  // ============================================================
  bot._notifyNewUser = async function(userId, firstName, username) {
    const oid = ownerChatId();
    if (!oid) return;
    const roles  = db.getAllRoles();
    const total  = Object.keys(roles).length;
    const started = getStartedUsers();
    try {
      await safeSend(oid,
        `${'🔔'} <b>New User Started Bot</b>\n` +
        `Name: ${htmlEscape(firstName || 'User')}\n` +
        `Username: ${username ? '@' + username : '-'}\n` +
        `ID: <code>${userId}</code>\n` +
        `Total started: ${started.length}\n` +
        `Total with roles: ${total}\n` +
        `Time: ${nowId()}`
      );
    } catch (_) {}
  };

  // ============================================================
  // START ALL SCHEDULERS
  // ============================================================
  scheduleDailyReport();
  scheduleWeeklyCleanup();
  scheduleIntegrityCheck();

  // Recovery check every 5 minutes (alongside existing monitor)
  setInterval(() => checkServerRecovery().catch(e => console.error('[RECOVERY]', e.message)), 5 * 60 * 1000);

  // Data retention check weekly (every 7 days)
  setInterval(() => dataRetentionClean().catch(e => console.error('[RETENTION]', e.message)), 7 * 24 * 3600 * 1000);

  // schedulers started silently
};
