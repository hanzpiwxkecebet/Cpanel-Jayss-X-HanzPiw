'use strict';

const { fbRead, fbWrite } = require('./firebase');
const path = require('path');

const mkPath = (dir, name) => path.join(dir, name);

function rjson(fp, def) {
  return fbRead(fp, def);
}
function wjson(fp, data) {
  fbWrite(fp, data);
}

function asciiBar(val, max, len = 12) {
  const filled = max > 0 ? Math.round((val / max) * len) : 0;
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, len - filled));
}

module.exports = function registerFeatures(bot, deps) {
  const {
    db, config, E, ROLE_DEFINITIONS, TIER_LABELS, PANEL_PLANS, TIER_ALLOWED_SERVERS,
    Markup, isOwner, isPrimaryOwner, htmlEscape, eBox, eMulti, eSect, renderCard,
    sendDirectCard, formatDateId, richTitle, richTable, richFold, richPara,
    richQuote, richEscape, makeView, getActiveServers, getServerStatus,
    pteroRequestFor, STARTED_USERS_FILE, DB_DIR, progressBar, formatDuration,
    BROADCAST_USERS, USERS_SECURITY, backToMenuKeyboard, getUserTier,
    getUserRoleDisplay, hasAccessForPanel, cleanDomain, getMaintenanceStatus,
    safeAnswer, eF, readBlacklist, saveBlacklist, pe,
  } = deps;

  const FAQ_FILE         = mkPath(DB_DIR, 'faq.json');
  const TUTORIAL_FILE    = mkPath(DB_DIR, 'tutorial.json');
  const MYPANELS_FILE    = mkPath(DB_DIR, 'mypanels.json');
  const SCHEDULED_BC     = mkPath(DB_DIR, 'scheduled_bc.json');
  const PEAK_HOURS_FILE  = mkPath(DB_DIR, 'peak_hours.json');
  const CMDSTATS_FILE    = mkPath(DB_DIR, 'cmd_stats.json');
  const BLACKLIST_DUR    = mkPath(DB_DIR, 'blacklist_durations.json');
  const BLOCKED_CMD_USER = mkPath(DB_DIR, 'blocked_cmds_user.json');
  const WGROUP_FILE      = mkPath(DB_DIR, 'whitelisted_groups.json');
  const CUSTOM_ROLES_F   = mkPath(DB_DIR, 'custom_roles.json');
  const SEC_ROLES_FILE   = mkPath(DB_DIR, 'secondary_roles.json');
  const MAINT_SCHED_FILE = mkPath(DB_DIR, 'maintenance_schedule.json');
  const WEEKLY_RPT_FILE  = mkPath(DB_DIR, 'weekly_report.json');
  const DEBUG_FILE       = mkPath(DB_DIR, 'debug_mode.json');

  function getTierBadge(tier) {
    const map = {
      akma:  '🟡',
      akme:  '🔵',
      akti:  '🔴',
      owner: '👑',
    };
    return map[tier] || '⚪';
  }

  function relativeTime(dateValue) {
    const diff = new Date(dateValue).getTime() - Date.now();
    const abs  = Math.abs(diff);
    const past = diff < 0;
    const mins  = Math.floor(abs / 60000);
    const hours = Math.floor(abs / 3600000);
    const days  = Math.floor(abs / 86400000);
    let str;
    if (days > 0)        str = `${days} hari`;
    else if (hours > 0)  str = `${hours} jam`;
    else if (mins > 0)   str = `${mins} menit`;
    else                 str = 'sebentar lagi';
    return past ? `${str} lalu` : `${str} lagi`;
  }

  function validateConfig() {
    const issues = [];
    if (!config.botToken || config.botToken === 'ISI_TOKEN_BOT_KAMU')
      issues.push('botToken belum diisi');
    const servers = getActiveServers();
    if (!servers.length)
      issues.push('Tidak ada server Pterodactyl aktif (domain/plta belum diisi)');
    servers.forEach(s => {
      if (!/^https?:\/\//i.test(String(s.domain || '')))
        issues.push(`Server V${s.index}: domain tidak valid (harus https://...)`);
      if (!/^ptla_/i.test(String(s.plta || '')))
        issues.push(`Server V${s.index}: PLTA tidak valid (harus ptla_...)`);
    });
    if (!config.ownerIds && !config.ownerId)
      issues.push('ownerIds / ownerId belum diisi');
    if (issues.length) {
    } else {
    }
    return issues;
  }

  validateConfig();

  function isDebugMode() { return rjson(DEBUG_FILE, { on: false }).on; }
  function sendDebugError(errMsg) {
    if (!isDebugMode()) return;
    const ownerId = (Array.isArray(config.ownerIds) ? config.ownerIds[0] : config.ownerId);
    if (!ownerId) return;
    bot.telegram.sendMessage(String(ownerId),
      `⁉️ <b>[DEBUG ERROR]</b>\n<code>${htmlEscape(String(errMsg).slice(0, 3000))}</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  bot._debugErr = sendDebugError;

  function trackCmd(cmdName) {
    const stats = rjson(CMDSTATS_FILE, {});
    stats[cmdName] = (stats[cmdName] || 0) + 1;
    wjson(CMDSTATS_FILE, stats);
  }

  function trackPanelHour() {
    const data = rjson(PEAK_HOURS_FILE, { hours: {} });
    const hour = new Date().toLocaleString('id-ID', {
      timeZone: config.timezone || 'Asia/Jakarta', hour: '2-digit', hour12: false
    }).replace(/[^0-9]/g, '').slice(0, 2);
    data.hours[hour] = (data.hours[hour] || 0) + 1;
    wjson(PEAK_HOURS_FILE, data);
  }

  function addMyPanel(userId, panelInfo) {
    const data = rjson(MYPANELS_FILE, { panels: {} });
    const uid  = String(userId);
    if (!data.panels[uid]) data.panels[uid] = [];
    data.panels[uid].unshift({ ...panelInfo, createdAt: new Date().toISOString() });

    if (data.panels[uid].length > 20) data.panels[uid] = data.panels[uid].slice(0, 20);
    wjson(MYPANELS_FILE, data);
  }
  function getMyPanels(userId) {
    return rjson(MYPANELS_FILE, { panels: {} }).panels[String(userId)] || [];
  }

  function readBLDur() { return rjson(BLACKLIST_DUR, {}); }
  function saveBLDur(d) { wjson(BLACKLIST_DUR, d); }
  function blDurAdd(userId, durationMs) {
    const d = readBLDur();
    d[String(userId)] = {
      addedAt: Date.now(),
      expiresAt: durationMs > 0 ? Date.now() + durationMs : null,
    };
    saveBLDur(d);
  }
  function blDurRemove(userId) {
    const d = readBLDur();
    delete d[String(userId)];
    saveBLDur(d);
  }
  function blDurIsExpired(userId) {
    const d = readBLDur();
    const e = d[String(userId)];
    if (!e) return false;
    if (!e.expiresAt) return false;
    return Date.now() > e.expiresAt;
  }
  function blDurGetInfo(userId) {
    return readBLDur()[String(userId)] || null;
  }

  setInterval(() => {
    const list  = readBlacklist();
    const dur   = readBLDur();
    let changed = false;
    for (const [uid, info] of Object.entries(dur)) {
      if (info.expiresAt && Date.now() > info.expiresAt) {
        const idx = list.indexOf(uid);
        if (idx !== -1) { list.splice(idx, 1); changed = true; }
        delete dur[uid];
      }
    }
    if (changed) { saveBlacklist(list); saveBLDur(dur); }
  }, 5 * 60 * 1000);

  function readWhitelistGroups() { return rjson(WGROUP_FILE, { enabled: false, groups: [] }); }
  function saveWhitelistGroups(d) { wjson(WGROUP_FILE, d); }
  function isGroupWhitelisted(chatId) {
    const d = readWhitelistGroups();
    if (!d.enabled) return true;
    return d.groups.includes(String(chatId));
  }

  function readCmdBlocks() { return rjson(BLOCKED_CMD_USER, {}); }
  function saveCmdBlocks(d) { wjson(BLOCKED_CMD_USER, d); }
  function isCmdBlockedForUser(userId, cmd) {
    const d = readCmdBlocks();
    return Array.isArray(d[String(userId)]) && d[String(userId)].includes(cmd);
  }
  function setCmdBlock(userId, cmd, block) {
    const d  = readCmdBlocks();
    const id = String(userId);
    if (!Array.isArray(d[id])) d[id] = [];
    if (block) { if (!d[id].includes(cmd)) d[id].push(cmd); }
    else        { d[id] = d[id].filter(c => c !== cmd); }
    saveCmdBlocks(d);
  }

  function readScheduledBC() { return rjson(SCHEDULED_BC, { jobs: [] }); }
  function saveScheduledBC(d) { wjson(SCHEDULED_BC, d); }

  setInterval(async () => {
    const data    = readScheduledBC();
    const now     = Date.now();
    const pending = data.jobs.filter(j => !j.sent && j.sendAt <= now);
    for (const job of pending) {
      try {
        const startedFile = rjson(STARTED_USERS_FILE, {});
        const userIds     = Object.keys(startedFile);
        let ok = 0;
        for (const uid of userIds) {
          try {
            await bot.telegram.sendMessage(uid,
              `📣 <b>Pengumuman Terjadwal</b>\n\n${htmlEscape(job.message)}`,
              { parse_mode: 'HTML' }
            );
            ok++;
            await new Promise(r => setTimeout(r, 50));
          } catch (_) {}
        }
        job.sent   = true;
        job.sentAt = new Date().toISOString();
        job.sentTo = ok;
        console.log(`[SCHEDULED BC] Job ${job.id} terkirim ke ${ok} user.`);
      } catch (e) {
        console.error('[SCHEDULED BC] Error:', e.message);
      }
    }
    if (pending.length) saveScheduledBC(data);
  }, 60 * 1000);

  function readMaintSched() { return rjson(MAINT_SCHED_FILE, { jobs: [] }); }
  function saveMaintSched(d) { wjson(MAINT_SCHED_FILE, d); }
  setInterval(() => {

    const sched = readMaintSched();
    const now   = Date.now();
    for (const job of sched.jobs) {
      if (!job.activated && job.startAt <= now) {
        job.activated = true;
        console.log('[MAINT SCHED] Maintenance started (manual toggle still needed)');
      }
    }
    saveMaintSched(sched);
  }, 30 * 1000);

  function readCustomRoles() { return rjson(CUSTOM_ROLES_F, { roles: {} }); }
  function saveCustomRoles(d) { wjson(CUSTOM_ROLES_F, d); }
  function getCustomRoleDef(roleName) {
    return readCustomRoles().roles[roleName] || null;
  }

  function readSecRoles() { return rjson(SEC_ROLES_FILE, {}); }
  function saveSecRoles(d) { wjson(SEC_ROLES_FILE, d); }
  function getUserSecondaryRoles(userId) {
    return readSecRoles()[String(userId)] || [];
  }
  function addSecondaryRole(userId, role, days = null) {
    const d   = readSecRoles();
    const id  = String(userId);
    if (!d[id]) d[id] = [];
    const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
    d[id] = d[id].filter(r => r.role !== role);
    d[id].push({ role, addedAt: new Date().toISOString(), expiresAt });
    saveSecRoles(d);
  }
  function removeSecondaryRole(userId, role) {
    const d  = readSecRoles();
    const id = String(userId);
    if (d[id]) d[id] = d[id].filter(r => r.role !== role);
    saveSecRoles(d);
  }

  const DEFAULT_WELCOME = rjson(mkPath(DB_DIR, 'welcome_messages.json'), {
    akma:  'Selamat datang! Kamu mendapatkan Akses Pertama (Akma). Ketik /menu untuk mulai.',
    akme:  'Selamat datang! Kamu mendapatkan Akses Menengah (Akme). Ketik /menu untuk mulai.',
    akti:  'Selamat datang! Kamu mendapatkan Akses Tinggi (Akti). Ketik /menu untuk mulai.',
    guest: 'Selamat datang! Kamu belum memiliki akses. Hubungi owner untuk membeli panel.',
  });
  function readWelcomeMessages() {
    return rjson(mkPath(DB_DIR, 'welcome_messages.json'), DEFAULT_WELCOME);
  }
  function saveWelcomeMessages(d) { wjson(mkPath(DB_DIR, 'welcome_messages.json'), d); }
  function getTierWelcome(tier) {
    return readWelcomeMessages()[tier] || readWelcomeMessages().guest;
  }

  const EVENT_CALENDAR = [
    { month: 1,  day: 1,  name: 'Tahun Baru',  emoji: '🎊' },
    { month: 4,  day: -1, name: 'Ramadan',      emoji: '🌙' },
    { month: 8,  day: 17, name: 'HUT RI',       emoji: '🇮🇩' },
    { month: 12, day: 25, name: 'Natal',        emoji: '🎄' },
    { month: 12, day: 31, name: 'Malam Tahun Baru', emoji: '🎆' },
  ];
  function getCurrentEvent() {
    const now = new Date();
    const m   = now.getMonth() + 1;
    const d   = now.getDate();
    return EVENT_CALENDAR.find(e => e.month === m && (e.day === d || e.day === -1)) || null;
  }

  function addWatermark(text) {
    return `${text}\n\n✅ <i>Powered by CPanel HanzPiw X Jayss • @itshanzpiw</i>`;
  }

  function startWeeklyDashboard() {
    const checkWeekly = async () => {
      const now = new Date();
      if (now.getDay() !== 1 || now.getHours() !== 8 || now.getMinutes() > 5) return;

      const last = rjson(WEEKLY_RPT_FILE, { lastSent: '' });
      const todayStr = now.toLocaleDateString('id-ID');
      if (last.lastSent === todayStr) return;

      const ownerId = Array.isArray(config.ownerIds) ? config.ownerIds[0] : config.ownerId;
      if (!ownerId) return;

      const stats    = rjson(mkPath(DB_DIR, 'panel_stats.json'), { totalPanels: 0, dailyStats: {}, serverStats: {} });
      const allRoles = db.getAllRoles ? db.getAllRoles() : {};
      const blLen    = readBlacklist().length;

      let weekTotal = 0;
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const lbl = d.toLocaleDateString('id-ID');
        weekTotal += stats.dailyStats?.[lbl] || 0;
      }

      const peak = rjson(PEAK_HOURS_FILE, { hours: {} }).hours;
      const peakEntries = Object.entries(peak).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const peakLines   = peakEntries.map(([h, c]) => `Jam ${h}:00 — ${c} panel`);

      const caption = eMulti([
        {
          title: `${'📊'} LAPORAN MINGGUAN — ${todayStr}`,
          lines: [
            `${'✅'}  Panel total    ┈ <b>${stats.totalPanels || 0}</b>`,
            `${'⭐'}   Panel minggu ini ┈ <b>${weekTotal}</b>`,
            `${'👤'}  Total user     ┈ <b>${Object.keys(allRoles).length}</b>`,
            `${'🚫'} Blacklist      ┈ <b>${blLen}</b>`,
          ],
        },
        {
          title: `${'🔥'} JAM TERSIBUK`,
          lines: peakLines.length ? peakLines : ['Belum ada data peak hour'],
        },
      ]);

      try {
        await bot.telegram.sendMessage(String(ownerId), caption, { parse_mode: 'HTML' });
        last.lastSent = todayStr;
        wjson(WEEKLY_RPT_FILE, last);
      } catch (_) {}
    };

    setInterval(checkWeekly, 5 * 60 * 1000);
  }
  startWeeklyDashboard();

  bot.use(async (ctx, next) => {
    const text = ctx.message?.text || '';
    if (text.startsWith('/')) {
      const cmd = text.split(/\s+/)[0].replace('@' + (ctx.botInfo?.username || ''), '').slice(1).toLowerCase();
      if (cmd) trackCmd(cmd);
    }
    return next();
  });

  const KNOWN_CMDS = [
    'menu','help','profile','ping','info','start',
    '1gb','2gb','3gb','4gb','5gb','6gb','7gb','8gb','9gb','10gb',
    '11gb','12gb','13gb','14gb','15gb','16gb','17gb','18gb','19gb','20gb',
    'unli','cadp','cadmin','addrole','delrole','listroles','broadcast',
    'blacklist','maintenance','stats','backup','cekserver','faq','mypanel',
    'myrole','tutorialpanel','panelstats','userstats','listpanel','version',
    'debugmode','cmdstats','scheduledbc','setmaintenance','rolelogs',
    'announcement','hanzgokil','storan','storanreset','cek','resetguest',
    'ban','unban','setcd','lockunli','unlockunli','lockadp','unlockadp',
    'menuku','netstat','uptimeserver','resellerlb','rolehistory','joinlog',
    'queuestat','autodelete','setgithub','panelstats2','cmdstats2',
    'listserver','listuser','listblacklist','monitorstatus','monitoron','monitoroff',
    'unsuspend','log','config','autocpu','hardenc','openenc','getcode','checkdomain',
  ];
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => i || j));
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i-1] === b[j-1]
          ? dp[i-1][j-1]
          : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
  }
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text || '';
    if (!text.startsWith('/')) return next();
    const cmd    = text.split(/\s+/)[0].slice(1).toLowerCase().replace(/@\w+$/, '');
    const isKnown = KNOWN_CMDS.includes(cmd);
    if (isKnown) return next();

    const suggestions = KNOWN_CMDS
      .map(k => ({ k, d: levenshtein(cmd, k) }))
      .filter(x => x.d <= 2 && x.d > 0)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    if (suggestions.length) {
      const btns = suggestions.map(s => [
        { text: eF(`/${s.k}`), callback_data: `suggestion_cmd_${s.k}`, style: 'primary' }
      ]);
      btns.push([{ text: eF('Batalkan'), callback_data: 'suggestion_cancel', style: 'danger' }]);
      await ctx.reply(
        `${'❓'} <b>Command <code>/${htmlEscape(cmd)}</code> tidak dikenal.</b>\nMaksud kamu salah satu ini?`,
        { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(btns).reply_markup }
      );
      return;
    }
    return next();
  });
  bot.action(/^suggestion_cmd_(.+)$/, async (ctx) => {
    await safeAnswer(ctx);
    const cmd = ctx.match[1];
    try { await ctx.deleteMessage(); } catch (_) {}

    try {
      const fakeUpdate = {
        update_id: Date.now(),
        message: {
          message_id: Date.now(),
          from: ctx.from,
          chat: ctx.chat,
          date: Math.floor(Date.now() / 1000),
          text: `/${cmd}`,
          entities: [{ offset: 0, length: cmd.length + 1, type: 'bot_command' }],
        },
      };
      await bot.handleUpdate(fakeUpdate);
    } catch (_) {

      await ctx.reply(`${'➡️'} Jalankan: <code>/${htmlEscape(cmd)}</code>`, { parse_mode: 'HTML' });
    }
  });
  bot.action('suggestion_cancel', async (ctx) => {
    await safeAnswer(ctx);
    try { await ctx.deleteMessage(); } catch (_) {}
  });

  bot.use(async (ctx, next) => {
    const text = ctx.message?.text || '';
    if (!text.startsWith('/')) return next();
    const userId = String(ctx.from?.id || '');
    if (!userId) return next();
    const cmd = text.split(/\s+/)[0].slice(1).toLowerCase().replace(/@\w+$/, '');
    if (isCmdBlockedForUser(userId, cmd)) {
      return ctx.reply(
        `${'🚫'} Command <code>/${htmlEscape(cmd)}</code> diblokir untuk akun kamu. Hubungi owner.`,
        { parse_mode: 'HTML' }
      );
    }
    return next();
  });

  bot.command('faq', async (ctx) => {
    trackCmd('faq');
    const data = rjson(FAQ_FILE, { entries: [] });
    if (!data.entries.length) {
      return ctx.reply(
        `${'❓'} <b>FAQ Belum Diisi</b>\n\n<i>Belum ada FAQ. Owner dapat menambahkan dengan /setfaq.</i>`,
        { parse_mode: 'HTML' }
      );
    }
    const lines = data.entries.map((e, i) =>
      `<b>${i + 1}. ${htmlEscape(e.q)}</b>\n${htmlEscape(e.a)}`
    );
    const caption = eMulti([{
      title: `${'❓'} FAQ — Pertanyaan Umum`,
      lines: [`Total ${data.entries.length} FAQ`, ''],
    }]) + '\n\n' + lines.join('\n\n');
    return ctx.reply(caption, { parse_mode: 'HTML' });
  });

  bot.command('setfaq', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const raw = (ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim();
    const sepIdx = raw.indexOf('|');
    if (sepIdx === -1) {
      return ctx.reply(
        `${'❌'} Format: <code>/setfaq Pertanyaan|Jawaban</code>`,
        { parse_mode: 'HTML' }
      );
    }
    const q    = raw.slice(0, sepIdx).trim();
    const a    = raw.slice(sepIdx + 1).trim();
    if (!q || !a) return ctx.reply(`${'❌'} Pertanyaan dan jawaban tidak boleh kosong.`, { parse_mode: 'HTML' });
    const data = rjson(FAQ_FILE, { entries: [] });
    data.entries.push({ q, a, addedAt: new Date().toISOString() });
    wjson(FAQ_FILE, data);
    return ctx.reply(
      `${'✅'} <b>FAQ berhasil ditambahkan (#${data.entries.length})</b>\n\n<b>Q:</b> ${htmlEscape(q)}\n<b>A:</b> ${htmlEscape(a)}`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('delfaq', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const idx  = parseInt(args[0]) - 1;
    const data = rjson(FAQ_FILE, { entries: [] });
    if (isNaN(idx) || idx < 0 || idx >= data.entries.length) {
      return ctx.reply(`${'❌'} Nomor FAQ tidak valid. Cek /faq untuk daftar.`, { parse_mode: 'HTML' });
    }
    const removed = data.entries.splice(idx, 1)[0];
    wjson(FAQ_FILE, data);
    return ctx.reply(
      `${'🗑️'} <b>FAQ #${idx + 1} dihapus.</b>\n<i>Q: ${htmlEscape(removed.q)}</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('announcement', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    trackCmd('announcement');
    const raw = (ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim();
    if (!raw) {
      return ctx.reply(
        `${'📣'} <b>Gunakan:</b>\n<code>/announcement Teks pengumuman</code>\n\n<i>Akan dikirim ke semua user yang pernah /start bot.</i>`,
        { parse_mode: 'HTML' }
      );
    }
    const event    = getCurrentEvent();
    const prefix   = event ? `${event.emoji} <b>[${event.name}]</b>\n\n` : '';
    const text     = `${'📣'} <b>Pengumuman</b>\n\n${prefix}${htmlEscape(raw)}`;
    const started  = rjson(STARTED_USERS_FILE, {});
    const userIds  = Object.keys(started);
    const progMsg  = await ctx.reply(`${'⌛'} Mengirim ke ${userIds.length} user...`, { parse_mode: 'HTML' });
    let ok = 0, fail = 0;
    for (const uid of userIds) {
      try {
        await bot.telegram.sendMessage(uid, text, { parse_mode: 'HTML' });
        ok++;
        await new Promise(r => setTimeout(r, 50));
      } catch (_) { fail++; }
    }
    try {
      await bot.telegram.editMessageText(
        ctx.chat.id, progMsg.message_id, null,
        `${'✅'} <b>Announcement selesai.</b>\n${'🟢'} Berhasil: <b>${ok}</b>\n${'🔴'} Gagal: <b>${fail}</b>`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {}
  });

  const ROLE_LOGS_FILE = mkPath(DB_DIR, 'role_logs.json');

  function addRoleLog(action, actorId, actorName, targetId, targetName, role, duration) {
    const data = rjson(ROLE_LOGS_FILE, { logs: [] });
    data.logs.unshift({
      action, actorId: String(actorId), actorName,
      targetId: String(targetId), targetName,
      role, duration, ts: new Date().toISOString(),
    });
    if (data.logs.length > 200) data.logs = data.logs.slice(0, 200);
    wjson(ROLE_LOGS_FILE, data);
  }
  bot._addRoleLog = addRoleLog;

  bot.command('rolelogs', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    trackCmd('rolelogs');
    const data = rjson(ROLE_LOGS_FILE, { logs: [] });
    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const page = parseInt(args[0]) || 1;
    const PER  = 10;
    const logs = data.logs;
    const totalPages = Math.max(1, Math.ceil(logs.length / PER));
    const cur  = Math.min(Math.max(1, page), totalPages);
    const slice = logs.slice((cur - 1) * PER, cur * PER);
    if (!slice.length) {
      return ctx.reply(`${'📊'} <b>Role Logs:</b> Belum ada log tersimpan.`, { parse_mode: 'HTML' });
    }
    const lines = slice.map(l => {
      const icon = l.action === 'add' ? '✅' : '🗑️';
      const exp  = l.duration || 'Permanent';
      return `${icon} <b>${htmlEscape(l.action.toUpperCase())}</b> · ${htmlEscape(l.role)}\n   👤 ${htmlEscape(l.targetName)} (<code>${l.targetId}</code>) oleh ${htmlEscape(l.actorName)}\n   ⏱ ${exp} · <i>${formatDateId(l.ts)}</i>`;
    });
    const caption = eMulti([{
      title: `${'🔖'} ROLE LOGS (${logs.length} total) — Hal. ${cur}/${totalPages}`,
      lines: [''],
    }]) + '\n\n' + lines.join('\n\n');
    return ctx.reply(caption, {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        ...(cur > 1 ? [[{ text: eF('◀ Sebelumnya'), callback_data: `rolelogs_page_${cur - 1}` }]] : []),
        ...(cur < totalPages ? [[{ text: eF('Selanjutnya ▶'), callback_data: `rolelogs_page_${cur + 1}` }]] : []),
      ]).reply_markup,
    });
  });
  bot.action(/^rolelogs_page_(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    const page = parseInt(ctx.match[1]) || 1;
    const data = rjson(ROLE_LOGS_FILE, { logs: [] });
    const PER  = 10;
    const logs = data.logs;
    const totalPages = Math.max(1, Math.ceil(logs.length / PER));
    const cur  = Math.min(Math.max(1, page), totalPages);
    const slice = logs.slice((cur - 1) * PER, cur * PER);
    const lines = slice.map(l => {
      const icon = l.action === 'add' ? '✅' : '🗑️';
      return `${icon} <b>${htmlEscape(l.action.toUpperCase())}</b> · ${htmlEscape(l.role)}\n   👤 ${htmlEscape(l.targetName)} (<code>${l.targetId}</code>) oleh ${htmlEscape(l.actorName)}\n   ⏱ ${l.duration || 'Permanent'} · <i>${formatDateId(l.ts)}</i>`;
    });
    const caption = eMulti([{
      title: `${'🔖'} ROLE LOGS (${logs.length} total) — Hal. ${cur}/${totalPages}`,
      lines: [''],
    }]) + '\n\n' + lines.join('\n\n');
    try {
      await ctx.editMessageText(caption, {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          ...(cur > 1 ? [[{ text: eF('◀ Sebelumnya'), callback_data: `rolelogs_page_${cur - 1}` }]] : []),
          ...(cur < totalPages ? [[{ text: eF('Selanjutnya ▶'), callback_data: `rolelogs_page_${cur + 1}` }]] : []),
        ]).reply_markup,
      });
    } catch (_) {}
  });

  bot.command('mypanel', async (ctx) => {
    trackCmd('mypanel');
    const panels = getMyPanels(ctx.from.id);
    if (!panels.length) {
      return ctx.reply(
        eBox(`${'🖥️'} PANEL SAYA`, [
          'Belum ada panel yang tercatat untuk akun kamu.',
          '',
          '<i>Panel akan otomatis tercatat setelah kamu membuat panel melalui bot.</i>',
        ]),
        { parse_mode: 'HTML' }
      );
    }
    const lines = panels.map((p, i) => {
      const ago = relativeTime(p.createdAt);
      return `<b>${i + 1}.</b> <code>${htmlEscape(p.username)}</code> · ${htmlEscape(p.plan)} · V${p.serverIndex}\n   <i>${ago}</i>`;
    });
    const caption = eMulti([{
      title: `${'🖥️'} PANEL SAYA (${panels.length})`,
      lines: [''],
    }]) + '\n\n' + lines.join('\n\n');
    return ctx.reply(caption, { parse_mode: 'HTML' });
  });

  bot._addMyPanel = addMyPanel;

  bot.command('myrole', async (ctx) => {
    trackCmd('myrole');
    const userId   = ctx.from.id;
    const roleInfo = getUserRoleDisplay(userId);
    const secRoles = getUserSecondaryRoles(userId);
    if (isOwner(userId)) {
      return ctx.reply(
        eBox(`${'👑'} ROLE KAMU`, [
          `${'👑'} Role    ┈ <b>Owner</b>`,
          `${'💠'} Tier   ┈ <b>Owner (Full Access)</b>`,
          `${'⌛'}  Expired ┈ <b>Permanent ∞</b>`,
          `${'✅'}  Server  ┈ <b>V1-V5 (All Access)</b>`,
        ]),
        { parse_mode: 'HTML' }
      );
    }
    if (!roleInfo) {
      return ctx.reply(
        eBox(`${'❌'} ROLE KAMU`, [
          'Kamu belum memiliki role aktif.',
          '',
          '<i>Hubungi owner atau reseller untuk mendapatkan akses panel.</i>',
        ]),
        { parse_mode: 'HTML' }
      );
    }
    const badge    = getTierBadge(roleInfo.tier);
    const expStr   = roleInfo.expiresAt ? relativeTime(roleInfo.expiresAt) : 'Permanent ∞';
    const expDate  = roleInfo.expiresAt ? formatDateId(roleInfo.expiresAt) : '—';
    const allowedSvr = (TIER_ALLOWED_SERVERS[roleInfo.tier] || []).map(n => `V${n}`).join(', ');
    const secLines  = secRoles.map(r => `• ${htmlEscape(r.role)}${r.expiresAt ? ` (${relativeTime(r.expiresAt)})` : ' (permanent)'}`);
    const lines = [
      `${badge} Role    ┈ <b>${htmlEscape(roleInfo.label)}</b>`,
      `${'💠'} Tier   ┈ <b>${htmlEscape(roleInfo.tierLabel)}</b>`,
      `${'⌛'}  Expired ┈ <b>${htmlEscape(expStr)}</b> (${htmlEscape(expDate)})`,
      `${'🖥️'} Server  ┈ <b>${htmlEscape(allowedSvr)}</b>`,
    ];
    if (secRoles.length) {
      lines.push('', `${'⭐'} Role Tambahan:`, ...secLines);
    }
    return ctx.reply(
      eBox(`${'🛡️'} ROLE KAMU`, lines),
      { parse_mode: 'HTML' }
    );
  });

  const DEFAULT_TUTORIAL = `1. Login ke panel menggunakan link, username, dan password yang sudah diberikan bot.\n2. Klik tombol "Files" untuk upload file bot kamu.\n3. Klik "Startup" untuk set environment variables jika diperlukan.\n4. Klik tombol Power → Start untuk menjalankan bot.\n5. Cek Console untuk melihat log bot berjalan.\n\nBantuan lebih lanjut: hubungi owner @itshanzpiw`;

  bot.command('tutorialpanel', async (ctx) => {
    trackCmd('tutorialpanel');
    const data = rjson(TUTORIAL_FILE, { content: DEFAULT_TUTORIAL });
    const caption = eBox(`${'🔖'} TUTORIAL PANEL PTERODACTYL`, [
      data.content || DEFAULT_TUTORIAL,
    ]);
    return ctx.reply(caption, { parse_mode: 'HTML' });
  });

  bot.command('settutorial', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    const content = (ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim();
    if (!content) {
      return ctx.reply(`${'❌'} Format: <code>/settutorial isi tutorial baru</code>`, { parse_mode: 'HTML' });
    }
    wjson(TUTORIAL_FILE, { content });
    return ctx.reply(`${'✅'} <b>Tutorial berhasil diupdate.</b>`, { parse_mode: 'HTML' });
  });

  bot.command('setmaintenance', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    trackCmd('setmaintenance');
    const raw  = (ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim();

    const m = raw.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})$/);
    if (raw === 'list') {
      const sched = readMaintSched();
      if (!sched.jobs.length) return ctx.reply(`${'🗓️'} Tidak ada maintenance terjadwal.`, { parse_mode: 'HTML' });
      const lines = sched.jobs.map((j, i) =>
        `<b>${i + 1}.</b> Mulai: <code>${j.startStr}</code> → Selesai: <code>${j.endStr}</code>${j.activated ? ' ✅' : ''}`
      );
      return ctx.reply(`${'🗓️'} <b>Jadwal Maintenance:</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
    }
    if (raw === 'clear') {
      saveMaintSched({ jobs: [] });
      return ctx.reply(`${'✅'} Semua jadwal maintenance dihapus.`, { parse_mode: 'HTML' });
    }
    if (!m) {
      return ctx.reply(
        `${'❌'} Format salah.\nGunakan:\n<code>/setmaintenance 2026-11-01 02:00 2026-11-01 04:00</code>\nAtau:\n<code>/setmaintenance list</code>\n<code>/setmaintenance clear</code>`,
        { parse_mode: 'HTML' }
      );
    }
    const startAt = new Date(m[1]).getTime();
    const endAt   = new Date(m[2]).getTime();
    if (isNaN(startAt) || isNaN(endAt)) {
      return ctx.reply(`${'❌'} Format tanggal tidak valid.`, { parse_mode: 'HTML' });
    }
    if (endAt <= startAt) {
      return ctx.reply(`${'❌'} Waktu selesai harus lebih besar dari waktu mulai.`, { parse_mode: 'HTML' });
    }
    const sched = readMaintSched();
    sched.jobs.push({
      id: Date.now(),
      startStr: m[1], endStr: m[2],
      startAt, endAt,
      activated: false, ended: false,
    });
    saveMaintSched(sched);
    return ctx.reply(
      eBox(`${'⌛'} MAINTENANCE TERJADWAL`, [
        `Mulai   ┈ <b>${m[1]}</b>`,
        `Selesai ┈ <b>${m[2]}</b>`,
        '',
        '<i>Bot akan masuk mode maintenance otomatis pada waktu yang ditentukan.</i>',
      ]),
      { parse_mode: 'HTML' }
    );
  });

  bot.command('scheduledbc', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    trackCmd('scheduledbc');
    const raw = (ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim();
    if (raw === 'list') {
      const data = readScheduledBC();
      const jobs = data.jobs;
      if (!jobs.length) return ctx.reply(`${'📣'} Tidak ada scheduled broadcast.`, { parse_mode: 'HTML' });
      const lines = jobs.map((j, i) =>
        `<b>${i + 1}.</b> <code>${j.sendStr}</code>${j.sent ? ` ✅ Terkirim ke ${j.sentTo} user` : ' ⏳ Menunggu'}\n   <i>${htmlEscape(j.message.slice(0, 60))}${j.message.length > 60 ? '…' : ''}</i>`
      );
      return ctx.reply(`${'📣'} <b>Scheduled Broadcasts:</b>\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' });
    }
    if (raw === 'clear') {
      const data = readScheduledBC();
      data.jobs = data.jobs.filter(j => !j.sent);
      saveScheduledBC(data);
      return ctx.reply(`${'✅'} Semua scheduled BC yang belum terkirim dihapus.`, { parse_mode: 'HTML' });
    }

    const mRecurr = raw.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+every\s+(\d+)(h|m|d)\s+([\s\S]+)$/i);
    const mOnce   = raw.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+([\s\S]+)$/);

    if (!mRecurr && !mOnce) {
      return ctx.reply(
        `${'❌'} Format:\n` +
        `<code>/scheduledbc 2026-11-01 10:00 Isi pesan</code>\n` +
        `<code>/scheduledbc 2026-11-01 10:00 every 24h Isi pesan</code>\n` +
        `<code>/scheduledbc list</code>\n` +
        `<code>/scheduledbc clear</code>`,
        { parse_mode: 'HTML' }
      );
    }

    let sendAt, message, recurringMs = null;
    if (mRecurr) {
      sendAt  = new Date(mRecurr[1]).getTime();
      message = mRecurr[4].trim();
      const qty = parseInt(mRecurr[2]);
      const unit = mRecurr[3].toLowerCase();
      recurringMs = qty * (unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 86400000);
    } else {
      sendAt  = new Date(mOnce[1]).getTime();
      message = mOnce[2].trim();
    }

    if (isNaN(sendAt)) return ctx.reply(`${'❌'} Format tanggal tidak valid.`, { parse_mode: 'HTML' });
    if (sendAt < Date.now()) return ctx.reply(`${'❌'} Waktu harus di masa depan.`, { parse_mode: 'HTML' });

    const data = readScheduledBC();
    data.jobs.push({
      id: Date.now(), sendStr: mRecurr ? mRecurr[1] : mOnce[1], sendAt, message, sent: false,
      ...(recurringMs ? { recurring: true, recurringMs, nextAt: sendAt } : {}),
    });
    saveScheduledBC(data);
    const started = rjson(STARTED_USERS_FILE, {});
    const targetCount = Array.isArray(started) ? started.length : Object.keys(started).length;
    return ctx.reply(
      eBox(`${'📣'} BROADCAST TERJADWAL`, [
        `Waktu   ┈ <b>${mRecurr ? mRecurr[1] : mOnce[1]}</b>`,
        recurringMs ? `Interval ┈ <b>Setiap ${mRecurr[2]}${mRecurr[3]}</b>` : `Tipe ┈ <b>Sekali kirim</b>`,
        `Target  ┈ <b>${targetCount} user</b>`,
        `Preview ┈ <i>${htmlEscape(message.slice(0, 80))}${message.length > 80 ? '…' : ''}</i>`,
      ]),
      { parse_mode: 'HTML' }
    );
  });

  bot.command('panelstats', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    trackCmd('panelstats');
    const stats = rjson(mkPath(DB_DIR, 'panel_stats.json'), { totalPanels: 0, dailyStats: {}, serverStats: {} });

    const daily30 = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const lbl = d.toLocaleDateString('id-ID');
      daily30.push({ lbl, count: stats.dailyStats?.[lbl] || 0 });
    }
    const max30 = Math.max(...daily30.map(x => x.count), 1);

    const last7 = daily30.slice(-7);
    const chartLines = last7.map(x => {
      const bar = '█'.repeat(Math.round((x.count / max30) * 12)).padEnd(12, '░');
      const day = x.lbl.split('/').slice(0,2).join('/');
      return `${day.padEnd(5)} ${bar} ${x.count}`;
    });

    const chart30 = daily30.map(x => Math.round((x.count / max30) * 8)).map(h => {
      const bars = ['▁','▂','▃','▄','▅','▆','▇','█'];
      return h === 0 ? '▁' : (bars[Math.min(h - 1, 7)] || '█');
    }).join('');

    const thisMonthTotal = daily30.slice(-30).reduce((s, x) => s + x.count, 0);
    const prevMonthTotal = (() => {
      const pm = [];
      for (let i = 59; i >= 30; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const lbl = d.toLocaleDateString('id-ID');
        pm.push(stats.dailyStats?.[lbl] || 0);
      }
      return pm.reduce((s, v) => s + v, 0);
    })();
    const trend = thisMonthTotal >= prevMonthTotal
      ? `📈 +${thisMonthTotal - prevMonthTotal} vs bulan lalu`
      : `📉 -${prevMonthTotal - thisMonthTotal} vs bulan lalu`;

    const planStats = rjson(mkPath(DB_DIR, 'plan_stats.json'), {});
    const planRows = Object.entries(planStats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([plan, count]) => [plan.toUpperCase(), String(count)]);

    const allRoles = db.getAllRoles ? db.getAllRoles() : {};
    const tierCount = {};
    Object.values(allRoles).forEach(u => {
      const def = ROLE_DEFINITIONS[u.role];
      if (def) tierCount[def.tier] = (tierCount[def.tier] || 0) + 1;
    });

    const richHtml = [
      richTitle('📊', '📊 Panel Statistics — Advanced'),
      richTable(['Metrik', 'Nilai'], [
        ['Total Semua Waktu', `<b>${stats.totalPanels || 0}</b>`],
        ['Bulan Ini (30h)',   `<b>${thisMonthTotal}</b>`],
        ['Bulan Lalu',        `<b>${prevMonthTotal}</b>`],
        ['Trend',             trend],
      ]),
      richFold('📈 <b>30-Day Mini Chart</b>', `<pre><code>${chart30}</code></pre><i>(kiri=lama, kanan=hari ini)</i>`),
      richFold('📅 <b>7 Hari Terakhir (Detail)</b>',
        `<pre><code>${chartLines.join('\n')}</code></pre>`
      ),
      richFold('🖥️ <b>Per Server</b>',
        richTable(['Server', 'Panel'], Object.entries(stats.serverStats || {})
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([sv, c]) => [`V${sv}`, String(c)]))
      ),
      ...(planRows.length ? [richFold('📦 <b>Per Plan (Top 8)</b>', richTable(['Plan', 'Count'], planRows))] : []),
      richFold('👥 <b>Distribusi Tier</b>',
        richTable(['Tier', 'User'], Object.entries(tierCount).map(([t, c]) => [TIER_LABELS[t] || t, String(c)]))
      ),
    ].join('\n');

    return renderCard(ctx, richHtml, Markup.inlineKeyboard([]));
  });

  bot.command('userstats', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    trackCmd('userstats');
    const allRoles  = db.getAllRoles ? db.getAllRoles() : {};
    const users     = Object.values(allRoles);
    const blLen     = readBlacklist().length;
    const started   = rjson(STARTED_USERS_FILE, {});
    const startedCount = Object.keys(started).length;

    const thisMonth = new Date().toLocaleDateString('id-ID', { month: '2-digit', year: 'numeric' });
    const newThisMonth = users.filter(u => {
      if (!u.addedAt) return false;
      const m = new Date(u.addedAt).toLocaleDateString('id-ID', { month: '2-digit', year: 'numeric' });
      return m === thisMonth;
    }).length;

    const soonExpire = users.filter(u => {
      if (!u.expiresAt) return false;
      const diff = new Date(u.expiresAt).getTime() - Date.now();
      return diff > 0 && diff < 7 * 86400000;
    });
    const expLines = soonExpire.slice(0, 5).map(u =>
      `• ${htmlEscape(u.username ? `@${u.username}` : u.userId)} — ${relativeTime(u.expiresAt)}`
    );

    const secData = readSecRoles();
    const topSec  = Object.entries(secData)
      .map(([id, roles]) => ({ id, count: roles.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    const caption = eMulti([
      {
        title: `${'👤'} STATISTIK USER`,
        lines: [
          `${'🟢'} Total User Terdaftar ┈ <b>${users.length}</b>`,
          `${'🔔'}  Pernah /start       ┈ <b>${startedCount}</b>`,
          `${'⭐'}  Baru Bulan Ini      ┈ <b>${newThisMonth}</b>`,
          `${'🚫'} Blacklist           ┈ <b>${blLen}</b>`,
        ],
      },
      ...(soonExpire.length ? [{
        title: `${'⚠️'} MENDEKATI EXPIRED (≤7 hari)`,
        lines: expLines.length ? expLines : ['Tidak ada'],
      }] : []),
    ]);
    return ctx.reply(caption, { parse_mode: 'HTML' });
  });

  bot.command('listpanel', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    trackCmd('listpanel');
    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    let targetId = null;
    if (args[0] && /^\d+$/.test(args[0])) targetId = args[0];
    else if (ctx.message?.reply_to_message?.from?.id)
      targetId = String(ctx.message.reply_to_message.from.id);
    if (!targetId) {
      return ctx.reply(
        `${'❌'} Format: <code>/listpanel userId</code>\natau reply ke pesan user.`,
        { parse_mode: 'HTML' }
      );
    }
    const panels = getMyPanels(targetId);
    const entry  = db.getRoleEntry ? db.getRoleEntry(targetId) : null;
    const uname  = entry?.username ? `@${entry.username}` : `User ${targetId}`;
    if (!panels.length) {
      return ctx.reply(
        eBox(`${'🖥️'} PANEL USER — ${uname}`, ['Belum ada panel tercatat untuk user ini.']),
        { parse_mode: 'HTML' }
      );
    }
    const lines = panels.map((p, i) => {
      const ago = relativeTime(p.createdAt);
      return `<b>${i + 1}.</b> <code>${htmlEscape(p.username)}</code> · ${htmlEscape(p.plan)} · V${p.serverIndex}\n   <i>${ago}</i>`;
    });
    const caption = eMulti([{
      title: `${'🖥️'} PANEL MILIK ${uname} (${panels.length})`,
      lines: [''],
    }]) + '\n\n' + lines.join('\n\n');
    return ctx.reply(caption, { parse_mode: 'HTML' });
  });

  bot.command('panelinfo', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    trackCmd('panelinfo');
    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const srvId = parseInt(args[0]);
    if (!srvId) {
      return ctx.reply(
        `${'❌'} Format: <code>/panelinfo <ptero_server_numeric_id></code>`,
        { parse_mode: 'HTML' }
      );
    }
    const servers = getActiveServers();
    if (!servers.length) return ctx.reply(`${'❌'} Tidak ada server aktif.`, { parse_mode: 'HTML' });

    const progMsg = await ctx.reply(`${'⌛'} Mengambil info panel #${srvId}...`, { parse_mode: 'HTML' });
    let found = null;
    let foundServer = null;
    for (const sv of servers) {
      try {
        const res = await pteroRequestFor(sv, `/api/application/servers/${srvId}?include=allocations,variables`);
        if (res?.attributes) { found = res.attributes; foundServer = sv; break; }
      } catch (_) {}
    }
    try { await bot.telegram.deleteMessage(ctx.chat.id, progMsg.message_id); } catch (_) {}
    if (!found) {
      return ctx.reply(`${'❌'} Panel ID <code>${srvId}</code> tidak ditemukan di semua server aktif.`, { parse_mode: 'HTML' });
    }
    const alloc  = found.relationships?.allocations?.data?.[0]?.attributes;
    const limits = found.limits || {};
    const feature = found.feature_limits || {};
    const caption = eMulti([
      {
        title: `${'🖥️'} PANEL INFO — #${srvId}`,
        lines: [
          `Nama       ┈ <b>${htmlEscape(found.name)}</b>`,
          `UUID       ┈ <code>${htmlEscape(found.identifier)}</code>`,
          `Status     ┈ <b>${htmlEscape(found.status || 'unknown')}</b>`,
          `Server     ┈ <b>V${foundServer.index}</b>`,
          `Suspended  ┈ <b>${found.suspended ? '🔴 Ya' : '🟢 Tidak'}</b>`,
        ],
      },
      {
        title: `${'⚙️'} RESOURCES`,
        lines: [
          `RAM   ┈ <b>${limits.memory === 0 ? '∞ Unlimited' : `${limits.memory} MB`}</b>`,
          `Disk  ┈ <b>${limits.disk === 0 ? '∞ Unlimited' : `${limits.disk} MB`}</b>`,
          `CPU   ┈ <b>${limits.cpu === 0 ? '∞ Unlimited' : `${limits.cpu}%`}</b>`,
          `Port  ┈ <b>${alloc ? `${alloc.ip}:${alloc.port}` : '—'}</b>`,
          `DB    ┈ <b>${feature.databases || 0}</b> · Backup: <b>${feature.backups || 0}</b>`,
        ],
      },
    ]);
    return ctx.reply(caption, { parse_mode: 'HTML' });
  });

  const BOT_VERSION = '2.1.0';
  const BOT_BUILD   = new Date().toLocaleDateString('id-ID');
  bot.command('version', async (ctx) => {
    trackCmd('version');
    const uptime  = formatDuration(process.uptime());
    const cmds    = rjson(CMDSTATS_FILE, {});
    const totalCmds = Object.values(cmds).reduce((a, b) => a + b, 0);
    const servers  = getActiveServers();
    const event    = getCurrentEvent();
    const caption  = eBox(`${'⭐'} VERSI BOT`, [
      `Versi     ┈ <b>v${BOT_VERSION}</b>`,
      `Build     ┈ <b>${BOT_BUILD}</b>`,
      `Uptime    ┈ <b>${uptime}</b>`,
      `Server    ┈ <b>${servers.length}/5 aktif</b>`,
      `Total CMD ┈ <b>${totalCmds} kali dipakai</b>`,
      ...(event ? [`Event     ┈ <b>${event.emoji} ${event.name}</b>`] : []),
      '',
      'Features addon v2.1: 43 update aktif',
    ]);
    return ctx.reply(caption, { parse_mode: 'HTML' });
  });

  bot.command('debugmode', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    trackCmd('debugmode');
    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const sub  = (args[0] || '').toLowerCase();
    const curr = isDebugMode();
    if (!['on', 'off'].includes(sub)) {
      return ctx.reply(
        `${'🧠'} <b>Debug Mode</b>\n\nStatus: <b>${curr ? '🔴 ON' : '🟢 OFF'}</b>\n\nGunakan:\n• <code>/debugmode on</code>\n• <code>/debugmode off</code>`,
        { parse_mode: 'HTML' }
      );
    }
    const newVal = sub === 'on';
    wjson(DEBUG_FILE, { on: newVal });
    return ctx.reply(
      `${'✅'} Debug mode <b>${newVal ? '🔴 AKTIF' : '🟢 NONAKTIF'}</b>\n<i>${newVal ? 'Full error stack trace akan dikirim ke owner chat.' : 'Hanya pesan error user-friendly yang tampil.'}</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('cmdstats', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    trackCmd('cmdstats');
    const stats  = rjson(CMDSTATS_FILE, {});
    const sorted = Object.entries(stats).sort((a, b) => b[1] - a[1]).slice(0, 20);
    if (!sorted.length) return ctx.reply(`${'📊'} Belum ada data statistik command.`, { parse_mode: 'HTML' });
    const total  = Object.values(stats).reduce((a, b) => a + b, 0);
    const maxVal = sorted[0]?.[1] || 1;
    const lines  = sorted.map(([cmd, count], i) => {
      const bar = asciiBar(count, maxVal, 10);
      return `${(i + 1).toString().padStart(2)}. /${cmd.padEnd(15)} ${bar} ${count}×`;
    });
    const caption = eBox(`${'📊'} COMMAND STATS (Total: ${total}×)`, lines);
    return ctx.reply(caption, { parse_mode: 'HTML' });
  });

  bot.command('blockcmduser', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const userId = args[0];
    const cmds   = (args[1] || '').split(',').map(c => c.trim().replace(/^\//, '')).filter(Boolean);
    if (!userId || !cmds.length) {
      return ctx.reply(`${'❌'} Format: <code>/blockcmduser userId cmd1,cmd2</code>`, { parse_mode: 'HTML' });
    }
    for (const cmd of cmds) setCmdBlock(userId, cmd, true);
    return ctx.reply(
      `${'🚫'} User <code>${userId}</code> diblokir dari: ${cmds.map(c => `<code>/${c}</code>`).join(', ')}`,
      { parse_mode: 'HTML' }
    );
  });
  bot.command('unblockcmduser', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const userId = args[0];
    const cmds   = (args[1] || '').split(',').map(c => c.trim().replace(/^\//, '')).filter(Boolean);
    if (!userId || !cmds.length) {
      return ctx.reply(`${'❌'} Format: <code>/unblockcmduser userId cmd1,cmd2</code>`, { parse_mode: 'HTML' });
    }
    for (const cmd of cmds) setCmdBlock(userId, cmd, false);
    return ctx.reply(
      `${'✅'} Blokir command <code>${userId}</code> dari ${cmds.map(c => `<code>/${c}</code>`).join(', ')} dicabut.`,
      { parse_mode: 'HTML' }
    );
  });
  bot.command('listcmdblock', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    const d = readCmdBlocks();
    const entries = Object.entries(d).filter(([, cmds]) => cmds.length);
    if (!entries.length) return ctx.reply(`${'✅'} Tidak ada command block aktif.`, { parse_mode: 'HTML' });
    const lines = entries.map(([uid, cmds]) =>
      `<code>${uid}</code> ┈ ${cmds.map(c => `/${c}`).join(', ')}`
    );
    return ctx.reply(
      eBox(`${'🚫'} COMMAND BLOCKS (${entries.length} user)`, lines),
      { parse_mode: 'HTML' }
    );
  });

  bot.command('setwhitelistgroup', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const sub  = args[0]?.toLowerCase();
    const d    = readWhitelistGroups();
    if (sub === 'on') {
      d.enabled = true; saveWhitelistGroups(d);
      return ctx.reply(`${'✅'} Whitelist grup <b>AKTIF</b>. Hanya grup terdaftar bisa pakai command panel.`, { parse_mode: 'HTML' });
    }
    if (sub === 'off') {
      d.enabled = false; saveWhitelistGroups(d);
      return ctx.reply(`${'✅'} Whitelist grup <b>NONAKTIF</b>. Semua grup bisa pakai command panel.`, { parse_mode: 'HTML' });
    }
    if (sub === 'add') {
      const gid = args[1] || String(ctx.chat.id);
      if (!d.groups.includes(gid)) d.groups.push(gid);
      saveWhitelistGroups(d);
      return ctx.reply(`${'✅'} Grup <code>${gid}</code> ditambahkan ke whitelist.`, { parse_mode: 'HTML' });
    }
    if (sub === 'remove') {
      const gid = args[1] || String(ctx.chat.id);
      d.groups  = d.groups.filter(g => g !== gid);
      saveWhitelistGroups(d);
      return ctx.reply(`${'🗑️'} Grup <code>${gid}</code> dihapus dari whitelist.`, { parse_mode: 'HTML' });
    }
    const grupList = d.groups.length
      ? d.groups.map(g => `  • <code>${g}</code>`).join('\n')
      : '  <i>(kosong)</i>';
    const statusMsg = [
      `🛡️ <b>WHITELIST GROUP</b>`,
      ``,
      `Status : ${d.enabled ? '🟢 <b>Aktif</b>' : '🔴 <b>Nonaktif</b>'}`,
      `Grup   : <b>${d.groups.length}</b> terdaftar`,
      ``,
      grupList,
      ``,
      `<code>/setwhitelistgroup on</code>  — aktifkan whitelist`,
      `<code>/setwhitelistgroup off</code> — nonaktifkan whitelist`,
      `<code>/setwhitelistgroup add [groupId]</code>`,
      `<code>/setwhitelistgroup remove [groupId]</code>`,
    ].join('\n');
    return ctx.reply(statusMsg, { parse_mode: 'HTML' });
  });

  bot.command('addrole2', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const args   = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const userId = args[0];
    const role   = args[1];
    const days   = parseInt(args[2]) || null;
    if (!userId || !role) {
      return ctx.reply(`${'❌'} Format: <code>/addrole2 userId role [days]</code>`, { parse_mode: 'HTML' });
    }
    if (!ROLE_DEFINITIONS[role] && !getCustomRoleDef(role)) {
      return ctx.reply(`${'❌'} Role <code>${role}</code> tidak dikenal.`, { parse_mode: 'HTML' });
    }
    addSecondaryRole(userId, role, days);
    return ctx.reply(
      `${'✅'} Secondary role <b>${htmlEscape(role)}</b> ditambahkan ke <code>${userId}</code>${days ? ` (${days} hari)` : ' (permanent)'}.`,
      { parse_mode: 'HTML' }
    );
  });
  bot.command('delrole2', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    const args   = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const userId = args[0];
    const role   = args[1];
    if (!userId || !role) {
      return ctx.reply(`${'❌'} Format: <code>/delrole2 userId role</code>`, { parse_mode: 'HTML' });
    }
    removeSecondaryRole(userId, role);
    return ctx.reply(
      `${'🗑️'} Secondary role <b>${htmlEscape(role)}</b> dihapus dari <code>${userId}</code>.`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('customrole', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    const raw  = (ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim();
    const args = raw.split(/\s+/);
    const sub  = args[0]?.toLowerCase();
    const data = readCustomRoles();
    if (sub === 'list') {
      const entries = Object.entries(data.roles);
      if (!entries.length) return ctx.reply(`${'✅'} Belum ada custom role.`, { parse_mode: 'HTML' });
      const lines = entries.map(([name, def]) =>
        `• <b>${htmlEscape(name)}</b> — Tier: ${def.tier}, Label: ${htmlEscape(def.label)}`
      );
      return ctx.reply(eBox(`${'👑'} CUSTOM ROLES`, lines), { parse_mode: 'HTML' });
    }
    if (sub === 'add') {

      const name  = args[1];
      const tier  = args[2];
      const label = args.slice(3).join(' ');
      if (!name || !tier || !label) {
        return ctx.reply(
          `${'❌'} Format: <code>/customrole add nama_role tier label</code>\nTier: akma|akme|akti`,
          { parse_mode: 'HTML' }
        );
      }
      if (!['akma','akme','akti'].includes(tier)) {
        return ctx.reply(`${'❌'} Tier harus salah satu dari: akma, akme, akti`, { parse_mode: 'HTML' });
      }
      data.roles[name] = { tier, tierLabel: TIER_LABELS[tier] || tier, label, rankOrder: 1, createdAt: new Date().toISOString() };
      saveCustomRoles(data);
      return ctx.reply(
        `${'✅'} Custom role <b>${htmlEscape(name)}</b> dibuat.\nTier: ${tier} · Label: ${htmlEscape(label)}`,
        { parse_mode: 'HTML' }
      );
    }
    if (sub === 'del') {
      const name = args[1];
      if (!name || !data.roles[name]) return ctx.reply(`${'❌'} Custom role tidak ditemukan.`, { parse_mode: 'HTML' });
      delete data.roles[name];
      saveCustomRoles(data);
      return ctx.reply(`${'🗑️'} Custom role <b>${htmlEscape(name)}</b> dihapus.`, { parse_mode: 'HTML' });
    }
    return ctx.reply(
      `${'👑'} <b>Custom Role Manager</b>\n\n` +
      `<code>/customrole list</code> — lihat semua\n` +
      `<code>/customrole add nama tier label</code> — tambah\n` +
      `<code>/customrole del nama</code> — hapus`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('bldur', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    const replyUser = ctx.message?.reply_to_message?.from;
    const userId = replyUser ? String(replyUser.id) : args[0];
    const durArg = replyUser ? args[0] : args[1];
    if (!userId) {
      return ctx.reply(
        `${'❌'} Format:\n<code>/bldur userId 7d</code> — blacklist 7 hari\n<code>/bldur userId 30d</code> — blacklist 30 hari\n<code>/bldur userId permanent</code> — permanent\n<code>/bldur userId remove</code> — unblacklist`,
        { parse_mode: 'HTML' }
      );
    }
    if (isOwner(userId)) return ctx.reply(`${'❌'} Tidak bisa blacklist owner.`, { parse_mode: 'HTML' });
    if (!durArg || durArg === 'remove') {

      const list = readBlacklist();
      const idx  = list.indexOf(userId);
      if (idx !== -1) list.splice(idx, 1);
      saveBlacklist(list);
      blDurRemove(userId);
      return ctx.reply(`${'✅'} User <code>${userId}</code> diunblacklist.`, { parse_mode: 'HTML' });
    }
    const isPermanent = durArg === 'permanent';
    let durationMs = 0;
    if (!isPermanent) {
      const m = durArg.match(/^(\d+)(d|h|m)$/i);
      if (!m) return ctx.reply(`${'❌'} Format durasi: <code>7d</code> (hari), <code>24h</code> (jam), <code>60m</code> (menit)`, { parse_mode: 'HTML' });
      const unit = m[2].toLowerCase();
      const val  = parseInt(m[1]);
      durationMs = unit === 'd' ? val * 86400000 : unit === 'h' ? val * 3600000 : val * 60000;
    }

    const list = readBlacklist();
    if (!list.includes(userId)) { list.push(userId); saveBlacklist(list); }
    blDurAdd(userId, durationMs);
    const durStr = isPermanent ? 'Permanent' : relativeTime(Date.now() + durationMs);
    return ctx.reply(
      eBox(`${'🚫'} BLACKLIST BERDURASI`, [
        `User      ┈ <code>${userId}</code>`,
        `Durasi    ┈ <b>${durStr}</b>`,
        `Otomatis  ┈ <b>${isPermanent ? 'Tidak (permanent)' : 'Ya (auto-unblacklist)'}</b>`,
      ]),
      { parse_mode: 'HTML' }
    );
  });

  bot.command('setwelcome', async (ctx) => {
    if (!isOwner(ctx.from.id))
      return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });

    const raw  = (ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim();
    const m    = raw.match(/^(akma|akme|akti|guest)\s+([\s\S]+)$/i);
    if (!m) {
      const msgs = readWelcomeMessages();
      return ctx.reply(
        eBox(`${'🙂'} WELCOME MESSAGES`, [
          `akma  ┈ ${htmlEscape(msgs.akma || '-')}`,
          `akme  ┈ ${htmlEscape(msgs.akme || '-')}`,
          `akti  ┈ ${htmlEscape(msgs.akti || '-')}`,
          `guest ┈ ${htmlEscape(msgs.guest || '-')}`,
          '',
          'Format: <code>/setwelcome tier pesan</code>',
          'Tier: akma|akme|akti|guest',
        ]),
        { parse_mode: 'HTML' }
      );
    }
    const tier = m[1].toLowerCase();
    const msgs = readWelcomeMessages();
    msgs[tier] = m[2].trim();
    saveWelcomeMessages(msgs);
    return ctx.reply(
      `${'✅'} Welcome message untuk <b>${tier}</b> diupdate.`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action('refresh_server_status', async (ctx) => {
    await safeAnswer(ctx, 'Memperbarui status...');
    try {
      const stats = await getServerStatus();
      const servers = getActiveServers();
      const rows    = servers.map(sv => [
        `V${sv.index} ${cleanDomain(sv.domain).replace(/^https?:\/\//, '').slice(0, 25)}`,
        '🟢 Online',
      ]);
      const richHtml = [
        richTitle(`${'📶'}`, 'Status Semua Server'),
        richTable(
          [`${'🖥️'} Server`, 'Status'],
          rows.length ? rows : [['—', '—']]
        ),
        richTable(
          [`${'⚙️'} VPS Resource`, 'Usage'],
          [
            ['CPU',  `<b>${stats.cpuPercent}%</b>  ${stats.cpuBar}`],
            ['RAM',  `<b>${stats.ramUsedText}/${stats.ramTotalText}</b>  ${stats.ramBar}`],
            ['Disk', `<b>${stats.diskUsedText}/${stats.diskTotalText}</b>  ${stats.diskBar}`],
            ['Ping', `<b>${stats.pingText}</b>`],
          ]
        ),
        richQuote(`Update: ${new Date().toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' })}`),
      ].join('\n');
      await ctx.editMessageText(richHtml, {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [{ text: eF('🔄 Refresh'), callback_data: 'refresh_server_status', style: 'primary' },
           { text: eF('Back To Menu'), callback_data: 'menu', style: 'danger' }],
        ]).reply_markup,
      });
    } catch (e) {
      await ctx.answerCbQuery('Gagal refresh: ' + e.message, { show_alert: true });
    }
  });

  bot._features = {
    getTierBadge,
    relativeTime,
    validateConfig,
    addMyPanel,
    getMyPanels,
    trackPanelHour,
    addRoleLog,
    isGroupWhitelisted,
    readWelcomeMessages,
    getTierWelcome,
    getCurrentEvent,
    addWatermark,
    blDurIsExpired,
    blDurGetInfo,
    blDurAdd,
    blDurRemove,
    trackCmd,
    sendDebugError,
    getUserSecondaryRoles,
    getCustomRoleDef,
  };

};
