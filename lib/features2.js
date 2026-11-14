'use strict';

const { fbRead, fbWrite } = require('./firebase');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const { execFileSync } = require('child_process');
const { getUserLang, setUserLang, t, randomTip } = require('./lang');

function rj(fp, def) {
  const d = typeof def === 'function' ? def() : def;
  return fbRead(fp, d);
}
function wj(fp, d) {
  fbWrite(fp, d);
}
function mkPath(dir, name) { return path.join(dir, name); }

const floodMap     = new Map();
const floodWarned  = new Set();
const otpStore     = new Map();
const pendingFeedbackReply = new Map();

const DEFAULT_HARGA = {
  reseller:   6000,
  premium:    8000,
  adminpanel: 11000,
  security:   15000,
  staff:      19000,
  svip:       25000,
  manager:    29000,
  direktur:   35000,
  komisaris:  39000,
  eksekutif:  45000,
  pimpinan:   50000,
};

module.exports = function registerFeatures3(bot, deps) {
  const {
    db, config, E, ROLE_DEFINITIONS, TIER_LABELS, PANEL_PLANS,
    TIER_ALLOWED_SERVERS, Markup, isOwner, isPrimaryOwner,
    htmlEscape, eBox, eMulti, renderCard, sendDirectCard,
    richTitle, richTable, richFold, richPara, richQuote, richEscape, makeView,
    getActiveServers, getServerStatus, pteroRequestFor,
    STARTED_USERS_FILE, DB_DIR,
    progressBar, formatDuration, BROADCAST_USERS,
    backToMenuKeyboard, getUserTier, getUserRoleDisplay, hasAccessForPanel,
    readBlacklist, saveBlacklist, cleanDomain, getMaintenanceStatus,
    safeAnswer, eF, pe, formatDateId,
  } = deps;

  const RULES_FILE        = mkPath(DB_DIR, 'rules.json');
  const CONTACT_FILE      = mkPath(DB_DIR, 'contact.json');
  const NOTICE_FILE       = mkPath(DB_DIR, 'notice.json');
  const FEEDBACK_FILE     = mkPath(DB_DIR, 'feedback.json');
  const RATINGS_FILE      = mkPath(DB_DIR, 'ratings.json');
  const POLLS_FILE        = mkPath(DB_DIR, 'polls.json');
  const HARGA_FILE        = mkPath(DB_DIR, 'harga.json');
  const INVOICES_FILE     = mkPath(DB_DIR, 'invoices.json');
  const BANWORDS_FILE     = mkPath(DB_DIR, 'banwords.json');
  const AUDIT_FILE        = mkPath(DB_DIR, 'audit_log.json');
  const FAILED_FILE       = mkPath(DB_DIR, 'failed_attempts.json');
  const DAILY_CFG_FILE    = mkPath(DB_DIR, 'daily_report_config.json');
  const SURL_FILE         = mkPath(DB_DIR, 'shorturl_clicks.json');
  const INTEGRITY_FILE    = mkPath(DB_DIR, 'integrity_log.json');
  const TIPS_PREFS_FILE   = mkPath(DB_DIR, 'tips_prefs.json');
  const CELEBRATION_FILE  = mkPath(DB_DIR, 'celebration_media.json');
  const FLOOD_WARN_FILE   = mkPath(DB_DIR, 'flood_warn.json');
  const AUDIO_PREFS_FILE  = mkPath(DB_DIR, 'audio_prefs.json');
  const MYPANELS_FILE     = mkPath(DB_DIR, 'mypanels.json');
  const PEAK_HOURS_FILE   = mkPath(DB_DIR, 'peak_hours.json');
  const CMD_STATS_FILE    = mkPath(DB_DIR, 'cmd_stats.json');

  function ownerIds() {
    const raw = config.ownerIds ?? config.ownerId;
    return Array.isArray(raw) ? raw.map(String) : [String(raw || '')];
  }
  function formatIdr(n) {
    return `Rp${Number(n || 0).toLocaleString('id-ID')}`;
  }
  function nowId() {
    return new Date().toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' });
  }
  function trackCmd(cmd) {
    const d = rj(CMD_STATS_FILE, {});
    d[cmd] = (d[cmd] || 0) + 1;
    wj(CMD_STATS_FILE, d);
  }
  function writeAudit(action, actor, target, detail = {}) {
    const log = rj(AUDIT_FILE, []);
    log.unshift({ action, actor, target, detail, at: new Date().toISOString() });
    if (log.length > 500) log.splice(500);
    wj(AUDIT_FILE, log);
  }
  function getHarga() {
    return rj(HARGA_FILE, DEFAULT_HARGA);
  }
  function isTipsEnabled(userId) {
    const d = rj(TIPS_PREFS_FILE, {});
    return d[String(userId)] !== false;
  }
  function getStartedUsers() {
    const raw = rj(STARTED_USERS_FILE, []);
    return Array.isArray(raw) ? raw : Object.keys(raw);
  }
  function checkBanword(username) {
    const words = rj(BANWORDS_FILE, []);
    const lower = String(username || '').toLowerCase();
    return words.find(w => lower.includes(w.toLowerCase())) || null;
  }
  function formatDur(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  const FLOOD_LIMIT = 5;
  const FLOOD_WINDOW = 10000;
  const FLOOD_MUTE   = 5 * 60 * 1000;
  const floodMuted   = new Map();

  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const uid = String(ctx.from.id);

    if (isOwner(ctx.from.id)) return next();

    const muteUntil = floodMuted.get(uid);
    if (muteUntil && Date.now() < muteUntil) {
      try { await ctx.deleteMessage(); } catch (_) {}
      return;
    }
    if (muteUntil) floodMuted.delete(uid);

    if (ctx.message?.text?.startsWith('/') || ctx.callbackQuery) {
      const now   = Date.now();
      const times = (floodMap.get(uid) || []).filter(ts => now - ts < FLOOD_WINDOW);
      times.push(now);
      floodMap.set(uid, times);

      if (times.length > FLOOD_LIMIT) {
        floodMuted.set(uid, now + FLOOD_MUTE);
        floodMap.delete(uid);

        try {
          await bot.telegram.sendMessage(
            String(config.ownerChannelId || ownerIds()[0]),
            `${'⁉️'} <b>Anti-Flood Alert</b>\n` +
            `User: <code>${uid}</code> (${htmlEscape(ctx.from.first_name || 'User')})\n` +
            `Action: Muted 5 minutes for flooding\n` +
            `Time: ${nowId()}`,
            { parse_mode: 'HTML' }
          );
        } catch (_) {}

        const fw = rj(FLOOD_WARN_FILE, {});
        fw[uid] = (fw[uid] || 0) + 1;
        wj(FLOOD_WARN_FILE, fw);
        if (fw[uid] >= 3) {
          try {
            await bot.telegram.sendMessage(
              String(ownerIds()[0]),
              `${'⁉️'} <b>Repeated Flood Violation</b>\n` +
              `User <code>${uid}</code> has flooded ${fw[uid]} times.\n` +
              `Consider blacklisting with /blacklist ${uid}`,
              { parse_mode: 'HTML' }
            );
          } catch (_) {}
        }

        try {
          await ctx.reply(t(uid, 'floodWarning'), { parse_mode: 'HTML' });
        } catch (_) {}
        return;
      }
    }

    return next();
  });

  function logFailedAttempt(userId, cmd, reason) {
    const db = rj(FAILED_FILE, {});
    const uid = String(userId);
    if (!db[uid]) db[uid] = [];
    db[uid].unshift({ cmd, reason, at: new Date().toISOString() });
    if (db[uid].length > 50) db[uid] = db[uid].slice(0, 50);
    wj(FAILED_FILE, db);

    const oneHourAgo = Date.now() - 3600000;
    const recent = db[uid].filter(a => new Date(a.at).getTime() > oneHourAgo);
    if (recent.length >= 5) {
      try {
        bot.telegram.sendMessage(
          String(config.ownerChannelId || ownerIds()[0]),
          `${'⚠️'} <b>Suspicious Failed Attempts</b>\n` +
          `User <code>${uid}</code> made ${recent.length} unauthorized command attempts in 1 hour.\n` +
          `Last: <code>${cmd}</code>`,
          { parse_mode: 'HTML' }
        );
      } catch (_) {}
    }
  }

  const OTP_EXPIRY   = 5 * 60 * 1000;
  const OTP_MAX_TRY  = 3;
  const otpTries     = new Map();

  function generateOtp(userId, cmdContext) {
    const code = crypto.randomInt(100000, 999999).toString();
    otpStore.set(String(userId), {
      code, cmdContext,
      expiresAt: Date.now() + OTP_EXPIRY,
      tries: 0,
    });
    return code;
  }
  function validateOtp(userId, inputCode) {
    const uid  = String(userId);
    const otp  = otpStore.get(uid);
    if (!otp) return { ok: false, reason: 'expired' };
    if (Date.now() > otp.expiresAt) {
      otpStore.delete(uid);
      return { ok: false, reason: 'expired' };
    }
    otp.tries++;
    if (otp.tries > OTP_MAX_TRY) {
      otpStore.delete(uid);
      return { ok: false, reason: 'too_many' };
    }
    if (otp.code !== String(inputCode).trim()) {
      return { ok: false, reason: 'wrong' };
    }
    const ctx = otp.cmdContext;
    otpStore.delete(uid);
    return { ok: true, cmdContext: ctx };
  }

  const OTP_REQUIRED = ['delrole', 'delsrvall', 'broadcast', 'blacklist'];

  bot.use(async (ctx, next) => {
    const text = ctx.message?.text?.trim() || '';
    if (!text.startsWith('/')) return next();
    const cmdRaw = text.split(/\s/)[0].replace('/', '').replace(`@${ctx.botInfo?.username || ''}`, '');

    if (!OTP_REQUIRED.includes(cmdRaw)) return next();
    if (!isOwner(ctx.from?.id)) return next();

    const uid  = String(ctx.from.id);
    const args = text.split(/\s+/).slice(1);
    const lastArg = args[args.length - 1];

    if (/^\d{6}$/.test(lastArg)) {
      const result = validateOtp(uid, lastArg);
      if (result.ok) {

        const newArgs = args.slice(0, -1);
        if (ctx.message) {
          ctx.message.text = `/${cmdRaw}${newArgs.length ? ' ' + newArgs.join(' ') : ''}`;
        }
        return next();
      }
      const reason = result.reason === 'expired' ? t(uid, 'otpExpired') : t(uid, 'otpInvalid');
      return ctx.reply(reason, { parse_mode: 'HTML' });
    }

    const code = generateOtp(uid, text);
    try {
      await bot.telegram.sendMessage(uid,
        `${'🛡️'} <b>OTP Verification Required</b>\n\n` +
        `Command: <code>/${cmdRaw}</code>\n` +
        `OTP Code: <code>${code}</code>\n` +
        `Expires: 5 minutes\n\n` +
        `Re-run: <code>${text} ${code}</code>`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {}
    return ctx.reply(t(uid, 'otpSent'), { parse_mode: 'HTML' });
  });

  bot.use(async (ctx, next) => {
    if (ctx.from && (ctx.message?.text?.startsWith('/') || ctx.callbackQuery)) {
      const uid  = String(ctx.from.id);
      const cmd  = ctx.message?.text?.split(/\s/)[0]?.replace('/','') ||
                   ctx.callbackQuery?.data?.split('_')[0] || 'callback';
      db.trackActivity(uid, ctx.from.first_name, ctx.from.username, cmd);
      db.addHistory(uid, cmd, true);
    }
    return next();
  });

  bot.command('lockuser', async (ctx) => {
    if (!isOwner(ctx.from.id)) {
      logFailedAttempt(ctx.from.id, 'lockuser', 'no permission');
      return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    }
    trackCmd('lockuser');
    const args = (ctx.message.text || '').split(/\s+/).slice(1);
    const targetId = ctx.message.reply_to_message?.from?.id
                  || (args[0] && /^\d+$/.test(args[0]) ? args[0] : null);
    if (!targetId) {
      return ctx.reply(
        eBox('🔒 LOCK USER', ['/lockuser <userId> [reason]', 'Atau reply ke pesan user']),
        { parse_mode: 'HTML' }
      );
    }
    const reason = args.slice(targetId === ctx.message.reply_to_message?.from?.id?.toString() ? 0 : 1).join(' ') || 'No reason';
    if (db.isUserLocked(targetId)) {
      return ctx.reply(t(ctx.from.id, 'alreadyLocked'), { parse_mode: 'HTML' });
    }
    db.lockUser(targetId, ctx.from.id, reason);
    writeAudit('lock_user', String(ctx.from.id), String(targetId), { reason });
    await ctx.reply(
      eBox(`🔒 USER LOCKED`, [
        `User ID: <code>${targetId}</code>`,
        `Reason: ${htmlEscape(reason)}`,
        `By: <code>${ctx.from.id}</code>`,
        `Time: ${nowId()}`,
      ]),
      { parse_mode: 'HTML' }
    );
  });

  bot.command('unlockuser', async (ctx) => {
    if (!isOwner(ctx.from.id)) {
      logFailedAttempt(ctx.from.id, 'unlockuser', 'no permission');
      return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    }
    trackCmd('unlockuser');
    const args = (ctx.message.text || '').split(/\s+/).slice(1);
    const targetId = ctx.message.reply_to_message?.from?.id || args[0];
    if (!targetId) return ctx.reply(eBox('🔓 UNLOCK USER', ['/unlockuser <userId>']), { parse_mode: 'HTML' });
    const ok = db.unlockUser(targetId);
    if (!ok) return ctx.reply(t(ctx.from.id, 'notLocked'), { parse_mode: 'HTML' });
    writeAudit('unlock_user', String(ctx.from.id), String(targetId));
    await ctx.reply(eBox('🔓 USER UNLOCKED', [`User <code>${targetId}</code> berhasil dibuka kuncinya.`]), { parse_mode: 'HTML' });
  });

  bot.command('topuser', async (ctx) => {
    if (!isOwner(ctx.from.id)) {
      logFailedAttempt(ctx.from.id, 'topuser', 'no permission');
      return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    }
    trackCmd('topuser');
    const panels = rj(MYPANELS_FILE, { panels: {} });
    const roles  = db.getAllRoles();
    const counts = {};
    Object.entries(panels.panels || {}).forEach(([uid, list]) => {
      counts[uid] = Array.isArray(list) ? list.length : 0;
    });
    const sorted = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const total = Object.values(counts).reduce((s, v) => s + v, 0);

    const medals = ['🥇','🥈','🥉'];
    const rows = sorted.map(([uid, cnt], i) => {
      const rEntry = roles[uid];
      const tier   = rEntry ? (ROLE_DEFINITIONS[rEntry.role]?.tier || '-') : '-';
      const pct    = total > 0 ? ((cnt / total) * 100).toFixed(1) : '0';
      return [(medals[i] || `${i + 1}.`), `<code>${uid}</code>`, String(cnt), `${pct}%`, tier];
    });

    const richHtml = [
      richTitle('🔝', '🏆 Top Panel Creators'),
      richTable(['#', 'User ID', 'Panels', '%', 'Tier'], rows),
    ].join('\n');

    return renderCard(ctx, richHtml, backToMenuKeyboard());
  });

  bot.command('inactiveuser', async (ctx) => {
    if (!isOwner(ctx.from.id)) {
      logFailedAttempt(ctx.from.id, 'inactiveuser', 'no permission');
      return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    }
    trackCmd('inactiveuser');
    const args = (ctx.message.text || '').split(/\s+/).slice(1);
    const days = parseInt(args[0] || '30');
    if (isNaN(days) || days < 1) {
      return ctx.reply(eBox('⏰ INACTIVE USER', ['/inactiveuser <hari>', 'Contoh: /inactiveuser 30']), { parse_mode: 'HTML' });
    }
    const inactive = db.getInactiveUsers(days);
    if (!inactive.length) {
      return ctx.reply(
        eBox(`⏰ INACTIVE USER (${days} hari)`, ['Tidak ada user yang tidak aktif selama periode tersebut.']),
        { parse_mode: 'HTML' }
      );
    }
    const rows = inactive.slice(0, 25).map(u => [
      `<code>${u.userId}</code>`,
      htmlEscape(u.firstName || '-'),
      u.username ? `@${htmlEscape(u.username)}` : '-',
      u.lastAt ? formatDateId(u.lastAt) : 'Never',
    ]);
    const richHtml = [
      richTitle('⌛', `⏰ Inactive Users (${days}+ Days)`),
      richPara(`Total: <b>${inactive.length}</b> inactive users`),
      richTable(['User ID', 'Name', 'Username', 'Last Active'], rows),
    ].join('\n');
    return renderCard(ctx, richHtml, backToMenuKeyboard());
  });

  bot.command('pingall', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    trackCmd('pingall');
    const servers = getActiveServers();
    if (!servers.length) return ctx.reply('❌ Tidak ada server aktif.', { parse_mode: 'HTML' });
    const msg = await ctx.reply('⏳ Pinging all servers...', { parse_mode: 'HTML' });
    const results = [];
    for (const sv of servers) {
      const start = Date.now();
      let ok = false, ms = 0, status = '';
      try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 8000);
        const res  = await fetch(`${cleanDomain(sv.domain)}/api/application/users?per_page=1`, {
          headers: { Authorization: `Bearer ${sv.plta}`, Accept: 'Application/vnd.pterodactyl.v1+json' },
          signal: ctrl.signal,
        });
        clearTimeout(tid);
        ms = Date.now() - start;
        ok = res.ok || res.status === 403;
        status = `HTTP ${res.status}`;
      } catch (e) {
        ms = Date.now() - start;
        status = e.name === 'AbortError' ? 'Timeout' : 'Offline';
      }
      results.push({ idx: sv.idx || sv.index, domain: sv.domain, ok, ms, status });
    }
    const rows = results.map(r => [
      `V${r.idx}`,
      r.ok ? '🟢 Online' : '🔴 Offline',
      `${r.ms}ms`,
      r.status,
    ]);
    const richHtml = [
      richTitle('📶', '📡 Multi-Server Ping'),
      richTable(['Server', 'Status', 'Response', 'HTTP'], rows),
    ].join('\n');
    try { await bot.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (_) {}
    return renderCard(ctx, richHtml, Markup.inlineKeyboard([]));
  });

  bot.command('restartbot', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    trackCmd('restartbot');
    writeAudit('restart_bot', String(ctx.from.id), 'system');
    await ctx.reply(
      eBox('♻️ BOT RESTART', [
        `${'✅'} Initiated by: <code>${ctx.from.id}</code>`,
        `${'⌛'} Restarting in 3 seconds...`,
        `${'ℹ️' || '💡'} Bot will be back shortly.`,
      ]),
      { parse_mode: 'HTML' }
    );
    setTimeout(() => process.exit(0), 3000);
  });

  bot.command('vpsinfo', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    trackCmd('vpsinfo');
    const ramTotal   = os.totalmem();
    const ramUsed    = ramTotal - os.freemem();
    const ramPct     = Math.round((ramUsed / ramTotal) * 100);
    const uptimeSecs = os.uptime();
    const cpus       = os.cpus();
    const cpuModel   = cpus?.[0]?.model?.replace(/\s+/g, ' ').trim() || 'Unknown';
    const cpuCount   = cpus?.length || 1;

    let cpuPct = 0;
    try {
      const load = os.loadavg()[0];
      cpuPct = Math.min(100, Math.round((load / cpuCount) * 100));
    } catch (_) {}

    let diskUsed = 0, diskTotal = 0, diskPct = 0;
    try {
      const df = execFileSync('df', ['-k', '/'], { encoding: 'utf8' }).trim().split('\n');
      const row = df[1]?.trim().split(/\s+/) || [];
      diskTotal  = Number(row[1] || 0);
      diskUsed   = Number(row[2] || 0);
      diskPct    = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;
    } catch (_) {}

    const toGb = kb => (kb / 1024 / 1024).toFixed(1) + 'GB';
    const toMb = b  => (b / 1024 / 1024).toFixed(0) + 'MB';
    const fmtUptime = s => {
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      return `${d}d ${h}h ${m}m`;
    };

    const richHtml = [
      richTitle('🖥️', '🖥️ VPS Resource Information'),
      richTable(['Metric', 'Value'], [
        ['Hostname', os.hostname()],
        ['OS',       os.type() + ' ' + os.release()],
        ['CPU Model', cpuModel.length > 30 ? cpuModel.slice(0, 30) + '…' : cpuModel],
        ['CPU Cores', String(cpuCount)],
        ['CPU Usage', `${cpuPct}% ${progressBar(cpuPct)}`],
        ['RAM Total', toMb(ramTotal)],
        ['RAM Used',  `${toMb(ramUsed)} (${ramPct}%)`],
        ['RAM Free',  toMb(os.freemem())],
        ['RAM Bar',   progressBar(ramPct)],
        ['Disk Total', toGb(diskTotal)],
        ['Disk Used',  `${toGb(diskUsed)} (${diskPct}%)`],
        ['Disk Free',  toGb(diskTotal - diskUsed)],
        ['Disk Bar',  progressBar(diskPct)],
        ['Uptime',    fmtUptime(uptimeSecs)],
      ]),
    ].join('\n');

    return renderCard(ctx, richHtml, Markup.inlineKeyboard([]), { thumb: true });
  });

  bot.command('harga', async (ctx) => {
    trackCmd('harga');
    const harga = getHarga();
    const uid   = ctx.from.id;

    const tierGroups = [
      { label: '🟡 I. AKSES PERTAMA (Akma)', roles: ['reseller','premium','adminpanel','security','staff'] },
      { label: '🔵 II. AKSES MENENGAH (Akme)', roles: ['svip','manager','direktur','komisaris'] },
      { label: '🔴 III. AKSES TINGGI (Akti)', roles: ['eksekutif','pimpinan'] },
    ];

    let richHtml = richTitle('💰', t(uid, 'hargaTitle'));
    for (const g of tierGroups) {
      const baseOffset = g.roles === tierGroups[0].roles ? 0 : g.roles === tierGroups[1].roles ? 5 : 9;
      const rows = g.roles.map((r, i) => [
        String(i + 1 + baseOffset),
        ROLE_DEFINITIONS[r]?.label || r,
        formatIdr(harga[r] || 0),
      ]);
      richHtml += '\n' + richPara(`<b>${g.label}</b>`) + '\n' + richTable(['#', 'Role', 'Harga'], rows);
    }

    if (isOwner(uid)) {
      richHtml += '\n' + richPara('💡 <i>Owner: /setharga <role> <harga> untuk ubah harga</i>');
    }

    return renderCard(ctx, richHtml, Markup.inlineKeyboard([]), { thumb: true });
  });

  bot.command('setharga', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    const args = (ctx.message.text || '').split(/\s+/).slice(1);
    if (args.length < 2) {
      return ctx.reply(eBox('💰 SET HARGA', ['/setharga <role> <harga>', 'Contoh: /setharga reseller 7000']), { parse_mode: 'HTML' });
    }
    const role  = db.normalizeRoleName(args[0]);
    const harga = parseInt(args[1].replace(/\D/g, ''));
    if (!role) return ctx.reply('❌ Role tidak valid.', { parse_mode: 'HTML' });
    if (isNaN(harga) || harga < 0) return ctx.reply('❌ Harga tidak valid.', { parse_mode: 'HTML' });
    const h = getHarga();
    h[role] = harga;
    wj(HARGA_FILE, h);
    writeAudit('set_harga', String(ctx.from.id), role, { harga });
    await ctx.reply(
      eBox('💰 HARGA DIPERBARUI', [`Role: ${ROLE_DEFINITIONS[role]?.label}`, `Harga: ${formatIdr(harga)}`]),
      { parse_mode: 'HTML' }
    );
  });

  // ─────────────────────────────────────────────────────────
  // /hargaup — Daftar Harga Upgrade Panel (selisih harga role)
  // Harga diambil langsung dari getHarga() (sumber yang sama dengan /harga).
  // Rumus: Harga Upgrade = Harga Role Tujuan − Harga Role Asal
  // ─────────────────────────────────────────────────────────
  bot.command('hargaup', async (ctx) => {
    trackCmd('hargaup');
    const harga = getHarga();

    // Urutan role berdasarkan rankOrder dari ROLE_DEFINITIONS
    const sortedRoles = Object.entries(ROLE_DEFINITIONS)
      .sort((a, b) => a[1].rankOrder - b[1].rankOrder);

    const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

    // Validasi: semua role harus punya harga di data /harga
    const missingPrices = sortedRoles
      .filter(([k]) => harga[k] == null)
      .map(([k, def]) => def.label);

    let richHtml = richTitle('💱', '💱 Daftar Harga Upgrade Panel');
    richHtml += '\n' + richPara(
      '<i>Harga upgrade = Harga role tujuan − Harga role asal.</i>',
      '<i>Upgrade hanya berlaku dari role lebih rendah ke lebih tinggi.</i>'
    );

    if (missingPrices.length) {
      richHtml += '\n' + richPara(
        `<b>⚠️ Harga belum diset:</b> ${missingPrices.join(', ')}`,
        '<i>Gunakan /setharga &lt;role&gt; &lt;harga&gt; untuk mengatur harga.</i>'
      );
    }

    // Buat satu section per role sumber (kecuali role tertinggi)
    for (let si = 0; si < sortedRoles.length - 1; si++) {
      const [srcKey, srcDef] = sortedRoles[si];
      const srcPrice = harga[srcKey];

      // Skip jika harga role sumber belum diset
      if (srcPrice == null) continue;

      const upgradeRows = [];
      for (let ti = si + 1; ti < sortedRoles.length; ti++) {
        const [tgtKey, tgtDef] = sortedRoles[ti];
        const tgtPrice = harga[tgtKey];

        // Skip jika harga role tujuan belum diset
        if (tgtPrice == null) continue;

        const diff = tgtPrice - srcPrice;
        // Hanya tampilkan jika selisih positif (tidak mungkin downgrade)
        if (diff <= 0) continue;

        const srcLabel = srcDef.label.replace(/ Panel$/, '');
        const tgtLabel = tgtDef.label.replace(/ Panel$/, '');
        upgradeRows.push([
          `${srcLabel} → ${tgtLabel}`,
          formatIdr(diff),
        ]);
      }

      if (!upgradeRows.length) continue;

      const sectionTitle =
        `${ROMAN[si] || String(si + 1)}. <b>${srcDef.label}</b> — ${formatIdr(srcPrice)}`;
      richHtml += '\n' + richFold(sectionTitle, richTable(['Upgrade', 'Harga'], upgradeRows));
    }

    // Footer info
    richHtml += '\n' + richPara(
      '<b>RESPANEL JAYS & HANZ</b>',
      '<i>Profesional • Terpercaya • Berkualitas</i>'
    );

    if (isOwner(ctx.from.id)) {
      richHtml += '\n' + richPara(
        '<i>💡 Owner: /setharga &lt;role&gt; &lt;harga&gt; untuk ubah harga role.</i>'
      );
    }

    return renderCard(ctx, richHtml, Markup.inlineKeyboard([]), { thumb: true });
  });

  function getRules() { return rj(RULES_FILE, { text: null, version: 0 }); }

  bot.command('rules', async (ctx) => {
    trackCmd('rules');
    const uid   = ctx.from.id;
    const rules = getRules();
    if (!rules.text) {
      return ctx.reply(t(uid, 'rulesNone'), { parse_mode: 'HTML' });
    }
    const accepted = db.hasAcceptedRules(uid);
    const kbd = accepted
      ? Markup.inlineKeyboard([[{ text: eF('✅ Already Accepted'), callback_data: 'rules_already', style: 'success' }]])
      : Markup.inlineKeyboard([
          [{ text: eF(t(uid, 'rulesAgree')), callback_data: 'rules_accept', style: 'success' }],
          [{ text: eF(t(uid, 'rulesDecline')), callback_data: 'rules_decline', style: 'danger' }],
        ]);

    const richHtml = [
      richTitle('📜', t(uid, 'rulesTitle')),
      richPara(htmlEscape(rules.text)),
      ...(accepted ? [richPara(`<i>✅ You have already accepted (v${rules.version || 1})</i>`)] : []),
    ].join('\n');

    return renderCard(ctx, richHtml, kbd);
  });

  bot.command('setrules', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    const text = (ctx.message.text || '').replace(/^\/setrules\s*/, '').trim();
    if (!text) return ctx.reply(eBox('📜 SET RULES', ['/setrules <teks aturan>']), { parse_mode: 'HTML' });
    const cur = getRules();
    wj(RULES_FILE, { text, version: (cur.version || 0) + 1, updatedAt: new Date().toISOString() });
    writeAudit('set_rules', String(ctx.from.id), 'system', { len: text.length });
    return ctx.reply(t(ctx.from.id, 'rulesSetOk'), { parse_mode: 'HTML' });
  });

  bot.action('rules_accept', async (ctx) => {
    await safeAnswer(ctx);
    db.setRulesConsent(ctx.from.id, true);
    return ctx.editMessageText(t(ctx.from.id, 'rulesAccepted'), { parse_mode: 'HTML' }).catch(() =>
      ctx.reply(t(ctx.from.id, 'rulesAccepted'), { parse_mode: 'HTML' })
    );
  });
  bot.action('rules_decline', async (ctx) => {
    await safeAnswer(ctx);
    db.setRulesConsent(ctx.from.id, false);
    return ctx.editMessageText(t(ctx.from.id, 'rulesDeclined'), { parse_mode: 'HTML' }).catch(() =>
      ctx.reply(t(ctx.from.id, 'rulesDeclined'), { parse_mode: 'HTML' })
    );
  });
  bot.action('rules_already', async (ctx) => { await safeAnswer(ctx, 'Already accepted!'); });

  function getContact() {
    return rj(CONTACT_FILE, {
      text: `Owner: ${config.ownerUsername || '@itshanzpiw'}\nChannel: ${config.ownerChannel || '@abouthanzpiww'}`,
    });
  }

  bot.command('contact', async (ctx) => {
    trackCmd('contact');
    const uid = ctx.from.id;
    const c   = getContact();
    const richHtml = [
      richTitle('📞', t(uid, 'contactTitle')),
      richPara(htmlEscape(c.text || t(uid, 'contactNone'))),
    ].join('\n');
    return renderCard(ctx, richHtml, Markup.inlineKeyboard([
      [{ text: eF(`💬 DM Owner`), url: `https://t.me/${(config.ownerUsername || '@itshanzpiw').replace('@','')}` }],
      [{ text: eF('Back To Menu'), callback_data: 'menu', style: 'danger'}],
    ]));
  });

  bot.command('setcontact', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    const text = (ctx.message.text || '').replace(/^\/setcontact\s*/, '').trim();
    if (!text) return ctx.reply(eBox('📞 SET CONTACT', ['/setcontact <info kontak>']), { parse_mode: 'HTML' });
    wj(CONTACT_FILE, { text, updatedAt: new Date().toISOString() });
    return ctx.reply(t(ctx.from.id, 'contactSetOk'), { parse_mode: 'HTML' });
  });

  bot.command('feedback', async (ctx) => {
    trackCmd('feedback');
    const uid  = ctx.from.id;
    const text = (ctx.message.text || '').replace(/^\/feedback\s*/, '').trim();
    if (!text) return ctx.reply(t(uid, 'feedbackFormat'), { parse_mode: 'HTML' });

    const fbs = rj(FEEDBACK_FILE, []);
    const id  = `FB${Date.now().toString(36).toUpperCase()}`;
    fbs.unshift({
      id, userId: String(uid),
      username: ctx.from.username || null,
      name:     ctx.from.first_name || 'User',
      text, at: new Date().toISOString(), replied: false,
    });
    if (fbs.length > 200) fbs.splice(200);
    wj(FEEDBACK_FILE, fbs);

    const ownerMsg = [
      `${'✉️'} <b>Feedback Baru (${id})</b>`,
      `From: ${ctx.from.first_name || 'User'} ${ctx.from.username ? '@' + ctx.from.username : ''} (<code>${uid}</code>)`,
      `Time: ${nowId()}`,
      '',
      `<blockquote>${htmlEscape(text)}</blockquote>`,
      '',
      `<i>Reply dengan: /replyfeedback ${id} <pesan balasan></i>`,
    ].join('\n');

    try {
      await bot.telegram.sendMessage(String(config.ownerChannelId || ownerIds()[0]), ownerMsg, { parse_mode: 'HTML' });
    } catch (_) {}

    return ctx.reply(`${'✅'} ${t(uid, 'feedbackSent')}\n<i>Feedback ID: <code>${id}</code></i>`, { parse_mode: 'HTML' });
  });

  bot.command('replyfeedback', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    const args  = (ctx.message.text || '').split(/\s+/).slice(1);
    const fbId  = args[0];
    const reply = args.slice(1).join(' ').trim();
    if (!fbId || !reply) {
      return ctx.reply(eBox('↩️ REPLY FEEDBACK', ['/replyfeedback <ID> <pesan>']), { parse_mode: 'HTML' });
    }
    const fbs = rj(FEEDBACK_FILE, []);
    const fb  = fbs.find(f => f.id === fbId);
    if (!fb) return ctx.reply(`❌ Feedback ID <code>${fbId}</code> tidak ditemukan.`, { parse_mode: 'HTML' });

    try {
      await bot.telegram.sendMessage(
        String(fb.userId),
        `${'✉️'} <b>Balasan dari Owner (${fbId})</b>\n\n<blockquote>${htmlEscape(reply)}</blockquote>`,
        { parse_mode: 'HTML' }
      );
      fb.replied = true; fb.replyAt = new Date().toISOString();
      wj(FEEDBACK_FILE, fbs);
      return ctx.reply(`${'✅'} Balasan terkirim ke user <code>${fb.userId}</code>.`, { parse_mode: 'HTML' });
    } catch (e) {
      return ctx.reply(`❌ Gagal kirim balasan: ${e.message}`, { parse_mode: 'HTML' });
    }
  });

  async function sendPanelRating(userId, panelUsername, serverIndex) {
    const uid = String(userId);
    const ratings = rj(RATINGS_FILE, {});

    if (ratings[`${uid}_${panelUsername}`]) return;

    const kbd = Markup.inlineKeyboard([
      [1,2,3,4,5].map(n => ({
        text: ['1⭐','2⭐','3⭐','4⭐','5⭐'][n-1],
        callback_data: `rate_panel_${uid}_${panelUsername}_${n}`,
        style: 'primary',
      }))
    ]);
    try {
      await bot.telegram.sendMessage(uid,
        `${'⭐'} <b>Rate Your Panel!</b>\n` +
        `Panel: <code>${htmlEscape(panelUsername)}</code> on Server V${serverIndex}\n\n` +
        `${t(uid, 'panelRating')}`,
        { parse_mode: 'HTML', reply_markup: kbd.reply_markup }
      );
    } catch (_) {}
  }

  bot.action(/^rate_panel_(\d+)_(.+)_([1-5])$/, async (ctx) => {
    await safeAnswer(ctx, '⭐ Rated!');
    const [, userId, panelUser, starStr] = ctx.match;
    const star = parseInt(starStr);
    const ratings = rj(RATINGS_FILE, {});
    const key = `${userId}_${panelUser}`;
    if (ratings[key]) return;
    ratings[key] = { userId, panelUser, star, at: new Date().toISOString() };
    wj(RATINGS_FILE, ratings);
    try {
      await ctx.editMessageText(
        `${'⭐'} ${t(userId, 'panelRatingThanks')}\nRating: ${'⭐'.repeat(star)}`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {}
  });

  bot._sendPanelRating = sendPanelRating;

  bot.command('setnotice', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    const text = (ctx.message.text || '').replace(/^\/setnotice\s*/, '').trim();
    if (!text) return ctx.reply(eBox('📢 SET NOTICE', ['/setnotice <teks pengumuman>']), { parse_mode: 'HTML' });
    wj(NOTICE_FILE, { text, at: new Date().toISOString() });
    writeAudit('set_notice', String(ctx.from.id), 'system', { len: text.length });
    return ctx.reply(t(ctx.from.id, 'noticeSetOk'), { parse_mode: 'HTML' });
  });

  bot.command('clearnotice', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    wj(NOTICE_FILE, { text: null });
    return ctx.reply(t(ctx.from.id, 'noticeClearOk'), { parse_mode: 'HTML' });
  });

  function getNoticeBanner(userId) {
    const n = rj(NOTICE_FILE, { text: null });
    if (!n.text) return '';
    return `\n${richQuote(`📢 <b>${t(userId, 'noticeTitle')}</b>\n${htmlEscape(n.text)}`)}`;
  }
  bot._getNoticeBanner = getNoticeBanner;

  bot.command('poll', async (ctx) => {
    if (!isOwner(ctx.from.id)) {
      logFailedAttempt(ctx.from.id, 'poll', 'no permission');
      return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    }
    trackCmd('poll');

    const raw  = (ctx.message.text || '').replace(/^\/poll\s*/, '').trim();
    const qm   = raw.match(/^"([^"]+)"\s+(.+?)\s+(\d+h)$/i);
    if (!qm) {
      return ctx.reply(t(ctx.from.id, 'pollFormat'), { parse_mode: 'HTML' });
    }
    const question = qm[1];
    const options  = qm[2].split('|').map(o => o.trim()).filter(Boolean);
    const hours    = parseInt(qm[3]);
    if (options.length < 2 || options.length > 8) {
      return ctx.reply('❌ Minimal 2 opsi, maksimal 8 opsi.', { parse_mode: 'HTML' });
    }

    const pollId  = `POLL${Date.now().toString(36).toUpperCase()}`;
    const closesAt = new Date(Date.now() + hours * 3600000).toISOString();
    const polls    = rj(POLLS_FILE, {});
    polls[pollId]  = { pollId, question, options: options.map(o => ({ text: o, votes: [] })), closesAt, createdBy: String(ctx.from.id), createdAt: new Date().toISOString() };
    wj(POLLS_FILE, polls);

    const optBtns = options.map((o, i) => [{
      text: eF(`${i + 1}. ${o}`),
      callback_data: `poll_vote_${pollId}_${i}`,
      style: 'primary',
    }]);

    const pollMsg = [
      `${'📊'} <b>📊 Poll: ${htmlEscape(question)}</b>`,
      `Closes: <i>${formatDateId(closesAt)}</i>`,
      '',
      ...options.map((o, i) => `${i + 1}. ${htmlEscape(o)}`),
    ].join('\n');

    const users = getStartedUsers();
    let sent = 0;
    for (const uid of users.slice(0, 200)) {
      try {
        await bot.telegram.sendMessage(uid, pollMsg, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: optBtns },
        });
        sent++;
        await new Promise(r => setTimeout(r, 50));
      } catch (_) {}
    }

    return ctx.reply(`${'✅'} ${t(ctx.from.id, 'pollCreated')}\nBroadcast to ${sent} users.\nPoll ID: <code>${pollId}</code>`, { parse_mode: 'HTML' });
  });

  bot.action(/^poll_vote_([A-Z0-9]+)_(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    const [, pollId, optIdxStr] = ctx.match;
    const optIdx = parseInt(optIdxStr);
    const uid    = String(ctx.from.id);
    const polls  = rj(POLLS_FILE, {});
    const poll   = polls[pollId];
    if (!poll) return ctx.answerCbQuery('❌ Poll not found.');
    if (poll.closesAt && new Date(poll.closesAt) < new Date()) return ctx.answerCbQuery(t(uid, 'pollClosed'));

    const alreadyVoted = poll.options.some(o => o.votes.includes(uid));
    if (alreadyVoted) return ctx.answerCbQuery(t(uid, 'pollAlready'));

    poll.options[optIdx].votes.push(uid);
    wj(POLLS_FILE, polls);

    const total  = poll.options.reduce((s, o) => s + o.votes.length, 0);
    const result = poll.options.map((o, i) => {
      const pct = total > 0 ? Math.round((o.votes.length / total) * 100) : 0;
      return `${i + 1}. ${o.text}: ${'█'.repeat(Math.round(pct / 10))}${'░'.repeat(10 - Math.round(pct / 10))} ${pct}% (${o.votes.length})`;
    }).join('\n');

    try {
      await ctx.editMessageText(
        `${'📊'} <b>📊 ${htmlEscape(poll.question)}</b>\n\n${result}\n\n<i>Total votes: ${total}</i>`,
        { parse_mode: 'HTML', reply_markup: ctx.callbackQuery.message.reply_markup }
      );
    } catch (_) {}

    await ctx.answerCbQuery(t(uid, 'pollVoted'));
  });

  bot.command('setlang', async (ctx) => {
    trackCmd('setlang');
    const uid  = ctx.from.id;
    const args = (ctx.message.text || '').split(/\s+/).slice(1);
    const lang = (args[0] || '').toLowerCase();

    if (!lang) {
      const cur = getUserLang(uid);
      return renderCard(ctx,
        richTitle('🌐', 'Language Settings') + '\n' +
        richPara(`Current: <b>${cur === 'id' ? 'Indonesia 🇮🇩' : 'English 🇬🇧'}</b>`),
        Markup.inlineKeyboard([
          [{ text: '🇬🇧 English', callback_data: 'setlang_en', style: getUserLang(uid) === 'en' ? 'success' : 'primary' }],
          [{ text: '🇮🇩 Indonesia', callback_data: 'setlang_id', style: getUserLang(uid) === 'id' ? 'success' : 'primary' }],
          [{ text: eF('Back To Menu'), callback_data: 'menu', style: 'danger'}],
        ])
      );
    }

    if (!['en', 'id'].includes(lang)) {
      return ctx.reply('❌ Language not supported. Use: <code>en</code> or <code>id</code>', { parse_mode: 'HTML' });
    }
    setUserLang(uid, lang);
    return ctx.reply(t(uid, 'langSet'), { parse_mode: 'HTML' });
  });

  bot.action(/^setlang_(en|id)$/, async (ctx) => {
    await safeAnswer(ctx);
    const lang = ctx.match[1];
    setUserLang(ctx.from.id, lang);
    try {
      await ctx.editMessageText(t(ctx.from.id, 'langSet'), { parse_mode: 'HTML' });
    } catch (_) {
      await ctx.reply(t(ctx.from.id, 'langSet'), { parse_mode: 'HTML' });
    }
  });

  bot.command('toggletips', async (ctx) => {
    trackCmd('toggletips');
    const uid = String(ctx.from.id);
    const d   = rj(TIPS_PREFS_FILE, {});
    const cur = d[uid] !== false;
    d[uid] = !cur;
    wj(TIPS_PREFS_FILE, d);
    return ctx.reply(t(uid, !cur ? 'tipsEnabled' : 'tipsDisabled'), { parse_mode: 'HTML' });
  });

  function maybeTip(userId, msg) {
    if (!isTipsEnabled(userId)) return msg;
    return msg + '\n\n' + `<i>${randomTip(userId)}</i>`;
  }
  bot._maybeTip = maybeTip;

  bot.command('myhistory', async (ctx) => {
    trackCmd('myhistory');
    const uid  = ctx.from.id;
    const hist = db.getHistory(uid);
    if (!hist.length) return ctx.reply(t(uid, 'historyEmpty'), { parse_mode: 'HTML' });

    const rows = hist.map(h => [
      `/${htmlEscape(h.cmd)}`,
      h.ok ? '✅' : '❌',
      formatDateId(h.at),
    ]);

    const richHtml = [
      richTitle('📋', t(uid, 'historyTitle')),
      richTable(['Command', 'Status', 'Time'], rows),
    ].join('\n');

    return renderCard(ctx, richHtml, backToMenuKeyboard());
  });

  bot.command('sendpanelinfo', async (ctx) => {
    trackCmd('sendpanelinfo');
    const uid   = String(ctx.from.id);
    const args  = (ctx.message.text || '').split(/\s+/).slice(1);
    const panels = rj(MYPANELS_FILE, { panels: {} });
    const myPanels = panels.panels?.[uid] || [];

    if (!myPanels.length) return ctx.reply(t(uid, 'sendPanelInfoNone'), { parse_mode: 'HTML' });

    const idx = args[0] ? parseInt(args[0]) - 1 : null;
    const toSend = idx !== null ? [myPanels[idx]].filter(Boolean) : myPanels.slice(0, 5);

    if (!toSend.length) return ctx.reply('❌ Panel tidak ditemukan.', { parse_mode: 'HTML' });

    for (const p of toSend) {
      const msg = [
        `${'📌'} <b>Panel Info</b>`,
        `Username: <code>${htmlEscape(p.username || '-')}</code>`,
        `Plan: <b>${p.plan || '-'}</b>`,
        `Server: V${p.serverIndex || '-'}`,
        `Created: ${p.createdAt ? formatDateId(p.createdAt) : '-'}`,
        p.loginUrl ? `\n<a href="${p.loginUrl}">🔗 Login Panel</a>` : '',
        '',
        '<i>⚠️ Password tidak disimpan untuk keamanan. Reset via Pterodactyl panel.</i>',
      ].join('\n');
      try {
        await bot.telegram.sendMessage(uid, msg, { parse_mode: 'HTML' });
      } catch (_) {}
    }

    if (ctx.chat?.type !== 'private') {
      await ctx.reply(`${'✅'} Info panel dikirim ke DM kamu.`, { parse_mode: 'HTML' });
    }
  });

  bot.command('fav', async (ctx) => {
    trackCmd('fav');
    const uid  = ctx.from.id;
    const args = (ctx.message.text || '').split(/\s+/).slice(1);
    const sub  = args[0]?.toLowerCase();
    const cmd  = args[1]?.replace('/', '');

    if (!sub || sub === 'list') {
      const favs = db.getFavorites(uid);
      if (!favs.length) return ctx.reply(t(uid, 'favEmpty'), { parse_mode: 'HTML' });
      return ctx.reply(
        eBox(t(uid, 'favTitle'), favs.map((c, i) => `${i + 1}. /${htmlEscape(c)}`)),
        { parse_mode: 'HTML' }
      );
    }
    if (sub === 'add' && cmd) {
      const result = db.addFavorite(uid, cmd);
      if (result === 'already') return ctx.reply(t(uid, 'favAlready'), { parse_mode: 'HTML' });
      if (result === 'limit')   return ctx.reply(t(uid, 'favLimit'),   { parse_mode: 'HTML' });
      return ctx.reply(t(uid, 'favAdded'), { parse_mode: 'HTML' });
    }
    if (sub === 'remove' && cmd) {
      const ok = db.removeFavorite(uid, cmd);
      return ctx.reply(ok ? t(uid, 'favRemoved') : t(uid, 'favNotFound'), { parse_mode: 'HTML' });
    }
    return ctx.reply(eBox('⭐ FAV', ['/fav list', '/fav add <command>', '/fav remove <command>']), { parse_mode: 'HTML' });
  });

  bot.command('genpass', async (ctx) => {
    trackCmd('genpass');
    const uid  = ctx.from.id;
    const args = (ctx.message.text || '').split(/\s+/).slice(1);
    const len  = Math.min(64, Math.max(8, parseInt(args[0] || '16')));
    const type = (args[1] || 'strong').toLowerCase();

    const charSets = {
      simple:  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      strong:  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}',
      numeric: '0123456789',
      alpha:   'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    };
    const chars = charSets[type] || charSets.strong;

    const bytes = crypto.randomBytes(len * 2);
    let pass = '';
    for (let i = 0; i < len; i++) {
      pass += chars[bytes[i] % chars.length];
    }

    const strength = len >= 16 && /[A-Z]/.test(pass) && /[0-9]/.test(pass) && /[^A-Za-z0-9]/.test(pass)
      ? '🔴 Very Strong' : len >= 12 ? '🟠 Strong' : '🟡 Medium';

    return ctx.reply(
      eBox(t(uid, 'genpassTitle'), [
        `Password: <code>${htmlEscape(pass)}</code>`,
        `Length: ${len}`,
        `Type: ${type}`,
        `Strength: ${strength}`,
      ]),
      { parse_mode: 'HTML' }
    );
  });

  bot.command('toqr', async (ctx) => {
    trackCmd('toqr');
    const uid  = ctx.from.id;
    const text = (ctx.message.text || '').replace(/^\/toqr\s*/, '').trim();
    if (!text) {
      return ctx.reply(eBox('📱 QR CODE', ['/toqr <teks atau URL>', 'Contoh: /toqr https://t.me/itshanzpiw']), { parse_mode: 'HTML' });
    }
    if (text.length > 500) return ctx.reply('❌ Teks terlalu panjang (maks 500 karakter).', { parse_mode: 'HTML' });

    const loadMsg = await ctx.reply(t(uid, 'qrGenerating'), { parse_mode: 'HTML' });
    try {
      const QRCode = require('qrcode');
      const buf    = await QRCode.toBuffer(text, { type: 'png', width: 512, margin: 2 });
      try { await bot.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch (_) {}
      return ctx.replyWithPhoto({ source: buf }, {
        caption: `📱 <b>QR Code</b>\n<code>${htmlEscape(text.length > 100 ? text.slice(0, 100) + '…' : text)}</code>`,
        parse_mode: 'HTML',
      });
    } catch (e) {
      try { await bot.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch (_) {}
      return ctx.reply(`${t(uid, 'qrError')}\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
    }
  });

  const CITY_TZ = {
    london: 'Europe/London', paris: 'Europe/Paris', berlin: 'Europe/Berlin',
    tokyo: 'Asia/Tokyo', osaka: 'Asia/Tokyo', beijing: 'Asia/Shanghai', shanghai: 'Asia/Shanghai',
    singapore: 'Asia/Singapore', jakarta: 'Asia/Jakarta', bali: 'Asia/Jakarta', bandung: 'Asia/Jakarta',
    dubai: 'Asia/Dubai', 'new york': 'America/New_York', newyork: 'America/New_York', nyc: 'America/New_York',
    'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', sydney: 'Australia/Sydney',
    seoul: 'Asia/Seoul', bangkok: 'Asia/Bangkok', mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata',
    istanbul: 'Europe/Istanbul', moscow: 'Europe/Moscow', cairo: 'Africa/Cairo',
    toronto: 'America/Toronto', chicago: 'America/Chicago', amsterdam: 'Europe/Amsterdam',
    rome: 'Europe/Rome', madrid: 'Europe/Madrid', stockholm: 'Europe/Stockholm',
    riyadh: 'Asia/Riyadh', kuala: 'Asia/Kuala_Lumpur', 'kuala lumpur': 'Asia/Kuala_Lumpur', kl: 'Asia/Kuala_Lumpur',
    hong: 'Asia/Hong_Kong', hongkong: 'Asia/Hong_Kong', taipei: 'Asia/Taipei',
    karachi: 'Asia/Karachi', dhaka: 'Asia/Dhaka', colombo: 'Asia/Colombo',
    melbourne: 'Australia/Melbourne', auckland: 'Pacific/Auckland',
  };

  bot.command('clock', async (ctx) => {
    trackCmd('clock');
    const uid  = ctx.from.id;
    const city = (ctx.message.text || '').replace(/^\/clock\s*/, '').trim().toLowerCase();
    if (!city) {
      return ctx.reply(eBox('🕐 CLOCK', ['/clock <kota>', 'Contoh: /clock Tokyo', '/clock London', '/clock New York']), { parse_mode: 'HTML' });
    }

    const tz = CITY_TZ[city] || Object.entries(CITY_TZ).find(([k]) => city.includes(k) || k.includes(city))?.[1];
    if (!tz) return ctx.reply(t(uid, 'clockError'), { parse_mode: 'HTML' });

    const now   = new Date();
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(now);
    const tzOffset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).format(now).split(' ').pop();

    const cityLabel = city.charAt(0).toUpperCase() + city.slice(1);
    return ctx.reply(
      eBox(t(uid, 'clockTitle'), [
        `City: <b>${htmlEscape(cityLabel)}</b>`,
        `Time: <code>${local}</code>`,
        `Timezone: <b>${tz}</b>`,
        `Abbrev: ${tzOffset}`,
      ]),
      { parse_mode: 'HTML' }
    );
  });

  bot.command('surlstats', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    trackCmd('surlstats');
    const clicks = rj(SURL_FILE, {});
    if (!Object.keys(clicks).length) {
      return ctx.reply('📊 No short URL stats yet.', { parse_mode: 'HTML' });
    }
    const rows = Object.entries(clicks)
      .sort((a, b) => b[1].clicks - a[1].clicks)
      .slice(0, 15)
      .map(([key, d]) => [key, String(d.clicks), d.lastClick ? formatDateId(d.lastClick) : '-']);
    const richHtml = [
      richTitle('📊', '📊 Short URL Click Stats'),
      richTable(['Key', 'Clicks', 'Last Click'], rows),
    ].join('\n');
    return renderCard(ctx, richHtml, backToMenuKeyboard());
  });

  bot.command('urlclick', async (ctx) => {
    const key = (ctx.message.text || '').split(/\s+/)[1];
    if (!key) return ctx.reply('❌ /urlclick <key>', { parse_mode: 'HTML' });
    const clicks = rj(SURL_FILE, {});
    if (!clicks[key]) return ctx.reply(`❌ Key <code>${key}</code> not found.`, { parse_mode: 'HTML' });
    clicks[key].clicks++;
    clicks[key].lastClick = new Date().toISOString();
    wj(SURL_FILE, clicks);
    return ctx.reply(`${'✅'} Click tracked for <code>${key}</code>. Total: ${clicks[key].clicks}`, { parse_mode: 'HTML' });
  });

  bot._trackShortUrl = function(key, originalUrl) {
    const clicks = rj(SURL_FILE, {});
    if (!clicks[key]) {
      clicks[key] = { originalUrl, clicks: 0, createdAt: new Date().toISOString(), lastClick: null };
    }
    wj(SURL_FILE, clicks);
    return key;
  };

  const WEATHER_KEY = config.weatherApiKey || '8f6f86ab4cbffe2e6f1f8c7215fdeb1c';
  const WEATHER_ICONS = {
    Clear: '☀️', Clouds: '☁️', Rain: '🌧️', Drizzle: '🌦️',
    Thunderstorm: '⛈️', Snow: '❄️', Mist: '🌫️', Fog: '🌫️', Haze: '🌫️',
    Dust: '💨', Sand: '💨', Tornado: '🌪️',
  };

  bot.command('cuaca', async (ctx) => {
    trackCmd('cuaca');
    const uid  = ctx.from.id;
    const city = (ctx.message.text || '').replace(/^\/cuaca\s*/, '').trim();
    if (!city) {
      return ctx.reply(eBox('🌤️ CUACA', ['/cuaca <kota>', 'Contoh: /cuaca Jakarta', '/cuaca Tokyo']), { parse_mode: 'HTML' });
    }

    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${WEATHER_KEY}&units=metric&lang=id`;
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 8000);
      const res  = await fetch(url, { signal: ctrl.signal });
      clearTimeout(tid);

      if (!res.ok) return ctx.reply(t(uid, 'weatherError'), { parse_mode: 'HTML' });
      const d = await res.json();

      const icon      = WEATHER_ICONS[d.weather?.[0]?.main] || '🌡️';
      const condition = d.weather?.[0]?.description || '-';
      const temp      = d.main?.temp;
      const feels     = d.main?.feels_like;
      const humidity  = d.main?.humidity;
      const wind      = d.wind?.speed;
      const country   = d.sys?.country;
      const city2     = d.name;

      const richHtml = [
        richTitle(icon, `${t(uid, 'weatherTitle')} — ${city2}, ${country}`),
        richTable(['Parameter', 'Value'], [
          ['Condition',   htmlEscape(condition)],
          ['Temperature', `<b>${temp?.toFixed(1)}°C</b>`],
          ['Feels Like',  `${feels?.toFixed(1)}°C`],
          ['Humidity',    `${humidity}%`],
          ['Wind Speed',  `${wind} m/s`],
          ['Updated',     nowId()],
        ]),
      ].join('\n');

      return renderCard(ctx, richHtml, backToMenuKeyboard());
    } catch (e) {
      return ctx.reply(`${t(uid, 'weatherError')}\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
    }
  });

  bot.command('setbanword', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    trackCmd('setbanword');
    const raw  = (ctx.message.text || '').replace(/^\/setbanword\s*/, '').trim();
    if (!raw) {
      const cur = rj(BANWORDS_FILE, []);
      if (!cur.length) return ctx.reply(eBox('🚫 BANWORD', [t(ctx.from.id, 'banwordNone'), '/setbanword kata1,kata2', '/clearbanword untuk hapus semua']), { parse_mode: 'HTML' });
      return ctx.reply(
        eBox(t(ctx.from.id, 'banwordList'), cur.map((w, i) => `${i + 1}. ${w}`)),
        { parse_mode: 'HTML' }
      );
    }
    const words = raw.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
    wj(BANWORDS_FILE, words);
    return ctx.reply(eBox('🚫 BANWORD SET', [`${words.length} kata terlarang disimpan:`, ...words.map(w => `• ${w}`)]), { parse_mode: 'HTML' });
  });

  bot.command('clearbanword', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    wj(BANWORDS_FILE, []);
    return ctx.reply('✅ Semua kata terlarang dihapus.', { parse_mode: 'HTML' });
  });

  bot._checkBanword = checkBanword;

  bot._checkBulkPanelAlert = async function(userId, username) {
    const panels    = rj(MYPANELS_FILE, { panels: {} });
    const myPanels  = panels.panels?.[String(userId)] || [];
    const oneHourAgo = Date.now() - 3600000;
    const recent    = myPanels.filter(p => new Date(p.createdAt).getTime() > oneHourAgo);
    if (recent.length >= 5) {
      const ownerId = config.ownerChannelId || ownerIds()[0];
      try {
        await bot.telegram.sendMessage(String(ownerId),
          `${'⚠️'} <b>Bulk Panel Alert!</b>\n` +
          `User: <code>${userId}</code> @${username || '-'}\n` +
          `Created <b>${recent.length} panels</b> in 1 hour!\n` +
          `Time: ${nowId()}\n\n` +
          `Actions:\n` +
          `/lockuser ${userId} suspicious_bulk\n` +
          `/blacklist ${userId}`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🔒 Lock User', callback_data: `bulk_lock_${userId}` },
                  { text: '🚫 Blacklist', callback_data: `bulk_blacklist_${userId}` },
                ],
                [{ text: '✅ Approve (Ignore)', callback_data: `bulk_approve_${userId}` }],
              ],
            },
          }
        );
      } catch (_) {}
    }
  };

  bot.action(/^bulk_lock_(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswer(ctx, '❌');
    await safeAnswer(ctx);
    const uid = ctx.match[1];
    db.lockUser(uid, ctx.from.id, 'bulk_panel_creation');
    await ctx.reply(`${'✅'} User <code>${uid}</code> locked.`, { parse_mode: 'HTML' });
  });

  bot.action(/^bulk_approve_(\d+)$/, async (ctx) => {
    await safeAnswer(ctx, '✅ Approved');
    try { await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ Approved by owner.', { parse_mode: 'HTML' }); } catch (_) {}
  });

  bot.command('auditlog', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    trackCmd('auditlog');
    const logs = rj(AUDIT_FILE, []);
    const args = (ctx.message.text || '').split(/\s+/).slice(1);
    const page = Math.max(1, parseInt(args[0] || '1'));
    const per  = 10;
    const slice = logs.slice((page - 1) * per, page * per);

    if (!slice.length) return ctx.reply('📋 No audit logs found.', { parse_mode: 'HTML' });

    const rows = slice.map(l => [
      htmlEscape(l.action || '-'),
      `<code>${l.actor || '-'}</code>`,
      htmlEscape(String(l.target || '-')).slice(0, 20),
      formatDateId(l.at),
    ]);

    const richHtml = [
      richTitle('📋', `Owner Audit Log — Page ${page}`),
      richTable(['Action', 'By', 'Target', 'Time'], rows),
      richPara(`Total: ${logs.length} | Page ${page}/${Math.ceil(logs.length / per)}`),
    ].join('\n');

    return renderCard(ctx, richHtml, Markup.inlineKeyboard([
      page > 1 ? [{ text: eF('◀ Prev'), callback_data: `auditlog_${page - 1}`, style: 'primary' }] : [],
      logs.length > page * per ? [{ text: eF('Next ▶'), callback_data: `auditlog_${page + 1}`, style: 'primary' }] : [],
      [{ text: eF('Back To Menu'), callback_data: 'menu', style: 'danger'}],
    ].filter(r => r.length)));
  });

  bot.action(/^auditlog_(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    const page = parseInt(ctx.match[1]);
    const logs = rj(AUDIT_FILE, []);
    const per  = 10;
    const slice = logs.slice((page - 1) * per, page * per);
    if (!slice.length) return;
    const rows = slice.map(l => [htmlEscape(l.action || '-'), `<code>${l.actor}</code>`, htmlEscape(String(l.target || '-').slice(0,20)), formatDateId(l.at)]);
    const richHtml = [richTitle('📋', `Audit Log — Page ${page}`), richTable(['Action', 'By', 'Target', 'Time'], rows)].join('\n');
    await renderCard(ctx, richHtml, Markup.inlineKeyboard([
      page > 1 ? [{ text: eF('◀ Prev'), callback_data: `auditlog_${page - 1}`, style: 'primary' }] : [],
      logs.length > page * per ? [{ text: eF('Next ▶'), callback_data: `auditlog_${page + 1}`, style: 'primary' }] : [],
      [{ text: eF('Back'), callback_data: 'menu', style: 'danger' }],
    ].filter(r => r.length)), { edit: true });
  });

  bot.command('setdailyreport', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    const arg = (ctx.message.text || '').split(/\s+/)[1]?.toLowerCase();
    const cfg = rj(DAILY_CFG_FILE, { enabled: false });
    if (arg === 'on') {
      cfg.enabled = true; wj(DAILY_CFG_FILE, cfg);
      return ctx.reply(t(ctx.from.id, 'dailyReportOn'), { parse_mode: 'HTML' });
    }
    if (arg === 'off') {
      cfg.enabled = false; wj(DAILY_CFG_FILE, cfg);
      return ctx.reply(t(ctx.from.id, 'dailyReportOff'), { parse_mode: 'HTML' });
    }
    const status = cfg.enabled ? '🟢 ON' : '🔴 OFF';
    return ctx.reply(
      eBox('📊 DAILY REPORT', [`Status: ${status}`, '/setdailyreport on', '/setdailyreport off']),
      { parse_mode: 'HTML' }
    );
  });

  bot.command('dbcheck', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    trackCmd('dbcheck');
    const msg = await ctx.reply('⏳ Running database integrity check...', { parse_mode: 'HTML' });
    const issues = await runDbIntegrityCheck();
    try { await bot.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (_) {}

    if (!issues.length) {
      return ctx.reply(`${'✅'} Database integrity check passed! No issues found.\n${nowId()}`, { parse_mode: 'HTML' });
    }

    const richHtml = [
      richTitle('⚠️', '⚠️ DB Integrity Issues Found'),
      richPara(`Found <b>${issues.length}</b> issue(s) at ${nowId()}`),
      richTable(['#', 'Issue', 'Detail'], issues.slice(0, 20).map((iss, i) => [String(i+1), htmlEscape(iss.type), htmlEscape(iss.detail || '-')])),
      richPara('<i>Issues logged. No data was modified automatically.</i>'),
    ].join('\n');

    return renderCard(ctx, richHtml, backToMenuKeyboard());
  });

  async function runDbIntegrityCheck() {
    const issues = [];
    try {
      const roles    = db.getAllRoles();
      const started  = getStartedUsers();
      const panels   = rj(MYPANELS_FILE, { panels: {} });
      const startedSet = new Set(started.map(String));

      for (const [uid] of Object.entries(roles)) {
        if (!startedSet.has(uid)) {
          issues.push({ type: 'role_no_start', detail: `User ${uid} has role but never used /start` });
        }
      }

      for (const [uid, ps] of Object.entries(panels.panels || {})) {
        if (!roles[uid] && !ownerIds().includes(uid)) {
          issues.push({ type: 'orphan_panel', detail: `User ${uid} has ${ps.length} panels but no role` });
        }
      }

      const locked = db.getLockedUsers();
      for (const [uid] of Object.entries(locked)) {
        if (!roles[uid]) {
          issues.push({ type: 'locked_no_role', detail: `Locked user ${uid} has no role` });
        }
      }

    } catch (e) {
      issues.push({ type: 'check_error', detail: e.message });
    }

    wj(INTEGRITY_FILE, { checkedAt: new Date().toISOString(), issues, total: issues.length });
    return issues;
  }

  bot._runDbIntegrityCheck = runDbIntegrityCheck;

  bot.command('dbcleanup', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply(t(ctx.from.id, 'ownerOnly'), { parse_mode: 'HTML' });
    trackCmd('dbcleanup');
    const msg = await ctx.reply('⏳ Running database cleanup...', { parse_mode: 'HTML' });
    const result = runDbCleanup();
    try { await bot.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (_) {}
    return ctx.reply(
      eBox('🗑️ DB CLEANUP', [
        `Panel history cleaned: ${result.panelsRemoved}`,
        `Stale audit logs trimmed: ${result.auditTrimmed}`,
        `Time: ${nowId()}`,
      ]),
      { parse_mode: 'HTML' }
    );
  });

  function runDbCleanup() {
    let panelsRemoved = 0, auditTrimmed = 0;
    try {
      const panels = rj(MYPANELS_FILE, { panels: {} });
      const cutoff = Date.now() - 90 * 86400000;
      for (const uid of Object.keys(panels.panels || {})) {
        const before = panels.panels[uid].length;
        panels.panels[uid] = panels.panels[uid].filter(p => new Date(p.createdAt).getTime() > cutoff);
        panelsRemoved += before - panels.panels[uid].length;
      }
      wj(MYPANELS_FILE, panels);

      const audit = rj(AUDIT_FILE, []);
      if (audit.length > 500) {
        auditTrimmed = audit.length - 500;
        wj(AUDIT_FILE, audit.slice(0, 500));
      }

      const fails   = rj(FAILED_FILE, {});
      const weekAgo = Date.now() - 7 * 86400000;
      for (const uid of Object.keys(fails)) {
        fails[uid] = fails[uid].filter(a => new Date(a.at).getTime() > weekAgo);
        if (!fails[uid].length) delete fails[uid];
      }
      wj(FAILED_FILE, fails);

    } catch (e) {
      console.error('[DB_CLEANUP]', e.message);
    }
    return { panelsRemoved, auditTrimmed };
  }

  bot._runDbCleanup = runDbCleanup;
  bot._runDbIntegrityCheck = runDbIntegrityCheck;
  bot._writeAudit = writeAudit;
  bot._logFailedAttempt = logFailedAttempt;

};
