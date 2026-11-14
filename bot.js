const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, exec } = require('child_process');
const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const db = require('./lib/db-firebase');
const { ROLE_DEFINITIONS } = db;
const { fbRead, fbWrite, fbInit, getCacheStats } = require('./lib/firebase');
const i18n = require('./lib/lang');

const DB_DIR = path.join(__dirname, 'database');
const PRAYER_DB_FILE = path.join(DB_DIR, 'prayer.json');
const CONFIG_OVERRIDE_FILE = path.join(DB_DIR, 'config_override.json');
const FIXED_BACKUP_CHAT_ID = config.FIXED_BACKUP_CHAT_ID
const BLACKLIST_FILE = path.join(DB_DIR, 'blacklist.json');
const STATS_FILE = path.join(DB_DIR, 'panel_stats.json');
const OFFLINE_TRACKER_FILE = path.join(DB_DIR, 'offline_tracker.json');
const GUEST_PANEL_FILE     = path.join(DB_DIR, 'guest_panels.json');
const STARTED_USERS_FILE   = path.join(DB_DIR, 'started_users.json');
const AUTO_DELETE_LOG_GROUP = config.AUTO_DELETE_LOG_GROUP
const OFFLINE_THRESHOLD_MS  = config.OFFLINE_THRESHOLD_MS
const OFFLINE_CHECK_INTERVAL_MS = config.OFFLINE_CHECK_INTERVAL_MS

const MAINTENANCE_FILE  = path.join(DB_DIR, 'maintenance.json');
const { startAutoServerCheck, buildRedirectRich } = require('./lib/auto-server-check');

const BROADCAST_USERS = {
  '8215299938': 'HanzPiw Official',
  '8070201877': 'Jayss Jos Jis',
  '8842981102': 'Yutaa',
  '8824744532': 'Vinz Official',
  '8957462071': 'kenken',
  '5289715508': 'bimz',
  '7776684288': 'kafz',
  '1973729040': 'LynxNotdev',
};

const USERS_SECURITY = BROADCAST_USERS;
const BLOCKED_CMDS_FILE = path.join(DB_DIR, 'blocked_cmds.json');
const STORAN_DB_FILE    = path.join(DB_DIR, 'storan.json');
const PM_USERS_FILE     = path.join(DB_DIR, 'pm_users.json');

const EGG_CONFIGS = {
  'nodejs': { loc: '1', nest: '5', egg: '15', name: 'Node.js' },
  'python': { loc: '1', nest: '5', egg: '16', name: 'Python' }
};

const unliSessions = new Map();
const panelSessions = new Map();

function parseUsernameAndRecipient(rawInput) {
  const trimmed = (rawInput || '').trim();

  if (trimmed.includes(',')) {
    const parts = trimmed.split(',');
    const username = sanitizeUsername(parts[0].trim());
    const recipientIdStr = parts[1].trim();
    const recipientId = Number(recipientIdStr);

    if (!username || username.length < 3) {
      return { username: null, recipientId: null, error: 'Username harus minimal 3 karakter' };
    }

    if (isNaN(recipientId) || recipientId <= 0) {
      return { username: null, recipientId: null, error: 'ID penerima harus berupa angka positif' };
    }

    return { username, recipientId, error: null };
  } else {
    const username = sanitizeUsername(trimmed);
    if (!username || username.length < 3) {
      return { username: null, recipientId: null, error: 'Username harus minimal 3 karakter' };
    }
    return { username, recipientId: null, error: null };
  }
}

function getEggConfig(eggType) {
  return EGG_CONFIGS[eggType] || null;
}

function readGuestPanelDb() {
  return fbRead(GUEST_PANEL_FILE, {});
}
function saveGuestPanelDb(data) {
  fbWrite(GUEST_PANEL_FILE, data);
}
function hasUsedGuestPanel(userId) {
  const gdb = readGuestPanelDb();
  return Boolean(gdb[String(userId)]);
}
function markGuestPanelUsed(userId, extra = {}) {
  const gdb = readGuestPanelDb();
  gdb[String(userId)] = { usedAt: new Date().toISOString(), ...extra };
  saveGuestPanelDb(gdb);
}

function resetGuestPanel(userId) {
  const gdb = readGuestPanelDb();
  if (!gdb[String(userId)]) return false;
  delete gdb[String(userId)];
  saveGuestPanelDb(gdb);
  return true;
}

async function createGuestPanelPanel(username, plan, telegramId, progressFn = null, eggCfg = null) {
  const servers = getActiveServers();
  if (!servers.length) throw new Error('Tidak ada server aktif. Coba lagi nanti atau hubungi admin.');
  let lastError = null;
  for (const server of servers) {
    if (progressFn) await progressFn(server.index, servers.length);
    try {
      const result = await createPanelServerOn(server, username, plan, telegramId, eggCfg);
      return { ...result, serverIndex: server.index, serverDomain: server.domain };
    } catch (error) {
      const msg = String(error?.message || '');
      if (msg.includes('alokasi') || msg.includes('allocation')) { lastError = error; continue; }
      throw error;
    }
  }
  throw lastError || new Error('Semua server penuh. Coba lagi nanti atau hubungi admin.');
}

const BOT_BRAND = 'Cpanel HanzPiw X Jayss';
const BOT_HDR   = `✦ ━━ <b>${BOT_BRAND}</b> ━━ ✦`;
const BOT_HDR_P = `✦ ━━ ${BOT_BRAND} ━━ ✦`;

function eBox(title, lines = []) {
  const body = lines.map(l => `  ➣ ${l}`).join('<br>');
  return `<blockquote>${BOT_HDR}<br><br>╔══『 ${title} 』<br>${body}<br>╚═════════════════════<br><br>${BOT_HDR}</blockquote>`;
}

function eSect(title, lines = []) {
  const body = lines.map(l => `  ➣ ${l}`).join('<br>');
  return `<blockquote>╔══『 ${title} 』<br>${body}<br>╚═════════════════════</blockquote>`;
}

function eMulti(sections) {

  const parts = sections.map(s => {
    const body = s.lines.map(l => `  ➣ ${l}`).join('<br>');
    return `╔══『 ${s.title} 』<br>${body}<br>╚═════════════════════`;
  }).join('<br><br>');
  return `<blockquote>${BOT_HDR}<br><br>${parts}<br><br>${BOT_HDR}</blockquote>`;
}

const MONITOR_TOP10_DB       = path.join(DB_DIR, 'monitor-top10.json');
const MONITOR_ENABLED        = Boolean(config.monitorEnabled !== false);
const MONITOR_CHAT_ID        = String(config.monitorChatId || config.ownerChannelId || '').trim();
const RAM_THRESHOLD_PCT      = Number(config.RAM_THRESHOLD_PERCENT  ?? 80);
const DISK_THRESHOLD_PCT     = Number(config.DISK_THRESHOLD_PERCENT ?? 80);
const RAM_ABS_MAX_MIB        = Number(config.RAM_ABSOLUTE_MAX_MIB   ?? 8192);
const DISK_ABS_MAX_MIB       = Number(config.DISK_ABSOLUTE_MAX_MIB  ?? 51200);
const CPU_STOP_THRESH        = Number(config.CPU_STOP_THRESHOLD     ?? 80);
const CPU_STOP_CD_MS         = Number(config.CPU_STOP_COOLDOWN_MS   ?? 60000);
const SUS_DISK_GROWTH_MIB    = Number(config.SUSPICIOUS_DISK_GROWTH_MIB ?? 512);
const SUS_DISK_GROWTH_PCT    = Number(config.SUSPICIOUS_DISK_GROWTH_PCT  ?? 20);
const POLL_MS                = Number(config.POLL_INTERVAL_MS       ?? 30000);
const SUSPEND_CD_MS          = Number(config.SUSPEND_COOLDOWN_MS    ?? 300000);
const AUTO_DEL_MONITOR_MS    = Number(config.AUTO_DELETE_MONITOR_MS ?? 25200000);
const MONITOR_DBG            = Boolean(config.MONITOR_DEBUG);

const { REQUIRED_CHANNELS } = require('./config');

const PANEL_PLANS = {
  '1gb':  { key: '1gb',  name: '1GB',  memory: 1024,  disk: 1024,  cpu: 40  },
  '2gb':  { key: '2gb',  name: '2GB',  memory: 2048,  disk: 2048,  cpu: 50  },
  '3gb':  { key: '3gb',  name: '3GB',  memory: 3072,  disk: 3072,  cpu: 60  },
  '4gb':  { key: '4gb',  name: '4GB',  memory: 4096,  disk: 4096,  cpu: 70  },
  '5gb':  { key: '5gb',  name: '5GB',  memory: 5120,  disk: 5120,  cpu: 80  },
  '6gb':  { key: '6gb',  name: '6GB',  memory: 6144,  disk: 6144,  cpu: 90  },
  '7gb':  { key: '7gb',  name: '7GB',  memory: 7168,  disk: 7168,  cpu: 100 },
  '8gb':  { key: '8gb',  name: '8GB',  memory: 8192,  disk: 8192,  cpu: 110 },
  '9gb':  { key: '9gb',  name: '9GB',  memory: 9216,  disk: 9216,  cpu: 120 },
  '10gb': { key: '10gb', name: '10GB', memory: 10240, disk: 10240, cpu: 130 },
  '11gb': { key: '11gb', name: '11GB', memory: 11264, disk: 11264, cpu: 140 },
  '12gb': { key: '12gb', name: '12GB', memory: 12288, disk: 12288, cpu: 150 },
  '13gb': { key: '13gb', name: '13GB', memory: 13312, disk: 13312, cpu: 160 },
  '14gb': { key: '14gb', name: '14GB', memory: 14336, disk: 14336, cpu: 170 },
  '15gb': { key: '15gb', name: '15GB', memory: 15360, disk: 15360, cpu: 180 },
  '16gb': { key: '16gb', name: '16GB', memory: 16384, disk: 16384, cpu: 190 },
  '17gb': { key: '17gb', name: '17GB', memory: 17408, disk: 17408, cpu: 200 },
  '18gb': { key: '18gb', name: '18GB', memory: 18432, disk: 18432, cpu: 210 },
  '19gb': { key: '19gb', name: '19GB', memory: 19456, disk: 19456, cpu: 220 },
  '20gb': { key: '20gb', name: '20GB', memory: 20480, disk: 20480, cpu: 230 },
  unli:   { key: 'unli', name: 'UNLI', memory: 0,     disk: 0,     cpu: 0   }
};

const TIER_ALLOWED_SERVERS = {
  owner: [1, 2, 3, 4, 5],
  akti:  [1, 2, 3, 4, 5],
  akme:  [1, 2, 3, 4],
  akma:  [1, 2]
};

const TIER_CAN_ADMIN_PANEL = {
  owner: true,
  akti:  true,
  akme:  true,
  akma:  false
};

const TIER_LABELS = {
  akma:  '🟡 Akses Pertama (Akma)',
  akme:  '🔵 Akses Menengah (Akme)',
  akti:  '🔴 Akses Tinggi (Akti)',
  owner: '👑 Akses Pemilik (Owner)',
};

function tierBadge(tier) {
  const map = { akma: '🟡', akme: '🔵', akti: '🔴', owner: '👑' };
  return map[tier] || '⚪';
}

(function loadConfigOverride() {
  const overrides = fbRead(CONFIG_OVERRIDE_FILE, {});
  if (overrides && Object.keys(overrides).length) Object.assign(config, overrides);
})();

if (!config.botToken || config.botToken === '') {
  console.error('[ERROR] botToken belum diisi di config.js');
  process.exit(1);
}

const bot = new Telegraf(config.botToken);
let BOT_USERNAME = '';
const pendingRole = new Map();
const pendingPM   = new Map();
const rateLimitMap = new Map();
const RATE_LIMIT_MS = 10 * 1000;

const TIER_COOLDOWN_MS = { akma: 30000, akme: 15000, akti: 5000, owner: 0 };

let configChangeTimer = null;

function getActiveServers() {
  const slots = [
    { index: 1, domain: config.domain,   plta: config.plta,   pltc: config.pltc   },
    { index: 2, domain: config.domainv2, plta: config.pltav2, pltc: config.pltcv2 },
    { index: 3, domain: config.domainv3, plta: config.pltav3, pltc: config.pltcv3 },
    { index: 4, domain: config.domainv4, plta: config.pltav4, pltc: config.pltcv4 },
    { index: 5, domain: config.domainv5, plta: config.pltav5, pltc: config.pltcv5 },
  ];
  return slots.filter(s => {
    const dom = String(s.domain || '').trim();
    const plta = String(s.plta || '').trim();
    return dom && /^https?:\/\//i.test(dom) &&
           plta && /^ptla_/i.test(plta) && !plta.includes('APPLICATION_API_KEY');
  });
}

let serverStatusCache = { ts: 0, data: null };
let onlineServersCache = { ts: 0, count: null };

async function getOnlineServerCount() {
  const now = Date.now();
  if (onlineServersCache.count !== null && now - onlineServersCache.ts < 60000) {
    return onlineServersCache.count;
  }
  const slots = [
    { index: 1, domain: config.domain,   plta: config.plta   },
    { index: 2, domain: config.domainv2, plta: config.pltav2 },
    { index: 3, domain: config.domainv3, plta: config.pltav3 },
    { index: 4, domain: config.domainv4, plta: config.pltav4 },
    { index: 5, domain: config.domainv5, plta: config.pltav5 },
  ];
  let onlineCount = 0;
  await Promise.all(slots.map(async slot => {
    const domain = cleanDomain(slot.domain || '');
    const plta   = String(slot.plta || '');
    const isConfigured = domain && /^https?:\/\//i.test(domain) &&
                         plta && /^ptla_/i.test(plta) && !plta.includes('APPLICATION_API_KEY');
    if (!isConfigured) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 7000);
      await fetch(`${domain}/api/application/users?per_page=1&page=1`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${plta}`, Accept: 'Application/vnd.pterodactyl.v1+json' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      onlineCount++;
    } catch (_) {}
  }));
  onlineServersCache = { ts: Date.now(), count: onlineCount };
  return onlineCount;
}

function htmlEscape(v) { return String(v ?? ''); }
function cleanDomain(v) { return String(v || '').trim().replace(/\/+$/, ''); }
function sensorDomain(rawDomain) {
  const cleaned = cleanDomain(rawDomain || '');
  if (!cleaned) return '—';
  const match = cleaned.match(/^(https?:\/\/)(.+)$/i);
  if (!match) return '***';
  const protocol = match[1];
  const rest = match[2];
  const portMatch = rest.match(/^([^:]+)(:\d+)?$/);
  const hostname = portMatch ? portMatch[1] : rest;
  const port     = portMatch && portMatch[2] ? portMatch[2] : '';
  const censored = hostname.split('.').map(seg => {
    if (seg.length <= 2) return seg[0] + '*';
    if (seg.length <= 4) return seg[0] + '*'.repeat(seg.length - 2) + seg[seg.length - 1];
    return seg.slice(0, 2) + '*'.repeat(seg.length - 3) + seg[seg.length - 1];
  });
  return `${protocol}${censored.join('.')}${port}`;
}

function sanitizeUsername(input) {
  return String(input || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16);
}
function appendUsernameSuffix(base, index) {
  const suffix = String(index || '');
  return `${String(base || 'user').slice(0, Math.max(3, 16 - suffix.length))}${suffix}`;
}
function randomPassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#';
  let r = ''; for (let i = 0; i < length; i++) r += chars[Math.floor(Math.random() * chars.length)]; return r;
}
function randomSuffix(length = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = ''; for (let i = 0; i < length; i++) r += chars[Math.floor(Math.random() * chars.length)]; return r;
}
function buildUniqueExternalId(prefix, username) {
  return `${prefix}-${String(username || 'user').slice(0, 12)}-${Date.now()}-${randomSuffix(4)}`;
}
function formatBytesToGB(bytes) { return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`; }
function formatKbToGB(kb) { return `${(Number(kb) / 1024 / 1024).toFixed(1)}GB`; }
function progressBar(percent, length = 10) {
  const safe = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((safe / 100) * length);
  return `${'■'.repeat(filled)}${'□'.repeat(Math.max(0, length - filled))}`;
}
function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days} Days`);
  if (hours) parts.push(`${hours} Hours`);
  if (!days && !hours) parts.push(`${minutes} Minutes`);
  return parts.join(', ');
}
function formatDateId(dateValue) {
  try {
    return new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: config.timezone || 'Asia/Jakarta'
    }).format(new Date(dateValue));
  } catch (_) { return String(dateValue || '-'); }
}
function formatRemainingTime(dateValue) {
  const diff = new Date(dateValue).getTime() - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return 'Kadaluarsa';
  const totalMinutes = Math.floor(diff / 60000);
  const days  = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins  = totalMinutes % 60;
  const parts = [];
  if (days)  parts.push(`${days} Hari`);
  if (hours) parts.push(`${hours} Jam`);
  if (mins || !parts.length) parts.push(`${mins} Menit`);

  if (days >= 30) return `~${Math.floor(days / 30)} Bulan lagi (${parts.join(', ')})`;
  if (days >= 7)  return `~${Math.floor(days / 7)} Minggu lagi (${parts.join(', ')})`;
  return `${parts.join(', ')} lagi`;
}
function formatPanelCreatedAt(date = new Date()) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: config.timezone || 'Asia/Jakarta',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date);
}
function parseDurationDays(raw) {
  const value = String(raw || '').trim().toUpperCase();
  const match = value.match(/^(\d+)(H|D|DAY|DAYS|HARI)?$/);
  if (!match) return null;
  const days = Number(match[1]);
  return days > 0 ? days : null;
}
function readPrettyOsName() {
  try {
    const content = fs.readFileSync('/etc/os-release', 'utf8');
    const match = content.match(/^PRETTY_NAME="?(.+?)"?$/m);
    if (match?.[1]) return match[1];
  } catch (_) {}
  return `${os.type()} ${os.release()}`;
}
function readCpuModel() {
  try { return String(os.cpus()?.[0]?.model || 'Unknown').replace(/\s+/g, ' ').trim(); }
  catch (_) { return 'Unknown CPU'; }
}
function readDatacenterLabel() {
  return String(config.datacenter || process.env.P_SERVER_LOCATION || os.hostname() || '-').trim();
}
function readDiskUsage() {
  try {
    const output = execFileSync('df', ['-k', '/'], { encoding: 'utf8' }).trim().split('\n');
    const row = output[1]?.trim().split(/\s+/) || [];
    const totalKb = Number(row[1] || 0), usedKb = Number(row[2] || 0);
    return { usedKb, totalKb, usedPercent: totalKb > 0 ? Math.round((usedKb / totalKb) * 100) : 0 };
  } catch (_) { return { usedKb: 0, totalKb: 0, usedPercent: 0 }; }
}
function readCpuTimes() {
  const stat = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = stat[3] + stat[4], total = stat.reduce((s, v) => s + v, 0);
  return { idle, total };
}
async function sampleCpuUsage() {
  try {
    const start = readCpuTimes();
    await new Promise(r => setTimeout(r, 250));
    const end = readCpuTimes();
    const usage = (end.total - start.total) > 0 ? Math.round((1 - (end.idle - start.idle) / (end.total - start.total)) * 100) : 0;
    return Math.max(0, Math.min(100, usage));
  } catch (_) {
    return Math.min(100, Math.round((os.loadavg()[0] / Math.max(1, os.cpus().length)) * 100));
  }
}
async function pingTarget() {

  const servers = getActiveServers();
  if (servers.length) {
    const target = cleanDomain(servers[0].domain);
    const c1 = new AbortController();
    const t1 = setTimeout(() => c1.abort(), 4000);
    const s1 = Date.now();
    try {
      await fetch(target, { method: 'HEAD', redirect: 'manual', signal: c1.signal });
      clearTimeout(t1);
      return { ms: Date.now() - s1 };
    } catch (_) { clearTimeout(t1); }
  }

  const c2 = new AbortController();
  const t2 = setTimeout(() => c2.abort(), 5000);
  const s2 = Date.now();
  try {
    await fetch('https://api.telegram.org', { method: 'HEAD', redirect: 'manual', signal: c2.signal });
    clearTimeout(t2);
    return { ms: Date.now() - s2 };
  } catch (_) { clearTimeout(t2); return null; }
}

async function getServerStatus() {
  const now = Date.now();
  if (serverStatusCache.data && now - serverStatusCache.ts < 15000) return serverStatusCache.data;
  const osName = readPrettyOsName();
  const cpuModel = readCpuModel();
  const datacenterText = readDatacenterLabel();
  const uptimeText = formatDuration(os.uptime());
  const ramTotal = os.totalmem(), ramUsed = ramTotal - os.freemem();
  const ramPercent = ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : 0;
  const disk = readDiskUsage();
  const cpuPercent = await sampleCpuUsage();
  const ping = await pingTarget();
  let statusLine = 'Online & Stable';
  if (!ping) statusLine = 'Online';
  else if (cpuPercent >= 85 || ramPercent >= 90 || disk.usedPercent >= 95) statusLine = 'High Load';
  else if (ping.ms >= 250) statusLine = 'Online';
  const data = {
    statusLine, osName, cpuModel, datacenterText, uptimeText,
    pingText: ping ? `${ping.ms}ms` : 'N/A',
    cpuPercent, cpuBar: progressBar(cpuPercent),
    ramUsedText: formatBytesToGB(ramUsed), ramTotalText: formatBytesToGB(ramTotal),
    ramPercent, ramBar: progressBar(ramPercent),
    diskUsedText: formatKbToGB(disk.usedKb), diskTotalText: formatKbToGB(disk.totalKb),
    diskPercent: disk.usedPercent, diskBar: progressBar(disk.usedPercent)
  };
  serverStatusCache = { ts: now, data };
  return data;
}

function isPrimaryOwner(userId) {

  const raw = config.ownerIds ?? config.ownerId;
  const ids = Array.isArray(raw)
    ? raw.map(String).filter(Boolean)
    : [String(raw || '')].filter(Boolean);
  return ids.includes(String(userId));
}
function isOwner(userId) { return isPrimaryOwner(userId); }

function savePendingPanel(userId, caption, keyboard) {
  try {
    const key = path.join(DB_DIR, `pending_panel_${userId}.json`);
    fbWrite(key, {
      caption,
      keyboardMarkup: keyboard?.reply_markup ?? (keyboard?.inline_keyboard ? keyboard : null),
      at: Date.now(),
      delivered: false,
    });
  } catch (_) {}
}

function requireGroupChat(ctx) {
  if (['group', 'supergroup'].includes(ctx.chat?.type)) return false;
  ctx.reply(
    '🔒 <b>Command ini hanya bisa digunakan di Grup.</b>\n\n' +
    '<i>Buat panel di grup agar admin bisa memantau. Data login akan dikirim ke Private Chat kamu.</i>',
    { parse_mode: 'HTML' }
  ).catch(() => {});
  return true;
}

function getCallerAddroleRank(userId) {
  if (isOwner(userId)) return Infinity;
  const role = db.getUserRole(userId);
  if (!role || !ROLE_DEFINITIONS[role]) return 0;
  return ROLE_DEFINITIONS[role].rankOrder;
}

function canUseAddrole(userId) {
  if (isOwner(userId)) return true;
  const role = db.getUserRole(userId);
  if (!role || !ROLE_DEFINITIONS[role]) return false;

  const rank = ROLE_DEFINITIONS[role].rankOrder;
  return rank > 1;
}

function allowedTiersForRank(callerRank) {
  const tiers = new Set();
  for (const def of Object.values(ROLE_DEFINITIONS)) {
    if (def.rankOrder < callerRank) tiers.add(def.tier);
  }
  return tiers;
}

const CONFIG_KEY_MAP = {
  domain: { v1: 'domain',   v2: 'domainv2', v3: 'domainv3', v4: 'domainv4', v5: 'domainv5' },
  plta:   { v1: 'plta',     v2: 'pltav2',   v3: 'pltav3',   v4: 'pltav4',   v5: 'pltav5'   },
  pltc:   { v1: 'pltc',     v2: 'pltcv2',   v3: 'pltcv3',   v4: 'pltcv4',   v5: 'pltcv5'   },
};

function saveConfigOverride(key, value) {
  const overrides = fbRead(CONFIG_OVERRIDE_FILE, {});
  overrides[key] = value;
  fbWrite(CONFIG_OVERRIDE_FILE, overrides);
}

function scheduleConfigRestart(ctx) {
  if (configChangeTimer) clearTimeout(configChangeTimer);
  configChangeTimer = setTimeout(async () => {
    configChangeTimer = null;
    try {
      await bot.telegram.sendMessage(
        ctx.chat.id,
        '♻️ <b>Config tersimpan — bot sedang restart...</b>\n<i>Semua perubahan aktif setelah restart.</i>',
        { parse_mode: 'HTML' }
      );
    } catch (_) {}

    setTimeout(() => process.exit(0), 800);
  }, 3000);
}

async function handleSetConfig(ctx, type) {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const keyMap = CONFIG_KEY_MAP[type];
  if (!keyMap) return;

  const raw = (ctx.message?.text || '').trim().replace(/^\/\S+\s*/, '');

  const commaIdx = raw.indexOf(',');
  if (commaIdx === -1) {
    return ctx.reply(
      `❌ Format salah.\nContoh: <code>/${type === 'domain' ? 'setdomain' : type === 'plta' ? 'setptla' : 'setptlc'} v1,nilai</code>`,
      { parse_mode: 'HTML' }
    );
  }
  const vKey = raw.slice(0, commaIdx).trim().toLowerCase();
  const value = raw.slice(commaIdx + 1).trim();

  if (!keyMap[vKey]) {
    return ctx.reply(
      `❌ Server tidak valid. Gunakan: <code>v1</code> s.d <code>v5</code>`,
      { parse_mode: 'HTML' }
    );
  }
  if (!value) {
    return ctx.reply('❌ Nilai tidak boleh kosong.', { parse_mode: 'HTML' });
  }

  const configKey = keyMap[vKey];
  config[configKey] = value;
  saveConfigOverride(configKey, value);
  serverStatusCache = { ts: 0, data: null };
  onlineServersCache = { ts: 0, count: null };

  const typeLabel = type === 'domain' ? 'Domain' : type === 'plta' ? 'PLTA' : 'PLTC';
  await ctx.reply(
    [
      `✅ <b>${typeLabel} ${vKey.toUpperCase()} berhasil diubah.</b>`,
      '',
      '<blockquote>',
      `🔑 Key     : <code>${configKey}</code>`,
      `📝 Nilai   : <code>${htmlEscape(value)}</code>`,
      `⏱️ Restart : 3 detik (reset jika /set* lagi)</blockquote>`,
    ].join('\n'),
    { parse_mode: 'HTML' }
  );

  scheduleConfigRestart(ctx);
}

async function handleSetApiKey(ctx) {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });

  const raw = (ctx.message?.text || '').trim().replace(/^\/\S+\s*/, '');

  const idx1 = raw.indexOf(',');
  if (idx1 === -1) {
    return ctx.reply(
      '❌ Format salah.\n' +
      'Gunakan: <code>/setapikey server,domain,ptla,pltc</code>\n' +
      'Contoh: <code>/setapikey v1,https://panel.com,ptla_xxx,ptlc_xxx</code>',
      { parse_mode: 'HTML' }
    );
  }
  const vKey  = raw.slice(0, idx1).trim().toLowerCase();
  const rest1 = raw.slice(idx1 + 1).trim();

  const idx2 = rest1.indexOf(',');
  if (idx2 === -1) {
    return ctx.reply(
      '❌ Format salah — kurang argumen <code>ptla</code>.\n' +
      'Gunakan: <code>/setapikey server,domain,ptla,pltc</code>',
      { parse_mode: 'HTML' }
    );
  }
  const domain = rest1.slice(0, idx2).trim();
  const rest2  = rest1.slice(idx2 + 1).trim();

  const idx3 = rest2.indexOf(',');
  if (idx3 === -1) {
    return ctx.reply(
      '❌ Format salah — kurang argumen <code>pltc</code>.\n' +
      'Gunakan: <code>/setapikey server,domain,ptla,pltc</code>',
      { parse_mode: 'HTML' }
    );
  }
  const ptla = rest2.slice(0, idx3).trim();
  const pltc = rest2.slice(idx3 + 1).trim();

  if (!CONFIG_KEY_MAP.domain[vKey]) {
    return ctx.reply(
      '❌ Server tidak valid. Gunakan: <code>v1</code> s.d <code>v5</code>',
      { parse_mode: 'HTML' }
    );
  }
  if (!domain) return ctx.reply('❌ Domain tidak boleh kosong.', { parse_mode: 'HTML' });
  if (!ptla)   return ctx.reply('❌ PTLA tidak boleh kosong.',   { parse_mode: 'HTML' });
  if (!pltc)   return ctx.reply('❌ PTLC tidak boleh kosong.',   { parse_mode: 'HTML' });

  const domainKey = CONFIG_KEY_MAP.domain[vKey];
  const pltaKey   = CONFIG_KEY_MAP.plta[vKey];
  const pltcKey   = CONFIG_KEY_MAP.pltc[vKey];

  config[domainKey] = domain;
  config[pltaKey]   = ptla;
  config[pltcKey]   = pltc;
  saveConfigOverride(domainKey, domain);
  saveConfigOverride(pltaKey,   ptla);
  saveConfigOverride(pltcKey,   pltc);
  serverStatusCache = { ts: 0, data: null };
  onlineServersCache = { ts: 0, count: null };

  await ctx.reply(
    [
      `✅ <b>API Key ${vKey.toUpperCase()} berhasil diubah.</b>`,
      '',
      '<blockquote>',
      `🌐 Domain : <code>${htmlEscape(domain)}</code>`,
      `🔑 PTLA   : <code>${htmlEscape(ptla)}</code>`,
      `🔑 PTLC   : <code>${htmlEscape(pltc)}</code>`,
      `⏱️ Restart : 3 detik (reset jika /setapikey lagi)</blockquote>`,
    ].join('\n'),
    { parse_mode: 'HTML' }
  );

  scheduleConfigRestart(ctx);
}

function getUserTier(userId) {
  if (isOwner(userId)) return 'owner';
  const role = db.getUserRole(userId);
  if (!role || !ROLE_DEFINITIONS[role]) return null;
  return ROLE_DEFINITIONS[role].tier;
}

function getAllowedServersForUser(userId) {
  const tier = getUserTier(userId);
  if (!tier) return [];
  const allowedIndices = TIER_ALLOWED_SERVERS[tier] || [];
  return getActiveServers().filter(s => allowedIndices.includes(s.index));
}

function canUseAdminPanel(userId) {
  if (isOwner(userId)) return true;
  const tier = getUserTier(userId);
  return tier ? Boolean(TIER_CAN_ADMIN_PANEL[tier]) : false;
}

function hasAccessForPanel(userId) {
  return getAllowedServersForUser(userId).length > 0;
}

function getServerAccessDisplay(userId) {
  const tier = getUserTier(userId);
  const allowedIndices = tier ? (TIER_ALLOWED_SERVERS[tier] || []) : [];
  return [1, 2, 3, 4, 5].map(i => ({ index: i, allowed: allowedIndices.includes(i) }));
}

function getUserStatusLabel(userId) {
  if (isOwner(userId)) return 'Owner 👑';
  const role = db.getUserRole(userId);
  if (role && ROLE_DEFINITIONS[role]) return 'Verified ✅';
  return 'Not Verified ❌';
}

function getRoleDisplayLabel(userId) {
  if (isOwner(userId)) return '👑 Owner Utama Bot';
  const role = db.getUserRole(userId);
  if (!role || !ROLE_DEFINITIONS[role]) return '❌ Tidak Ada Role';
  const def = ROLE_DEFINITIONS[role];
  return `${def.label} [${def.tier.toUpperCase()}]`;
}

function getUserRoleDisplay(userId) {
  if (isOwner(userId)) return { label: 'Owner', tier: 'owner', tierLabel: TIER_LABELS.owner, expiresAt: null };
  const entry = db.getRoleEntry(userId);
  if (!entry || !ROLE_DEFINITIONS[entry.role]) return null;
  const def = ROLE_DEFINITIONS[entry.role];
  return { label: def.label, tier: def.tier, tierLabel: def.tierLabel, expiresAt: entry.expiresAt, addedAt: entry.addedAt };
}

function getOwnerDisplay() { return `${config.ownerName || 'HanzPiw Official'} (${config.ownerUsername || '@itshanzpiw'})`; }
function mentionUser(ctx) { return [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User'; }
function getDisplayUsername(ctx) {
  const u = ctx.from?.username; return u ? `@${u}` : mentionUser(ctx);
}
function resolveTargetUserId(ctx, args) {
  const fromReply = ctx.message?.reply_to_message?.from?.id;
  if (fromReply) return String(fromReply);
  if (args[0] && /^\d+$/.test(args[0])) return String(args[0]);
  return null;
}

const ANIM_COLORS = ['primary', 'danger', 'success'];
const ANIM_INTERVAL = 5000;
const ANIM_DURATION = 120000;
const MAX_ACTIVE_ANIMS = 30;
const activeAnims = new Map();

function paintMarkup(markup, tick) {
  const color = ANIM_COLORS[tick % ANIM_COLORS.length];
  return {
    ...markup,
    inline_keyboard: (markup.inline_keyboard || []).map(row =>
      row.map(btn => ({ ...btn, style: color }))
    )
  };
}
function stopButtonAnim(key) {
  const a = activeAnims.get(key);
  if (a) { clearTimeout(a.timer); activeAnims.delete(key); }
}
function startButtonAnim(chatId, messageId, markup) {
  if (!chatId || !messageId || !markup?.inline_keyboard?.length) return;
  const key = `${chatId}:${messageId}`;
  stopButtonAnim(key);
  if (activeAnims.size >= MAX_ACTIVE_ANIMS) stopButtonAnim(activeAnims.keys().next().value);
  const startedAt = Date.now();
  const a = { tick: 0, timer: null };
  activeAnims.set(key, a);
  const step = async () => {
    if (Date.now() - startedAt >= ANIM_DURATION) return stopButtonAnim(key);
    a.tick++;
    try {
      await bot.telegram.callApi('editMessageReplyMarkup', {
        chat_id: chatId, message_id: messageId,
        reply_markup: paintMarkup(markup, a.tick)
      });
    } catch (err) {
      const msg = String(err?.message || '');
      if (!/message is not modified/i.test(msg)) return stopButtonAnim(key);
    }
    if (activeAnims.get(key) === a) {
      a.timer = setTimeout(step, ANIM_INTERVAL);
      if (a.timer.unref) a.timer.unref();
    }
  };
  a.timer = setTimeout(step, ANIM_INTERVAL);
  if (a.timer.unref) a.timer.unref();
}

function toSmallCaps(value) {
  const n = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const m = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ0123456789';
  const map = Object.fromEntries(Array.from(n).map((c, i) => [c, Array.from(m)[i]]));
  return Array.from(String(value)).map(c => map[c] || c).join('');
}
function eF(t) { return toSmallCaps(String(t)); }
function eUp(t) { return toSmallCaps(String(t).toUpperCase()); }

function backToMenuKeyboard() {
  return Markup.inlineKeyboard([[{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: "danger"}]]);
}
function menuKeyboard(ctx) {

  const uid  = ctx.from?.id;
  const rows = [];

  rows.push([
    { text: eF('『 🗂️ 』 Panel Menu'),   callback_data: 'panel_menu',   style: 'primary'},
    { text: eF('『 🖥️ 』 Server Menu'), callback_data: 'server_menu',  style: 'primary'},
  ]);

  rows.push([
    { text: eF('『 👤 』 Info User'),    callback_data: 'info_user',    style: 'primary'},
    { text: eF('『 👑 』 Owner Menu'),   callback_data: 'owner_menu',   style: isOwner(uid) ? 'danger' : 'primary'},
  ]);

  rows.push([
    { text: eF('『 ⚙️ 』 Pusat Kontrol'), callback_data: 'pusat_kontrol', style: isOwner(uid) ? 'danger' : 'primary'},
  ]);

  rows.push([
    { text: eF('『 🙏 』 Thanks To'),   callback_data: 'thanks_to',    style: 'primary'},
    { text: eF('『 👨‍💻 』 Developer'),   callback_data: 'developer',    style: 'primary'},
  ]);

  return Markup.inlineKeyboard(rows);
}
function ownerMenuKeyboard() {
  return Markup.inlineKeyboard([
    [{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: "danger"}],
  ]);
}
function resultActionKeyboard(loginUrl, username, password) {

  const rows = [
    [{ text: eF('🔗 LOGIN PANEL'), url: loginUrl || 'https://panel.example.com' }],
    [{ text: eF('『 📋 』 Copy Username'), copy_text: { text: String(username || '-').slice(0, 256) } }],
  ];
  if (password && password !== 'Password lama / existing user') {
    rows.push([{ text: '🔑 Copy Password', copy_text: { text: String(password).slice(0, 256) } }]);
  } else {
    rows.push([{ text: eF('『 🔐 』 Info Password'), callback_data: 'copy_pass_existing', style: "primary"}]);
  }

  return Markup.inlineKeyboard(rows);
}
function delServerConfirmKeyboard(serverId) {
  return Markup.inlineKeyboard([
    [{ text: eF('『 🗑️ 』 Ya, Hapus Server'), callback_data: `confirm_del_server_${serverId}`, style: "danger"}],
    [{ text: eF('『 ✖️ 』 Batal'), callback_data: 'owner_menu', style: "success"}]
  ]);
}
function delAllServersConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [{ text: eF('『 🗑️ 』 Ya, Hapus Semua Server!'), callback_data: 'confirm_del_srv_all', style: "danger"}],
    [{ text: eF('『 ✖️ 』 Batal'), callback_data: 'owner_menu', style: "success"}]
  ]);
}

function delServerSlotKeyboard() {
  return Markup.inlineKeyboard([
    [
      { text: eF('『 1️⃣ 』 Server 1'), callback_data: 'delserver_slot_v1', style: "danger"},
      { text: eF('『 2️⃣ 』 Server 2'), callback_data: 'delserver_slot_v2', style: "danger"},
    ],
    [
      { text: eF('『 3️⃣ 』 Server 3'), callback_data: 'delserver_slot_v3', style: "danger"},
      { text: eF('『 4️⃣ 』 Server 4'), callback_data: 'delserver_slot_v4', style: "danger"},
    ],
    [{ text: eF('『 5️⃣ 』 Server 5'), callback_data: 'delserver_slot_v5', style: "danger"}],
    [{ text: eF('『 🗑️ 』 Hapus Semua Slot'), callback_data: 'delserver_all', style: "danger"}],
    [{ text: eF('『 ✖️ 』 Batal'), callback_data: 'owner_menu', style: "success"}],
  ]);
}
function delServerSlotConfirmKeyboard(vn) {
  return Markup.inlineKeyboard([
    [{ text: eF(`『 🗑️ 』 Ya, Hapus Semua Di V${vn}`), callback_data: `confirm_delserver_slot_v${vn}`, style: "danger"}],
    [{ text: eF('『 ✖️ 』 Batal'), callback_data: 'owner_menu', style: "success"}],
  ]);
}

function delUserSlotKeyboard() {
  return Markup.inlineKeyboard([
    [
      { text: eF('『 1️⃣ 』 Server 1'), callback_data: 'deluser_slot_v1', style: "danger"},
      { text: eF('『 2️⃣ 』 Server 2'), callback_data: 'deluser_slot_v2', style: "danger"},
    ],
    [
      { text: eF('『 3️⃣ 』 Server 3'), callback_data: 'deluser_slot_v3', style: "danger"},
      { text: eF('『 4️⃣ 』 Server 4'), callback_data: 'deluser_slot_v4', style: "danger"},
    ],
    [{ text: eF('『 5️⃣ 』 Server 5'), callback_data: 'deluser_slot_v5', style: "danger"}],
    [{ text: eF('『 🗑️ 』 Hapus Semua Slot'), callback_data: 'deluser_all', style: "danger"}],
    [{ text: eF('『 ✖️ 』 Batal'), callback_data: 'owner_menu', style: "success"}],
  ]);
}
function delUserSlotConfirmKeyboard(vn) {
  return Markup.inlineKeyboard([
    [{ text: eF(`『 👥 』 Ya, Hapus User Di V${vn}`), callback_data: `confirm_deluser_slot_v${vn}`, style: "danger"}],
    [{ text: eF('『 ✖️ 』 Batal'), callback_data: 'owner_menu', style: "success"}],
  ]);
}

function delVnConfirmKeyboard(vn, serverId) {
  return Markup.inlineKeyboard([
    [{ text: eF(`『 🗑️ 』 Ya, Hapus Server`), callback_data: `confirm_del_server_v${vn}_${serverId}`, style: "danger"}],
    [{ text: eF('『 ✖️ 』 Batal'), callback_data: 'owner_menu', style: "success"}],
  ]);
}

function serverSelectionKeyboard(type) {
  return Markup.inlineKeyboard([
    [{ text: eF('『 1️⃣ 』 Server 1'), callback_data: `${type}_select_v1`, style: "primary"}, { text: eF('『 2️⃣ 』 Server 2'), callback_data: `${type}_select_v2`, style: "primary"}],
    [{ text: eF('『 3️⃣ 』 Server 3'), callback_data: `${type}_select_v3`, style: "primary"}, { text: eF('『 4️⃣ 』 Server 4'), callback_data: `${type}_select_v4`, style: "primary"}],
    [{ text: eF('『 5️⃣ 』 Server 5'), callback_data: `${type}_select_v5`, style: "primary"}],
    [{ text: eF('『 ✖️ 』 Batal'), callback_data: `${type}_cancel`, style: "danger"}],
  ]);
}

function sendServerSelectionMenu(ctx, type) {
  const label = type === 'ls' ? 'LIST SERVER' : 'LIST USER';

  const overrides = fbRead(CONFIG_OVERRIDE_FILE, {});

  const merged = { ...config, ...overrides };

  const slots = [
    { index: 1, domain: merged.domain,   plta: merged.plta   },
    { index: 2, domain: merged.domainv2, plta: merged.pltav2 },
    { index: 3, domain: merged.domainv3, plta: merged.pltav3 },
    { index: 4, domain: merged.domainv4, plta: merged.pltav4 },
    { index: 5, domain: merged.domainv5, plta: merged.pltav5 },
  ];

  const activeSlots = slots.filter(s => {
    const dom  = String(s.domain || '').trim();
    const plta = String(s.plta   || '').trim();
    return dom && /^https?:\/\//i.test(dom) &&
           plta && /^ptla_/i.test(plta) && !plta.includes('APPLICATION_API_KEY');
  });

  if (!activeSlots.length)
    return renderCard(ctx, `${'❌'} Tidak ada server aktif di config_override.json.`, ownerMenuKeyboard());

  const rows = [];
  for (let i = 0; i < activeSlots.length; i += 2) {
    const row = [{ text: eF(`『 🖥️ 』 Server ${activeSlots[i].index}`), callback_data: `${type}_select_v${activeSlots[i].index}`, style: "primary"}];
    if (activeSlots[i + 1])
      row.push({ text: eF(`『 🖥️ 』 Server ${activeSlots[i + 1].index}`), callback_data: `${type}_select_v${activeSlots[i + 1].index}`, style: "primary"});
    rows.push(row);
  }
  rows.push([{ text: eF('『 ✖️ 』 Batal'), callback_data: `${type}_cancel`, style: "danger"}]);

  const lines = activeSlots.map(s => `🖥️ <b>Server ${s.index}</b> — ${sensorDomain(s.domain)}`);
  const caption = eBox(`🖥️ PILIH SERVER — ${label}`, [
    'Silahkan pilih server yang ingin ditampilkan:',
    '',
    ...lines,
  ]);

  return renderCard(ctx, caption, Markup.inlineKeyboard(rows));
}

async function sendListUsersForServer(ctx, serverIndex, page = 1, options = {}) {
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Menu ini khusus owner.', Markup.inlineKeyboard([]), options);

  try {
    const servers = getActiveServers();
    const server = servers.find(s => s.index === serverIndex);
    if (!server) {
      return renderCard(ctx, `❌ Server V${serverIndex} tidak aktif.`, ownerMenuKeyboard(), options);
    }

    let allUsers = [];
    try {
      allUsers = await getAllPterodactylUsersOn(server);
    } catch (_) {}

    if (!allUsers.length) {
      return renderCard(ctx, `❌Tidak ada user di Server V${serverIndex}.`, ownerMenuKeyboard(), options);
    }

    const perPage = 10, totalPages = Math.max(1, Math.ceil(allUsers.length / perPage));
    const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
    const slice = allUsers.slice((current - 1) * perPage, current * perPage);

    const lines = slice.map((item, idx) => {
      const a = item.attributes || {};
      return `${(current - 1) * perPage + idx + 1}. <b>${htmlEscape(a.username || 'No username')}</b><br>   ID: <code>${a.id}</code>`;
    });

    const rows = [];
    if (current > 1) rows.push({ text: eF('『 ◀ 』 Sebelumnya'), callback_data: `lu_page_v${serverIndex}_${current - 1}`, style: "primary"});
    if (current < totalPages) rows.push({ text: eF('『 ▶ 』 Selanjutnya'), callback_data: `lu_page_v${serverIndex}_${current + 1}`, style: "primary"});

    const caption = [
      `👤 <b>LIST USER — SERVER V${serverIndex}</b>`,
      `Total: <b>${allUsers.length}</b> user`,
      `Halaman ${current}/${totalPages}`, '',
      ...(lines.length ? lines : ['Belum ada user.'])
    ].join('<br>');

    const keyboard = Markup.inlineKeyboard([
      ...(rows.length ? [rows] : []),
      [{ text: eF('『 🖥️ 』 Pilih Server'), callback_data: 'lu_back', style: "primary"}, { text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: "danger"}]
    ]);

    return renderCard(ctx, caption, keyboard, options);
  } catch (error) {
    return renderCard(ctx, `❌ Gagal mengambil daftar user.\n\n${htmlEscape(error.message || error)}`, ownerMenuKeyboard(), options);
  }
}

function tierSelectionKeyboard(callerRank = Infinity) {
  const allowed = allowedTiersForRank(callerRank);
  const allTiers = [
    { tier: 'akma', label: '🟡 Akma — Akses Pertama' },
    { tier: 'akme', label: '🔵 Akme — Akses Menengah' },
    { tier: 'akti', label: '🔴 Akti — Akses Tinggi'  },
  ].filter(t => allowed.has(t.tier));
  const rows = allTiers.map(t => [{ text: eF(t.label), callback_data: `addrole_tier_${t.tier}`, style: "primary"}]);
  rows.push([{text: eF('『 ✖️ 』 Batal'), callback_data: 'addrole_cancel', style: "danger"}]);
  return Markup.inlineKeyboard(rows);
}
function roleSelectionKeyboard(tier, callerRank = Infinity) {
  const tierRoles = Object.entries(ROLE_DEFINITIONS)
    .filter(([_, def]) => def.tier === tier && def.rankOrder < callerRank)
    .map(([key, def]) => ({ text: eF(def.label), callback_data: `addrole_role_${key}`, style: "primary"}));
  const rows = [];
  for (let i = 0; i < tierRoles.length; i += 2) rows.push(tierRoles.slice(i, i + 2));
  rows.push([{ text: eF('『 🎖️ 』 Pilih Tier'), callback_data: 'addrole_back_tier', style: "primary"}, { text: eF('『 ✖️ 』 Batal'), callback_data: 'addrole_cancel', style: "danger"}]);
  return Markup.inlineKeyboard(rows);
}
function durationSelectionKeyboard() {
  return Markup.inlineKeyboard([
    [{ text: eF('『 ∞ 』 Permanent'), callback_data: 'addrole_dur_permanent', style: "success"}],
    [{ text: eF('『 7 』 Hari'), callback_data: 'addrole_dur_7', style: "primary"},   { text: eF('『 14 』 Hari'), callback_data: 'addrole_dur_14', style: "primary"}],
    [{ text: eF('『 30 』 Hari'), callback_data: 'addrole_dur_30', style: "primary"},  { text: eF('『 90 』 Hari'), callback_data: 'addrole_dur_90', style: "primary"}],
    [{ text: eF('『 180 』 Hari'), callback_data: 'addrole_dur_180', style: "primary"}, { text: eF('『 365 』 Hari'), callback_data: 'addrole_dur_365', style: "primary"}],
    [{ text: eF('『 🎭 』 Pilih Role'), callback_data: 'addrole_back_role', style: "primary"}, { text: eF('『 ✖️ 』 Batal'), callback_data: 'addrole_cancel', style: "danger"}]
  ]);
}

const MENU_IMAGE_IS_REMOTE = /^https?:\/\//i.test(config.menuImage);
function hasMenuImage() { return Boolean(config.menuImage && (MENU_IMAGE_IS_REMOTE || fs.existsSync(config.menuImage))); }
function menuPhotoSource() { return MENU_IMAGE_IS_REMOTE ? config.menuImage : { source: config.menuImage }; }
function asTelegramBlockquote(caption) {
  const body = String(caption ?? '').replace(/<\/?blockquote\b[^>]*>/gi, '').trim();
  return `<blockquote>${body}</blockquote>`;
}

function get429RetryAfter(error) {
  const msg = String(error?.message || '');
  if (error?.response?.error_code === 429 || msg.includes('429') || msg.toLowerCase().includes('too many requests')) {
    return (error?.response?.parameters?.retry_after) || parseInt(msg.match(/retry after (\d+)/i)?.[1]) || 30;
  }
  return 0;
}

async function safeSend(fn) {
  try {
    return await fn();
  } catch (err) {
    const retryAfter = get429RetryAfter(err);
    if (retryAfter > 0) {
      console.warn(`[RATE LIMIT] 429 — menunggu ${retryAfter}s lalu retry...`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      try { return await fn(); } catch (retryErr) {
        console.error('[RATE LIMIT] Retry gagal:', retryErr.message);
        return null;
      }
    }
    throw err;
  }
}

let richDisabled = false;
let richDisabledAt = 0;

function isRichAvailable() {
  if (!richDisabled) return true;
  if (Date.now() - richDisabledAt >= RICH_RETRY_MS) {
    richDisabled = false;
    richDisabledAt = 0;
    return true;
  }
  return false;
}

function disableRich() {
  richDisabled = true;
  richDisabledAt = Date.now();
}

function richEscape(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function noRichMethod(e) {
  return /method not found|unknown method|not supported/i.test(String(e?.message || ''));
}
function richTable(head, rows) {
  return '<table bordered striped><tr>' +
    head.map(x => `<th>${x}</th>`).join('') + '</tr>' +
    rows.map(r => '<tr>' + r.map(x => `<td>${x}</td>`).join('') + '</tr>').join('') +
    '</table>';
}
function richTitle(icon, text)   { return `<h1>${icon ? icon + ' ' : ''}${richEscape(text)}</h1>`; }
function richSub(icon, text)     { return `<h2>${icon ? icon + ' ' : ''}${richEscape(text)}</h2>`; }
function richPara(...lines)      { return `<p>${lines.flat().join('<br>')}</p>`; }
function richQuote(...lines)     { return `<blockquote>${lines.flat().join('<br>')}</blockquote>`; }
function richNote(icon, text, body) {
  return richQuote(`${icon} <b>${richEscape(text)}</b>${body ? '<br>' + body : ''}`);
}
function richFold(summary, ...body) {
  return `<details><summary>${summary}</summary><p>${body.flat().join('<br>')}</p></details>`;
}
function richBullets(items) { return richPara(items.map(x => `• ${x}`)); }

function toLegacy(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n<b>$1</b>\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n<b>$1</b>\n')
    .replace(/<table[^>]*>[\s\S]*?<\/table>/gi, m => {

      const rows = [];
      const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let tr;
      while ((tr = trRe.exec(m)) !== null) {
        const cells = [];
        let cell;
        const cRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        while ((cell = cRe.exec(tr[1])) !== null) cells.push(cell[1].trim());
        if (cells.length) rows.push(cells.join(' │ '));
      }
      return rows.length ? `<blockquote>${rows.join('\n')}</blockquote>` : '';
    })
    .replace(/<details[^>]*>[\s\S]*?<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi,
      (_, summary, body) => `<b>${summary}</b>\n${body.replace(/<\/?p>/gi, '')}`)
    .replace(/<\/?p>/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function makeView(rich) { return { rich, legacy: toLegacy(rich) }; }

function parseInlineRich(html) {
  const parts = [];

  let str = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/gi, '$1');
  const inlineRe = /<(b|i|u|s|code)(?:[^>]*)>([\s\S]*?)<\/\1>/gi;
  let lastIdx = 0, m;
  while ((m = inlineRe.exec(str)) !== null) {
    if (m.index > lastIdx) {
      const plain = str.slice(lastIdx, m.index).replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      if (plain) parts.push(plain);
    }
    const inner = m[2].replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const typeMap = { b: 'bold', i: 'italic', u: 'underline', s: 'strikethrough', code: 'code' };
    if (inner) parts.push({ type: typeMap[m[1]] || 'bold', text: inner });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < str.length) {
    const plain = str.slice(lastIdx).replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (plain) parts.push(plain);
  }
  if (!parts.length) return '';
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0];
  return parts;
}

function parseTableBlock(tableHtml) {
  const cells2d = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trM;
  while ((trM = trRe.exec(tableHtml)) !== null) {
    const rowHtml = trM[1];
    const isHeader = /<th/i.test(rowHtml);
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cM;
    const rowCells = [];
    while ((cM = cellRe.exec(rowHtml)) !== null) {
      const cell = {
        align: isHeader ? 'center' : 'left',
        valign: 'middle',
        text: parseInlineRich(cM[1]),
      };
      if (isHeader) cell.is_header = true;
      rowCells.push(cell);
    }
    if (rowCells.length) cells2d.push(rowCells);
  }
  if (!cells2d.length) return null;

  const maxCols = Math.max(...cells2d.map(r => r.length));
  cells2d.forEach(row => {
    if (row.length < maxCols) row[row.length - 1].colspan = maxCols - row.length + 1;
  });
  return { type: 'table', is_bordered: true, is_striped: true, cells: cells2d };
}

function htmlToBlocks(html) {
  const blocks = [];
  let pos = 0;
  const str = String(html || '');
  while (pos < str.length) {

    while (pos < str.length && /\s/.test(str[pos])) pos++;
    if (pos >= str.length) break;
    const rest = str.slice(pos);
    let m;
    if ((m = /^<(h[123])[^>]*>([\s\S]*?)<\/\1>/i.exec(rest))) {
      const size = parseInt(m[1][1]);
      blocks.push({ type: 'heading', text: parseInlineRich(m[2]), size });
      pos += m[0].length;
    } else if ((m = /^<table[^>]*>([\s\S]*?)<\/table>/i.exec(rest))) {
      const tb = parseTableBlock(m[1]);
      if (tb) blocks.push(tb);
      pos += m[0].length;
    } else if ((m = /^<details[^>]*>([\s\S]*?)<\/details>/i.exec(rest))) {
      const sumM = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(m[1]);
      if (sumM) {
        const body = m[1].slice(sumM.index + sumM[0].length).replace(/<\/?p[^>]*>/gi, '').trim();
        const sumParsed = parseInlineRich(sumM[1]);
        const bodyStr = body ? body.replace(/<br\s*\/?>/gi, '\n') : '';
        const bodyParsed = bodyStr ? parseInlineRich(bodyStr) : null;

        const toArr = v => (v === null || v === undefined || v === '') ? [] : (Array.isArray(v) ? v : [v]);
        const parts = [
          ...toArr(sumParsed),
          ...(bodyParsed !== null ? ['\n', ...toArr(bodyParsed)] : [])
        ].filter(x => x !== '' && x != null);
        const textFull = parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts;
        blocks.push({ type: 'expandable_blockquote', text: textFull });
      }
      pos += m[0].length;
    } else if ((m = /^<blockquote[^>]*>([\s\S]*?)<\/blockquote>/i.exec(rest))) {
      const innerHtml = m[1].replace(/<br\s*\/?>/gi, '\n');
      const lines = innerHtml.split('\n');
      const paragraphBlocks = lines
        .map(line => {
          const text = parseInlineRich(line);
          if (text === '' || text == null) return null;
          return { type: 'paragraph', text };
        })
        .filter(Boolean);
      blocks.push({
        type: 'blockquote',
        blocks: paragraphBlocks.length ? paragraphBlocks : [{ type: 'paragraph', text: '' }]
      });
      pos += m[0].length;
    } else if ((m = /^<p[^>]*>([\s\S]*?)<\/p>/i.exec(rest))) {
      const text = parseInlineRich(m[1].replace(/<br\s*\/?>/gi, '\n'));
      if (text) blocks.push({ type: 'paragraph', text });
      pos += m[0].length;
    } else {
      pos++;
    }
  }
  return blocks;
}

async function sendRich(chatId, view, extra = {}, thumbUrl = null) {
  if (isRichAvailable()) {
    try {
      let richMsg;
      if (thumbUrl) {

        const contentBlocks = htmlToBlocks(view.rich);
        richMsg = { blocks: [{ type: 'photo', photo: { type: 'photo', media: thumbUrl } }, ...contentBlocks] };
      } else {

        richMsg = { html: view.rich };
      }
      return await bot.telegram.callApi('sendRichMessage', {
        chat_id: chatId,
        rich_message: richMsg,
        ...extra
      });
    } catch (e) {
      if (noRichMethod(e)) { disableRich(); }
      else { console.error('[RICH] send:', e.message); }
    }
  }

  if (thumbUrl) {
    const legacyText = view.legacy;
    if (legacyText.length <= 1024) {
      return bot.telegram.sendPhoto(chatId, thumbUrl, {
        caption: legacyText,
        parse_mode: 'HTML',
        ...extra
      });
    }

    await bot.telegram.sendPhoto(chatId, thumbUrl).catch(e => console.error('[THUMB]', e.message));
    return bot.telegram.sendMessage(chatId, legacyText, { parse_mode: 'HTML', ...extra });
  }
  return bot.telegram.sendMessage(chatId, view.legacy, { parse_mode: 'HTML', ...extra });
}

async function editRich(chatId, msgId, view, extra = {}) {
  if (isRichAvailable()) {
    try {
      return await bot.telegram.callApi('editRichMessage', {
        chat_id: chatId,
        message_id: msgId,
        rich_message: { html: view.rich },
        ...extra
      });
    } catch (e) {
      if (noRichMethod(e)) { disableRich(); }
    }
  }
  return bot.telegram.editMessageText(chatId, msgId, null, view.legacy, { parse_mode: 'HTML', ...extra });
}

async function renderCard(ctx, richHtml, keyboard, options = {}) {
  const kb = keyboard || backToMenuKeyboard();
  const replyMarkup = kb.reply_markup;
  const view = makeView(richHtml);
  const isEdit = Boolean(options.edit && ctx.callbackQuery?.message?.message_id);
  const chatId = ctx.chat?.id;
  const msgId  = isEdit ? ctx.callbackQuery.message.message_id : null;

  if (isEdit) {
    try {
      const result = await editRich(chatId, msgId, view,
        replyMarkup ? { reply_markup: replyMarkup } : {});
      if (msgId && replyMarkup) startButtonAnim(chatId, msgId, replyMarkup);
      return result;
    } catch (e) {
      if (String(e?.message || '').includes('message is not modified')) {
        if (msgId && replyMarkup) startButtonAnim(chatId, msgId, replyMarkup);
        return null;
      }
      try { await bot.telegram.deleteMessage(chatId, msgId); } catch (_) {}
      console.error('[EDIT ERROR]', e.message);
    }
  }

  const thumbUrl = (options.thumb && config.thumbnailUrl) ? config.thumbnailUrl : null;
  try {
    const sent = await sendRich(chatId, view, replyMarkup ? { reply_markup: replyMarkup } : {}, thumbUrl);
    if (sent?.message_id && replyMarkup) startButtonAnim(chatId, sent.message_id, replyMarkup);
    return sent;
  } catch (err) {
    console.error('[SEND RICH ERROR]', err.message);
    return null;
  }
}

async function sendDirectCard(chatId, caption, keyboard = backToMenuKeyboard()) {
  const kb = keyboard || backToMenuKeyboard();
  const replyMarkup = kb.reply_markup;
  const view = makeView(caption);

  const sent = await sendRich(chatId, view, replyMarkup ? { reply_markup: replyMarkup } : {}, config.thumbnailUrl || null);
  if (sent?.message_id && replyMarkup) startButtonAnim(chatId, sent.message_id, replyMarkup);
  return sent;
}

async function safeAnswer(ctx, text) { try { await ctx.answerCbQuery(text || 'Proses memuat menu...'); } catch (_) {} }

async function buildMenuCaption(ctx, stats) {
  const username = ctx.from?.username ? `@${ctx.from.username}` : '-';
  const roleInfo = getUserRoleDisplay(ctx.from.id);
  const botName  = config.botName || 'Cpanel Jayss X HanzPiw';
  const onlineCount = await getOnlineServerCount();
  const badge    = tierBadge(roleInfo?.tier);

  const eventMap = [
    { month: 1,  day: 1,  name: '🎊 Tahun Baru', emoji: '🎊' },
    { month: 8,  day: 17, name: '🇮🇩 HUT RI',    emoji: '🇮🇩' },
    { month: 12, day: 25, name: '🎄 Natal',       emoji: '🎄' },
    { month: 12, day: 31, name: '🎆 Malam Tahun Baru', emoji: '🎆' },
  ];
  const nowEv    = new Date();
  const curEv    = eventMap.find(e => e.month === nowEv.getMonth() + 1 && e.day === nowEv.getDate());
  const botTitle = curEv ? `${curEv.name} — ${botName}` : botName;

  const waktuWIB = new Intl.DateTimeFormat('id-ID', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: config.timezone || 'Asia/Jakarta',
  }).format(new Date()).replace(',', '') + ' WIB';

  const roleLabel = roleInfo
    ? `${badge} ${richEscape(TIER_LABELS[roleInfo.tier] || roleInfo.tier)}`
    : '👤 User';

  const rich = [
    richTitle('⚡', botTitle),
    richPara(`🔼 Halo, <b>${richEscape(ctx.from?.first_name || 'User')}</b>`),
    richQuote('🎉 Pilih menu yang dibutuhkan.', '💎 Akses mengikuti role akun.'),
    richTable(
      ['👤 Akun', 'Detail'],
      [
        ['Nama',     richEscape(ctx.from?.first_name || 'User')],
        ['Username', richEscape(username)],
        ['ID',       `<code>${richEscape(String(ctx.from.id))}</code>`],
        ['Role',     `<b>${roleLabel}</b>`],
        ['Waktu',    richEscape(waktuWIB)],
      ]
    ),
    richTable(
      ['🤖 Bot', 'Detail'],
      [
        ['Nama',    richEscape(botName)],
        ['Username', BOT_USERNAME ? richEscape(`@${BOT_USERNAME}`) : '—'],
        ['Versi',   'v2.5'],
        ['Aktif',   `<b>${richEscape(stats.uptimeText || '—')}</b>`],
        ['Ping',    `<b>${richEscape(stats.pingText || 'N/A')}</b>`],
        ['Server',  `<b>${richEscape(String(onlineCount))}</b> aktif`],
        ...(curEv ? [['Event', richEscape(curEv.name)]] : []),
      ]
    ),
  ].join('\n');

  return rich;
}

async function sendMenu(ctx, options = {}) {
  db.trackUser(ctx.from.id);
  let stats;
  try { stats = await getServerStatus(); }
  catch (_) {
    stats = {
      statusLine: 'Online', pingText: 'N/A', osName: readPrettyOsName(), cpuModel: readCpuModel(),
      datacenterText: readDatacenterLabel(), uptimeText: formatDuration(os.uptime()),
      cpuPercent: 0, cpuBar: progressBar(0),
      ramUsedText: '0.0GB', ramTotalText: formatBytesToGB(os.totalmem()),
      ramPercent: 0, ramBar: progressBar(0),
      diskUsedText: '0.0GB', diskTotalText: '0.0GB', diskPercent: 0, diskBar: progressBar(0)
    };
  }
  const richHtml = await buildMenuCaption(ctx, stats);
  return renderCard(ctx, richHtml, menuKeyboard(ctx), { thumb: true, ...options });
}

async function sendProfile(ctx, options = {}) {
  const roleInfo = getUserRoleDisplay(ctx.from.id);
  const expStr = roleInfo?.expiresAt
    ? formatRemainingTime(roleInfo.expiresAt) + ' lagi'
    : (roleInfo ? 'Permanent ∞' : '—');

  const richHtml = [
    richTitle('👤', 'Profil Akun'),
    richTable(
      ['Field', 'Value'],
      [
        ['Username', richEscape(getDisplayUsername(ctx))],
        ['User ID',  `<code>${richEscape(String(ctx.from.id))}</code>`],
        ['Status',   `<b>${richEscape(getUserStatusLabel(ctx.from.id))}</b>`],
        ['Role',     richEscape(roleInfo ? roleInfo.label : '—')],
        ['Tier',     richEscape(roleInfo ? roleInfo.tierLabel : '—')],
        ['Aktif s/d',richEscape(expStr)],
        ['Owner',    richEscape(config.ownerName || 'HanzPiw Official')],
      ]
    ),
    richQuote(
      `💡 Gunakan <code>/info</code> untuk cek akses server kamu`
    ),
  ].join('\n');

  return renderCard(ctx, richHtml, backToMenuKeyboard(), { thumb: true, ...options });
}

async function sendInfo(ctx, targetId, targetUsername, options = {}) {
  const userId = targetId || ctx.from.id;
  const isOwnInfo = String(userId) === String(ctx.from.id);
  const displayUsername = isOwnInfo
    ? (ctx.from?.username ? `@${ctx.from.username}` : 'Tidak ada username')
    : (targetUsername || '—');

  const roleLabel  = getRoleDisplayLabel(userId);
  const roleInfo   = getUserRoleDisplay(userId);
  const serverAccess = getServerAccessDisplay(userId);
  const hasAccess  = hasAccessForPanel(userId);

  const expStr = roleInfo?.expiresAt
    ? formatRemainingTime(roleInfo.expiresAt) + ' lagi'
    : (roleInfo ? 'Permanent ∞' : '—');

  const guideText = hasAccess
    ? `Ⓥ Cpanel Jayss X HanzPiw`
    : `⛔ Hubungi owner untuk mendapatkan akses panel`;

  const serverRows = serverAccess.map(s => [
    `V${s.index}`,
    s.allowed
      ? `✅ Akses Diberikan`
      : `❌ Tidak Ada Akses`,
  ]);

  const richHtml = [
    richTitle('🆔', 'Info Akun'),
    richTable(
      ['Field', 'Value'],
      [
        ['ID',      `<code>${richEscape(String(userId))}</code>`],
        ['Username', richEscape(displayUsername)],
        ['Role',     richEscape(roleLabel)],
        ...(roleInfo ? [['Tier', richEscape(roleInfo.tierLabel)]] : []),
        ['Expired',  richEscape(expStr)],
      ]
    ),
    serverRows.length
      ? richTable(['🖥️ Server', 'Akses'], serverRows)
      : '',
    richQuote(guideText),
  ].filter(Boolean).join('\n');

  return renderCard(ctx, richHtml, Markup.inlineKeyboard([]), { thumb: true, ...options });
}

async function sendPing(ctx, options = {}) {
  const startTelegram = Date.now();
  await bot.telegram.getMe();
  const telegramMs = Date.now() - startTelegram;
  const target = await pingTarget();
  const stats  = await getServerStatus();

  const richHtml = [
    richTitle('⌛', 'Realtime Ping'),
    richTable(
      ['⌛ Ping', 'Hasil'],
      [
        ['Telegram API', `<b>${richEscape(String(telegramMs))}ms</b>`],
        ['Panel/Target', `<b>${richEscape(target ? `${target.ms}ms` : 'N/A')}</b>`],
        ['Status',       `<b>${richEscape(stats.statusLine)}</b>`],
      ]
    ),
    richTable(
      ['🖥️ VPS Info', 'Detail'],
      [
        ['CPU Model',  richEscape(stats.cpuModel)],
        ['OS',         richEscape(stats.osName)],
        ['Datacenter', richEscape(stats.datacenterText)],
        ['Uptime',     `<b>${richEscape(stats.uptimeText)}</b>`],
      ]
    ),
    richTable(
      ['📊 Resources', 'Usage'],
      [
        ['CPU',  `<b>${richEscape(String(stats.cpuPercent))}%</b>  ${richEscape(stats.cpuBar)}`],
        ['RAM',  `<b>${richEscape(stats.ramUsedText)}/${richEscape(stats.ramTotalText)}</b>  ${richEscape(stats.ramBar)}`],
        ['Disk', `<b>${richEscape(stats.diskUsedText)}/${richEscape(stats.diskTotalText)}</b>  ${richEscape(stats.diskBar)}`],
      ]
    ),
  ].join('\n');

  return renderCard(ctx, richHtml, Markup.inlineKeyboard([]), { thumb: true, ...options });
}

async function sendHelp(ctx, options = {}) {

  const uid   = ctx.from?.id;
  const tier  = getUserTier(uid);
  const badge = tierBadge(tier);
  const isOwnerUser = isOwner(uid);
  const hasAccess   = hasAccessForPanel(uid);

  const sectionUmum = richFold(
    '🤖 <b>Umum</b>',
    '/start · /menu      — buka menu utama',
    '/ping               — realtime ping & VPS stats',
    '/info               — info & akses server kamu',
    '/profile · /myrole  — profil & role aktif kamu',
    '/mypanel            — panel yang pernah kamu buat',
    '/myhistory          — riwayat aktivitas kamu',
    '/fav                — panel favorit kamu',
    '/faq                — pertanyaan umum',
    '/tutorialpanel      — cara login & pakai panel',
    '/cekserver          — status semua server',
    '/harga              — daftar harga panel',
    '/hargaup            — daftar harga upgrade role panel',
    '/rules              — peraturan',
    '/contact            — info kontak owner',
    '/feedback           — kirim feedback ke owner',
    '/hanzgokil          — jadwal sholat hari ini',
    '/toggletips         — aktif/nonaktif tips bot',
    '/setlang            — ganti bahasa bot',
    '/version            — info versi bot',
  );

  const sectionPanel = hasAccess ? richFold(
    `🎁 <b>Panel Pterodactyl</b> ${badge}`,
    '/1gb ~ /20gb [username]  — buat panel',
    '/unli [username]         — panel unlimited V1',
    ...(tier === 'akme' || tier === 'akti' ? [
      '/unliv2 ~ /unliv5 [usr] — panel unlimited V2–V5',
      '/cadp [username]        — admin panel V1',
      '/cadpv2 ~ /cadpv5 [usr] — admin panel V2–V5',
    ] : []),
    `<i>${tierBadge('akma')} Akma: V1-V2 | ${tierBadge('akme')} Akme: V1-V4 | ${tierBadge('akti')} Akti: V1-V5</i>`,
  ) : richFold(
    '🎁 <b>Panel Pterodactyl</b>',
    '⚠️ Kamu belum memiliki akses panel.',
    'Hubungi owner untuk membeli akses.',
  );

  const sectionTools = richFold(
    '🔐 <b>Tools</b>',
    '/hardenc (reply file js)    — enkripsi JS',
    '/openenc (reply file js)    — dekripsi JS',
    '/getcode url                — ambil source code',
    '/checkdomain url            — cek domain',
    '/play nama_lagu             — cari musik',
    '/tiktok url                 — download TikTok',
    '/instagram url              — download IG',
    '/tourl (reply file)         — upload ke Catbox',
    '/tourlv2 (reply file)       — upload ke Uguu',
    '/bypassurl url              — bypass short URL',
    '/generateimage prompt       — buat gambar AI',
    '/promt text                 — generate prompt AI',
    '/carbon (reply code)        — buat gambar code',
    '/ytmp4 url                  — download YouTube',
    '/brainly pertanyaan         — tanya Brainly',
    '/gimage query               — cari gambar Google',
    '/shorturl url               — perpendek URL',
    '/calc rumus                 — kalkulator',
    '/quotes                     — kata-kata random',
    '/genpass                    — generate password aman',
    '/toqr url                   — buat QR code dari URL',
    '/clock                      — jam digital real-time',
    '/cuaca kota                 — cek cuaca kota',
    '/poll pertanyaan            — buat polling grup',
  );

  const sectionOwner = isOwnerUser ? richFold(
    '👑 <b>Owner Commands</b>',
    '── Manajemen Role ──',
    '/addrole · /delrole · /listroles',
    '/addrole2 · /delrole2       — secondary role',
    '/customrole                 — kelola custom role',
    '/rolelogs                   — riwayat addrole/delrole',
    '/lockuser · /unlockuser     — kunci/buka akun user',
    '/topuser                    — top user paling aktif',
    '/inactiveuser               — user tidak aktif',
    '/cek @user                  — cek info lengkap user',
    '/resetguest userId          — reset jatah panel tamu',
    '── Panel & Server ──',
    '/del · /delserver · /deluser',
    '/listserver · /listuser · /pterotest',
    '/delsrvoff · /delusroff · /delsrvall',
    '/autodel                    — toggle auto delete server tiap 6 jam',
    '/setapikey server,domain,ptla,pltc',
    '/lockunli · /unlockunli     — lock panel UNLI',
    '/lockadp  · /unlockadp     — lock panel ADP',
    '/autocpu                    — manajemen auto CPU',
    '/panelstats                 — statistik panel detail',
    '/userstats                  — statistik user',
    '/listpanel userId           — list panel milik user',
    '/panelinfo serverID         — detail panel Pterodactyl',
    '/sendpanelinfo              — kirim info panel ke user',
    '── Broadcast & Notifikasi ──',
    '/broadcast                  — broadcast ke semua user',
    '/announcement               — broadcast pengumuman',
    '/scheduledbc                — broadcast terjadwal',
    '/setnotice · /clearnotice   — kelola notifikasi',
    '/replyfeedback              — balas feedback user',
    '/poll                       — buat polling grup',
    '── Blacklist & Keamanan ──',
    '/blacklist · /bldur         — blacklist & berdurasi',
    '/listblacklist              — list semua blacklist',
    '/ban id · /unban id',
    '/blockcmd · /blockcmduser   — blok command',
    '/unblockcmduser · /listcmdblock — blokir per user',
    '/setbanword · /clearbanword — kelola kata terlarang',
    '/storan · /storanreset      — kinerja security & reset',
    '── Konfigurasi Bot ──',
    '/config                     — konfigurasi bot utama',
    '/setharga · /setrules · /setcontact — info bot',
    '/setfaq · /delfaq           — kelola FAQ',
    '/settutorial                — update tutorial panel',
    '/setwelcome tier            — custom welcome per tier',
    '/setmaintenance             — jadwalkan maintenance',
    '/maintenance                — toggle maintenance',
    '/setwhitelistgroup          — kelola whitelist grup',
    '/setcd jam                  — set cooldown global',
    '/debugmode on|off           — toggle debug mode',
    '/setlang                    — ganti bahasa bot',
    '── Database & Log ──',
    '/log                        — lihat activity log',
    '/cmdstats                   — statistik command',
    '/auditlog                   — log audit sistem',
    '/stats                      — statistik umum',
    '/backup                     — backup proyek bot',
    '/setdailyreport             — laporan harian otomatis',
    '/dbcheck · /dbcleanup       — kelola database',
    '/surlstats · /urlclick      — statistik URL pendek',
    '/update · /cekupdate        — cek & update bot',
    '/absen                      — manajemen absensi',
    '/addpm                      — kelola PM users',
    '/version                    — info versi & build',
  ) : '';

  const sectionMonitor = (isOwnerUser || tier === 'akme' || tier === 'akti') ? richFold(
    '📡 <b>Monitoring</b>',
    '/top10              — top 10 disk & cpu',
    '/unsuspend [id]     — unsuspend server by ID',
    '/pingall            — ping semua server sekaligus',
    '/vpsinfo            — info resource VPS',
    '/monitorstatus      — status monitoring bot',
    '/monitoron · /monitoroff',
    ...(isOwnerUser ? ['/restartbot — restart bot secara remote'] : []),
  ) : '';

  const tierTable = richTable(
    ['🎖 Tier', 'Role'],
    [
      [`${tierBadge('akma')} Akma (rank 1–5)`,  'reseller, premium, adminpanel, security, staff'],
      [`${tierBadge('akme')} Akme (rank 6–9)`,  'svip, manager, direktur, komisaris'],
      [`${tierBadge('akti')} Akti (rank 10–11)`, 'eksekutif, pimpinan'],
      [`${tierBadge('owner')} Owner`,             '∞ Infinity'],
    ]
  );

  const richHtml = [
    richTitle('💬', `Panduan Bot ${badge}`),
    sectionUmum,
    sectionPanel,
    sectionTools,
    sectionMonitor,
    sectionOwner,
    tierTable,
  ].filter(Boolean).join('\n');

  return renderCard(ctx, richHtml, backToMenuKeyboard(), { thumb: true, ...options });
}

async function sendOwnerMenu(ctx, options = {}) {
  if (!isOwner(ctx.from.id)) {
    return renderCard(ctx, richNote('❌', 'Akses Ditolak', 'Menu ini khusus owner.'), Markup.inlineKeyboard([]), options);
  }
  const onlineCount = await getOnlineServerCount();
  const monStat = MONITOR_ENABLED && MONITOR_CHAT_ID
    ? `✅ Aktif`
    : `❌ Nonaktif`;

  const richHtml = [
    richTitle('👑', 'Owner Panel'),
    richTable(
      ['Status', 'Info'],
      [
        ['Server Aktif', `<b>${onlineCount}/5</b>`],
        ['Monitor',      monStat],
      ]
    ),
    richFold(
      '🔑 <b>Role Management</b>',
      '<code>/addrole</code>      — tambah role user',
      '<code>/delrole</code>      — hapus role user',
      '<code>/listroles</code>    — list semua role',
      '<code>/cek</code> @user    — cek info lengkap user',
      '<code>/resetguest</code> id — reset jatah panel tamu',
    ),
    richFold(
      '🖥️ <b>Server &amp; Panel</b>',
      '<code>/del</code>        — hapus panel by ID',
      '<code>/listserver</code> — list semua server',
      '<code>/pterotest</code>  — test koneksi pterodactyl',
      '<code>/cekserver</code>  — cek status server',
      '<code>/delsrvoff</code>  — hapus server offline',
      '<code>/delusroff</code>  — hapus user offline',
      '<code>/delsrvall</code>  — hapus semua server',
    ),
    richFold(
      '⚙️ <b>Bot Management</b>',
      '<code>/backup</code>      — backup bot',
      '<code>/broadcast</code>   — broadcast ke semua user',
      '<code>/stats</code>       — statistik bot',
      '<code>/maintenance</code> — mode maintenance',
      '<code>/blacklist</code>   — kelola blacklist',
      '<code>/blockcmd</code>    — blokir command',
      '<code>/setapikey</code>   — set domain + API key',
      '<code>/ban</code> &lt;id&gt;   — ban user',
      '<code>/unban</code> &lt;id&gt; — unban user',
      '<code>/setcd</code> &lt;jam&gt; — set cooldown',
      '<code>/lockunli</code>    — kunci panel unli',
      '<code>/lockadp</code>     — kunci admin panel',
      '<code>/autocpu</code>     — manajemen auto CPU',
      '<code>/log</code>         — activity log',
      '<code>/config</code>      — konfigurasi bot',
    ),
    richFold(
      '📡 <b>Auto Monitoring</b>',
      '<code>/top10</code>         — top 10 disk &amp; CPU',
      '<code>/unsuspend</code> [id] — unsuspend server',
      '<code>/monitorstatus</code>  — status monitor',
      '<code>/monitoron</code>      — aktifkan monitor',
      '<code>/monitoroff</code>     — matikan monitor',
    ),
  ].join('\n');

  return renderCard(ctx, richHtml, ownerMenuKeyboard(), { thumb: true, ...options });
}

async function sendServerMenu(ctx, options = {}) {
  const richHtml = [
    richTitle('🖥️', 'Server Menu'),
    richPara('🔄 Monitor &amp; daftar server panel.'),
    richQuote('📌 Beberapa command butuh role tertentu / group verified.'),
    richTable(
      ['Command', 'Penjelasan'],
      [
        ['/listserver',       'List semua server aktif (pilih via tombol)'],
        ['/listuser',         'List user panel di server (pilih via tombol)'],
        ['/delsrvoff',        'Hapus server yang offline/suspended'],
        ['/delusroff',        'Hapus user tanpa server'],
        ['/delsrvall',        'Hapus semua server di panel'],
        ['/cekserver',        'Status semua server panel'],
        ['/pterotest',        'Test koneksi Pterodactyl'],
      ]
    ),
    richQuote('✅ Mulai dari /listserver untuk melihat server aktif.'),
  ].join('\n');

  return renderCard(ctx, richHtml, Markup.inlineKeyboard([
    [{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: 'danger' }],
  ]), { thumb: true, ...options });
}

async function sendInfoUserMenu(ctx, options = {}) {
  const richHtml = [
    richTitle('👤', 'Info User'),
    richPara('🔄 Cek identitas, role, dan akses panel.'),
    richQuote('📌 Bisa cek diri sendiri atau user lain (reply / ID / @username).'),
    richTable(
      ['Command', 'Penjelasan'],
      [
        ['/myrole',            'Cek role akun kamu (rich + emoji Prem)'],
        ['/info',              'Ringkasan role & akses server kamu'],
        ['/info @user/reply',  'Cek info user lain'],
        ['/profile',           'Detail profil & avatar kamu'],
        ['/mypanel',           'Panel yang pernah kamu buat'],
        ['/ping',              'Status bot + latency VPS'],
      ]
    ),
    richQuote('✅ Coba /info untuk melihat akses panel kamu.'),
  ].join('\n');

  return renderCard(ctx, richHtml, Markup.inlineKeyboard([
    [{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: 'danger' }],
  ]), { thumb: true, ...options });
}

async function sendPusatKontrol(ctx, options = {}) {
  const richHtml = [
    richTitle('⚙️', 'Pusat Kontrol'),
    richPara('🔄 Panel administrasi dan kontrol sistem.'),
    richQuote('📌 Perintah administratif mengikuti pemeriksaan role dan izin bawaan. Control Center khusus Telegram.'),
    richTable(
      ['Command', 'Penjelasan'],
      [
        ['/backup',               'Buat backup proyek bot'],
        ['/maintenance on|off',   'Toggle mode maintenance'],
        ['/update · /cekupdate',  'Cek & jalankan update bot'],
        ['/config',               'Konfigurasi utama bot'],
        ['/log',                  'Lihat activity log terbaru'],
        ['/stats',                'Statistik penggunaan bot'],
        ['/auditlog',             'Log audit sistem'],
        ['/dbcheck · /dbcleanup', 'Cek & bersihkan database'],
        ['/debugmode on|off',     'Toggle mode debug'],
        ['/restartbot',           'Restart bot secara remote'],
        ['/setwhitelistgroup',    'Kelola grup yang diizinkan'],
        ['/vpsinfo',              'Info resource VPS real-time'],
      ]
    ),
    richQuote('💡 Gunakan /config untuk mengubah konfigurasi utama bot.'),
  ].join('\n');

  return renderCard(ctx, richHtml, Markup.inlineKeyboard([
    [{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: 'danger' }],
  ]), { thumb: true, ...options });
}

async function sendThanksTo(ctx, options = {}) {
  const botName = config.botName || 'Cpanel Jayss X HanzPiw';

  const richHtml = [
    richTitle('🙏', 'Thanks To'),
    richTable(
      ['Nama', 'Peran'],
      [
        ['Telegram',                'Platform'],
        ['Pterodactyl',             'Panel Hosting'],
        ['Node.js',                 'Runtime'],
        ['Allah SWT',               'Gods'],
        ['Orang Tua Bapak Dan Ibu', 'Support'],
        ['HanzPiw',                 'Script Base'],
        ['Jayss',                   'Contributor'],
      ]
    ),
    richQuote(`💙 Terima kasih telah menggunakan ${richEscape(botName)}`),
  ].join('\n');

  return renderCard(ctx, richHtml, Markup.inlineKeyboard([
    [{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: 'danger' }],
  ]), { thumb: true, ...options });
}

async function sendDeveloper(ctx, options = {}) {
  const ownerName  = config.ownerName     || 'HanzPiw Official';
  const ownerUser  = config.ownerUsername || '@itshanzpiw';
  const botName    = config.botName       || 'Cpanel Jayss X HanzPiw';
  const ver        = (() => { try { return require('./version.json').version || 'v1.0'; } catch (_) { return 'v1.0'; } })();

  const richHtml = [
    richTitle('👨‍💻', 'Developer Script'),
    richTable(
      ['Nama', 'Username', 'Role'],
      [
        [richEscape(ownerName), richEscape(ownerUser), 'Main Developer'],
      ]
    ),
    richTable(
      ['Info', 'Detail'],
      [
        ['Bot Name', richEscape(botName)],
        ['Versi',    richEscape(ver)],
        ['Runtime',  'Node.js'],
        ['Platform', 'Telegram Bot'],
      ]
    ),
    richQuote('💻 Dibuat dengan ❤️ untuk komunitas bot Indonesia.'),
  ].join('\n');

  return renderCard(ctx, richHtml, Markup.inlineKeyboard([
    [{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: 'danger' }],
  ]), { thumb: true, ...options });
}

const LR_TIER_META = {
  akma: { label: '🟡 Akma — Akses Pertama' },
  akme: { label: '🔵 Akme — Akses Menengah' },
  akti: { label: '🔴 Akti — Akses Tinggi' },
};
const LR_PAGE_SIZE = 15;

function lrTierKeyboard() {
  return Markup.inlineKeyboard([
    [{ text: eF('『 🟡 』 Akma — Akses Pertama'),  callback_data: 'lr_tier_akma', style: 'primary'}],
    [{ text: eF('『 🔵 』 Akme — Akses Menengah'), callback_data: 'lr_tier_akme', style: 'primary'}],
    [{ text: eF('『 🔴 』 Akti — Akses Tinggi'),   callback_data: 'lr_tier_akti', style: 'primary'}],
    [{ text: eF('『 👑 』 Owner Menu'), callback_data: 'owner_menu', style: 'danger'}],
  ]);
}

function lrRoleKeyboard(tier) {
  const tierRoles = Object.entries(ROLE_DEFINITIONS)
    .filter(([, def]) => def.tier === tier)
    .sort((a, b) => a[1].rankOrder - b[1].rankOrder)
    .map(([key, def]) => ({ text: eF(def.label), callback_data: `lr_role_${key}_1`, style: 'primary'}));
  const rows = [];
  for (let i = 0; i < tierRoles.length; i += 2) rows.push(tierRoles.slice(i, i + 2));
  rows.push([{ text: eF('『 🎖️ 』 Pilih Tier'), callback_data: 'lr_back_tier', style: 'primary'}]);
  return Markup.inlineKeyboard(rows);
}

function lrUserKeyboard(role, page, totalPages) {
  const def = ROLE_DEFINITIONS[role];
  const rows = [];
  const navRow = [];
  if (page > 1)          navRow.push({ text: eF('『 ⏪ 』 Sebelumnya'), callback_data: `lr_role_${role}_${page - 1}`, style: 'primary'});
  if (page < totalPages) navRow.push({ text: eF('『 ⏩ 』 Selanjutnya'), callback_data: `lr_role_${role}_${page + 1}`, style: 'primary'});
  if (navRow.length) rows.push(navRow);
  rows.push([
    { text: eF('『 🎭 』 Pilih Role'), callback_data: `lr_tier_${def ? def.tier : 'akma'}`, style: 'primary'},
    { text: eF('『 🎖️ 』 Pilih Tier'), callback_data: 'lr_back_tier',                        style: 'primary'},
  ]);
  return Markup.inlineKeyboard(rows);
}

async function sendListUsers(ctx, options = {}) {
  if (!isOwner(ctx.from.id)) {
    return renderCard(ctx, richNote('❌', 'Akses Ditolak', 'Menu ini khusus owner.'), Markup.inlineKeyboard([]), options);
  }
  const totalRoleUsers = Object.keys(db.getAllRoles()).length;
  const richHtml = [
    richTitle('👥', 'List Roles — Pilih Tier'),
    richQuote(`Total user ber-role: <b>${totalRoleUsers}</b>`, 'Pilih tier untuk melihat daftar user.'),
  ].join('\n');
  return renderCard(ctx, richHtml, lrTierKeyboard(), options);
}

async function sendListRolesByTier(ctx, tier, options = {}) {
  if (!isOwner(ctx.from.id)) return;
  const meta = LR_TIER_META[tier];
  const tierRoleKeys = Object.entries(ROLE_DEFINITIONS)
    .filter(([, def]) => def.tier === tier)
    .sort((a, b) => a[1].rankOrder - b[1].rankOrder)
    .map(([key, def]) => {
      const count = Object.values(db.getAllRoles()).filter(e => e.role === key).length;
      return `${def.label} — <b>${count}</b> user`;
    });
  const richHtml = [
    richTitle('👥', `List Roles — ${meta ? meta.label : tier}`),
    richQuote(...(tierRoleKeys.length ? tierRoleKeys : ['Belum ada role di tier ini.'])),
  ].join('\n');
  return renderCard(ctx, richHtml, lrRoleKeyboard(tier), options);
}

async function sendListRolesByRole(ctx, role, page, options = {}) {
  if (!isOwner(ctx.from.id)) return;
  const def = ROLE_DEFINITIONS[role];
  if (!def) {
    return renderCard(ctx, richNote('❌', 'Role Tidak Valid', 'Role tidak ditemukan.'), Markup.inlineKeyboard([]), options);
  }
  const usersInRole = Object.values(db.getAllRoles()).filter(e => e.role === role);
  const totalPages  = Math.max(1, Math.ceil(usersInRole.length / LR_PAGE_SIZE));
  const current     = Math.min(Math.max(1, page), totalPages);
  const slice       = usersInRole.slice((current - 1) * LR_PAGE_SIZE, current * LR_PAGE_SIZE);
  const tableRows   = slice.length
    ? slice.map(e => [
        `<code>${richEscape(String(e.userId))}</code>`,
        richEscape(e.username ? `@${e.username}` : '—'),
        richEscape(e.expiresAt ? formatRemainingTime(e.expiresAt) : 'Permanent ∞'),
      ])
    : [['—', 'Belum ada user', '—']];
  const richHtml = [
    richTitle('👥', `${def.label} (${usersInRole.length} user)`),
    richTable(['User ID', 'Username', 'Status'], tableRows),
    totalPages > 1 ? richQuote(`Halaman <b>${current}</b> / <b>${totalPages}</b>`) : '',
  ].filter(Boolean).join('\n');
  return renderCard(ctx, richHtml, lrUserKeyboard(role, current, totalPages), options);
}

async function pteroRequestFor(server, endpoint, options = {}) {
  const domain = cleanDomain(server.domain);
  const apiKey = String(server.plta || '').trim();
  const response = await fetch(`${domain}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'Application/vnd.pterodactyl.v1+json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (response.status === 204) return {};
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
  if (!response.ok) {
    const detail = data?.errors?.[0]?.detail || data?.message || raw || 'Request gagal';
    throw new Error(`Pterodactyl S${server.index} HTTP ${response.status}: ${detail}`);
  }
  return data;
}
async function pteroRequest(endpoint, options = {}) {
  const servers = getActiveServers();
  if (!servers.length) throw new Error('Tidak ada server aktif. Periksa config.js');
  return pteroRequestFor(servers[0], endpoint, options);
}
async function testPterodactylConnection() {
  const servers = getActiveServers();
  if (!servers.length) throw new Error('Tidak ada server yang terkonfigurasi.');
  const results = [];
  for (const s of servers) {
    try {
      const res = await pteroRequestFor(s, '/api/application/users?per_page=1&page=1');
      results.push({ index: s.index, domain: s.domain, ok: true, total: res?.meta?.pagination?.total ?? 0 });
    } catch (error) {
      results.push({ index: s.index, domain: s.domain, ok: false, error: error.message });
    }
  }
  return results;
}
// eggCfg: optional { nest, egg } — jika tidak diberikan, pakai config.nest / config.egg
async function getEggDetailFor(server, eggCfg = null) {
  const nestId = eggCfg ? Number(eggCfg.nest) : Number(config.nest);
  const eggId  = eggCfg ? Number(eggCfg.egg)  : Number(config.egg);
  return pteroRequestFor(server, `/api/application/nests/${nestId}/eggs/${eggId}?include=variables`);
}
async function findUserByUsernameOn(server, username) {
  const query = encodeURIComponent(username);
  const response = await pteroRequestFor(server, `/api/application/users?filter[username]=${query}`);
  const rows = Array.isArray(response?.data) ? response.data : [];
  return rows.find(item => item?.attributes?.username === username) || null;
}
async function listNodeAllocationsPageOn(server, nodeId, page = 1) {
  return pteroRequestFor(server, `/api/application/nodes/${Number(nodeId)}/allocations?page=${Number(page) || 1}`);
}
async function findDeployableNodeIdsOn(server, locationId) {
  const wantedLocation = String(locationId || '').trim();
  let page = 1, totalPages = 1; const nodeIds = [];
  while (page <= totalPages) {
    const response = await pteroRequestFor(server, `/api/application/nodes?page=${page}`);
    const rows = Array.isArray(response?.data) ? response.data : [];
    for (const item of rows) {
      const attrs = item?.attributes || {};
      if (String(attrs.location_id || '') === wantedLocation) nodeIds.push(attrs.id);
    }
    totalPages = Number(response?.meta?.pagination?.total_pages || 1);
    page++;
  }
  return nodeIds;
}
async function findFreeAllocationOn(server, locationId) {
  const nodeIds = await findDeployableNodeIdsOn(server, locationId);
  if (!nodeIds.length) throw new Error(`S${server.index}: Tidak ada node untuk location tersebut.`);
  for (const nodeId of nodeIds) {
    let page = 1, totalPages = 1;
    while (page <= totalPages) {
      const response = await listNodeAllocationsPageOn(server, nodeId, page);
      const rows = Array.isArray(response?.data) ? response.data : [];
      const free = rows.find(item => !item?.attributes?.assigned);
      if (free) return { nodeId, allocationId: free.attributes.id, ip: free.attributes.ip, port: free.attributes.port };
      totalPages = Number(response?.meta?.pagination?.total_pages || 1);
      page++;
    }
  }
  throw new Error(`S${server.index}: Tidak ada alokasi port kosong.`);
}
function getEggVariableRows(eggDetail) {
  return Array.isArray(eggDetail?.relationships?.variables?.data)
    ? eggDetail.relationships.variables.data
    : Array.isArray(eggDetail?.attributes?.relationships?.variables?.data)
      ? eggDetail.attributes.relationships.variables.data : [];
}
function pickEggDockerImage(eggDetail) {
  const attrs = eggDetail?.attributes || {};
  if (attrs.docker_image) return attrs.docker_image;
  const images = attrs.docker_images;
  if (images && typeof images === 'object') {
    const firstKey = Object.keys(images)[0];
    if (firstKey && images[firstKey]) return images[firstKey];
  }
  return null;
}
function buildEggEnvironment(eggDetail, allocation) {
  const environment = {};
  for (const item of getEggVariableRows(eggDetail)) {
    const attrs = item?.attributes || {};
    const key = attrs.env_variable; if (!key) continue;
    let value = attrs.server_value;
    if (value === undefined || value === null || value === '') value = attrs.default_value;
    if (value === undefined || value === null) value = '';
    environment[key] = String(value);
  }
  if (!environment.TZ) environment.TZ = config.timezone || 'Asia/Jakarta';
  if (allocation) {
    if (!environment.SERVER_IP) environment.SERVER_IP = String(allocation.ip || '');
    if (!environment.SERVER_PORT) environment.SERVER_PORT = String(allocation.port || '');
  }
  return environment;
}
async function createPanelUserWithRetryOn(server, payload, password, attempts = 5) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const created = await pteroRequestFor(server, '/api/application/users', { method: 'POST', body: JSON.stringify(payload) });
      return { id: created?.attributes?.id, username: created?.attributes?.username, email: created?.attributes?.email, password, root_admin: Boolean(created?.attributes?.root_admin) };
    } catch (error) {
      lastError = error;
      if (String(error?.message || '').includes('Third Party Identifier has already been taken')) {
        payload.external_id = buildUniqueExternalId(payload.root_admin ? 'admin' : 'panel', payload.username);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('Gagal membuat user panel.');
}
async function findAvailableUsernameOn(server, baseUsername) {
  const base = sanitizeUsername(baseUsername);
  if (!base || base.length < 3) throw new Error('Username minimal 3 karakter.');
  let candidate = base, counter = 0;
  while (counter <= 99) {
    const existing = await findUserByUsernameOn(server, candidate);
    if (!existing) return { requested: base, finalUsername: candidate, adjusted: counter > 0 };
    counter++;
    candidate = appendUsernameSuffix(base, counter);
  }
  throw new Error('Tidak bisa mencari username kosong. Coba username lain.');
}
// eggCfg: optional { nest, egg, name } — jika null, pakai config.nest / config.egg (default)
async function createPanelServerOn(server, username, plan, telegramId, eggCfg = null) {
  const available = await findAvailableUsernameOn(server, username);
  const finalUsername = available.finalUsername;
  const password = randomPassword(12);
  const userPayload = {
    email: `${finalUsername}@jayss.local`, username: finalUsername,
    first_name: finalUsername, last_name: 'Panel', language: 'en',
    password, external_id: buildUniqueExternalId(`tg${telegramId}`, finalUsername)
  };
  const user = await createPanelUserWithRetryOn(server, userPayload, password);
  // Gunakan eggCfg.nest / eggCfg.egg jika user memilih engine tertentu (Python/Node.js)
  const eggDetail = await getEggDetailFor(server, eggCfg);
  const allocation = await findFreeAllocationOn(server, config.loc);
  const dockerImage = pickEggDockerImage(eggDetail);
  const startup = eggDetail?.attributes?.startup || undefined;
  const environment = buildEggEnvironment(eggDetail, allocation);
  // Gunakan egg ID dari eggCfg jika tersedia, fallback ke config.egg
  const eggId = eggCfg ? Number(eggCfg.egg) : Number(config.egg);
  const serverPayload = {
    name: finalUsername, user: Number(user.id), egg: eggId, environment,
    limits: { memory: Number(plan.memory) || 0, swap: 0, disk: Number(plan.disk) || 0, io: 500, cpu: Number(plan.cpu) || 0 },
    feature_limits: { databases: 0, allocations: 0, backups: 0 },
    allocation: { default: Number(allocation.allocationId) }
  };
  if (dockerImage) serverPayload.docker_image = dockerImage;
  if (startup) serverPayload.startup = startup;
  const createdServer = await pteroRequestFor(server, '/api/application/servers', { method: 'POST', body: JSON.stringify(serverPayload) });
  return { user, server: createdServer, allocation, egg: eggDetail?.attributes || {}, adjusted: available.adjusted, requested: available.requested, finalUsername };
}
async function createAdminPanelOn(server, username, telegramId) {
  const available = await findAvailableUsernameOn(server, username);
  const finalUsername = available.finalUsername;
  const password = randomPassword(14);
  const payload = {
    email: `${finalUsername}@jayss.local`, username: finalUsername,
    first_name: finalUsername, last_name: 'Admin', language: 'en',
    password, root_admin: true, external_id: buildUniqueExternalId(`admin${telegramId}`, finalUsername)
  };
  const user = await createPanelUserWithRetryOn(server, payload, password);
  return { user, adjusted: available.adjusted, requested: available.requested, finalUsername };
}

// eggCfg: optional { nest, egg, name } — diteruskan ke createPanelServerOn
async function createPanelForUser(username, plan, telegramId, userId, progressFn = null, eggCfg = null) {
  const servers = getAllowedServersForUser(userId);
  if (!servers.length) {
    const tier = getUserTier(userId);
    if (!tier) throw new Error('Kamu tidak memiliki role. Hubungi owner untuk mendapatkan akses.');
    throw new Error(`Tidak ada server tersedia untuk tier ${TIER_LABELS[tier] || tier}.`);
  }
  let lastError = null;
  for (const server of servers) {
    if (progressFn) await progressFn(server.index, servers.length);
    try {
      const result = await createPanelServerOn(server, username, plan, telegramId, eggCfg);
      return { ...result, serverIndex: server.index, serverDomain: server.domain };
    } catch (error) {
      const msg = String(error?.message || '');
      if (msg.includes('alokasi') || msg.includes('allocation')) { lastError = error; continue; }
      throw error;
    }
  }
  throw new Error(`Semua ${servers.length} server yang kamu akses penuh. Hubungi owner.`);
}

async function createAdminPanelForUser(username, telegramId, userId, progressFn = null) {
  const servers = getAllowedServersForUser(userId);
  if (!servers.length) throw new Error('Tidak ada server aktif yang bisa diakses.');
  let lastError = null;
  for (const server of servers) {
    if (progressFn) await progressFn(server.index);
    try {
      const result = await createAdminPanelOn(server, username, telegramId);
      return { ...result, serverIndex: server.index, serverDomain: server.domain };
    } catch (error) {
      const msg = String(error?.message || '');
      if (msg.includes('alokasi') || msg.includes('allocation')) { lastError = error; continue; }
      throw error;
    }
  }
  throw lastError || new Error('Gagal membuat admin panel di semua server.');
}

// eggCfg: optional — diteruskan ke createPanelServerOn
async function createPanelForUserOnServer(username, plan, telegramId, userId, serverIndex, eggCfg = null) {
  const allServers = getAllowedServersForUser(userId);
  const server = allServers.find(s => s.index === serverIndex);

  if (!server) {
    const tier = getUserTier(userId);
    if (!tier) throw new Error('Kamu tidak memiliki role. Hubungi owner untuk mendapatkan akses.');
    throw new Error(`Server V${serverIndex} tidak dapat diakses oleh tier ${TIER_LABELS[tier] || tier}.`);
  }

  try {
    const result = await createPanelServerOn(server, username, plan, telegramId, eggCfg);
    return { ...result, serverIndex: server.index, serverDomain: server.domain };
  } catch (error) {
    throw error;
  }
}

async function createAdminPanelForUserOnServer(username, telegramId, userId, serverIndex) {
  const allServers = getAllowedServersForUser(userId);
  const server = allServers.find(s => s.index === serverIndex);

  if (!server) throw new Error(`Server V${serverIndex} tidak dapat diakses atau tidak aktif.`);

  try {
    const result = await createAdminPanelOn(server, username, telegramId);
    return { ...result, serverIndex: server.index, serverDomain: server.domain };
  } catch (error) {
    throw error;
  }
}

async function handleUnliCommand(ctx) {
  if (requireGroupChat(ctx)) return;
  const userId = ctx.from.id;
  if (lockState.unli) {
    return ctx.reply(eBox('🔒 PANEL UNLI TERKUNCI', ['Command /unli sedang dikunci oleh owner!', 'Hubungi owner untuk informasi lebih lanjut.']), { parse_mode: 'HTML' });
  }

  const hasRole = hasAccessForPanel(userId);
  const isGuest = !isOwner(userId) && !hasRole;

  if (isGuest) {
    if (hasUsedGuestPanel(userId)) {
      return ctx.reply(
        '⚠️ <b>AKSES PANEL TERBATAS</b>\n\n' +
        'Kamu belum memiliki akses panel resmi.\n' +
        '❌ Jatah panel gratis (1×) sudah digunakan.\n\n' +
        'Hubungi admin agar akses kamu segera di-add.\n' +
        `Owner: ${htmlEscape(config.ownerUsername || '@itshanzpiw')}`,
        { parse_mode: 'HTML' }
      );
    }

    await ctx.reply(
      '⚠️ <b>PANEL TAMU (1×)</b>\n\n' +
      'Kamu belum di-add oleh admin.\n' +
      '✅ Kamu diizinkan membuat <b>1 panel gratis</b> untuk sementara.\n\n' +
      'Setelah panel dibuat, kamu tidak bisa membuat panel lagi\n' +
      'sampai admin menambahkan akses ke akunmu.\n\n' +
      `🔔 Hubungi: ${htmlEscape(config.ownerUsername || '@itshanzpiw')}`,
      { parse_mode: 'HTML' }
    );
  } else if (!isOwner(userId)) {
    const tier = getUserTier(userId);
    if (!tier) return ctx.reply('❌ Kamu tidak memiliki role. Hubungi owner untuk mendapatkan akses panel.', { parse_mode: 'HTML' });
    if (!hasRole) return ctx.reply(`❌ Tier kamu (${TIER_LABELS[tier] || tier}) tidak memiliki akses server yang aktif.`, { parse_mode: 'HTML' });
  }

  if (!isOwner(userId)) {
    const cooldown = checkRateLimit(userId);
    if (cooldown > 0) {
      return ctx.reply(`⏳ Tunggu <b>${cooldown} detik</b> lagi sebelum membuat panel baru.`, { parse_mode: 'HTML' });
    }
  }

  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const { username, recipientId, error: parseError } = parseUsernameAndRecipient(args[0] || '');

  if (parseError || !username || username.length < 3) {
    return ctx.reply(
      `❌ Format: <code>/unli username</code>\nAtau jika buat untuk user lain: <code>/unli username,IDTelegram</code>`,
      { parse_mode: 'HTML' }
    );
  }

  if (await requireStartConfirm(ctx)) return;

  unliSessions.set(userId, { username, recipientId: recipientId || null, isGuest, timestamp: Date.now() });

  const richHtml = [
    richTitle('💎', 'PILIH EGG - PANEL UNLIMITED'),
    richTable(
      ['💎 Egg', 'Info'],
      [
        ['💎 <b>Node.js</b>', 'Untuk aplikasi Node.js'],
        ['loc / nest / egg', '1 / 5 / 15'],
        ['🐍 <b>Python</b>', 'Untuk aplikasi Python'],
        ['loc / nest / egg', '1 / 5 / 16'],
      ]
    ),
    richPara('Silahkan pilih egg yang ingin digunakan untuk panel unlimited kamu:'),
  ].join('\n');

  return renderCard(ctx, richHtml, Markup.inlineKeyboard([
    [{ text: eF('『 🟢 』 Node.js'), callback_data: `unli_choose_nodejs_${ctx.from.id}`, style: "primary"}, { text: eF('『 🐍 』 Python'), callback_data: `unli_choose_python_${ctx.from.id}`, style: "primary"}],
    [{ text: eF('『 ✖️ 』 Batal'), callback_data: 'menu', style: "danger"}],
  ]));
}

async function createPanelWithEgg(ctx, eggType, userId) {
  const userSession = unliSessions.get(userId);
  if (!userSession) {
    return ctx.answerCbQuery('⏱ Session expired, silahkan gunakan /unli lagi', true);
  }

  const { username, isGuest, recipientId } = userSession;
  const eggConfig = getEggConfig(eggType);

  if (!eggConfig) {
    return ctx.answerCbQuery('❌ Egg tidak valid', true);
  }

  if (!isOwner(userId)) {
    const cooldown = checkRateLimit(userId);
    if (cooldown > 0) {
      return ctx.answerCbQuery(`⏳ Tunggu ${cooldown}s lagi`, true);
    }
  }

  const plan = PANEL_PLANS['unli'];
  if (!plan) return ctx.answerCbQuery('❌ Paket tidak valid', true);

  if (!isGuest) {
    const allowedServers = getAllowedServersForUser(userId);
    if (!allowedServers.length) {
      return ctx.answerCbQuery('❌ Tidak ada akses server', true);
    }
  }

  const msgText = `⏳ <b>Menyiapkan panel unlimited ${eggConfig.name}...</b>\nUsername: <code>${htmlEscape(username)}</code>\nEgg: <b>${eggConfig.name}</b>${isGuest ? '\n⚠️ Mode panel tamu (1×)' : ''}`;

  try {
    await ctx.editMessageText(msgText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
  } catch (_) {}

  try {
    const result = isGuest
      ? await createGuestPanelPanel(username, plan, userId, async (serverIndex) => {
          try {
            await bot.telegram.editMessageText(ctx.chat.id, ctx.msgId, undefined,
              `⏳ <b>Menyiapkan panel unlimited ${eggConfig.name}...</b>\nUsername: <code>${htmlEscape(username)}</code>\nMencoba Server V${serverIndex}... (tamu)\nEgg: <b>${eggConfig.name}</b>`,
              { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
          } catch (_) {}
        }, eggConfig)
      : await createPanelForUser(username, plan, recipientId || userId, userId, async (serverIndex) => {
          try {
            await bot.telegram.editMessageText(ctx.chat.id, ctx.msgId, undefined,
              `⏳ <b>Menyiapkan panel unlimited ${eggConfig.name}...</b>\nUsername: <code>${htmlEscape(username)}</code>\nMencoba Server V${serverIndex}...\nEgg: <b>${eggConfig.name}</b>`,
              { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
          } catch (_) {}
        }, eggConfig);

    const serverAttr = result.server?.attributes || {};
    const loginUrl = cleanDomain(result.serverDomain);

    const notifCaption = [
      `${'✅'} <b>Panel Unlimited (${eggConfig.name})${isGuest ? ' ⚠️ (TAMU - 1x)' : ''} berhasil Dibuat!</b>`, '',
      `<b>📌 Nama Panel:</b> <code>${htmlEscape(result.finalUsername)}</code>`,
      `<b>👤 Pembuat:</b> ${htmlEscape(ctx.from?.username ? `@${ctx.from.username}` : [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User')}`,
      `<b>🆔 Id Server:</b> <code>V${result.serverIndex}</code> (Ptero: <code>${htmlEscape(String(result.server?.attributes?.id || '-'))}</code>)`,
      '',
      `<blockquote><b>📦 Paket:</b> ${htmlEscape(plan.name)}${isGuest ? ' <i>(tamu 1×)</i>' : ''}`,
      `<b>🥚 Egg:</b> ${htmlEscape(eggConfig.name)} (${eggConfig.egg})`,
      `<b>🧠 RAM:</b> ${htmlEscape(plan.memory === 0 ? '∞ Unlimited' : `${plan.memory} MB`)}`,
      `<b>💾 Disk:</b> ${htmlEscape(plan.disk === 0 ? '∞ Unlimited' : `${plan.disk} MB`)}`,
      `<b>⚙️ CPU:</b> ${htmlEscape(plan.cpu === 0 ? '∞ Unlimited' : `${plan.cpu}%`)}`,
      '</blockquote>',
      '',
      `<blockquote><b>✅ Data akun ( Email & Password ) telah dikirim ke Private Chat Anda</b>`,
      '</blockquote>'
    ].join('\n');

    const caption = eMulti([
      {
        title: '✅ パネル作成完了 - PANEL BERHASIL DIBUAT',
        lines: [
          `Login    ┈ ${htmlEscape(loginUrl)}`,
          `Username ┈ <b>${htmlEscape(result.finalUsername)}</b>`,
          `Password ┈ <code>${htmlEscape(result.user?.password || '-')}</code>`,
          `Paket    ┈ <b>${htmlEscape(plan.name)}</b>${isGuest ? ' <i>(tamu 1×)</i>' : ''}`,
          `Egg      ┈ <b>${eggConfig.name}</b> (${eggConfig.egg})`,
          `RAM      ┈ <b>${htmlEscape(plan.memory === 0 ? '∞ Unlimited' : `${plan.memory} MB`)}</b>`,
          `Disk     ┈ <b>${htmlEscape(plan.disk === 0 ? '∞ Unlimited' : `${plan.disk} MB`)}</b>`,
          `CPU      ┈ <b>${htmlEscape(plan.cpu === 0 ? '∞ Unlimited' : `${plan.cpu}%`)}</b>`,
          `Server   ┈ <b>V${result.serverIndex}</b>`,
          `SID      ┈ <code>${htmlEscape(serverAttr.identifier || serverAttr.uuid || '-')}</code>`,
          result.adjusted ? `Note  ┈ ${htmlEscape(result.requested)} ➜ ${htmlEscape(result.finalUsername)}` : `Note  ┈ Username langsung dipakai`,
          `Owner    ┈ ${htmlEscape(config.ownerName || 'HanzPiw Official')}`,
        ]
      },
      {
        title: '📌 KETENTUAN',
        lines: [
          'Garansi 15 hari  •  1x replace  •  No DDoS',
          'Jangan share  •  Dilarang tindakan ilegal',
        ]
      },
    ]);

    if (isGuest) {
      markGuestPanelUsed(userId, { planKey: 'unli', username: result.finalUsername, serverIndex: result.serverIndex });
    }

    recordPanelStat(userId, result.serverIndex);
    await notifyOwnerNewPanel(ctx, { plan, username: result.finalUsername, userId, password: result.user?.password, serverIndex: result.serverIndex, pteroServerId: result.server?.attributes?.id, pteroUserId: result.user?.attributes?.id, isGuest });

    const keyboard = resultActionKeyboard(loginUrl, result.finalUsername, result.user?.password);

    try {
      await ctx.deleteMessage();
    } catch (_) {}

    if (['group', 'supergroup'].includes(ctx.chat?.type)) {
      try {

        await ctx.reply(notifCaption, { parse_mode: 'HTML' });

        await sendDirectCard(ctx.from.id, caption, keyboard);
      } catch (_) {
        await renderCard(ctx, caption, keyboard);
      }
    } else {

      await ctx.reply(notifCaption, { parse_mode: 'HTML' });
      await renderCard(ctx, caption, keyboard);
    }

    unliSessions.delete(userId);

  } catch (error) {
    unliSessions.delete(userId);
    await ctx.editMessageText(
      `${'❌'} <b>Gagal membuat panel unlimited</b>\n\n<code>${htmlEscape(error.message || error)}</code>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
    );
  }
}

async function handleUnliCommandForServer(ctx, serverIndex) {
  if (requireGroupChat(ctx)) return;
  if (lockState.unli) {
    return ctx.reply(eBox('🔒 PANEL UNLI TERKUNCI', ['Command /unliv2-5 sedang dikunci oleh owner!', 'Hubungi owner untuk informasi lebih lanjut.']), { parse_mode: 'HTML' });
  }

  if (!hasAccessForPanel(ctx.from.id)) {
    const tier = getUserTier(ctx.from.id);
    if (!tier) return ctx.reply('❌ Kamu tidak memiliki role. Hubungi owner untuk mendapatkan akses panel.', { parse_mode: 'HTML' });
    return ctx.reply(`❌ Tier kamu (${TIER_LABELS[tier] || tier}) tidak memiliki akses server yang aktif.`, { parse_mode: 'HTML' });
  }

  const allowedServers = getAllowedServersForUser(ctx.from.id);
  const hasAccessToServer = allowedServers.some(s => s.index === serverIndex);
  if (!hasAccessToServer) {
    return ctx.reply(
      `❌ Kamu tidak memiliki akses ke Server V${serverIndex}.\n\nAkses yang tersedia: V${allowedServers.map(s => s.index).join(', V')}`,
      { parse_mode: 'HTML' }
    );
  }

  if (!isOwner(ctx.from.id)) {
    const cooldown = checkRateLimit(ctx.from.id);
    if (cooldown > 0) {
      return ctx.reply(`⏳ Tunggu <b>${cooldown} detik</b> lagi sebelum membuat panel baru.`, { parse_mode: 'HTML' });
    }
  }

  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const { username, recipientId, error: parseError } = parseUsernameAndRecipient(args[0] || '');

  if (parseError || !username || username.length < 3) {
    return ctx.reply(
      `❌ Format: <code>/unliv${serverIndex} username</code>\nAtau jika buat untuk user lain: <code>/unliv${serverIndex} username,IDTelegram</code>`,
      { parse_mode: 'HTML' }
    );
  }

  if (await requireStartConfirm(ctx)) return;

  unliSessions.set(ctx.from.id, { username, recipientId: recipientId || null, serverIndex, timestamp: Date.now() });

  const richHtml = [
    richTitle('💎', `PILIH EGG - PANEL UNLIMITED V${serverIndex}`),
    richTable(
      ['💎 Egg', 'Info'],
      [
        ['💎 <b>Node.js</b>', 'Untuk aplikasi Node.js'],
        ['loc / nest / egg', '1 / 5 / 15'],
        ['🐍<b>Python</b>', 'Untuk aplikasi Python'],
        ['loc / nest / egg', '1 / 5 / 16'],
      ]
    ),
    richPara(`Silahkan pilih egg yang ingin digunakan untuk panel unlimited di Server V${serverIndex}:`),
  ].join('\n');

  return renderCard(ctx, richHtml, Markup.inlineKeyboard([
    [{ text: eF('『 🟢 』 Node.js'), callback_data: `unli_v${serverIndex}_choose_nodejs_${ctx.from.id}`, style: "primary"}, { text: eF('『 🐍 』 Python'), callback_data: `unli_v${serverIndex}_choose_python_${ctx.from.id}`, style: "primary"}],
    [{ text: eF('『 ✖️ 』 Batal'), callback_data: 'menu', style: "danger"}],
  ]));
}

async function createPanelWithEggForServer(ctx, eggType, userId, serverIndex) {
  const userSession = unliSessions.get(userId);
  if (!userSession) {
    return ctx.answerCbQuery('⏱ Session expired, silahkan gunakan command lagi', true);
  }

  const { username, recipientId } = userSession;
  const eggConfig = getEggConfig(eggType);

  if (!eggConfig) {
    return ctx.answerCbQuery('❌ Egg tidak valid', true);
  }

  if (!isOwner(userId)) {
    const cooldown = checkRateLimit(userId);
    if (cooldown > 0) {
      return ctx.answerCbQuery(`⏳ Tunggu ${cooldown}s lagi`, true);
    }
  }

  const plan = PANEL_PLANS['unli'];
  if (!plan) return ctx.answerCbQuery('❌ Paket tidak valid', true);

  const allowedServers = getAllowedServersForUser(userId);
  const hasAccessToServer = allowedServers.some(s => s.index === serverIndex);
  if (!hasAccessToServer) {
    return ctx.answerCbQuery(`❌ Tidak ada akses ke Server V${serverIndex}`, true);
  }

  const msgText = `⏳ <b>Menyiapkan panel unlimited ${eggConfig.name} di Server V${serverIndex}...</b>\nUsername: <code>${htmlEscape(username)}</code>\nEgg: <b>${eggConfig.name}</b>`;

  try {
    await ctx.editMessageText(msgText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
  } catch (_) {}

  try {
    // Pass eggConfig agar engine Python/Node.js yang dipilih user diteruskan ke Pterodactyl
    const result = await createPanelForUserOnServer(username, plan, recipientId || userId, userId, serverIndex, eggConfig);
    const serverAttr = result.server?.attributes || {};
    const loginUrl = cleanDomain(result.serverDomain);

    const caption = eMulti([
      {
        title: '✅ パネル作成完了 - PANEL BERHASIL DIBUAT',
        lines: [
          `Login    ┈ ${htmlEscape(loginUrl)}`,
          `Username ┈ <b>${htmlEscape(result.finalUsername)}</b>`,
          `Password ┈ <code>${htmlEscape(result.user?.password || '-')}</code>`,
          `Paket    ┈ <b>${htmlEscape(plan.name)}</b>`,
          `Egg      ┈ <b>${eggConfig.name}</b> (${eggConfig.egg})`,
          `RAM      ┈ <b>${htmlEscape(plan.memory === 0 ? '∞ Unlimited' : `${plan.memory} MB`)}</b>`,
          `Disk     ┈ <b>${htmlEscape(plan.disk === 0 ? '∞ Unlimited' : `${plan.disk} MB`)}</b>`,
          `CPU      ┈ <b>${htmlEscape(plan.cpu === 0 ? '∞ Unlimited' : `${plan.cpu}%`)}</b>`,
          `Server   ┈ <b>V${result.serverIndex}</b>`,
          `SID      ┈ <code>${htmlEscape(serverAttr.identifier || serverAttr.uuid || '-')}</code>`,
          result.adjusted ? `Note  ┈ ${htmlEscape(result.requested)} ➜ ${htmlEscape(result.finalUsername)}` : `Note  ┈ Username langsung dipakai`,
          `Owner    ┈ ${htmlEscape(config.ownerName || 'HanzPiw Official')}`,
        ]
      },
      {
        title: '📌 KETENTUAN',
        lines: [
          'Garansi 15 hari  •  1x replace  •  No DDoS',
          'Jangan share  •  Dilarang tindakan ilegal',
        ]
      },
    ]);

    recordPanelStat(userId, result.serverIndex);
    await notifyOwnerNewPanel(ctx, { plan, username: result.finalUsername, userId, password: result.user?.password, serverIndex: result.serverIndex, pteroServerId: result.server?.attributes?.id, pteroUserId: result.user?.attributes?.id });

    const keyboard = resultActionKeyboard(loginUrl, result.finalUsername, result.user?.password);

    try {
      await ctx.deleteMessage();
    } catch (_) {}

    if (['group', 'supergroup'].includes(ctx.chat?.type)) {
      try {
        await sendDirectCard(ctx.from.id, caption, keyboard);
        const notifCaption = [
          `${'✅'} <b>Panel ${htmlEscape(plan.name)} (${htmlEscape(eggConfig.name)}) berhasil Dibuat!</b>`, '',
          `<b>📌 Nama Panel:</b> <code>${htmlEscape(result.finalUsername)}</code>`,
          `<b>👤 Pembuat:</b> ${htmlEscape(ctx.from?.username ? `@${ctx.from.username}` : [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User')}`,
          `<b>🆔 Id Server:</b> <code>V${result.serverIndex}</code> (Ptero: <code>${htmlEscape(String(result.server?.attributes?.id || '-'))}</code>)`,
          '',
          `<blockquote><b>📦 Paket:</b> ${htmlEscape(plan.name)}`,
          `<b>🥚 Egg:</b> ${htmlEscape(eggConfig.name)} (${eggConfig.egg})`,
          `<b>🧠 RAM:</b> ${htmlEscape(plan.memory === 0 ? '∞ Unlimited' : `${plan.memory} MB`)}`,
          `<b>💾 Disk:</b> ${htmlEscape(plan.disk === 0 ? '∞ Unlimited' : `${plan.disk} MB`)}`,
          `<b>⚙️ CPU:</b> ${htmlEscape(plan.cpu === 0 ? '∞ Unlimited' : `${plan.cpu}%`)}`,
          '</blockquote>',
          '',
          `<blockquote><b>✅ Data akun ( Email & Password ) telah dikirim ke Private Chat Anda</b>`,
          '</blockquote>'
        ].join('\n');
        await ctx.reply(notifCaption, { parse_mode: 'HTML' });
      } catch (_) {
        await renderCard(ctx, caption, keyboard);
      }
    } else {
      await renderCard(ctx, caption, keyboard);
    }

    unliSessions.delete(userId);

  } catch (error) {
    unliSessions.delete(userId);
    await ctx.editMessageText(
      `${'❌'} <b>Gagal membuat panel unlimited di V${serverIndex}</b>\n\n<code>${htmlEscape(error.message || error)}</code>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
    );
  }
}

async function handlePanelCommandForServer(ctx, planKey, serverIndex) {
  if (!hasAccessForPanel(ctx.from.id)) {
    const tier = getUserTier(ctx.from.id);
    if (!tier) return ctx.reply('❌ Kamu tidak memiliki role. Hubungi owner untuk mendapatkan akses panel.', { parse_mode: 'HTML' });
    return ctx.reply(`❌ Tier kamu (${TIER_LABELS[tier] || tier}) tidak memiliki akses server yang aktif.`, { parse_mode: 'HTML' });
  }

  if (!isOwner(ctx.from.id)) {
    const cooldown = checkRateLimit(ctx.from.id);
    if (cooldown > 0) {
      return ctx.reply(`⏳ Tunggu <b>${cooldown} detik</b> lagi sebelum membuat panel baru.`, { parse_mode: 'HTML' });
    }
  }

  const plan = PANEL_PLANS[planKey];
  if (!plan) return ctx.reply('❌ Paket tidak valid.', { parse_mode: 'HTML' });

  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const rawArg = args[0] || '';
  const { username, recipientId, error } = parseUsernameAndRecipient(rawArg);
  const targetUserId = recipientId || ctx.from.id;

  if (error || !username) {
    return ctx.reply(
      `❌ Format: <code>/unli${serverIndex} username</code>\nContoh: <code>/unli${serverIndex} myserver123</code>`,
      { parse_mode: 'HTML' }
    );
  }

  if (await requireStartConfirm(ctx)) return;

  const allowedServers = getAllowedServersForUser(ctx.from.id);
  const hasAccessToServer = allowedServers.some(s => s.index === serverIndex);

  if (!hasAccessToServer) {
    return ctx.reply(
      `❌ Kamu tidak memiliki akses ke Server V${serverIndex}.\n\nAkses yang tersedia: V${allowedServers.map(s => s.index).join(', V')}`,
      { parse_mode: 'HTML' }
    );
  }

  const loadingMsg = await ctx.reply(
    `⏳ <b>Menyiapkan panel ${plan.name} di Server V${serverIndex}...</b>\nUsername: <code>${htmlEscape(username)}</code>`,
    { parse_mode: 'HTML' }
  );

  try {
    const result = await createPanelForUserOnServer(username, plan, ctx.from.id, ctx.from.id, serverIndex);
    const serverAttr = result.server?.attributes || {};
    const loginUrl = cleanDomain(result.serverDomain);

    const caption = eMulti([
      {
        title: '✅ パネル作成完了 - PANEL BERHASIL DIBUAT',
        lines: [
          `Login    ┈ ${htmlEscape(loginUrl)}`,
          `Username ┈ <b>${htmlEscape(result.finalUsername)}</b>`,
          `Password ┈ <code>${htmlEscape(result.user?.password || '-')}</code>`,
          `Paket    ┈ <b>${htmlEscape(plan.name)}</b>`,
          `RAM      ┈ <b>${htmlEscape(plan.memory === 0 ? '∞ Unlimited' : `${plan.memory} MB`)}</b>`,
          `Disk     ┈ <b>${htmlEscape(plan.disk === 0 ? '∞ Unlimited' : `${plan.disk} MB`)}</b>`,
          `CPU      ┈ <b>${htmlEscape(plan.cpu === 0 ? '∞ Unlimited' : `${plan.cpu}%`)}</b>`,
          `Server   ┈ <b>V${result.serverIndex}</b>`,
          `SID      ┈ <code>${htmlEscape(serverAttr.identifier || serverAttr.uuid || '-')}</code>`,
          result.adjusted ? `Note  ┈ ${htmlEscape(result.requested)} ➜ ${htmlEscape(result.finalUsername)}` : `Note  ┈ Username langsung dipakai`,
          `Owner    ┈ ${htmlEscape(config.ownerName || 'HanzPiw Official')}`,
        ]
      },
      {
        title: '📌 KETENTUAN',
        lines: [
          'Garansi 15 hari  •  1x replace  •  No DDoS',
          'Jangan share  •  Dilarang tindakan ilegal',
        ]
      },
    ]);

    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    recordPanelStat(ctx.from.id, result.serverIndex);
    await notifyOwnerNewPanel(ctx, { plan, username: result.finalUsername, userId: ctx.from.id, password: result.user?.password, serverIndex: result.serverIndex, pteroServerId: result.server?.attributes?.id, pteroUserId: result.user?.attributes?.id });

    const keyboard = resultActionKeyboard(loginUrl, result.finalUsername, result.user?.password);
    if (['group', 'supergroup'].includes(ctx.chat?.type)) {
      try {
        await sendDirectCard(ctx.from.id, caption, keyboard);
        const notifCaption = [
          `${'✅'} <b>Panel ${htmlEscape(plan.name)} (Node.js) berhasil Dibuat!</b>`, '',
          `<b>📌 Nama Panel:</b> <code>${htmlEscape(result.finalUsername)}</code>`,
          `<b>👤 Pembuat:</b> ${htmlEscape(ctx.from?.username ? `@${ctx.from.username}` : [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User')}`,
          `<b>🆔 Id Server:</b> <code>V${result.serverIndex}</code> (Ptero: <code>${htmlEscape(String(result.server?.attributes?.id || '-'))}</code>)`,
          '',
          `<blockquote><b>📦 Paket:</b> ${htmlEscape(plan.name)}`,
          `<b>🥚 Egg:</b> Node.js (15)`,
          `<b>🧠 RAM:</b> ${htmlEscape(plan.memory === 0 ? '∞ Unlimited' : `${plan.memory} MB`)}`,
          `<b>💾 Disk:</b> ${htmlEscape(plan.disk === 0 ? '∞ Unlimited' : `${plan.disk} MB`)}`,
          `<b>⚙️ CPU:</b> ${htmlEscape(plan.cpu === 0 ? '∞ Unlimited' : `${plan.cpu}%`)}`,
          '</blockquote>',
          '',
          `<blockquote><b>✅ Data akun ( Email & Password ) telah dikirim ke Private Chat Anda</b>`,
          '</blockquote>'
        ].join('\n');
        await ctx.reply(notifCaption, { parse_mode: 'HTML' });
      } catch (_) {
        await ctx.reply(
          '⚠️ <b>Panel berhasil dibuat!</b>\n\n'
          + 'Gagal kirim data ke DM-mu — kemungkinan kamu belum <code>/start</code> bot.\n'
          + '<i>Klik tombol di bawah, data login akan langsung dikirim otomatis.</i>',
          {
            parse_mode: 'HTML',
            ...(BOT_USERNAME ? {
              reply_markup: { inline_keyboard: [[{ text: '📩 Ambil Data Panel', url: `https://t.me/${BOT_USERNAME}?start=getpanel` }]] }
            } : {}),
          }
        ).catch(() => {});
        savePendingPanel(ctx.from.id, caption, keyboard);
      }
    } else {
      await renderCard(ctx, caption, keyboard);
    }
  } catch (error) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    await ctx.reply(`❌ <b>Gagal membuat panel ${plan.name} di V${serverIndex}</b>\n\n<code>${htmlEscape(error.message || error)}</code>`, { parse_mode: 'HTML' });
  }
}

async function handleAdminPanelCommandForServer(ctx, serverIndex) {
  if (requireGroupChat(ctx)) return;
  if (!canUseAdminPanel(ctx.from.id)) {
    return ctx.reply('❌ Command ini membutuhkan minimal tier Akme (Akses Menengah). Hubungi owner.', { parse_mode: 'HTML' });
  }

  const allowedServers = getAllowedServersForUser(ctx.from.id);
  const hasAccessToServer = allowedServers.some(s => s.index === serverIndex);

  if (!hasAccessToServer) {
    return ctx.reply(
      `❌ Kamu tidak memiliki akses ke Server V${serverIndex}.\n\nAkses yang tersedia: V${allowedServers.map(s => s.index).join(', V')}`,
      { parse_mode: 'HTML' }
    );
  }

  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const { username, recipientId, error: parseError } = parseUsernameAndRecipient(args[0] || '');
  if (parseError || !username || username.length < 3) {
    return ctx.reply(
      `❌ Format: <code>/cadpv${serverIndex} username</code>\nAtau jika buat untuk user lain: <code>/cadpv${serverIndex} username,IDTelegram</code>`,
      { parse_mode: 'HTML' }
    );
  }

  if (await requireStartConfirm(ctx)) return;

  const loadingMsg = await ctx.reply(
    `⏳ <b>Menyiapkan admin panel di Server V${serverIndex}...</b>\nUsername: <code>${htmlEscape(username)}</code>`,
    { parse_mode: 'HTML' }
  );

  try {
    const result = await createAdminPanelForUserOnServer(username, recipientId || ctx.from.id, ctx.from.id, serverIndex);
    const loginUrl = cleanDomain(result.serverDomain);

    const caption = eBox('👑 ADMIN PANEL BERHASIL', [
      `Login    ┈ ${htmlEscape(loginUrl)}`,
      `Username ┈ <b>${htmlEscape(result.finalUsername)}</b>`,
      `Password ┈ <code>${htmlEscape(result.user?.password || '-')}</code>`,
      `Status   ┈ Admin panel root`,
      `Server   ┈ <b>V${result.serverIndex}</b>`,
      result.adjusted ? `Note  ┈ ${htmlEscape(result.requested)} → ${htmlEscape(result.finalUsername)}` : `Note  ┈ Username dipakai langsung`,
      `Owner    ┈ ${htmlEscape(config.ownerName || 'HanzPiw Official')}`,
    ]);

    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}

    const keyboard = resultActionKeyboard(loginUrl, result.finalUsername, result.user?.password);
    if (['group', 'supergroup'].includes(ctx.chat?.type)) {
      try {
        await sendDirectCard(ctx.from.id, caption, keyboard);
        const adminNotifCaption = [
          `${'✅'} <b>Admin Panel berhasil Dibuat!</b>`, '',
          `<b>${'📌'} Nama Panel:</b> <code>${htmlEscape(result.finalUsername)}</code>`,
          `<b>${'👤'} Pembuat:</b> ${htmlEscape(ctx.from?.username ? `@${ctx.from.username}` : [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User')}`,
          `<b>${'✌️'} Id Server:</b> <code>V${result.serverIndex}</code>`,
          '',
          `<blockquote><b>${'🛡️'} Status:</b> Root Admin Panel`,
          '',
          `<blockquote><b>${'✅'} Data akun ( Email &amp; Password ) telah dikirim ke Private Chat Anda</b></blockquote>`,
        ].join('\n');
        await ctx.reply(adminNotifCaption, { parse_mode: 'HTML' });
      } catch (_) {
        await ctx.reply(
          '⚠️ <b>Panel berhasil dibuat!</b>\n\n'
          + 'Gagal kirim data ke DM-mu — kemungkinan kamu belum <code>/start</code> bot.\n'
          + '<i>Klik tombol di bawah, data login akan langsung dikirim otomatis.</i>',
          {
            parse_mode: 'HTML',
            ...(BOT_USERNAME ? {
              reply_markup: { inline_keyboard: [[{ text: '📩 Ambil Data Panel', url: `https://t.me/${BOT_USERNAME}?start=getpanel` }]] }
            } : {}),
          }
        ).catch(() => {});
        savePendingPanel(ctx.from.id, caption, keyboard);
      }
    } else {
      await renderCard(ctx, caption, keyboard);
    }
  } catch (error) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    await ctx.reply(`❌ <b>Gagal membuat admin panel di V${serverIndex}</b>\n\n<code>${htmlEscape(error.message || error)}</code>`, { parse_mode: 'HTML' });
  }
}

async function notifyOwnerNewPanel(ctx, { plan, username, userId, password, serverIndex, pteroServerId, pteroUserId, isGuest = false }) {
  const channelId = String(config.ownerChannelId || '').trim();

  const createdBy = ctx.from?.username
    ? `@${ctx.from.username}`
    : [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User';
  const time = formatPanelCreatedAt();
  const guestLabel = isGuest ? ' ⚠️ TAMU (belum di-add)' : '';

  try {
    const mypanelsFile = require('path').join(DB_DIR, 'mypanels.json');
    const mypanels = fbRead(mypanelsFile, { panels: {} });
    const uid = String(userId);
    if (!mypanels.panels[uid]) mypanels.panels[uid] = [];
    mypanels.panels[uid].unshift({
      username, plan: plan?.name || '-',
      serverIndex: serverIndex || 1,
      pteroServerId: String(pteroServerId || '-'),
      pteroUserId:   String(pteroUserId || '-'),
      createdAt: new Date().toISOString(),
      loginUrl: `${(config['domain' + (serverIndex > 1 ? 'v' + serverIndex : '')] || '').replace(/\/$/, '')}`,
    });
    if (mypanels.panels[uid].length > 50) mypanels.panels[uid] = mypanels.panels[uid].slice(0, 50);
    fbWrite(mypanelsFile, mypanels);
  } catch (_) {}

  if (bot._checkBulkPanelAlert) {
    bot._checkBulkPanelAlert(userId, ctx.from?.username).catch(() => {});
  }

  if (bot._writeAudit) {
    bot._writeAudit('panel_created', String(userId), username, {
      plan: plan?.name, server: serverIndex, pteroServerId,
    });
  }

  try {
    const stickerId = config.celebrationStickerId;
    if (stickerId) {
      await bot.telegram.sendSticker(String(ctx.from?.id || userId), stickerId);
    } else {

      const tip = i18n.randomTip ? i18n.randomTip(ctx.from?.id || userId) : '';
      const celebMsg = `🎉 <b>Panel berhasil dibuat!</b>\n👤 Username: <code>${htmlEscape(username)}</code>\n🖥️ Server: V${serverIndex || 1}${tip ? '\n\n' + tip : ''}`;
      await bot.telegram.sendMessage(String(ctx.from?.id || userId), celebMsg, { parse_mode: 'HTML' });
    }
  } catch (_) {}

  if (bot._sendPanelRating && !isGuest) {
    setTimeout(() => {
      bot._sendPanelRating(userId, username, serverIndex).catch(() => {});
    }, 5000);
  }

  try {
    const hargaFile = require('path').join(DB_DIR, 'harga.json');
    const harga = fbRead(hargaFile, {});
    const userRole = db.getUserRole ? db.getUserRole(userId) : null;
    const price = userRole?.role && harga[userRole.role]
      ? harga[userRole.role] : null;
    if (price && !isGuest) {
      const invId = `INV${Date.now().toString(36).toUpperCase()}`;
      const invMsg = [
        `🧾 <b>INVOICE — ${invId}</b>`,
        `<blockquote>`,
        `Panel: <code>${htmlEscape(username)}</code>`,
        `Plan: ${htmlEscape(plan?.name || '-')}`,
        `Role: ${userRole?.role || '-'}`,
        `Harga: <b>Rp${Number(price).toLocaleString('id-ID')}</b>`,
        `Server: V${serverIndex}`,
        `Waktu: ${time}`,
        `</blockquote>`,
        `<i>Simpan invoice ini sebagai bukti pembelian.</i>`,
      ].join('\n');
      await bot.telegram.sendMessage(String(userId), invMsg, { parse_mode: 'HTML' });

      const invFile = require('path').join(DB_DIR, 'invoices.json');
      const invs = fbRead(invFile, []);
      invs.unshift({ id: invId, userId: String(userId), username, plan: plan?.name, price, serverIndex, at: new Date().toISOString() });
      if (invs.length > 500) invs.splice(500);
      fbWrite(invFile, invs);
    }
  } catch (_) {}

  if (!channelId) return false;

  const caption = [
    `◆ <b>PANEL BARU DIBUAT${guestLabel}</b>`, '',
    '<blockquote>',
    `◆ <b>Tipe:</b> ${htmlEscape(plan?.name || '-')}${isGuest ? ' <i>(panel tamu 1×)</i>' : ''}`,
    `◉ <b>Username:</b> <code>${htmlEscape(username)}</code>`,
    `⌁ <b>UID Telegram:</b> <code>${htmlEscape(String(userId))}</code>`,
    `🖧 <b>Server:</b> V${serverIndex || 1}`,
    `🆔 <b>ID Server Ptero:</b> <code>${htmlEscape(String(pteroServerId || '-'))}</code>`,
    `👤 <b>ID User Ptero:</b> <code>${htmlEscape(String(pteroUserId || '-'))}</code>`,
    `◷ <b>Waktu:</b> ${htmlEscape(time)}`,
    `◉ <b>Dibuat oleh:</b> ${htmlEscape(createdBy)}`,
    '</blockquote>',
    `<blockquote>🗑️ Hapus panel: <code>/del ${htmlEscape(String(pteroServerId || 'ID_SERVER'))}</code></blockquote>`,
    '<blockquote>◆ Notifikasi otomatis sistem panel</blockquote>'
  ].join('\n');

  try {
    const { generatePanelCard } = require('./utils/CardGenerator');
    const imgBuffer = await generatePanelCard({
      type:         String(plan?.name || 'Unlimited'),
      username:     String(username || '-'),
      telegramId:   String(userId),
      server:       `Server V${serverIndex || 1}`,
      createdBy:    String(createdBy),
      time:         String(time),
      serverStatus: 'online',
    });
    await bot.telegram.sendPhoto(
      channelId,
      { source: imgBuffer },
      { caption, parse_mode: 'HTML' }
    );
    return true;
  } catch (imgErr) {

    console.warn('[NOTIF PANEL] Gambar gagal, fallback teks:', imgErr?.message || imgErr);
    try {
      await bot.telegram.sendMessage(channelId, caption, { parse_mode: 'HTML' });
      return true;
    } catch (error) {
      console.error('[NOTIF PANEL ERROR]', error?.message || error);
      return false;
    }
  }
}

async function getAllPanelServers() {
  const servers = getActiveServers();
  if (!servers.length) throw new Error('Tidak ada server aktif.');
  const all = [];
  for (const server of servers) {
    try {
      let page = 1;
      while (page <= 100) {
        const response = await pteroRequestFor(server, `/api/application/servers?per_page=100&page=${page}`);
        const rows = Array.isArray(response?.data) ? response.data : [];
        all.push(...rows.map(r => ({ ...r, _serverIndex: server.index, _server: server })));
        const pagination = response?.meta?.pagination;
        if (!rows.length || !pagination || page >= Number(pagination.total_pages || page)) break;
        page++;
      }
    } catch (e) {

      console.warn(`[getAllPanelServers] Server V${server.index} dilewati: ${e?.message || e}`);
    }
  }
  return all;
}

async function getAllPterodactylUsersOn(server) {
  const all = [];
  let page = 1;
  while (page <= 200) {
    const response = await pteroRequestFor(server, `/api/application/users?include=servers&per_page=100&page=${page}`);
    const rows = Array.isArray(response?.data) ? response.data : [];
    all.push(...rows.map(r => ({ ...r, _server: server })));
    const pagination = response?.meta?.pagination;
    if (!rows.length || !pagination || page >= Number(pagination.total_pages || page)) break;
    page++;
  }
  return all;
}

async function sendCekServer(ctx, options = {}) {
  const slots = [
    { index: 1, domain: config.domain,   plta: config.plta   },
    { index: 2, domain: config.domainv2, plta: config.pltav2 },
    { index: 3, domain: config.domainv3, plta: config.pltav3 },
    { index: 4, domain: config.domainv4, plta: config.pltav4 },
    { index: 5, domain: config.domainv5, plta: config.pltav5 },
  ];
  const results = [];
  for (const slot of slots) {
    const domain = cleanDomain(slot.domain || '');
    const plta = String(slot.plta || '');
    const isConfigured = domain && /^https?:\/\//i.test(domain) &&
                         plta && /^ptla_/i.test(plta) && !plta.includes('APPLICATION_API_KEY');
    if (!isConfigured) { results.push({ index: slot.index, status: 'not_configured', domain }); continue; }
    try {
      const res = await pteroRequestFor(slot, '/api/application/users?per_page=1&page=1');
      results.push({ index: slot.index, status: 'online', domain, total: res?.meta?.pagination?.total ?? 0 });
    } catch (error) {
      results.push({ index: slot.index, status: 'offline', domain, error: String(error?.message || error) });
    }
  }
  const onlineCount = results.filter(r => r.status === 'online').length;
  const updateTime  = new Date().toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta', hour12: false });
  const tableRows   = results.map(r => {
    if (r.status === 'not_configured') return [`V${r.index}`, '❌ Tidak dikonfigurasi', '—'];
    if (r.status === 'online')         return [`V${r.index}`, '✅ Online', `${r.total} user`];
    return [`V${r.index}`, '❌ Offline', '—'];
  });
  const richHtml = [
    richTitle('🖥️', 'Cek Server Config'),
    richTable(['Metrik', 'Nilai'], [
      ['Server Online', `<b>${onlineCount}/5</b>`],
      ['Update',        `<i>${richEscape(updateTime)}</i>`],
    ]),
    richTable(['Server', 'Status', 'User'], tableRows),
  ].join('\n');
  return renderCard(ctx, richHtml, Markup.inlineKeyboard([]), { thumb: true, ...options });
}

function readBlacklist() {
  return fbRead(BLACKLIST_FILE, []);
}
function saveBlacklist(list) {
  fbWrite(BLACKLIST_FILE, list);
}
function isBlacklisted(userId) {
  return readBlacklist().includes(String(userId));
}

function getMaintenanceStatus() {
  return fbRead(MAINTENANCE_FILE, { on: false }).on === true;
}
function setMaintenanceStatus(on) {
  fbWrite(MAINTENANCE_FILE, { on });
}

function getBlockedCmds() {
  const data = fbRead(BLOCKED_CMDS_FILE, { cmds: [] });
  return Array.isArray(data.cmds) ? data.cmds : [];
}
function saveBlockedCmds(cmds) {
  fbWrite(BLOCKED_CMDS_FILE, { cmds });
}
function isCommandBlocked(text) {
  const cmds = getBlockedCmds();
  if (!cmds.length) return false;
  const match = String(text || '').trim().match(/^\/([a-zA-Z0-9_]+)/);
  if (!match) return false;
  const cmd = match[1].toLowerCase();
  return cmds.some(c => c.toLowerCase().replace(/^\//, '') === cmd);
}

async function checkMembership(userId) {
  const notJoined = [];
  for (const ch of REQUIRED_CHANNELS) {
    try {
      const member = await bot.telegram.getChatMember(ch.id, userId);
      if (!['member', 'administrator', 'creator'].includes(member.status)) notJoined.push(ch);
    } catch (_) {
      notJoined.push(ch);
    }
  }
  return notJoined;
}

function readStats() {
  return fbRead(STATS_FILE, { totalPanels: 0, dailyStats: {}, serverStats: {}, tierStats: {} });
}
function saveStats(data) {
  fbWrite(STATS_FILE, data);
}
function recordPanelStat(userId, serverIndex) {
  try {
    const stats = readStats();
    const today = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
    const tier = getUserTier(userId) || 'unknown';
    stats.totalPanels = (stats.totalPanels || 0) + 1;
    stats.dailyStats[today] = (stats.dailyStats[today] || 0) + 1;
    stats.serverStats[String(serverIndex)] = (stats.serverStats[String(serverIndex)] || 0) + 1;
    stats.tierStats[tier] = (stats.tierStats[tier] || 0) + 1;
    saveStats(stats);
  } catch (_) {}
}

function checkRateLimit(userId) {
  const now = Date.now();

  const ovr        = fbRead(CONFIG_OVERRIDE_FILE, {});
  const tier        = getUserTier(userId);
  const tierCd      = TIER_COOLDOWN_MS[tier] ?? RATE_LIMIT_MS;
  const cdMs        = ovr.rateLimitMs || tierCd;
  const last        = rateLimitMap.get(String(userId));
  if (last && (now - last) < cdMs) {
    return Math.ceil((cdMs - (now - last)) / 1000);
  }
  rateLimitMap.set(String(userId), now);
  return 0;
}

async function sendInfoNotFound(ctx, mentionText, options = {}) {
  const richHtml = [
    richTitle('👤', 'Info Akun'),
    richTable(
      ['Field', 'Nilai'],
      [
        ['👤 Username', richEscape(mentionText)],
        ['🆔 User ID',  'Tidak diketahui'],
        ['⭐ Role',     'Belum terdaftar'],
      ]
    ),
    richNote(
      '⛔',
      'Belum Terdaftar',
      `User ini belum terdaftar di bot.<br>Hubungi <b>${richEscape(config.ownerName || 'HanzPiw Official')}</b> untuk mendapatkan akses panel.`
    ),
  ].join('\n');
  return renderCard(ctx, richHtml, Markup.inlineKeyboard([]), { thumb: true, ...options });
}

const { deflateRawSync } = require('zlib');

const _crcTable = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32buf(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}
function dosTime(d) {
  return ((d.getFullYear() - 1980) << 25) | ((d.getMonth() + 1) << 21) |
         (d.getDate() << 16) | (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
}

const BACKUP_SKIP_DIRS  = new Set(['node_modules', '.git', '.npm', '.cache', '.yarn', 'tmp', 'temp', '.venv', '__pycache__', '.recycle_bin']);
const BACKUP_SKIP_EXTS  = new Set(['.zip', '.gz', '.tar', '.log', '.tmp', '.lock', '.bak']);
const BACKUP_SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
const BACKUP_MAX_FILE_MB = 15;

function backupCollectFiles(dir, base) {
  const result = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return result; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel  = path.relative(base, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (BACKUP_SKIP_DIRS.has(e.name)) continue;
      result.push(...backupCollectFiles(full, base));
    } else if (e.isFile()) {
      if (BACKUP_SKIP_FILES.has(e.name)) continue;
      if (BACKUP_SKIP_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      let stat;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      if (stat.size > BACKUP_MAX_FILE_MB * 1024 * 1024) continue;
      result.push({ full, rel });
    }
  }
  return result;
}

function buildZipBuffer(files) {
  const locals = [], centrals = [];
  let offset = 0;
  const mtime = dosTime(new Date());

  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(f.full); } catch (_) { continue; }
    const nameBuf    = Buffer.from(f.rel, 'utf8');
    const compressed = deflateRawSync(raw, { level: 6 });
    const crc        = crc32buf(raw);

    const lfh = Buffer.allocUnsafe(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(8, 8); lfh.writeUInt32LE(mtime, 10); lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressed.length, 18); lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26); lfh.writeUInt16LE(0, 28);
    nameBuf.copy(lfh, 30);

    const cdh = Buffer.allocUnsafe(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(0x031E, 4); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8); cdh.writeUInt16LE(8, 10); cdh.writeUInt32LE(mtime, 12);
    cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(compressed.length, 20);
    cdh.writeUInt32LE(raw.length, 24); cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); cdh.writeUInt16LE(0, 32); cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36); cdh.writeUInt32LE(0x81A40000, 38); cdh.writeUInt32LE(offset, 42);
    nameBuf.copy(cdh, 46);

    locals.push(lfh, compressed);
    centrals.push(cdh);
    offset += lfh.length + compressed.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd  = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

async function doBackup(targetChatId) {
  const ts       = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const cwd      = process.cwd();
  const backupName = `Cpanel Jayss X HanzPiw ( ʙᴀᴄᴋᴜᴘ ).zip`;
  const backupPath = path.join(os.tmpdir(), backupName);

  console.log(`[BACKUP] Mengumpulkan file dari ${cwd} ...`);
  const files = backupCollectFiles(cwd, cwd);
  if (!files.length) throw new Error('Tidak ada file untuk di-backup.');

  console.log(`[BACKUP] ${files.length} file, membuat ZIP...`);
  const zipBuf = buildZipBuffer(files);
  const sizeMB = (zipBuf.length / (1024 * 1024)).toFixed(2);

  if (zipBuf.length > 50 * 1024 * 1024) {
    throw new Error(`File backup terlalu besar (${sizeMB} MB > 50 MB).`);
  }

  fs.writeFileSync(backupPath, zipBuf);
  console.log(`[BACKUP] ZIP ${sizeMB} MB, mengirim ke ${targetChatId}...`);

  try {
    await bot.telegram.sendDocument(
      targetChatId,
      { source: fs.createReadStream(backupPath), filename: backupName },
      {
        caption: [
          '<blockquote>📦 <b>BACKUP BOT</b>', '',
          `✅ Backup berhasil!`,
          `📅 Waktu  : ${ts}`,
          `📁 Ukuran : ${sizeMB} MB`,
          `📂 Files  : ${files.length} file`,
          `🤖 Bot    : ${config.botName || 'Cpanel HanzPiw X Jayss'}`,
          '</blockquote>'
        ].join('\n'),
        parse_mode: 'HTML',
      }
    );
    console.log(`[BACKUP] ✅ Terkirim ke ${targetChatId}.`);
    return backupName;
  } catch (sendErr) {
    throw new Error(`Gagal kirim ke Telegram (${targetChatId}): ${sendErr.message}`);
  } finally {
    try { fs.unlinkSync(backupPath); } catch (_) {}
  }
}

function readOfflineTracker() {
  return fbRead(OFFLINE_TRACKER_FILE, {});
}
function saveOfflineTracker(data) {
  fbWrite(OFFLINE_TRACKER_FILE, data);
}

async function pteroClientRequestFor(server, endpoint, options = {}) {
  const domain = cleanDomain(server.domain);
  const apiKey = String(server.pltc || '').trim();
  if (!apiKey || apiKey.includes('CLIENT_API_KEY')) {
    throw new Error(`Client API key (pltc) tidak dikonfigurasi di server V${server.index}`);
  }
  const response = await fetch(`${domain}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'Application/vnd.pterodactyl.v1+json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (response.status === 204) return {};
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
  if (!response.ok) {
    const detail = data?.errors?.[0]?.detail || data?.message || raw || 'Request gagal';
    throw new Error(`Client V${server.index} HTTP ${response.status}: ${detail}`);
  }
  return data;
}

async function getServerRunningState(server, identifier) {
  try {
    const res = await pteroClientRequestFor(server, `/api/client/servers/${identifier}/resources`);
    return res?.attributes?.current_state || 'unknown';
  } catch (_) { return 'unknown'; }
}

async function getAllPanelServersWithUsers() {
  const servers = getActiveServers();
  if (!servers.length) return [];
  const all = [];
  for (const server of servers) {
    let page = 1;
    while (page <= 100) {
      try {
        const response = await pteroRequestFor(server, `/api/application/servers?per_page=100&page=${page}&include=user`);
        const rows = Array.isArray(response?.data) ? response.data : [];
        all.push(...rows.map(r => ({ ...r, _serverIndex: server.index, _server: server })));
        const pagination = response?.meta?.pagination;
        if (!rows.length || !pagination || page >= Number(pagination.total_pages || page)) break;
        page++;
      } catch (_) { break; }
    }
  }
  return all;
}

async function startOfflineTrackerScheduler() {
  const jkt = () => new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const delay = ms => new Promise(r => setTimeout(r, ms));

  const tick = async () => {
    try {
      const activeServers = getActiveServers();
      if (!activeServers.length) return;

      const tracker = readOfflineTracker();
      const now = Date.now();

      let allPanelServers;
      try {
        allPanelServers = await getAllPanelServersWithUsers();
      } catch (e) {
        console.error('[OFFLINE TRACKER] Gagal fetch servers:', e.message);
        return;
      }

      const existingKeys = new Set();

      for (const srv of allPanelServers) {
        const attrs = srv?.attributes || {};
        const serverObj = srv._server;
        if (!serverObj || !attrs.id || !attrs.identifier) continue;

        const pteroServerId = attrs.id;
        const identifier    = attrs.identifier;
        const serverName    = attrs.name || 'Tanpa nama';
        const pteroUserId   = attrs.user;
        const adminStatus   = attrs.status;

        if (['installing', 'restoring_backup', 'reinstalling'].includes(adminStatus)) continue;

        let isAdminUser = false;
        const relUser = srv?.relationships?.user?.attributes;
        if (relUser !== undefined) {
          isAdminUser = Boolean(relUser?.root_admin);
        } else if (pteroUserId) {
          try {
            const ud = await pteroRequestFor(serverObj, `/api/application/users/${pteroUserId}`);
            isAdminUser = Boolean(ud?.attributes?.root_admin);
          } catch (_) {}
        }
        if (isAdminUser) continue;

        const key = `V${serverObj.index}_${identifier}`;
        existingKeys.add(key);

        const state = await getServerRunningState(serverObj, identifier);
        await delay(80);

        if (state === 'unknown') continue;

        if (state !== 'offline') {

          if (tracker[key]) {
            delete tracker[key];
            console.log(`[OFFLINE TRACKER] ✅ ${serverName} kembali online, tracker reset.`);
          }
          continue;
        }

        if (!tracker[key]) {

          tracker[key] = {
            firstSeenOffline: now,
            serverIndex:  serverObj.index,
            serverDomain: serverObj.domain,
            pteroServerId,
            identifier,
            serverName,
            pteroUserId,
          };
          console.log(`[OFFLINE TRACKER] ⚠️  ${serverName} (${identifier}) V${serverObj.index} offline — mulai hitung.`);
          continue;
        }

        const elapsed   = now - tracker[key].firstSeenOffline;
        const elapsedH  = Math.floor(elapsed / 3600000);
        const elapsedM  = Math.floor((elapsed % 3600000) / 60000);

        if (elapsed < OFFLINE_THRESHOLD_MS) {

          console.log(`[OFFLINE TRACKER] ⏳ ${serverName} offline ${elapsedH}j${elapsedM}m / 6j`);
          continue;
        }

        const autodelState = readAutodelDb();
        if (autodelState[`v${serverObj.index}`] !== true) {
          console.log(`[OFFLINE TRACKER] ⏭️  ${serverName} V${serverObj.index} offline ${elapsedH}j${elapsedM}m — AUTO DEL OFF, skip.`);
          continue;
        }

        console.log(`[OFFLINE TRACKER] 🗑️  ${serverName} offline ${elapsedH}j${elapsedM}m → hapus...`);

        let serverDeleted = false, userDeleted = false, skipReason = '';

        try {
          await pteroRequestFor(serverObj, `/api/application/servers/${pteroServerId}`, { method: 'DELETE' });
          serverDeleted = true;
        } catch (e) {
          skipReason = e.message;
          console.error(`[OFFLINE TRACKER] Gagal hapus server: ${e.message}`);
        }

        if (serverDeleted && pteroUserId) {
          await delay(500);
          try {
            const userInfo = await pteroRequestFor(serverObj, `/api/application/users/${pteroUserId}?include=servers`);
            const remainingServers = userInfo?.relationships?.servers?.data || [];
            if (remainingServers.length === 0) {
              await pteroRequestFor(serverObj, `/api/application/users/${pteroUserId}`, { method: 'DELETE' });
              userDeleted = true;
            } else {
              skipReason = `user masih punya ${remainingServers.length} server lain`;
            }
          } catch (e) {
            console.error(`[OFFLINE TRACKER] Gagal hapus user: ${e.message}`);
          }
        }

        delete tracker[key];
        serverStatusCache = { ts: 0, data: null };
  onlineServersCache = { ts: 0, count: null };

        const logLines = [
          `${'🗑️'} <b>AUTO DELETE — OFFLINE SERVER</b>`, '',
          '<blockquote>',
          `📝 Nama : ${htmlEscape(serverName)}`,
          `🆔 ID : <code>${htmlEscape(identifier)}</code>`,
          `🖥️ Panel : V${serverObj.index}`,
          `🕐 Offline : ${elapsedH} jam ${elapsedM} menit`,
          `🖥️ Server : ${serverDeleted ? `${'✅'} Dihapus` : `${'❌'} Gagal`}`,
          `👤 User : ${userDeleted ? `${'✅'} Dihapus` : `${'➡️'} Dilewati${skipReason ? ` (${skipReason.slice(0, 60)})` : ''}`}`,
          `🗓️ Waktu : ${jkt()}`,
          '</blockquote>',
        ];

        try {
          await bot.telegram.sendMessage(AUTO_DELETE_LOG_GROUP, logLines.join('\n'), { parse_mode: 'HTML' });
        } catch (logErr) {
          console.error('[OFFLINE TRACKER] Gagal kirim log:', logErr.message);
        }
      }

      for (const key of Object.keys(tracker)) {
        if (!existingKeys.has(key)) {
          console.log(`[OFFLINE TRACKER] 🧹 ${key} tidak ditemukan di panel, hapus dari tracker.`);
          delete tracker[key];
        }
      }

      saveOfflineTracker(tracker);
    } catch (e) {
      console.error('[OFFLINE TRACKER] Error pada tick:', e.message);
    }
  };

  setTimeout(tick, 2 * 60 * 1000);
  setInterval(tick, OFFLINE_CHECK_INTERVAL_MS);
  return { ok: true, info: `Threshold 6j, cek tiap ${OFFLINE_CHECK_INTERVAL_MS / 60000} menit` };
}

async function sendListServers(ctx, page = 1, options = {}) {
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Menu ini khusus owner.', Markup.inlineKeyboard([]), options);

  try {
    const servers = await getAllPanelServers();

    if (!servers.length) {
      return renderCard(ctx, '❌ Tidak ada server.', ownerMenuKeyboard(), options);
    }

    const serverMap = {};
    servers.forEach(s => {
      const idx = s._serverIndex || 1;
      if (!serverMap[idx]) serverMap[idx] = [];
      serverMap[idx].push(s);
    });

    const serverIndices = Object.keys(serverMap).map(Number).sort((a, b) => a - b);

    const caption = eMulti([
      {
        title: '🖥️ LIST SERVER',
        lines: [
          `Total: <b>${servers.length}</b> server di <b>${serverIndices.length}</b> server aktif`,
          '',
          'Silahkan pilih server untuk melihat detail list panel:',
          '',
          ...serverIndices.map(idx => `<b>Server V${idx}</b> - ${serverMap[idx].length} panel`)
        ]
      }
    ]);

    const buttons = serverIndices.map(idx =>
      [{ text: eF(`『 🖥️ 』 Server V${idx} (${serverMap[idx].length})`), callback_data: `list_server_detail_${idx}`, style: "primary"}]
    );
    buttons.push([{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: "danger"}, { text: eF('『 👑 』 Owner Menu'), callback_data: 'owner_menu', style: "primary"}]);

    const keyboard = Markup.inlineKeyboard(buttons);
    return renderCard(ctx, caption, keyboard, options);
  } catch (error) {
    return renderCard(ctx, `❌ Gagal mengambil daftar server.\n\n${htmlEscape(error.message || error)}`, ownerMenuKeyboard(), options);
  }
}

async function showServerDetail(ctx, serverIndex, page = 1, options = {}) {
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Menu ini khusus owner.', Markup.inlineKeyboard([]));

  try {
    const servers = await getAllPanelServers();
    const serverList = servers.filter(s => (s._serverIndex || 1) === serverIndex);

    const perPage = 10, totalPages = Math.max(1, Math.ceil(serverList.length / perPage));
    const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
    const slice = serverList.slice((current - 1) * perPage, current * perPage);

    const lines = slice.map((item, idx) => {
      const a = item.attributes || {};
      return `${(current - 1) * perPage + idx + 1}. <b>${htmlEscape(a.name || 'Tanpa nama')}</b><br>   ID: <code>${htmlEscape(a.id)}</code> · ${htmlEscape(a.status || '-')}`;
    });

    const rows = [];
    if (current > 1) rows.push({ text: eF('『 ◀ 』 Sebelumnya'), callback_data: `list_server_detail_${serverIndex}_${current - 1}`, style: "primary"});
    if (current < totalPages) rows.push({ text: eF('『 ▶ 』 Selanjutnya'), callback_data: `list_server_detail_${serverIndex}_${current + 1}`, style: "primary"});

    const caption = [
      `🖥️ <b>LIST PANEL - SERVER V${serverIndex}</b>`,
      `Total: <b>${serverList.length}</b> panel`,
      `Halaman ${current}/${totalPages}`, '',
      ...(lines.length ? lines : ['Belum ada panel.'])
    ].join('<br>');

    const keyboard = Markup.inlineKeyboard([
      ...(rows.length ? [rows] : []),
      [{ text: eF('『 ↩️ 』 Kembali'), callback_data: 'list_server_choose', style: "primary"}]
    ]);

    return renderCard(ctx, caption, keyboard, options);
  } catch (error) {
    return renderCard(ctx, `❌ Gagal mengambil detail server.\n\n${htmlEscape(error.message || error)}`, Markup.inlineKeyboard([
      [{ text: eF('『 ↩️ 』 Kembali'), callback_data: 'list_server_choose', style: "primary"}]
    ]), options);
  }
}

async function sendListPterodactylUsers(ctx, page = 1, options = {}) {
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Menu ini khusus owner.', Markup.inlineKeyboard([]), options);

  try {
    const servers = getActiveServers();
    if (!servers.length) {
      return renderCard(ctx, '❌ Tidak ada server aktif.', ownerMenuKeyboard(), options);
    }

    let allUsers = [];
    for (const server of servers) {
      try {
        const users = await getAllPterodactylUsersOn(server);
        allUsers.push(...users.map(u => ({ ...u, _server: server })));
      } catch (_) {}
    }

    if (!allUsers.length) {
      return renderCard(ctx, '❌ Tidak ada user.', ownerMenuKeyboard(), options);
    }

    const perPage = 10, totalPages = Math.max(1, Math.ceil(allUsers.length / perPage));
    const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
    const slice = allUsers.slice((current - 1) * perPage, current * perPage);

    const lines = slice.map((item, idx) => {
      const a = item.attributes || {};
      const srvIdx = item._server._index || 1;
      return `${(current - 1) * perPage + idx + 1}. <b>${htmlEscape(a.username || 'No username')}</b>\n   ID: <code>${a.id}</code> · Server V${srvIdx}`;
    });

    const rows = [];
    if (current > 1) rows.push({ text: eF('『 ⏪ 』 Sebelumnya'), callback_data: `list_users_${current - 1}`, style: "primary"});
    if (current < totalPages) rows.push({ text: eF('『 ⏩ 』 Selanjutnya'), callback_data: `list_users_${current + 1}`, style: "primary"});

    const caption = [
      `👤 <b>LIST SEMUA USER</b>`,
      `Total: <b>${allUsers.length}</b> user di ${servers.length} server`,
      `Halaman ${current}/${totalPages}`, '',
      ...(lines.length ? lines : ['Belum ada user.'])
    ].join('\n');

    const keyboard = Markup.inlineKeyboard([
      ...(rows.length ? [rows] : []),
      [{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: "danger"}, { text: eF('『 👑 』 Owner Menu'), callback_data: 'owner_menu', style: "primary"}]
    ]);

    return renderCard(ctx, caption, keyboard, options);
  } catch (error) {
    return renderCard(ctx, `❌ Gagal mengambil daftar user.\n\n${htmlEscape(error.message || error)}`, ownerMenuKeyboard(), options);
  }
}

async function showDeleteServerConfirm(ctx, serverId) {
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Command ini khusus owner.');
  if (!/^\d+$/.test(String(serverId || ''))) return renderCard(ctx, 'Format: <code>/del ID_SERVER</code>', ownerMenuKeyboard());
  try {
    const response = await pteroRequest(`/api/application/servers/${Number(serverId)}`);
    const a = response?.attributes || {};
    return renderCard(ctx,
      `⚠️ <b>KONFIRMASI HAPUS PANEL</b>\n\nNama: ${htmlEscape(a.name || '-')}\nID: <code>${htmlEscape(a.id || serverId)}</code>\nIdentifier: <code>${htmlEscape(a.identifier || '-')}</code>\n\nServer akan dihapus permanen. Lanjutkan?`,
      delServerConfirmKeyboard(serverId));
  } catch (error) {
    return renderCard(ctx, `❌ Server ID ${htmlEscape(serverId)} tidak ditemukan.\n\n${htmlEscape(error.message || error)}`, ownerMenuKeyboard());
  }
}

async function showDeleteServerConfirmForSlot(ctx, serverId, vn) {
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Command ini khusus owner.');
  if (!/^\d+$/.test(String(serverId || ''))) return renderCard(ctx, `Format: <code>/delv${vn} ID_SERVER</code>\nContoh: <code>/delv${vn} 123</code>`, ownerMenuKeyboard());
  const servers = getActiveServers();
  const server  = servers.find(s => s.index === vn);
  if (!server) return renderCard(ctx, `❌ Server V${vn} tidak aktif atau belum dikonfigurasi.`, ownerMenuKeyboard());
  try {
    const response = await pteroRequestFor(server, `/api/application/servers/${Number(serverId)}`);
    const a = response?.attributes || {};
    return renderCard(ctx,
      [
        '⚠️ <b>KONFIRMASI HAPUS PANEL</b>', '',
        `<blockquote>Slot: <b>V${vn}</b> · ${htmlEscape(cleanDomain(server.domain))}\nNama: ${htmlEscape(a.name || '-')}\nID: <code>${htmlEscape(String(a.id || serverId))}</code>\nIdentifier: <code>${htmlEscape(a.identifier || '-')}</code>\n\n⛔ Tidak bisa dibatalkan setelah dieksekusi!</blockquote>`,
      ].join('\n'),
      delVnConfirmKeyboard(vn, serverId)
    );
  } catch (error) {
    return renderCard(ctx,
      `❌ Server ID ${htmlEscape(serverId)} tidak ditemukan di V${vn}.\n\n${htmlEscape(error.message || error)}`,
      ownerMenuKeyboard()
    );
  }
}

let _startedUsersCache = null;

const pendingConfirmSessions = new Map();

function loadStartedUsers() {
  if (_startedUsersCache) return _startedUsersCache;
  _startedUsersCache = new Set(fbRead(STARTED_USERS_FILE, []));
  return _startedUsersCache;
}

function markUserStarted(userId) {
  const set = loadStartedUsers();
  const key = String(userId);
  if (!set.has(key)) {
    set.add(key);
    fbWrite(STARTED_USERS_FILE, [...set]);
  }
}

function hasUserStartedBot(userId) {
  return loadStartedUsers().has(String(userId));
}

async function requireStartConfirm(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (isOwner(userId) || hasUserStartedBot(userId)) return false;

  const cmdText = ctx.message?.text || '';
  const chatId  = ctx.chat?.id;
  pendingConfirmSessions.set(String(userId), {
    cmdText,
    chatId,
    timestamp: Date.now(),
  });

  const botLink = BOT_USERNAME
    ? `\n\n${'➡️'} <a href="https://t.me/${BOT_USERNAME}">Buka private chat bot di sini</a>, tekan Start, lalu kembali ke grup ini.`
    : '';

  await ctx.reply(
    `${'⚠️'} <b>Konfirmasi Start Bot!</b>\n\n` +
    `Sebelum panel dibuat, kamu perlu start bot di private chat terlebih dahulu agar hasil panel bisa dikirim ke DM kamu.\n` +
    `Lakukan sekali saja, tidak akan ditanya lagi setelahnya.` +
    botLink,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: `✅ Sudah Start Bot di Private Chat`, callback_data: `confirmstart_${userId}` }
        ]]
      }
    }
  );
  return true;
}

async function dispatchPendingCommand(ctx, cmdText) {
  const cmd = cmdText.trim().split(/\s+/)[0]
    .replace(/^\//, '').toLowerCase();

  if (cmd === 'unli')   return handleUnliCommand(ctx);
  if (cmd === 'cadp')   return handleAdminPanelCommand(ctx);
  if (PANEL_PLANS[cmd]) return handlePanelCommand(ctx, cmd);

  const unliv = cmd.match(/^unliv(\d+)$/);
  if (unliv) return handleUnliCommandForServer(ctx, Number(unliv[1]));

  const cadpv = cmd.match(/^cadpv(\d+)$/);
  if (cadpv) return handleAdminPanelCommandForServer(ctx, Number(cadpv[1]));

  const panelv = cmd.match(/^(.+?)v(\d+)$/);
  if (panelv && PANEL_PLANS[panelv[1]])
    return handlePanelCommandForServer(ctx, panelv[1], Number(panelv[2]));

  await ctx.reply(
    `${'⌛'} <b>Session expired.</b>\nSilahkan kirim ulang perintahmu.`,
    { parse_mode: 'HTML' }
  );
}

async function handlePanelCommand(ctx, planKey) {
  const userId = ctx.from.id;
  const hasRole = hasAccessForPanel(userId);
  const isGuest = !isOwner(userId) && !hasRole;

  if (isGuest) {

    if (hasUsedGuestPanel(userId)) {
      return ctx.reply(
        '⚠️ <b>AKSES PANEL TERBATAS</b>\n\n' +
        'Kamu belum memiliki akses panel resmi.\n' +
        '❌ Jatah panel gratis (1×) sudah digunakan.\n\n' +
        'Hubungi admin agar akses kamu segera di-add.\n' +
        `Owner: ${htmlEscape(config.ownerUsername || '@itshanzpiw')}`,
        { parse_mode: 'HTML' }
      );
    }

    await ctx.reply(
      '⚠️ <b>PANEL TAMU (1×)</b>\n\n' +
      'Kamu belum di-add oleh admin.\n' +
      '✅ Kamu diizinkan membuat <b>1 panel gratis</b> untuk sementara.\n\n' +
      'Setelah panel dibuat, kamu tidak bisa membuat panel lagi\n' +
      'sampai admin menambahkan akses ke akunmu.\n\n' +
      `🔔 Hubungi: ${htmlEscape(config.ownerUsername || '@itshanzpiw')}`,
      { parse_mode: 'HTML' }
    );
  } else if (!isOwner(userId)) {
    const tier = getUserTier(userId);
    if (!tier) return ctx.reply('❌ Kamu tidak memiliki role. Hubungi owner untuk mendapatkan akses panel.', { parse_mode: 'HTML' });
    if (!hasRole) return ctx.reply(`❌ Tier kamu (${TIER_LABELS[tier] || tier}) tidak memiliki akses server yang aktif.`, { parse_mode: 'HTML' });
  }

  if (!isOwner(userId)) {
    const cooldown = checkRateLimit(userId);
    if (cooldown > 0) {
      return ctx.reply(`⏳ Tunggu <b>${cooldown} detik</b> lagi sebelum membuat panel baru.`, { parse_mode: 'HTML' });
    }
  }
  const plan = PANEL_PLANS[planKey];
  if (!plan) return ctx.reply('❌ Paket tidak valid.', { parse_mode: 'HTML' });
  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const rawArg = args[0] || '';
  const { username, recipientId, error } = parseUsernameAndRecipient(rawArg);
  const targetUserId = recipientId || userId;

  if (error || !username) {
    return ctx.reply(
      `❌ Format: <code>/${planKey} username</code>\nContoh: <code>/${planKey} myserver123</code>`,
      { parse_mode: 'HTML' }
    );
  }

  if (await requireStartConfirm(ctx)) return;

  const allowedServers = isGuest ? getActiveServers() : getAllowedServersForUser(userId);
  const loadingMsg = await ctx.reply(
    `⏳ <b>Menyiapkan panel ${plan.name}...</b>\nUsername: <code>${htmlEscape(username)}</code>\n${isGuest ? '⚠️ Mode panel tamu (1×)' : `Akses server: V${allowedServers.map(s => s.index).join(', V')}`}`,
    { parse_mode: 'HTML' }
  );
  try {
    const result = isGuest
      ? await createGuestPanelPanel(username, plan, userId, async (serverIndex) => {
          try {
            await bot.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined,
              `⏳ <b>Menyiapkan panel ${plan.name}...</b>\nUsername: <code>${htmlEscape(username)}</code>\nMencoba Server V${serverIndex}... (panel tamu)`,
              { parse_mode: 'HTML' });
          } catch (_) {}
        })
      : await createPanelForUser(username, plan, userId, userId, async (serverIndex) => {
          try {
            await bot.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined,
              `⏳ <b>Menyiapkan panel ${plan.name}...</b>\nUsername: <code>${htmlEscape(username)}</code>\nMencoba Server V${serverIndex}...`,
              { parse_mode: 'HTML' });
          } catch (_) {}
        });
    const serverAttr = result.server?.attributes || {};
    const loginUrl = cleanDomain(result.serverDomain);
    const caption = eMulti([
      {
        title: '✅ パネル作成完了 - PANEL BERHASIL DIBUAT',
        lines: [
          `Login    ┈ ${htmlEscape(loginUrl)}`,
          `Username ┈ <b>${htmlEscape(result.finalUsername)}</b>`,
          `Password ┈ <code>${htmlEscape(result.user?.password || '-')}</code>`,
          `Paket    ┈ <b>${htmlEscape(plan.name)}</b>`,
          `RAM      ┈ <b>${htmlEscape(plan.memory === 0 ? '∞ Unlimited' : `${plan.memory} MB`)}</b>`,
          `Disk     ┈ <b>${htmlEscape(plan.disk === 0 ? '∞ Unlimited' : `${plan.disk} MB`)}</b>`,
          `CPU      ┈ <b>${htmlEscape(plan.cpu === 0 ? '∞ Unlimited' : `${plan.cpu}%`)}</b>`,
          `Server   ┈ <b>V${result.serverIndex}</b>`,
          `SID      ┈ <code>${htmlEscape(serverAttr.identifier || serverAttr.uuid || '-')}</code>`,
          result.adjusted ? `Note  ┈ ${htmlEscape(result.requested)} ➜ ${htmlEscape(result.finalUsername)}` : `Note  ┈ Username langsung dipakai`,
          `Owner    ┈ ${htmlEscape(config.ownerName || 'HanzPiw Official')}`,
        ]
      },
      {
        title: '📌 KETENTUAN',
        lines: [
          'Garansi 15 hari  •  1x replace  •  No DDoS',
          'Jangan share  •  Dilarang tindakan ilegal',
        ]
      },
    ]);
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}

    if (isGuest) {
      markGuestPanelUsed(userId, { planKey, username: result.finalUsername, serverIndex: result.serverIndex });
    }

    recordPanelStat(userId, result.serverIndex);
    await notifyOwnerNewPanel(ctx, { plan, username: result.finalUsername, userId, password: result.user?.password, serverIndex: result.serverIndex, pteroServerId: result.server?.attributes?.id, pteroUserId: result.user?.attributes?.id, isGuest });
    const keyboard = resultActionKeyboard(loginUrl, result.finalUsername, result.user?.password);
    if (['group', 'supergroup'].includes(ctx.chat?.type)) {
      try {
        await sendDirectCard(userId, caption, keyboard);
        const notifCaption = [
          `${'✅'} <b>Panel ${htmlEscape(plan.name)} ${isGuest ? '(Tamu 1×)' : '(Node.js)'} berhasil Dibuat!</b>`, '',
          `<b>📌 Nama Panel:</b> <code>${htmlEscape(result.finalUsername)}</code>`,
          `<b>👤 Pembuat:</b> ${htmlEscape(ctx.from?.username ? `@${ctx.from.username}` : [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User')}`,
          `<b>🆔 Id Server:</b> <code>V${result.serverIndex}</code> (Ptero: <code>${htmlEscape(String(result.server?.attributes?.id || '-'))}</code>)`,
          '',
          `<blockquote><b>📦 Paket:</b> ${htmlEscape(plan.name)}${isGuest ? ' <i>(tamu 1×)</i>' : ''}`,
          `<b>🥚 Egg:</b> Node.js (15)`,
          `<b>🧠 RAM:</b> ${htmlEscape(plan.memory === 0 ? '∞ Unlimited' : `${plan.memory} MB`)}`,
          `<b>💾 Disk:</b> ${htmlEscape(plan.disk === 0 ? '∞ Unlimited' : `${plan.disk} MB`)}`,
          `<b>⚙️ CPU:</b> ${htmlEscape(plan.cpu === 0 ? '∞ Unlimited' : `${plan.cpu}%`)}`,
          '</blockquote>',
          '',
          `<blockquote><b>✅ Data akun ( Email & Password ) telah dikirim ke Private Chat Anda</b>`,
          '</blockquote>'
        ].join('\n');
        await ctx.reply(notifCaption, { parse_mode: 'HTML' });
      } catch (_) {
        await ctx.reply(
          '⚠️ <b>Panel berhasil dibuat!</b>\n\n'
          + 'Gagal kirim data ke DM-mu — kemungkinan kamu belum <code>/start</code> bot.\n'
          + '<i>Klik tombol di bawah, data login akan langsung dikirim otomatis.</i>',
          {
            parse_mode: 'HTML',
            ...(BOT_USERNAME ? {
              reply_markup: { inline_keyboard: [[{ text: '📩 Ambil Data Panel', url: `https://t.me/${BOT_USERNAME}?start=getpanel` }]] }
            } : {}),
          }
        ).catch(() => {});
        savePendingPanel(ctx.from.id, caption, keyboard);
      }
    } else {
      await renderCard(ctx, caption, keyboard);
    }
  } catch (error) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    await ctx.reply(`❌ <b>Gagal membuat panel ${plan.name}</b>\n\n<code>${htmlEscape(error.message || error)}</code>`, { parse_mode: 'HTML' });
  }
}

async function handleAdminPanelCommand(ctx) {
  if (requireGroupChat(ctx)) return;
  if (!canUseAdminPanel(ctx.from.id)) {
    return ctx.reply('❌ Command ini membutuhkan minimal tier Akme (Akses Menengah). Hubungi owner.', { parse_mode: 'HTML' });
  }
  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const { username, recipientId, error: parseError } = parseUsernameAndRecipient(args[0] || '');
  if (parseError || !username || username.length < 3) {
    return ctx.reply(
      '❌ Format: <code>/cadp username</code>\nAtau jika buat untuk user lain: <code>/cadp username,IDTelegram</code>',
      { parse_mode: 'HTML' }
    );
  }

  if (await requireStartConfirm(ctx)) return;

  const loadingMsg = await ctx.reply(
    `⏳ <b>Menyiapkan admin panel...</b>\nUsername: <code>${htmlEscape(username)}</code>`,
    { parse_mode: 'HTML' }
  );
  try {
    const result = await createAdminPanelForUser(username, recipientId || ctx.from.id, ctx.from.id, async (serverIndex) => {
      try {
        await bot.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined,
          `⏳ <b>Menyiapkan admin panel...</b>\nUsername: <code>${htmlEscape(username)}</code>\nMencoba V${serverIndex}...`,
          { parse_mode: 'HTML' });
      } catch (_) {}
    });
    const loginUrl = cleanDomain(result.serverDomain);
    const caption = eBox('👑 アドミン - ADMIN PANEL BERHASIL', [
      `Login    ┈ ${htmlEscape(loginUrl)}`,
      `Username ┈ <b>${htmlEscape(result.finalUsername)}</b>`,
      `Password ┈ <code>${htmlEscape(result.user?.password || '-')}</code>`,
      `Status   ┈ <b>Root Admin Panel</b>`,
      `Server   ┈ <b>V${result.serverIndex}</b>`,
      result.adjusted ? `Note  ┈ ${htmlEscape(result.requested)} ➜ ${htmlEscape(result.finalUsername)}` : `Note  ┈ Username langsung dipakai`,
      `Owner    ┈ ${htmlEscape(config.ownerName || 'HanzPiw Official')}`,
    ]);
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    const keyboard = resultActionKeyboard(loginUrl, result.finalUsername, result.user?.password);
    if (['group', 'supergroup'].includes(ctx.chat?.type)) {
      try {
        await sendDirectCard(ctx.from.id, caption, keyboard);
        const adminNotifCaption = [
          `${'✅'} <b>Admin Panel berhasil Dibuat!</b>`, '',
          `<b>${'📌'} Nama Panel:</b> <code>${htmlEscape(result.finalUsername)}</code>`,
          `<b>${'👤'} Pembuat:</b> ${htmlEscape(ctx.from?.username ? `@${ctx.from.username}` : [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User')}`,
          `<b>${'✌️'} Id Server:</b> <code>V${result.serverIndex}</code>`,
          '',
          `<blockquote><b>${'🛡️'} Status:</b> Root Admin Panel`,
          '',
          `<blockquote><b>${'✅'} Data akun ( Email &amp; Password ) telah dikirim ke Private Chat Anda</b></blockquote>`,
        ].join('\n');
        await ctx.reply(adminNotifCaption, { parse_mode: 'HTML' });
      } catch (_) {
        await ctx.reply(
          '⚠️ <b>Panel berhasil dibuat!</b>\n\n'
          + 'Gagal kirim data ke DM-mu — kemungkinan kamu belum <code>/start</code> bot.\n'
          + '<i>Klik tombol di bawah, data login akan langsung dikirim otomatis.</i>',
          {
            parse_mode: 'HTML',
            ...(BOT_USERNAME ? {
              reply_markup: { inline_keyboard: [[{ text: '📩 Ambil Data Panel', url: `https://t.me/${BOT_USERNAME}?start=getpanel` }]] }
            } : {}),
          }
        ).catch(() => {});
        savePendingPanel(ctx.from.id, caption, keyboard);
      }
    } else {
      await renderCard(ctx, caption, keyboard);
    }
  } catch (error) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    await ctx.reply(`${'❌'} <b>Gagal membuat admin panel</b>\n\n<code>${htmlEscape(error.message || error)}</code>`, { parse_mode: 'HTML' });
  }
}

const monSuspended    = new Map();
const monRecovered    = new Set();
const monDiskHistory  = new Map();
const monCpuHistory   = new Map();
let   monitorRunning  = false;

function monDbLoad() {
  return fbRead(MONITOR_TOP10_DB, { topDisk: [], topCpu: [], lastUpdated: null });
}
function monDbSave(data) {
  fbWrite(MONITOR_TOP10_DB, data);
}
function monDbUpdateTop10(snapshots) {
  const db = monDbLoad();
  db.topDisk      = [...snapshots].sort((a,b) => b.diskUsed  - a.diskUsed).slice(0,10);
  db.topCpu       = [...snapshots].sort((a,b) => b.cpuUsed   - a.cpuUsed).slice(0,10);
  db.lastUpdated  = new Date().toISOString();
  monDbSave(db);
}

function monFmtMiB(mib) {
  if (mib == null) return 'N/A';
  const n = Number(mib);
  return n >= 1024 ? `${(n/1024).toFixed(2)} GiB` : `${n.toFixed(0)} MiB`;
}
function monPBar(pct, len = 10) {
  const filled = Math.round((Math.min(Number(pct)||0, 100)/100) * len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}
function monEscMd(str) {
  return String(str ?? '').replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}
function monNowWIB() {
  return new Date().toLocaleString('id-ID', {
    weekday:'long', year:'numeric', month:'long', day:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    hour12: false, timeZone: 'Asia/Jakarta',
  });
}
function monSpikeEmoji(pct) {
  const n = Number(pct)||0;
  if (n >= 98) return '🔴';
  if (n >= 90) return '🟠';
  if (n >= 80) return '🟡';
  return '🟢';
}

async function monGetAllServers() {
  const servers = getActiveServers();
  const all = [];
  for (const srv of servers) {
    let page = 1;
    while (true) {
      const data = await pteroRequestFor(srv, `/api/application/servers?per_page=100&page=${page}&include=user`);
      all.push(...(data.data || []).map(s => ({ ...s, _srv: srv })));
      if ((data.meta?.pagination?.current_page || page) >= (data.meta?.pagination?.total_pages || page)) break;
      page++;
    }
  }
  return all;
}

async function monGetResources(server, uuid) {
  const domain = cleanDomain(server.domain);
  const key    = String(server.pltc || '').trim();
  if (!key || key.includes('CLIENT_API_KEY')) return null;
  const res = await fetch(`${domain}/api/client/servers/${uuid}/resources`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'Application/vnd.pterodactyl.v1+json' },
  });
  if (!res.ok) return null;
  return res.json();
}

async function monSuspend(server, serverId) {
  await pteroRequestFor(server, `/api/application/servers/${serverId}/suspend`, { method: 'POST' });
}
async function monUnsuspend(server, serverId) {
  await pteroRequestFor(server, `/api/application/servers/${serverId}/unsuspend`, { method: 'POST' });
}
async function monDelete(server, serverId) {
  await pteroRequestFor(server, `/api/application/servers/${serverId}`, { method: 'DELETE' });
}
async function monStop(server, uuid) {
  const domain = cleanDomain(server.domain);
  const key    = String(server.pltc || '').trim();
  await fetch(`${domain}/api/client/servers/${uuid}/power`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'Application/vnd.pterodactyl.v1+json' },
    body: JSON.stringify({ signal: 'kill' }),
  });
}

function monBuildSuspendMsg({ serverName, serverUuid, owner, node, spikeType, reason,
  ramPercent, diskPercent, ramUsed, ramLimit, diskUsed, diskLimit, isRamUnlimited, isDiskUnlimited }) {
  const ramPctV  = ramPercent  ?? Math.min((ramUsed  / RAM_ABS_MAX_MIB)  * 100, 100);
  const diskPctV = diskPercent ?? Math.min((diskUsed / DISK_ABS_MAX_MIB) * 100, 100);
  const spikeLabel = spikeType === 'SUSPICIOUS' ? `${'⁉️'} DISK MENCURIGAKAN`
    : spikeType === 'RAM'      ? `${'🧠'} RAM`
    : spikeType === 'DISK'     ? `${'⬇️'} DISK`
    : `${'🧠'} RAM + ${'⬇️'} DISK`;
  const ramPctTxt  = isRamUnlimited  ? `${monFmtMiB(ramUsed)} digunakan`  : `${Number(ramPercent).toFixed(1)}%`;
  const diskPctTxt = isDiskUnlimited ? `${monFmtMiB(diskUsed)} digunakan` : `${Number(diskPercent).toFixed(1)}%`;
  const ramLimTxt  = isRamUnlimited  ? '∞ Unlimited' : monFmtMiB(ramLimit);
  const diskLimTxt = isDiskUnlimited ? '∞ Unlimited' : monFmtMiB(diskLimit);
  const reasonLine = reason ? `\n${'⁉️'} <b>Detail:</b> ${htmlEscape(reason)}` : '';
  return [
    `${'⁉️'} <b>SERVER DISUSPEND OTOMATIS</b>`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `${'📌'} <b>Nama:</b> <code>${htmlEscape(serverName)}</code>`,
    `${'✌️'}  <b>UUID:</b> <code>${serverUuid}</code>`,
    `${'👤'} <b>Owner:</b> ${htmlEscape(owner ?? 'Unknown')}`,
    `${'🖥️'} <b>Node:</b> ${htmlEscape(node ?? 'Unknown')}`,
    '',
    `${'⚠️'} <b>Alasan:</b> ${spikeLabel}${reasonLine}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `${'🧠'} <b>RAM Usage</b>`,
    `${monSpikeEmoji(ramPctV)} <code>${monPBar(ramPctV)}</code> <b>${ramPctTxt}</b>`,
    `   Pakai: <b>${monFmtMiB(ramUsed)}</b> / Limit: <b>${ramLimTxt}</b>`,
    '',
    `${'⬇️'} <b>Disk Usage</b>`,
    `${monSpikeEmoji(diskPctV)} <code>${monPBar(diskPctV)}</code> <b>${diskPctTxt}</b>`,
    `   Pakai: <b>${monFmtMiB(diskUsed)}</b> / Limit: <b>${diskLimTxt}</b>`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `${'✏️'} <b>Admin</b>`,
    `• Unsuspend: <code>/unsuspend ${serverUuid}</code>`,
    '',
    `${'🗓️'} <b>Waktu:</b> ${monNowWIB()} WIB`,
    `${'☄️'} <i>Cpanel Jayss X HanzPiw Auto Monitor</i>`,
  ].join('\n');
}

function monBuildRecoveryMsg({ serverName, serverUuid, ramPercent, diskPercent, ramUsed, diskUsed }) {
  const ramStr  = ramPercent  != null ? `${Number(ramPercent).toFixed(1)}%`  : `${Number(ramUsed).toFixed(0)} MiB`;
  const diskStr = diskPercent != null ? `${Number(diskPercent).toFixed(1)}%` : `${(diskUsed/1024).toFixed(2)} GiB`;
  return [
    `${'✅'} <b>SERVER KEMBALI NORMAL</b>`,
    '━━━━━━━━━━━━━━━━━',
    '',
    `${'📌'} <b>Server:</b> <code>${htmlEscape(serverName)}</code>`,
    `${'✌️'}  <b>UUID:</b> <code>${serverUuid}</code>`,
    '',
    `${'📊'} RAM: <b>${ramStr}</b> | Disk: <b>${diskStr}</b>`,
    'Resource sudah kembali normal.',
    '',
    `${'🗓️'} ${new Date().toLocaleTimeString('id-ID')} WIB`,
  ].join('\n');
}

function monBuildDeleteMsg({ serverName, serverUuid }) {
  return [
    `${'🗑️'} <b>SERVER DIHAPUS OTOMATIS</b>`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `${'📌'} <b>Nama:</b> <code>${htmlEscape(serverName)}</code>`,
    `${'✌️'}  <b>UUID:</b> <code>${serverUuid}</code>`,
    '',
    `${'⌛'} Server tersuspend lebih dari <b>7 jam</b> tanpa tindakan.`,
    `${'🔴'} Server telah <b>dihapus permanen</b> dari panel.`,
    '',
    `${'🗓️'} ${monNowWIB()} WIB`,
    `${'☄️'} <i>Cpanel Jayss X HanzPiw Auto Monitor</i>`,
  ].join('\n');
}

function monBuildCpuStopMsg({ serverName, serverId, owner, node, cpuUsed }) {
  return [
    `${'📶'} <b>SERVER DIHENTIKAN — CPU TINGGI</b>`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `${'📌'} <b>Nama:</b> <code>${htmlEscape(serverName)}</code>`,
    `${'✌️'}  <b>ID:</b> <code>${serverId}</code>`,
    `${'👤'} <b>Owner:</b> ${htmlEscape(owner ?? 'Unknown')}`,
    `${'🖥️'} <b>Node:</b> ${htmlEscape(node ?? 'Unknown')}`,
    '',
    `${'⚙️'} <b>CPU:</b> <code>${monPBar(Math.min(cpuUsed,100))}</code> <b>${Number(cpuUsed).toFixed(1)}%</b>`,
    '',
    `${'⚠️'} Dihentikan otomatis karena CPU ≥ <b>${CPU_STOP_THRESH}%</b>`,
    `${'🔄'} Jika ulangi → langsung <b>disuspend</b>`,
    '',
    `${'🗓️'} ${monNowWIB()} WIB`,
  ].join('\n');
}

function monBuildCpuSuspendMsg({ serverName, serverId, owner, node, cpuUsed }) {
  return [
    `${'⁉️'} <b>SERVER DISUSPEND — CPU BERULANG</b>`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `${'📌'} <b>Nama:</b> <code>${htmlEscape(serverName)}</code>`,
    `${'✌️'}  <b>ID:</b> <code>${serverId}</code>`,
    `${'👤'} <b>Owner:</b> ${htmlEscape(owner ?? 'Unknown')}`,
    `${'🖥️'} <b>Node:</b> ${htmlEscape(node ?? 'Unknown')}`,
    '',
    `${'⚙️'} <b>CPU:</b> <code>${monPBar(Math.min(cpuUsed,100))}</code> <b>${Number(cpuUsed).toFixed(1)}%</b>`,
    '',
    `${'🔴'} Sudah pernah dihentikan, sekarang langsung <b>disuspend</b>`,
    '',
    `${'✏️'} Unsuspend: <code>/unsuspend ${serverId}</code>`,
    '',
    `${'🗓️'} ${monNowWIB()} WIB`,
  ].join('\n');
}

function monBuildTop10Msg(db) {
  const fmtDisk = arr => arr.length === 0 ? '<i>Belum ada data</i>'
    : arr.map((s,i) => `<b>${i+1}.</b> <code>${htmlEscape(s.name)}</code> — <b>${monFmtMiB(s.diskUsed)}</b>\n    ${'👤'} <i>${htmlEscape(s.owner ?? 'Unknown')}</i>`).join('\n');
  const fmtCpu  = arr => arr.length === 0 ? '<i>Belum ada data</i>'
    : arr.map((s,i) => `<b>${i+1}.</b> <code>${htmlEscape(s.name)}</code> — <b>${Number(s.cpuUsed).toFixed(1)}%</b>\n    ${'👤'} <i>${htmlEscape(s.owner ?? 'Unknown')}</i>`).join('\n');
  const updated = db.lastUpdated
    ? htmlEscape(new Date(db.lastUpdated).toLocaleString('id-ID', { hour12:false, timeZone:'Asia/Jakarta' }))
    : 'Belum pernah';
  return [
    `${'📊'} <b>TOP 10 SERVER STATS</b>`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `${'⬇️'} <b>Disk Terbesar</b>`,
    fmtDisk(db.topDisk),
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `${'⚙️'} <b>CPU Tertinggi</b>`,
    fmtCpu(db.topCpu),
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `${'🗓️'} Update: <b>${updated}</b> WIB`,
  ].join('\n');
}

async function monCheckAutoDelete() {
  const now = Date.now();
  for (const [uuid, suspAt] of monSuspended.entries()) {
    if (now - suspAt < AUTO_DEL_MONITOR_MS) continue;
    let found, srvObj;
    try {
      const all = await monGetAllServers();
      const item = all.find(s => s.attributes.uuid === uuid);
      if (!item) { monSuspended.delete(uuid); continue; }
      found  = item.attributes;
      srvObj = item._srv;
    } catch (e) { console.error('[MONITOR] Auto-delete fetch err:', e.message); continue; }

    console.log(`[MONITOR] AUTO-DELETE "${found.name}" > 7 jam, hapus...`);
    try {
      await monDelete(srvObj, found.id);
      monSuspended.delete(uuid);
      monRecovered.delete(uuid);
      monDiskHistory.delete(uuid);
      console.log(`[MONITOR] "${found.name}" dihapus otomatis.`);
    } catch (e) { console.error('[MONITOR] Gagal hapus:', e.message); continue; }

    if (MONITOR_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(MONITOR_CHAT_ID,
          monBuildDeleteMsg({ serverName: found.name, serverUuid: uuid }),
          { parse_mode: 'HTML' });
      } catch (_) {}
    }
  }
}

async function monitorLoop() {
  if (!MONITOR_ENABLED || !MONITOR_CHAT_ID) return;
  if (monitorRunning) return;
  monitorRunning = true;
  console.log('[MONITOR] Siklus monitoring dimulai...');

  try {
    await monCheckAutoDelete();
    let servers;
    try {
      servers = await monGetAllServers();
      console.log(`[MONITOR] ${servers.length} server ditemukan`);
    } catch (e) { console.error('[MONITOR] Gagal fetch servers:', e.message); return; }

    const snapshots = [];

    for (const s of servers) {
      const { uuid, name, node, id: serverId, relationships } = s.attributes;
      const srvObj = s._srv;
      const owner = relationships?.user?.attributes?.email ?? null;

      let resources;
      try { resources = await monGetResources(srvObj, uuid); }
      catch (e) { console.warn(`[MONITOR] Gagal resource "${name}":`, e.message); continue; }
      if (!resources) continue;

      const currentState = resources.attributes?.current_state ?? 'unknown';
      const stats    = resources.attributes?.resources ?? {};
      const ramUsed  = (stats.memory_bytes ?? 0) / (1024*1024);
      const diskUsed = (stats.disk_bytes   ?? 0) / (1024*1024);
      const cpuUsed  =  stats.cpu_absolute ?? 0;

      const ramLimitRaw  = s.attributes.limits?.memory;
      const diskLimitRaw = s.attributes.limits?.disk;
      const isRamUnlimited  = !ramLimitRaw  || ramLimitRaw  === 0;
      const isDiskUnlimited = !diskLimitRaw || diskLimitRaw === 0;
      const ramLimit  = isRamUnlimited  ? null : ramLimitRaw;
      const diskLimit = isDiskUnlimited ? null : diskLimitRaw;
      const ramPercent  = ramLimit  ? (ramUsed  / ramLimit)  * 100 : null;
      const diskPercent = diskLimit ? (diskUsed / diskLimit) * 100 : null;

      snapshots.push({ uuid, name, owner, diskUsed, cpuUsed, ramUsed });

      if (MONITOR_DBG) {
        const rd = ramLimit  ? `${ramPercent.toFixed(1)}%  (${ramUsed.toFixed(0)}/${ramLimit} MiB)` : `unlimited (${ramUsed.toFixed(0)} MiB)`;
        const dd = diskLimit ? `${diskPercent.toFixed(1)}% (${diskUsed.toFixed(0)}/${diskLimit} MiB)` : `unlimited (${(diskUsed/1024).toFixed(2)} GiB)`;
        console.log(`[DBG] ${name.padEnd(30)} RAM:${rd}  DISK:${dd}  CPU:${cpuUsed.toFixed(1)}%`);
      }

      if (currentState === 'running' && cpuUsed >= CPU_STOP_THRESH) {
        const now = Date.now();
        const cpuRec = monCpuHistory.get(uuid) ?? { count: 0, lastStop: 0 };
        if (now - cpuRec.lastStop < CPU_STOP_CD_MS) {
        } else if (cpuRec.count >= 1) {
          console.log(`[MONITOR] CPU BERULANG "${name}" (${cpuUsed.toFixed(1)}%) → SUSPEND`);
          try {
            await monSuspend(srvObj, serverId);
            monSuspended.set(uuid, now);
            monRecovered.delete(uuid);
            monCpuHistory.set(uuid, { count: cpuRec.count+1, lastStop: now });
            await bot.telegram.sendMessage(MONITOR_CHAT_ID,
              monBuildCpuSuspendMsg({ serverName: name, serverId, owner, node, cpuUsed }),
              { parse_mode: 'HTML' });
          } catch (e) { console.error('[MONITOR] Gagal CPU suspend:', e.message); }
        } else {
          console.log(`[MONITOR] CPU TINGGI "${name}" (${cpuUsed.toFixed(1)}%) → STOP`);
          try {
            await monStop(srvObj, uuid);
            monCpuHistory.set(uuid, { count: 1, lastStop: now });
            await bot.telegram.sendMessage(MONITOR_CHAT_ID,
              monBuildCpuStopMsg({ serverName: name, serverId, owner, node, cpuUsed }),
              { parse_mode: 'HTML' });
          } catch (e) { console.error('[MONITOR] Gagal CPU stop:', e.message); }
        }
      }

      let susReason = null;
      const prevDisk = monDiskHistory.get(uuid);
      if (prevDisk != null) {
        const growth    = diskUsed - prevDisk;
        const growthPct = diskLimit ? (growth / diskLimit) * 100 : 0;
        if (growth >= SUS_DISK_GROWTH_MIB)
          susReason = `Disk naik *${monFmtMiB(growth)}* dalam ${POLL_MS/1000}s`;
        else if (diskLimit && growthPct >= SUS_DISK_GROWTH_PCT)
          susReason = `Disk naik *${growthPct.toFixed(1)}%* dari limit dalam ${POLL_MS/1000}s`;
      }
      monDiskHistory.set(uuid, diskUsed);

      const ramSpike = currentState === 'running' && (
        ramLimit ? ramPercent >= RAM_THRESHOLD_PCT : ramUsed >= RAM_ABS_MAX_MIB
      );
      const diskSpike = diskLimit ? diskPercent >= DISK_THRESHOLD_PCT : diskUsed >= DISK_ABS_MAX_MIB;
      const shouldSuspend = ramSpike || diskSpike || susReason != null;

      if (shouldSuspend) {
        const now = Date.now();
        if (now - (monSuspended.get(uuid) ?? 0) < SUSPEND_CD_MS) continue;
        const spikeType = susReason ? 'SUSPICIOUS'
          : ramSpike && diskSpike ? 'RAM+DISK'
          : ramSpike ? 'RAM' : 'DISK';
        if (susReason) console.log(`[MONITOR] MENCURIGAKAN "${name}": ${susReason}`);
        else console.log(`[MONITOR] ${spikeType} SPIKE "${name}"`);
        try {
          await monSuspend(srvObj, serverId);
          monSuspended.set(uuid, now);
          monRecovered.delete(uuid);
          console.log(`[MONITOR] "${name}" disuspend.`);
        } catch (e) { console.error('[MONITOR] Gagal suspend:', e.message); continue; }
        try {
          await bot.telegram.sendMessage(MONITOR_CHAT_ID,
            monBuildSuspendMsg({ serverName: name, serverUuid: uuid, owner, node,
              spikeType, reason: susReason, ramPercent, diskPercent,
              ramUsed, ramLimit, diskUsed, diskLimit, isRamUnlimited, isDiskUnlimited }),
            { parse_mode: 'HTML' });
        } catch (e) { console.error('[MONITOR] Gagal notif:', e.message); }
      } else if (monSuspended.has(uuid) && !monRecovered.has(uuid) && currentState === 'running') {
        try {
          await bot.telegram.sendMessage(MONITOR_CHAT_ID,
            monBuildRecoveryMsg({ serverName: name, serverUuid: uuid, ramPercent, diskPercent, ramUsed, diskUsed }),
            { parse_mode: 'HTML' });
          monRecovered.add(uuid);
        } catch (e) { console.error('[MONITOR] Gagal recovery notif:', e.message); }
      }
    }

    if (snapshots.length > 0) monDbUpdateTop10(snapshots);
    console.log('[MONITOR] Siklus selesai.\n');
  } finally {
    monitorRunning = false;
  }
}

function startMonitorScheduler() {
  if (!MONITOR_ENABLED) return { ok: false, info: 'Dinonaktifkan' };
  if (!MONITOR_CHAT_ID) return { ok: false, info: 'Chat ID kosong' };
  setTimeout(() => {
    monitorLoop();
    setInterval(monitorLoop, POLL_MS);
  }, 10000);
  return { ok: true, info: `Interval ${POLL_MS/1000}s` };
}

bot.catch(async (error, ctx) => {
  const retryAfter = get429RetryAfter(error);
  if (retryAfter > 0) {
    console.warn(`[RATE LIMIT] 429 di handler — retry after ${retryAfter}s (tidak ada balasan ke user)`);
    return;
  }
  console.error('[TELEGRAF ERROR]', error?.message || error);
  try {
    if (ctx && typeof ctx.reply === 'function') {
      await ctx.reply('❌ Terjadi error saat memproses request.', { parse_mode: 'HTML' });
    }
  } catch (_) {}
});

bot.use(async (ctx, next) => {
  if (!isOwner(ctx.from?.id) && getMaintenanceStatus()) {
    const text = '🔧 <b>Bot sedang dalam mode maintenance.</b>\n\n<i>Silakan tunggu hingga maintenance selesai.</i>';
    if (ctx.callbackQuery) {
      try { await ctx.answerCbQuery('🔧 Bot sedang maintenance. Harap tunggu.', { show_alert: true }); } catch (_) {}
    } else if (ctx.message) {
      try { await ctx.reply(text, { parse_mode: 'HTML' }); } catch (_) {}
    }
    return;
  }
  return next();
});

bot.use(async (ctx, next) => {
  if (ctx.message?.text && !isOwner(ctx.from?.id)) {
    if (isCommandBlocked(ctx.message.text)) {
      const m = ctx.message.text.trim().match(/^\/([a-zA-Z0-9_]+)/);
      const cmdName = m ? `/${m[1]}` : 'Command';
      return ctx.reply(`⛔ Command <code>${cmdName}</code> sedang dinonaktifkan oleh owner.`, { parse_mode: 'HTML' });
    }
  }
  return next();
});

bot.use(async (ctx, next) => {
  if (ctx.from?.id && !isOwner(ctx.from.id)) {
    if (ctx.message?.new_chat_members) return next();
    if (ctx.callbackQuery?.data?.startsWith('checkjoin_')) return next();
    if (ctx.callbackQuery?.data?.startsWith('confirmstart_')) return next();

    if (ctx.message || ctx.callbackQuery) {
      const notJoined = await checkMembership(ctx.from.id);
      if (notJoined.length > 0) {
        const userId      = ctx.from.id;
        const chatId      = ctx.chat?.id;
        const chatType    = ctx.chat?.type;

        if (chatId && (chatType === 'group' || chatType === 'supergroup') && ctx.message) {
          try { await muteUserInChat(chatId, userId); } catch (_) {}
        }

        const channelList = notJoined.map(ch => `• <a href="${ch.link}">${htmlEscape(ch.name)}</a>`).join('\n');

        const text = `${'⚠️'} <b>Wajib Join Channel!</b>\n\n` +
          `Kamu harus join semua channel berikut untuk menggunakan bot:\n\n` +
          `${channelList}\n\n` +
          `${'✅'} Setelah join semua channel, tekan tombol di bawah.`;

        const replyOpts = {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: chatId ? {
            inline_keyboard: [[
              { text: `✅ Check & Unmute Me`, callback_data: `checkjoin_${userId}_${chatId}` }
            ]]
          } : undefined,
        };

        if (ctx.callbackQuery) {
          try { await ctx.answerCbQuery(`${'⚠️'} Kamu harus join semua channel dulu!`, { show_alert: true }); } catch (_) {}
          try { await ctx.reply(text, replyOpts); } catch (_) {}
        } else if (ctx.message) {
          try { await ctx.reply(text, replyOpts); } catch (_) {}
        }
        return;
      }
    }
  }
  return next();
});

function readWhitelistGroupsGlobal() {
  return fbRead(path.join(__dirname, 'database', 'whitelisted_groups.json'), { enabled: false, groups: [] });
}
function isGroupWhitelistedGlobal(chatId) {
  const d = readWhitelistGroupsGlobal();
  if (!d.enabled) return true;
  return d.groups.includes(String(chatId));
}

bot.use(async (ctx, next) => {
  const _chatType = ctx.chat?.type;
  if ((_chatType === 'group' || _chatType === 'supergroup') &&
      ctx.updateType !== 'my_chat_member' &&
      !isGroupWhitelistedGlobal(ctx.chat?.id)) {
    try { await bot.telegram.leaveChat(ctx.chat.id); } catch (_) {}
    return;
  }

  if (ctx.from?.id && !isOwner(ctx.from.id) && isBlacklisted(ctx.from.id)) {
    if (ctx.callbackQuery) {
      try { await ctx.answerCbQuery('⛔ Kamu diblokir dari bot ini.', { show_alert: true }); } catch (_) {}
    } else if (ctx.message) {
      try { await ctx.reply('⛔ Akses ditolak. Kamu telah diblokir dari bot ini.', { parse_mode: 'HTML' }); } catch (_) {}
    }
    return;
  }

  const chatType = ctx.chat?.type;
  if (chatType === 'group' || chatType === 'supergroup') {
    try {
      const data = getPrayerDb();
      const groupId = String(ctx.chat.id);
      if (!data.groups.includes(groupId)) { data.groups.push(groupId); savePrayerDb(data); }
    } catch (_) {}
  }
  if (chatType === 'private' && !isOwner(ctx.from?.id)) {
    const isBroadcastUser = Boolean(BROADCAST_USERS[String(ctx.from?.id)]);
    const msgText         = ctx.message?.text?.trim() || '';
    const isBroadcastCmd  = msgText.startsWith('/broadcast');
    const isAbsenCmd      = msgText.startsWith('/absen');
    if (isBroadcastUser && (isBroadcastCmd || isAbsenCmd)) return next();

    try {
  await ctx.replyWithSticker('CAACAgUAAxkBA6_ly2rv3NulgpaR-IuNl97cG5MUco1YAAItGwACJ-XpVXMUci0P9D_LPQQ');
  await new Promise(r => setTimeout(r, 100));
} catch (_) {}
    if (ctx.callbackQuery) {
      try { await ctx.answerCbQuery('Bot hanya dapat digunakan di grup. PV khusus owner.', { show_alert: true }); } catch (_) {}
    } else if (ctx.message) {
      try { await ctx.reply('⛔ 𝗔𝗞𝗦𝗘𝗦 𝗗𝗜𝗕𝗔𝗧𝗔𝗦𝗜\n\nMaaf, bot ini hanya dapat digunakan melalui grup yang telah ditentukan.\n\n🔒 Akses melalui private chat dinonaktifkan dan hanya tersedia khusus untuk Owner Bot.\n\nSilakan gunakan bot melalui grup untuk mengakses seluruh fitur yang tersedia.', { parse_mode: 'HTML' }); } catch (_) {}
    }
    return;
  }
  return next();
});

bot.use(async (ctx, next) => {
  try {
    const msg    = ctx.message;
    const chatId = ctx.chat?.id;
    const from   = ctx.from;
    if (!msg || !chatId || !from) return next();

    const chatType = ctx.chat?.type;
    if (chatType !== 'group' && chatType !== 'supergroup') return next();
    if (isOwner(from.id)) return next();

    const text = (msg.text || msg.caption || '').trim();
    if (!text) return next();

    if (typeof bot._checkBanword === 'function') {
      const matched = bot._checkBanword(text);
      if (matched) {
        const msgId   = msg.message_id;
        const mention = from.username
          ? `@${from.username}`
          : `<a href="tg://user?id=${from.id}">${htmlEscape(from.first_name || 'User')}</a>`;

        try { await bot.telegram.deleteMessage(chatId, msgId); } catch (_) {}

        try {
          const warn = await bot.telegram.sendMessage(chatId,
            `${'⚠️'} <b>⚠️ PERINGATAN KATA TERLARANG</b>\n\n` +
            `${mention}, pesan kamu dihapus karena mengandung kata yang dilarang.\n\n` +
            `<blockquote>🚫 Kata terdeteksi: <code>${htmlEscape(matched)}</code></blockquote>\n` +
            `<i>Harap jaga etika dan sopan santun di grup ini.</i>`,
            { parse_mode: 'HTML' }
          );
          setTimeout(() => {
            bot.telegram.deleteMessage(chatId, warn.message_id).catch(() => {});
          }, 15000);
        } catch (_) {}

        return;
      }
    }
  } catch (_) {}
  return next();
});

bot.on('my_chat_member', async (ctx, next) => {
  const chat = ctx.chat;
  if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
    try {
      const status = ctx.myChatMember?.new_chat_member?.status;
      if (status && ['member', 'administrator'].includes(status)) {
        if (!isGroupWhitelistedGlobal(chat.id)) {
          try {
            await bot.telegram.sendMessage(chat.id,
              `⛔ Grup ini tidak terdaftar di whitelist bot ini.\nBot akan keluar secara otomatis.\n\n` +
              `📞 Hubungi owner dan minta ID grup ini (<code>${chat.id}</code>) ditambahkan via /setwhitelistgroup add ${chat.id}`,
              { parse_mode: 'HTML' }
            );
          } catch (_) {}
          try { await bot.telegram.leaveChat(chat.id); } catch (_) {}
          return;
        }
        const data = getPrayerDb();
        const groupId = String(chat.id);
        if (!data.groups.includes(groupId)) data.groups.push(groupId);
        savePrayerDb(data);
      }
    } catch (_) {}
  }
  return next();
});

async function muteUserInChat(chatId, userId) {
  try {
    await bot.telegram.restrictChatMember(chatId, userId, {
      until_date: 0,
      permissions: {
        can_send_messages:         false,
        can_send_audios:           false,
        can_send_documents:        false,
        can_send_photos:           false,
        can_send_videos:           false,
        can_send_video_notes:      false,
        can_send_voice_notes:      false,
        can_send_polls:            false,
        can_send_other_messages:   false,
        can_add_web_page_previews: false,
        can_change_info:           false,
        can_invite_users:          false,
        can_pin_messages:          false,
      }
    });
    return true;
  } catch (_) { return false; }
}

async function unmuteUserInChat(chatId, userId) {
  try {
    await bot.telegram.restrictChatMember(chatId, userId, {
      permissions: {
        can_send_messages:         true,
        can_send_audios:           true,
        can_send_documents:        true,
        can_send_photos:           true,
        can_send_videos:           true,
        can_send_video_notes:      true,
        can_send_voice_notes:      true,
        can_send_polls:            true,
        can_send_other_messages:   true,
        can_add_web_page_previews: true,
        can_change_info:           false,
        can_invite_users:          true,
        can_pin_messages:          false,
      }
    });
    return true;
  } catch (_) { return false; }
}

bot.on('new_chat_members', async (ctx) => {
  try {
    const chatType = ctx.chat?.type;
    if (!['group', 'supergroup'].includes(chatType)) return;
    if (!REQUIRED_CHANNELS || REQUIRED_CHANNELS.length === 0) return;

    const chatId = ctx.chat.id;

    for (const newMember of (ctx.message?.new_chat_members || [])) {
      if (newMember.is_bot) continue;
      if (isOwner(newMember.id)) continue;

      const notJoined = await checkMembership(newMember.id);
      if (notJoined.length === 0) continue;

      await muteUserInChat(chatId, newMember.id);

      const firstName   = htmlEscape(newMember.first_name || 'User');
      const channelList = notJoined.map(ch => `• <a href="${ch.link}">${htmlEscape(ch.name)}</a>`).join('\n');
      const cbData      = `checkjoin_${newMember.id}_${chatId}`;

      await ctx.reply(
        `${'⚠️'} <b>Hei, ${firstName}!</b>\n\n` +
        `Kamu di-<b>mute</b> sementara karena belum join semua channel wajib.\n\n` +
        `${'🔗'} <b>Channel yang harus di-join:</b>\n${channelList}\n\n` +
        `${'⌛'} Setelah join semua channel di atas, tekan tombol <b>Check & Unmute Me</b>.`,
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[
              { text: `✅ Check & Unmute Me`, callback_data: cbData }
            ]]
          }
        }
      );
    }
  } catch (err) {
    console.error('[NEW_MEMBER_MUTE]', err.message);
  }
});

bot.action(/^checkjoin_(\d+)_(-?\d+)$/, async (ctx) => {
  try {
    const [, targetUserId, chatIdStr] = ctx.match;
    const presserId = String(ctx.from.id);
    const chatId    = Number(chatIdStr);

    if (presserId !== targetUserId) {
      return ctx.answerCbQuery(`${'❌'} Tombol ini hanya untuk user yang di-mute.`, { show_alert: true });
    }

    const notJoined = await checkMembership(ctx.from.id);
    if (notJoined.length > 0) {
      const remaining = notJoined.map(ch => ch.name).join(', ');
      return ctx.answerCbQuery(`⚠️ Masih belum join: ${remaining}`, { show_alert: true });
    }

    const ok = await unmuteUserInChat(chatId, ctx.from.id);
    if (ok) {
      const firstName = htmlEscape(ctx.from.first_name || 'User');
      try {
        await ctx.editMessageText(
          `${'✅'} <b>${firstName} sudah di-unmute!</b>\n\n${'🎉'} Selamat datang dan selamat menggunakan bot!`,
          { parse_mode: 'HTML' }
        );
      } catch (_) {}
      return ctx.answerCbQuery(`✅ Berhasil! Kamu sudah di-unmute. Selamat datang!`, { show_alert: true });
    } else {
      return ctx.answerCbQuery(`${'❌'} Gagal unmute. Pastikan bot punya hak Admin di grup.`, { show_alert: true });
    }
  } catch (err) {
    console.error('[CHECKJOIN_CB]', err.message);
    try { await ctx.answerCbQuery('Terjadi error, coba lagi.', { show_alert: true }); } catch (_) {}
  }
});

bot.action(/^confirmstart_(\d+)$/, async (ctx) => {
  try {
    const [, targetUserId] = ctx.match;
    const presserId = String(ctx.from.id);

    if (presserId !== targetUserId) {
      return ctx.answerCbQuery(`❌ Tombol ini bukan untukmu.`, { show_alert: true });
    }

    const pending = pendingConfirmSessions.get(presserId);
    pendingConfirmSessions.delete(presserId);

    markUserStarted(presserId);

    await ctx.answerCbQuery('✅ Konfirmasi diterima!');

    try {
      await ctx.editMessageText(
        `${'✅'} <b>Konfirmasi diterima!</b>\n<i>Memproses perintah kamu...</i>`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {}

    if (!pending || (Date.now() - pending.timestamp) > 5 * 60 * 1000) {
      return ctx.reply(
        `${'⌛'} <b>Session expired (>5 menit).</b>\n\nSilahkan kirim ulang perintahmu.`,
        { parse_mode: 'HTML' }
      );
    }

    const fakeCtx = Object.create(ctx);
    fakeCtx.message = {
      text: pending.cmdText,
      message_id: 0,
      from: ctx.from,
      chat: ctx.chat,
    };

    await dispatchPendingCommand(fakeCtx, pending.cmdText);
  } catch (err) {
    console.error('[CONFIRMSTART_CB]', err.message);
    try { await ctx.answerCbQuery('Error, coba kirim ulang perintahmu.', { show_alert: true }); } catch (_) {}
  }
});

bot.start(async (ctx) => {
  if (ctx.chat?.type === 'private') {
    markUserStarted(ctx.from.id);

    const _pendingKey = path.join(DB_DIR, `pending_panel_${ctx.from.id}.json`);
    const _pending    = fbRead(_pendingKey, null);
    if (_pending?.caption && !_pending.delivered && (Date.now() - (_pending.at || 0)) < 86_400_000) {
      fbWrite(_pendingKey, { ..._pending, delivered: true });
      await ctx.reply(_pending.caption, {
        parse_mode: 'HTML',
        ...(_pending.keyboardMarkup ? { reply_markup: _pending.keyboardMarkup } : {}),
      }).catch(() => {});
    }
  }
try {
  await ctx.replyWithSticker('CAACAgUAAxkBA69URGruNNl9bHHVZgguD3AWLUmxqnooAAKICAACMzdJVsNM_eVeQiOMPQQ');
  await new Promise(r => setTimeout(r, 800));
} catch (_) {}

try {
  await sendMenu(ctx);

  if (config.startAudio?.url) {
    try {
      await ctx.replyWithAudio(
        { url: config.startAudio.url },
        {
          title: config.startAudio.title || config.botName || 'Menu',
          performer: config.startAudio.performer || '',
        }
      );
    } catch (_) {}
  }
} catch (e) {
  console.error('[START ERROR]', e);
  await ctx.reply(
    '❌ <b>Menu gagal dimuat.</b>\n<i>Coba /menu</i>',
    { parse_mode: 'HTML' }
  );
}
});

bot.action('upd_go', async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.answerCbQuery('Khusus owner bot.', { show_alert: true });
  }
  await ctx.answerCbQuery('Memulai update...').catch(() => {});

  const { isUpdating, applyUpdate, setPendingNotice } = require('./lib/updater');
  const chatId = ctx.chat.id;
  const msgId  = ctx.callbackQuery?.message?.message_id || null;

  const edit = (text) => msgId
    ? ctx.telegram.editMessageText(chatId, msgId, undefined, text, { parse_mode: 'HTML' }).catch(() => {})
    : ctx.reply(text, { parse_mode: 'HTML' });

  if (isUpdating()) return edit('⏳ <b>Update sedang berjalan.</b> Tunggu sebentar.');

  await edit('⏳ <b>Mengunduh & memasang update...</b>');

  const onProgress = (stage) => {
    const stageText = {
      download: '📥 <b>Mengunduh file dari GitHub...</b>',
      sync:     '🔄 <b>Menyinkronkan file...</b>',
      cleanup:  '🗑️ <b>Menghapus file lama yang tidak ada di repo...</b>',
    }[stage];
    if (stageText) edit(stageText);
  };

  try {
    const r = await applyUpdate(config, { force: false, onProgress });
    if (r.status === 'uptodate') {
      return edit('✅ <b>Sudah Versi Terbaru</b>\n\n<blockquote>📦 Versi : <code>' + r.from + '</code></blockquote>');
    }
    const changelogText = r.changelog?.length
      ? '\n\n📝 <b>Yang baru:</b>\n' + r.changelog.map(l => '• ' + l).join('\n')
      : '';
    setPendingNotice(chatId, { by: ctx.from.id });
    await edit(
      '✅ <b>Update Berhasil!</b>\n\n<blockquote>' +
      '📦 Versi : <code>' + r.from + '</code> → <code>' + r.to + '</code>\n' +
      '📄 File diperbarui : ' + r.changed +
      (r.removed ? '\n🗑️ File lama dihapus : ' + r.removed : '') +
      (r.npm     ? '\n🔧 Dependency diinstall ulang'            : '') +
      '\n🔄 Bot restart otomatis...</blockquote>' + changelogText
    );
    setTimeout(() => process.exit(1), 2000);
  } catch (e) {
    await edit(
      '❌ <b>Update Gagal</b>\n\n<blockquote>File dikembalikan seperti semula.\n<code>' +
      e.message.slice(0, 300) + '</code></blockquote>'
    );
  }
});

bot.command(['update', 'cekupdate'], async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  const {
    isConfigured: updIsConfigured,
    checkForUpdate, applyUpdate,
    isUpdating, localVersion, setPendingNotice,
  } = require('./lib/updater');
  const chatId  = ctx.chat.id;
  const rawCmd  = (ctx.message?.text || '').trim().split(/\s+/)[0]
    .replace(/^\//, '').split('@')[0].toLowerCase();
  const args    = (ctx.message?.text || '').trim().split(/\s+/).slice(1);

  if (!updIsConfigured(config)) {
    return ctx.reply(
      `❌ <b>Auto Update Belum Aktif</b>\n\n<blockquote>Isi <code>autoUpdate.repo</code> di <code>config.js</code>\nContoh: <code>"username/nama-repo"</code></blockquote>`,
      { parse_mode: 'HTML' }
    );
  }

  if (rawCmd === 'cekupdate') {
    const m = await ctx.reply('⏳ Memeriksa update...', { parse_mode: 'HTML' });
    try {
      const r = await checkForUpdate(config);
      const text = r.hasUpdate
        ? `🔔 <b>Update Tersedia!</b>\n\n<blockquote>📦 Sekarang : <code>${r.local}</code>\n🆕 Versi baru : <code>${r.remote.version}</code>${r.remote.date ? ` (${r.remote.date})` : ''}</blockquote>\n\nKetik /update untuk memperbarui.`
        : `✅ <b>Sudah Versi Terbaru</b>\n\n<blockquote>📦 Versi : <code>${r.local}</code>\nSumber : <code>h******xk****et/*p***l-****-*-*******</code></blockquote>`;
      await ctx.telegram.editMessageText(chatId, m.message_id, undefined, text, { parse_mode: 'HTML' });
    } catch (e) {
      await ctx.telegram.editMessageText(chatId, m.message_id, undefined,
        `❌ <b>Gagal Cek Update</b>\n\n<code>${e.message}</code>`, { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    return;
  }

  if (isUpdating()) {
    return ctx.reply('⏳ <b>Update sedang berjalan.</b> Tunggu sebentar.', { parse_mode: 'HTML' });
  }
  const force = (args[0] || '').toLowerCase() === 'force';
  const m = await ctx.reply('⏳ <b>Mengunduh & memasang update...</b>', { parse_mode: 'HTML' });

  const onProgress = (stage) => {
    const stageText = {
      download: '📥 <b>Mengunduh file dari GitHub...</b>',
      sync:     '🔄 <b>Menyinkronkan file...</b>',
      cleanup:  '🗑️ <b>Menghapus file lama yang tidak ada di repo...</b>',
    }[stage];
    if (stageText) {
      ctx.telegram.editMessageText(chatId, m.message_id, undefined, stageText, { parse_mode: 'HTML' }).catch(() => {});
    }
  };

  try {
    const r = await applyUpdate(config, { force, onProgress });
    if (r.status === 'uptodate') {
      return ctx.telegram.editMessageText(chatId, m.message_id, undefined,
        `✅ <b>Sudah Versi Terbaru</b>\n\n<blockquote>📦 Versi : <code>${r.from}</code></blockquote>\n<i>Pakai /update force untuk install ulang paksa.</i>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    const changelogText = r.changelog?.length
      ? '\n\n📝 <b>Yang baru:</b>\n' + r.changelog.map(l => `• ${l}`).join('\n')
      : '';
    setPendingNotice(chatId, { by: ctx.from.id });
    await ctx.telegram.editMessageText(chatId, m.message_id, undefined,
      `✅ <b>Update Berhasil!</b>\n\n<blockquote>📦 Versi : <code>${r.from}</code> → <code>${r.to}</code>\n📄 File diperbarui : ${r.changed}${r.removed ? `\n🗑️ File lama dihapus : ${r.removed}` : ''}${r.npm ? '\n🔧 Dependency diinstall ulang' : ''}\n🔄 Bot restart otomatis...</blockquote>${changelogText}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    setTimeout(() => process.exit(1), 2000);
  } catch (e) {
    await ctx.telegram.editMessageText(chatId, m.message_id, undefined,
      `❌ <b>Update Gagal</b>\n\n<blockquote>File dikembalikan seperti semula.\n<code>${e.message.slice(0, 300)}</code></blockquote>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
});

bot.command('menu', async (ctx) => {
  try { await sendMenu(ctx); } catch (e) { await ctx.reply('❌ Menu gagal dimuat.', { parse_mode: 'HTML' }); }
});
bot.command('profile', async (ctx) => {
  try { await sendProfile(ctx); } catch (e) { await ctx.reply('❌ Profil gagal dimuat.', { parse_mode: 'HTML' }); }
});
bot.command('ping', async (ctx) => {
  try { await sendPing(ctx); } catch (e) { await ctx.reply('❌ Ping gagal dimuat.', { parse_mode: 'HTML' }); }
});
bot.command('help', async (ctx) => {
  try { await sendHelp(ctx); } catch (e) { await ctx.reply('❌ Bantuan gagal dimuat.', { parse_mode: 'HTML' }); }
});

bot.command('info', async (ctx) => {
  try {
    let targetId = null, targetUsername = null;

    const replyUser = ctx.message?.reply_to_message?.from;
    if (replyUser) {
      targetId = String(replyUser.id);
      targetUsername = replyUser.username ? `@${replyUser.username}` : replyUser.first_name;
    } else {
      const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
      const arg = args[0] || '';
      if (/^\d+$/.test(arg)) {
        targetId = arg;
      } else if (arg.length > 0) {
        const entities = ctx.message?.entities || [];
        const mentionEntity = entities.find(e => e.type === 'mention' || e.type === 'text_mention');
        if (mentionEntity) {
          if (mentionEntity.type === 'text_mention' && mentionEntity.user) {
            targetId = String(mentionEntity.user.id);
            targetUsername = mentionEntity.user.username
              ? `@${mentionEntity.user.username}`
              : mentionEntity.user.first_name;
          } else {
            const msgText = ctx.message.text || '';
            const mentionText = msgText.substring(mentionEntity.offset, mentionEntity.offset + mentionEntity.length);
            targetUsername = mentionText;
            const allRoles = db.getAllRoles ? db.getAllRoles() : {};
            const found = Object.values(allRoles).find(
              entry => entry.username && entry.username.toLowerCase() === mentionText.replace('@', '').toLowerCase()
            );
            if (found) {
              targetId = String(found.userId);
            } else {
              try {
                const member = await bot.telegram.getChatMember(ctx.chat.id, mentionText);
                const tgUser = member.user;
                targetId       = String(tgUser.id);
                targetUsername = tgUser.username ? `@${tgUser.username}` : mentionText;
              } catch (_) {
                return await sendInfoNotFound(ctx, mentionText);
              }
            }
          }
        } else {
          const cleanArg = arg.replace('@', '');
          const allRoles = db.getAllRoles ? db.getAllRoles() : {};
          const found = Object.values(allRoles).find(
            entry => entry.username && entry.username.toLowerCase() === cleanArg.toLowerCase()
          );
          if (found) {
            targetId = String(found.userId);
            targetUsername = `@${cleanArg}`;
          } else if (arg.startsWith('@')) {
            try {
              const member = await bot.telegram.getChatMember(ctx.chat.id, arg);
              const tgUser = member.user;
              targetId       = String(tgUser.id);
              targetUsername = tgUser.username ? `@${tgUser.username}` : arg;
            } catch (_) {
              return await sendInfoNotFound(ctx, arg);
            }
          }
        }
      }
    }

    if (!targetId) {
      await sendInfo(ctx, String(ctx.from.id), ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name);
      try {
        await ctx.reply(
          `${'❓'} <b>Tips:</b> Untuk cek info user lain:\n` +
          `• <code>/info @username</code>\n` +
          `• <code>/info 123456789</code>\n` +
          `• Reply ke pesan user → <code>/info</code>`,
          { parse_mode: 'HTML' }
        );
      } catch (_) {}
      return;
    }

    await sendInfo(ctx, targetId, targetUsername);
  } catch (e) { console.error('[INFO ERROR]', e); await ctx.reply('❌ Info gagal dimuat.'); }
});

bot.command('addrole', async (ctx) => {
  if (!canUseAddrole(ctx.from.id)) {
    return ctx.reply('❌ Kamu tidak memiliki izin untuk menggunakan command ini.', { parse_mode: 'HTML' });
  }
  const callerRank = getCallerAddroleRank(ctx.from.id);
  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const replyUser = ctx.message?.reply_to_message?.from;
  let targetId, targetDisplay;
  if (replyUser) {
    targetId = String(replyUser.id);
    targetDisplay = replyUser.username ? `@${replyUser.username}` : replyUser.first_name;
  } else if (args[0] && /^\d+$/.test(args[0])) {
    targetId = args[0];
    targetDisplay = `User ${targetId}`;
  } else {
    return ctx.reply(
      '❌ Format: <code>/addrole userId</code> atau reply ke user\nContoh: <code>/addrole 12345678</code>',
      { parse_mode: 'HTML' }
    );
  }
  if (targetId === String(ctx.from.id) && !isOwner(ctx.from.id)) {
    return ctx.reply('❌ Tidak bisa menambahkan role ke diri sendiri.', { parse_mode: 'HTML' });
  }
  const kbTierInit = tierSelectionKeyboard(callerRank);
  const sent = await ctx.reply(
    `🎭 <b>Tambah Role</b>\n\nTarget: <code>${htmlEscape(targetId)}</code> (${htmlEscape(targetDisplay)})\n\nPilih tier:`,
    { parse_mode: 'HTML', ...kbTierInit }
  );
  if (sent?.message_id && kbTierInit.reply_markup) {
    startButtonAnim(ctx.chat.id, sent.message_id, kbTierInit.reply_markup);
  }
  pendingRole.set(String(ctx.from.id), {
    targetId, targetDisplay,
    messageId: sent.message_id, chatId: String(ctx.chat.id),
    callerRank
  });
});

bot.command('delrole', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const targetId = resolveTargetUserId(ctx, args);
  if (!targetId) return ctx.reply('❌ Format: <code>/delrole userId</code> atau reply ke user', { parse_mode: 'HTML' });

  const oldEntry = db.getRoleEntry(targetId);
  const oldLabel = oldEntry ? (getRoleDisplayLabel(targetId) || '-') : '-';

  const existed = db.removeUserRole(targetId);
  await ctx.reply(
    existed ? `✅ Role user <code>${htmlEscape(targetId)}</code> berhasil dihapus.` : `❌ User <code>${htmlEscape(targetId)}</code> tidak memiliki role.`,
    { parse_mode: 'HTML' }
  );

  if (existed) {
    const actorName = USERS_SECURITY[String(ctx.from.id)];
    if (actorName) {
      addStoranEntry(ctx.from.id, actorName, 'delrole', {
        'Target ID': targetId,
        'Role Lama': oldLabel,
      });
    }
  }
});

bot.command('listroles', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  await sendListUsers(ctx);
});

bot.command('listserver', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  return sendServerSelectionMenu(ctx, 'ls');
});

bot.command('del', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const serverId = (ctx.message?.text || '').trim().split(/\s+/)[1];
  if (!serverId) return renderCard(ctx, 'Format: <code>/del ID_SERVER</code>\nContoh: <code>/del 123</code>', ownerMenuKeyboard());
  return showDeleteServerConfirm(ctx, serverId);
});

bot.command(['cadp', 'cadmin'], async (ctx) => {
  if (lockState.adp) return ctx.reply(eBox('🔒 PANEL ADP TERKUNCI', ['Command /cadp & /cadmin sedang dikunci oleh owner!', 'Hubungi owner untuk informasi lebih lanjut.']), { parse_mode: 'HTML' });
  try { await handleAdminPanelCommand(ctx); }
  catch (e) { console.error('[ADMIN PANEL ERROR]', e); await ctx.reply('❌ Gagal membuat admin panel.'); }
});

bot.command('pterotest', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  try {
    const results = await testPterodactylConnection();
    const lines = results.map(r =>
      r.ok ? `✅ Server V${r.index}: ${cleanDomain(r.domain)} (${r.total} user)` : `❌ Server V${r.index}: ${r.error}`
    );
    return ctx.reply(`🔧 <b>TEST KONEKSI PTERODACTYL</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  } catch (error) {
    return ctx.reply(`❌ Pterodactyl gagal diakses.\n\n${String(error?.message || error)}`, { parse_mode: 'HTML' });
  }
});

bot.command('cekserver', async (ctx) => {
  const channelId = String(config.channelServer || '').trim();
  if (!channelId) {
    if (isOwner(ctx.from.id)) {
      const loadingMsg = await ctx.reply('⏳ Mengecek semua server...', { parse_mode: 'HTML' });
      try {
        const result = await sendCekServer(ctx);
        try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
        return result;
      } catch (error) {
        try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
        return ctx.reply(`❌ Gagal: ${String(error?.message || error)}`, { parse_mode: 'HTML' });
      }
    }
    return ctx.reply('📡 Status server tersedia di channel khusus.', { parse_mode: 'HTML' });
  }
  const richHtml = buildRedirectRich(channelId, { richTitle, richTable, richEscape });
  return renderCard(ctx, richHtml, Markup.inlineKeyboard([]));
});

bot.command('pingall', async (ctx) => {
  const channelId = String(config.channelServer || '').trim();
  if (!channelId) {
    return ctx.reply('📡 Status server tersedia di channel khusus.', { parse_mode: 'HTML' });
  }
  const richHtml = buildRedirectRich(channelId, { richTitle, richTable, richEscape });
  return renderCard(ctx, richHtml, Markup.inlineKeyboard([]));
});

bot.command('delsrvoff', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const loadingMsg = await ctx.reply('⏳ Mencari server offline/suspended...', { parse_mode: 'HTML' });
  try {
    const panelServers = await getAllPanelServers();
    const offlineServers = panelServers.filter(s => {
      const status = s?.attributes?.status;
      return status === 'suspended' || status === 'install_failed';
    });
    if (!offlineServers.length) {
      try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
      return renderCard(ctx, '✅ Tidak ada server offline/suspended ditemukan.', Markup.inlineKeyboard([[{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: "danger"}, { text: eF('『 👑 』 Owner Menu'), callback_data: 'owner_menu', style: "primary"}]]));
    }
    let deleted = 0, failed = 0;
    for (const srv of offlineServers) {
      const srvId = srv?.attributes?.id;
      const serverObj = srv._server;
      if (!srvId || !serverObj) { failed++; continue; }
      try {
        await pteroRequestFor(serverObj, `/api/application/servers/${srvId}`, { method: 'DELETE' });
        deleted++;
      } catch (_) { failed++; }
    }
    serverStatusCache = { ts: 0, data: null };
  onlineServersCache = { ts: 0, count: null };
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    const caption = [
      '🗑️ <b>HAPUS SERVER OFFLINE</b>', '',
      `<blockquote>Total ditemukan: ${offlineServers.length}\n✅ Berhasil dihapus: ${deleted}\n❌ Gagal: ${failed}</blockquote>`
    ].join('\n');
    return renderCard(ctx, caption, Markup.inlineKeyboard([[{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: "danger"}, { text: eF('『 👑 』 Owner Menu'), callback_data: 'owner_menu', style: "primary"}]]));
  } catch (error) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    return ctx.reply(`❌ Gagal: ${htmlEscape(String(error?.message || error))}`, { parse_mode: 'HTML' });
  }
});

bot.command('delusroff', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const loadingMsg = await ctx.reply('⏳ Mencari user tanpa server...', { parse_mode: 'HTML' });
  try {
    const servers = getActiveServers();
    if (!servers.length) {
      try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
      return ctx.reply('❌ Tidak ada server aktif.', { parse_mode: 'HTML' });
    }
    let totalFound = 0, deleted = 0, failed = 0;
    for (const server of servers) {
      const users = await getAllPterodactylUsersOn(server);
      const noServerUsers = users.filter(u => {
        const attrs = u?.attributes || {};
        if (attrs.root_admin) return false;
        const srvList = u?.relationships?.servers?.data;
        return Array.isArray(srvList) ? srvList.length === 0 : false;
      });
      totalFound += noServerUsers.length;
      for (const user of noServerUsers) {
        const userId = user?.attributes?.id;
        if (!userId) { failed++; continue; }
        try {
          await pteroRequestFor(server, `/api/application/users/${userId}`, { method: 'DELETE' });
          deleted++;
        } catch (_) { failed++; }
      }
    }
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    const caption = [
      '👤 <b>HAPUS USER TANPA SERVER</b>', '',
      `<blockquote>Total ditemukan: ${totalFound}\n✅ Berhasil dihapus: ${deleted}\n❌ Gagal: ${failed}</blockquote>`
    ].join('\n');
    return renderCard(ctx, caption, Markup.inlineKeyboard([[{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: "danger"}, { text: eF('『 👑 』 Owner Menu'), callback_data: 'owner_menu', style: "primary"}]]));
  } catch (error) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    return ctx.reply(`❌ Gagal: ${htmlEscape(String(error?.message || error))}`, { parse_mode: 'HTML' });
  }
});

bot.command('delsrvall', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const servers = getActiveServers();
  if (!servers.length) return ctx.reply('❌ Tidak ada server aktif.', { parse_mode: 'HTML' });
  return renderCard(ctx,
    [
      '⚠️ <b>KONFIRMASI HAPUS SEMUA SERVER</b>', '',
      '<blockquote>Tindakan ini akan menghapus <b>SEMUA</b> panel server dari semua server aktif yang dikonfigurasi.',
      '',
      '⛔ Tidak bisa dibatalkan setelah dieksekusi!',
      '',
      'Yakin ingin melanjutkan?</blockquote>'
    ].join('\n'),
    delAllServersConfirmKeyboard()
  );
});

for (const vn of [1, 2, 3, 4, 5]) {
  bot.command(`delv${vn}`, async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
    const serverId = (ctx.message?.text || '').trim().split(/\s+/)[1];
    if (!serverId) return renderCard(ctx, `Format: <code>/delv${vn} ID_SERVER</code>\nContoh: <code>/delv${vn} 123</code>`, ownerMenuKeyboard());
    return showDeleteServerConfirmForSlot(ctx, serverId, vn);
  });
}

const AUTODEL_FILE = path.join(DB_DIR, 'auto_delete_config.json');

function readAutodelDb() {
  return fbRead(AUTODEL_FILE, { v1: false, v2: false, v3: false, v4: false, v5: false });
}
function saveAutodelDb(data) {
  fbWrite(AUTODEL_FILE, data);
}

async function sendAutodelMenu(ctx, options = {}) {
  const servers  = getActiveServers();
  const state    = readAutodelDb();
  const rows     = [];

  for (let i = 1; i <= 5; i++) {
    const active = servers.find(s => s.index === i);
    const isOn   = state[`v${i}`] === true;
    const label  = active
      ? `${isOn ? '✅' : '❌'} SERVER ${i} · Auto Del ${isOn ? 'ON' : 'OFF'}`
      : `⬛ SERVER ${i} · Tidak Aktif`;
    rows.push([{
      text:          eF(label),
      callback_data: active ? `autodel_toggle_v${i}` : `autodel_noop_v${i}`,
      style:         isOn ? 'success' : (active ? 'danger' : 'secondary'),
    }]);
  }

  rows.push([{
    text: eF('『 ✅ 』 Selesai'), callback_data: 'autodel_done', style: 'primary',
  }]);

  const enabled = Object.keys(state).filter(k => state[k] === true);
  const caption = [
    '⏰ <b>AUTO DELETE SERVER</b>', '',
    '<blockquote>Setiap server yang di-<b>ON</b>kan akan otomatis dihapus seluruh panel-nya setiap <b>6 jam</b> sekali.',
    '',
    '🟢 Tap tombol server untuk toggle ON/OFF.</blockquote>',
    '',
    enabled.length
      ? `🔴 Aktif: <b>${enabled.map(k => 'Server ' + k.replace('v', '')).join(', ')}</b>`
      : '⚫ Belum ada server yang di-aktifkan.',
  ].join('\n');

  return renderCard(ctx, caption, Markup.inlineKeyboard(rows), { thumb: true, ...options });
}

bot.command('autodel', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  return sendAutodelMenu(ctx);
});

for (let i = 1; i <= 5; i++) {
  bot.action(`autodel_toggle_v${i}`, async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.answerCbQuery('❌ Akses ditolak.', { show_alert: true });
    try {
      await ctx.answerCbQuery('');
      const state  = readAutodelDb();
      state[`v${i}`] = !state[`v${i}`];
      saveAutodelDb(state);
      return sendAutodelMenu(ctx, { edit: true });
    } catch (e) {
      console.error(`[AUTODEL TOGGLE V${i}]`, e?.message || e);
    }
  });

  bot.action(`autodel_noop_v${i}`, async (ctx) => {
    await ctx.answerCbQuery(`⬛ Server ${i} tidak aktif / belum dikonfigurasi.`, { show_alert: true });
  });
}

bot.action('autodel_done', async (ctx) => {
  try {
    await ctx.answerCbQuery('✅ Pengaturan disimpan.');
    await ctx.deleteMessage();
  } catch (_) {
    try {
      await bot.telegram.editMessageReplyMarkup(
        ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, { inline_keyboard: [] }
      );
    } catch (_) {}
  }
});

async function runAutodelJob() {
  const state   = readAutodelDb();
  const servers = getActiveServers();
  const enabled = servers.filter(s => state[`v${s.index}`] === true);
  if (!enabled.length) return;

  const jkt = () => new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  for (const server of enabled) {
    const vn = server.index;
    console.log(`[AUTODEL] Menjalankan auto-delete Server V${vn}...`);
    try {
      let page = 1, panelServers = [];
      while (page <= 100) {
        const resp = await pteroRequestFor(server, `/api/application/servers?per_page=100&page=${page}`);
        const rows = Array.isArray(resp?.data) ? resp.data : [];
        panelServers.push(...rows);
        const pag = resp?.meta?.pagination;
        if (!rows.length || !pag || page >= Number(pag.total_pages || page)) break;
        page++;
      }

      for (const srv of panelServers) {
        const attr       = srv?.attributes || {};
        const srvId      = attr.id;
        const userId     = attr.user;
        const srvName    = attr.name      || '-';
        const srvIdent   = attr.identifier || '-';
        const appStatus  = attr.status    || '';   // Pterodactyl application-level status
        if (!srvId) continue;

        // ── CEK STATE SEBELUM HAPUS ───────────────────────────────────────────
        // Jika pltc dikonfigurasi, cek power state via client API.
        // Jika power state bukan 'offline', skip — server masih berjalan.
        // Jika pltc tidak ada, fallback: hanya hapus jika status aplikasi
        // menunjukkan masalah (suspended / install_failed).
        // Server yang sedang running, starting, atau stopping TIDAK akan dihapus.
        const pltcKey = String(server.pltc || '').trim();
        if (pltcKey && !/CLIENT_API_KEY/.test(pltcKey)) {
          const powerState = await getServerRunningState(server, srvIdent);
          if (powerState !== 'offline') {
            console.log(`[AUTODEL] ⏭️  ${srvName} (${srvIdent}) V${vn} state=${powerState} — skip, bukan offline.`);
            continue;
          }
        } else {
          // Tanpa pltc: hanya hapus jika status aplikasi menandai masalah
          const isProblematic = appStatus === 'suspended' || appStatus === 'install_failed';
          if (!isProblematic) {
            console.log(`[AUTODEL] ⏭️  ${srvName} (${srvIdent}) V${vn} status="${appStatus}" — skip, tidak terindikasi offline (pltc belum dikonfigurasi).`);
            continue;
          }
        }
        // ─────────────────────────────────────────────────────────────────────

        let serverDeleted = false;
        let userDeleted   = false;
        let skipReason    = '';

        try {
          await pteroRequestFor(server, `/api/application/servers/${srvId}`, { method: 'DELETE' });
          serverDeleted = true;
        } catch (e) {
          skipReason = e.message;
          console.error(`[AUTODEL] Gagal hapus server ${srvId}: ${e.message}`);
        }

        if (serverDeleted && userId) {
          try {
            const userInfo = await pteroRequestFor(server, `/api/application/users/${userId}?include=servers`);
            const remaining = userInfo?.relationships?.servers?.data || [];
            if (remaining.length === 0) {
              await pteroRequestFor(server, `/api/application/users/${userId}`, { method: 'DELETE' });
              userDeleted = true;
            } else {
              skipReason = `user masih punya ${remaining.length} server lain`;
            }
          } catch (e) {
            console.error(`[AUTODEL] Gagal hapus user ${userId}: ${e.message}`);
          }
        }

        const logLines = [
          `🗑️ <b>AUTO DELETE — SCHEDULED (V${vn})</b>`, '',
          '<blockquote>',
          `📝 Nama   : ${htmlEscape(srvName)}`,
          `🆔 ID     : <code>${htmlEscape(srvIdent)}</code>`,
          `🖥️ Panel  : V${vn}`,
          `⏰ Jadwal : Setiap 6 jam`,
          `🗑️ Server : ${serverDeleted ? '✅ Dihapus' : '❌ Gagal'}`,
          `👤 User   : ${userDeleted ? '✅ Dihapus' : `➡️ Dilewati${skipReason ? ` (${skipReason.slice(0, 60)})` : ''}`}`,
          `🗓️ Waktu  : ${jkt()}`,
          '</blockquote>',
        ];

        try {
          await bot.telegram.sendMessage(AUTO_DELETE_LOG_GROUP, logLines.join('\n'), { parse_mode: 'HTML' });
        } catch (logErr) {
          console.error('[AUTODEL] Gagal kirim log ke grup:', logErr.message);
        }

      }

      serverStatusCache  = { ts: 0, data: null };
      onlineServersCache = { ts: 0, count: null };
      console.log(`[AUTODEL] V${vn}: selesai.`);
    } catch (e) {
      console.error(`[AUTODEL] Error V${vn}:`, e?.message || e);
    }
  }
}

setInterval(runAutodelJob, 6 * 60 * 60 * 1000);

bot.command('delserver', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const activeServers = getActiveServers();
  if (!activeServers.length) return ctx.reply('❌ Tidak ada server aktif.', { parse_mode: 'HTML' });
  return renderCard(ctx,
    [
      '🗑️ <b>HAPUS SERVER</b>', '',
      '<blockquote>Pilih slot server yang ingin dihapus semua servernya.\nAtau pilih <b>Hapus Semua Slot</b> untuk menghapus dari seluruh slot sekaligus.\n\n⛔ Tindakan ini tidak bisa dibatalkan!</blockquote>',
    ].join('\n'),
    delServerSlotKeyboard()
  );
});

bot.command('deluser', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const activeServers = getActiveServers();
  if (!activeServers.length) return ctx.reply('❌ Tidak ada server aktif.', { parse_mode: 'HTML' });
  return renderCard(ctx,
    [
      '👤 <b>HAPUS USER</b>', '',
      '<blockquote>Pilih slot server untuk menghapus semua user tanpa panel di dalamnya.\nAtau pilih <b>Hapus Semua Slot</b> untuk menghapus dari seluruh slot sekaligus.\n\n⛔ Tindakan ini tidak bisa dibatalkan!</blockquote>',
    ].join('\n'),
    delUserSlotKeyboard()
  );
});

bot.command('backup', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const sentMsg = await ctx.reply('<blockquote>⏳ <b>Membuat backup...</b>\n\nMohon tunggu sebentar.</blockquote>', { parse_mode: 'HTML' });
  try {
    await doBackup(FIXED_BACKUP_CHAT_ID);
    const isSelf = String(ctx.from.id) === String(FIXED_BACKUP_CHAT_ID);
    const info = isSelf ? '' : `\nDikirim ke: <code>${FIXED_BACKUP_CHAT_ID}</code>`;
    await ctx.telegram.editMessageText(ctx.chat.id, sentMsg.message_id, undefined,
      `<blockquote>✅ <b>Backup berhasil!</b>${info}</blockquote>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, sentMsg.message_id, undefined,
      `<blockquote>❌ <b>Backup gagal.</b>\n${htmlEscape(String(e.message || e).slice(0, 300))}</blockquote>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
});

bot.command('broadcast', async (ctx) => {
  const senderId = String(ctx.from.id);
  const senderName = BROADCAST_USERS[senderId];
  if (!senderName) return ctx.reply('❌ Kamu tidak punya akses /broadcast.', { parse_mode: 'HTML' });

  const text = (ctx.message?.text || '').replace(/^\/broadcast\S*\s*/i, '').trim();
  if (!text) {
    return ctx.reply(
      '❌ Format: <code>/broadcast pesan kamu di sini</code>\n\n<i>Mendukung HTML formatting (bold, italic, code, dll)</i>',
      { parse_mode: 'HTML' }
    );
  }
  const roles = db.getAllRoles();
  const userIds = Object.keys(roles);
  if (!userIds.length) return ctx.reply('❌ Belum ada user terdaftar di database.', { parse_mode: 'HTML' });

  const sentMsg = await ctx.reply(
    `<blockquote>⏳ <b>Broadcast dimulai...</b>\nPengirim: <b>${senderName}</b>\nTarget: <b>${userIds.length} user</b></blockquote>`,
    { parse_mode: 'HTML' }
  );
  let success = 0, failed = 0;
  for (const userId of userIds) {
    try {
      await bot.telegram.sendMessage(userId,
        `📢 <b>BROADCAST</b>\n\n${text}\n\n<i>— ${senderName}</i>`,
        { parse_mode: 'HTML' }
      );
      success++;
    } catch (_) { failed++; }
    await new Promise(r => setTimeout(r, 60));
  }
  await ctx.telegram.editMessageText(ctx.chat.id, sentMsg.message_id, undefined,
    [
      '<blockquote>📢 <b>BROADCAST SELESAI</b>', '',
      `👤 Pengirim : <b>${senderName}</b>`,
      `✅ Terkirim : ${success} user`,
      `❌ Gagal    : ${failed} user`,
      `📊 Total    : ${userIds.length} user`,
      '',
      '<i>Gagal biasanya karena user belum start bot (DM).</i></blockquote>'
    ].join('\n'),
    { parse_mode: 'HTML' }
  ).catch(() => {});

  addStoranEntry(senderId, senderName, 'broadcast', {
    'Terkirim': `${success}/${userIds.length} user`,
    'Preview':  text.substring(0, 60) + (text.length > 60 ? '…' : ''),
  });
});

bot.command('blacklist', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });

  let targetId = null;
  const replyUser = ctx.message?.reply_to_message?.from;
  if (replyUser) {
    targetId = String(replyUser.id);
  } else {
    const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
    if (args[0] && /^\d+$/.test(args[0])) targetId = args[0];
  }

  if (!targetId) {
    return ctx.reply(
      '❌ Format: <code>/blacklist userId</code>\natau reply ke pesan user yang ingin di-blacklist.',
      { parse_mode: 'HTML' }
    );
  }
  if (isOwner(targetId)) {
    return ctx.reply('❌ Tidak bisa blacklist owner.', { parse_mode: 'HTML' });
  }

  const list = readBlacklist();
  const idx = list.indexOf(String(targetId));
  if (idx !== -1) {
    list.splice(idx, 1);
    saveBlacklist(list);
    const entry = db.getRoleEntry(targetId);
    const uname = entry?.username ? `@${entry.username}` : `User ${targetId}`;
    return ctx.reply(
      `<blockquote>✅ <b>Blacklist dihapus</b>\n👤 ${htmlEscape(uname)}\n🆔 <code>${targetId}</code>\n\n<i>User sekarang bisa menggunakan bot kembali.</i></blockquote>`,
      { parse_mode: 'HTML' }
    );
  } else {
    list.push(String(targetId));
    saveBlacklist(list);
    const entry = db.getRoleEntry(targetId);
    const uname = entry?.username ? `@${entry.username}` : `User ${targetId}`;
    await ctx.reply(
      `<blockquote>🚫 <b>User diblacklist</b>\n👤 ${htmlEscape(uname)}\n🆔 <code>${targetId}</code>\n\n<i>User tidak bisa menggunakan bot. Ulangi command untuk unblacklist.</i></blockquote>`,
      { parse_mode: 'HTML' }
    );
    const actorName = USERS_SECURITY[String(ctx.from.id)];
    if (actorName) {
      addStoranEntry(ctx.from.id, actorName, 'blacklist', {
        'Target': `${htmlEscape(uname)} (${targetId})`,
      });
    }
  }
});

bot.command('listblacklist', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const list = readBlacklist();
  if (!list.length) return ctx.reply('<blockquote>✅ Blacklist kosong, tidak ada user yang diblokir.</blockquote>', { parse_mode: 'HTML' });

  const lines = list.map((uid, i) => {
    const entry = db.getRoleEntry(uid);
    const uname = entry?.username ? `@${entry.username}` : '-';
    return `${i + 1}. <code>${uid}</code> — ${htmlEscape(uname)}`;
  });
  return ctx.reply(
    `<blockquote>🚫 <b>BLACKLIST (${list.length} user)</b>\n\n${lines.join('\n')}</blockquote>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('maintenance', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const arg  = (args[0] || '').toLowerCase();
  if (!['on', 'off'].includes(arg)) {
    const current = getMaintenanceStatus();
    return ctx.reply(
      `🔧 <b>Maintenance Mode</b>\n\nStatus sekarang: <b>${current ? '🔴 ON' : '🟢 OFF'}</b>\n\nGunakan:\n• <code>/maintenance on</code> — aktifkan maintenance\n• <code>/maintenance off</code> — matikan maintenance`,
      { parse_mode: 'HTML' }
    );
  }
  const newStatus = arg === 'on';
  setMaintenanceStatus(newStatus);
  await ctx.reply(
    newStatus
      ? '🔧 <b>Maintenance Mode: ON</b>\n\n<i>Semua user (kecuali owner) tidak bisa mengakses bot sampai kamu ketik /maintenance off.</i>'
      : '✅ <b>Maintenance Mode: OFF</b>\n\n<i>Bot kembali normal, semua user bisa mengakses.</i>',
    { parse_mode: 'HTML' }
  );
});

bot.command('blockcmd', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  if (!args.length) {
    const cmds = getBlockedCmds();
    const listText = cmds.length
      ? cmds.map(c => `• <code>/${c}</code>`).join('\n')
      : '<i>Tidak ada command yang diblokir.</i>';
    return ctx.reply(
      `🚫 <b>Daftar Command Terblokir</b>\n\n${listText}\n\n<i>Gunakan <code>/blockcmd /namacommand</code> untuk memblokir atau membuka blokirnya (toggle).</i>`,
      { parse_mode: 'HTML' }
    );
  }
  const target = args[0].toLowerCase().replace(/^\//, '');
  if (!target) return ctx.reply('❌ Masukkan nama command. Contoh: <code>/blockcmd /cadp</code>', { parse_mode: 'HTML' });
  const cmds = getBlockedCmds();
  const idx  = cmds.findIndex(c => c.toLowerCase() === target);
  if (idx !== -1) {
    cmds.splice(idx, 1);
    saveBlockedCmds(cmds);
    return ctx.reply(
      `✅ Command <code>/${target}</code> berhasil <b>dibuka blokirnya</b>.\n\nCommand tersebut kini bisa digunakan kembali.`,
      { parse_mode: 'HTML' }
    );
  } else {
    cmds.push(target);
    saveBlockedCmds(cmds);
    return ctx.reply(
      `🚫 Command <code>/${target}</code> berhasil <b>diblokir</b>.\n\nTidak ada seorang pun yang bisa mengakses command ini (kecuali owner).\n\nKetik <code>/blockcmd /${target}</code> lagi untuk membuka blokirnya.`,
      { parse_mode: 'HTML' }
    );
  }
});

bot.command('stats', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });

  const stats = readStats();
  const roles = db.getAllRoles();
  const users = Object.values(roles);

  const today = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
  const todayPanels = stats.dailyStats?.[today] || 0;

  const tierCount = {};
  users.forEach(u => {
    const def = ROLE_DEFINITIONS[u.role];
    if (def) tierCount[def.tier] = (tierCount[def.tier] || 0) + 1;
  });

  const serverLines = Object.entries(stats.serverStats || {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([sv, count]) => `V${sv}: ${count} panel`);

  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
    last7.push(`${label}: ${stats.dailyStats?.[label] || 0}`);
  }

  const blCount = readBlacklist().length;
  const tierRows = Object.entries(tierCount).map(([t, c]) => [TIER_LABELS[t] || t, String(c)]);
  const panelRows = [
    ['Total', String(stats.totalPanels || 0)],
    ['Hari ini', String(todayPanels)],
    ...Object.entries(stats.serverStats || {})
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([sv, count]) => [`Server V${sv}`, String(count)]),
  ];
  const last7Rows = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
    last7Rows.push([label, String(stats.dailyStats?.[label] || 0)]);
  }

  const lockedUsers  = db.getLockedUsers ? Object.keys(db.getLockedUsers()) : [];
  const activity     = db.getAllActivity ? db.getAllActivity() : {};
  const todayStr     = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
  const activeToday  = Object.values(activity).filter(u => {
    if (!u.lastAt) return false;
    return new Date(u.lastAt).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' }) === todayStr;
  }).length;

  let peakChart = '';
  try {
    const ph   = fbRead(path.join(DB_DIR, 'peak_hours.json'), {});
    const vals = Array.from({ length: 24 }, (_, h) => ph[String(h)] || 0);
    const mx   = Math.max(1, ...vals);
    peakChart  = vals.map((v, h) => {
      const bar = '█'.repeat(Math.round((v / mx) * 8)).padEnd(8, '░');
      return `${String(h).padStart(2, '0')}h ${bar} ${v}`;
    }).join('\n');
  } catch (_) {}

  const tierDetailRows = Object.entries(ROLE_DEFINITIONS).map(([role, def]) => {
    const cnt = users.filter(u => u.role === role).length;
    return cnt > 0 ? [def.label || role, (TIER_LABELS[def.tier] || def.tier), String(cnt)] : null;
  }).filter(Boolean);

  const richHtml = [
    richTitle('📊', '統計 — Statistik Bot'),
    richTable(
      ['📊 Metrik', 'Nilai'],
      [
        ['Total User',    `<b>${users.length}</b>`],
        ['Aktif Hari Ini',`<b>${activeToday}</b>`],
        ['User Terkunci', `<b>${lockedUsers.length}</b>`],
        ['Blacklist',     `<b>${blCount}</b>`],
        ['Total Panel',   `<b>${stats.totalPanels || 0}</b>`],
        ['Hari Ini',      `<b>${todayPanels}</b>`],
      ]
    ),
    richFold(
      '👥 <b>Distribusi Role per Tier</b>',
      tierDetailRows.length
        ? richTable(['Role', 'Tier', 'User'], tierDetailRows)
        : richPara('Belum ada user terdaftar')
    ),
    richFold(
      '📦 <b>Panel per Server</b>',
      panelRows.length
        ? richTable(['Server', 'Panel'], panelRows)
        : richPara('Belum ada data')
    ),
    richFold(
      '📅 <b>7 Hari Terakhir</b>',
      richTable(['Tanggal', 'Panel'], last7Rows)
    ),
    ...(peakChart ? [richFold(
      '🕐 <b>Peak Hours (semua waktu)</b>',
      `<pre><code>${peakChart}</code></pre>`
    )] : []),
  ].join('\n');

  return renderCard(ctx, richHtml, Markup.inlineKeyboard([]));
});

bot.command('setapikey', async (ctx) => { await handleSetApiKey(ctx); });

for (const planKey of Object.keys(PANEL_PLANS)) {
  if (planKey === 'unli') continue;

  bot.command(planKey, async (ctx) => {
    try { await handlePanelCommand(ctx, planKey); }
    catch (e) { console.error(`[${planKey.toUpperCase()} ERROR]`, e); await ctx.reply(`❌ Gagal membuat panel ${planKey.toUpperCase()}.`); }
  });
}

bot.command('unli', async (ctx) => {
  try { await handleUnliCommand(ctx); }
  catch (e) { console.error('[UNLI ERROR]', e); await ctx.reply('❌ Gagal memproses command /unli.'); }
});

bot.command('listuser', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  return sendServerSelectionMenu(ctx, 'lu');
});

bot.command('unliv2', async (ctx) => {
  try { await handleUnliCommandForServer(ctx, 2); }
  catch (e) { console.error('[UNLIV2 ERROR]', e); await ctx.reply('❌ Gagal memproses command /unliv2.'); }
});

bot.command('unliv3', async (ctx) => {
  try { await handleUnliCommandForServer(ctx, 3); }
  catch (e) { console.error('[UNLIV3 ERROR]', e); await ctx.reply('❌ Gagal memproses command /unliv3.'); }
});

bot.command('unliv4', async (ctx) => {
  try { await handleUnliCommandForServer(ctx, 4); }
  catch (e) { console.error('[UNLIV4 ERROR]', e); await ctx.reply('❌ Gagal memproses command /unliv4.'); }
});

bot.command('unliv5', async (ctx) => {
  try { await handleUnliCommandForServer(ctx, 5); }
  catch (e) { console.error('[UNLIV5 ERROR]', e); await ctx.reply('❌ Gagal memproses command /unliv5.'); }
});

bot.command(['cadpv2', 'cadminv2'], async (ctx) => {
  try { await handleAdminPanelCommandForServer(ctx, 2); }
  catch (e) { console.error('[CADPV2 ERROR]', e); await ctx.reply('❌ Gagal membuat admin panel di V2.'); }
});

bot.command(['cadpv3', 'cadminv3'], async (ctx) => {
  try { await handleAdminPanelCommandForServer(ctx, 3); }
  catch (e) { console.error('[CADPV3 ERROR]', e); await ctx.reply('❌ Gagal membuat admin panel di V3.'); }
});

bot.command(['cadpv4', 'cadminv4'], async (ctx) => {
  try { await handleAdminPanelCommandForServer(ctx, 4); }
  catch (e) { console.error('[CADPV4 ERROR]', e); await ctx.reply('❌ Gagal membuat admin panel di V4.'); }
});

bot.command(['cadpv5', 'cadminv5'], async (ctx) => {
  try { await handleAdminPanelCommandForServer(ctx, 5); }
  catch (e) { console.error('[CADPV5 ERROR]', e); await ctx.reply('❌ Gagal membuat admin panel di V5.'); }
});

bot.action(/^panel_choose_(nodejs|python)_(\d+)_([1-9]\d*gb|unli)(?:_v(\d+))?$/, async (ctx) => {
  await safeAnswer(ctx);

  const [_, eggType, userIdMatch, planKey, serverIndexMatch] = ctx.match;
  const userId = Number(userIdMatch);
  const serverIndex = serverIndexMatch ? Number(serverIndexMatch) : null;

  if (userId !== ctx.from.id) {
    return ctx.answerCbQuery('❌ Button ini bukan untuk kamu', true);
  }

  const sessionKey = serverIndex
    ? `panel_${userId}_${planKey}_v${serverIndex}`
    : `panel_${userId}_${planKey}`;

  const session = panelSessions.get(sessionKey);
  if (!session) {
    return ctx.answerCbQuery('⏱ Session expired, silahkan ulangi command', true);
  }

  const { username, plan, userId: sessionUserId } = session;
  const eggConfig = getEggConfig(eggType);

  if (!eggConfig) {
    return ctx.answerCbQuery('❌ Engine tidak valid', true);
  }

  if (!isOwner(userId)) {
    const cooldown = checkRateLimit(userId);
    if (cooldown > 0) {
      return ctx.answerCbQuery(`⏳ Tunggu ${cooldown}s lagi`, true);
    }
  }

  const planSummary = [
    `📦 Paket  : <b>${htmlEscape(plan.name)}</b>`,
    `🔧 Engine : <b>${eggConfig.name}</b>`,
    `🧠 RAM    : <b>${plan.memory === 0 ? '∞ Unlimited' : `${plan.memory} MB`}</b>`,
    `💾 Disk   : <b>${plan.disk   === 0 ? '∞ Unlimited' : `${plan.disk} MB`}</b>`,
    `⚙️ CPU    : <b>${plan.cpu    === 0 ? '∞ Unlimited' : `${plan.cpu}%`}</b>`,
  ].join('\n');

  const steps = ['1/4 Menyiapkan alokasi...', '2/4 Membuat akun user...', '3/4 Konfigurasi server...', '4/4 Finalisasi panel...'];
  let stepIdx = 0;
  const updateStep = async (label) => {
    try {
      await bot.telegram.editMessageText(ctx.chat.id, ctx.msgId, undefined,
        `⏳ <b>Membuat Panel</b>\n\n${planSummary}\n\n<code>${label}</code>`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {}
  };

  try {
    await ctx.editMessageText(
      `⏳ <b>Membuat Panel ${htmlEscape(plan.name)}</b>\n\n${planSummary}\n\n<code>${steps[stepIdx++]}</code>`,
      { parse_mode: 'HTML' }
    );
  } catch (_) {}

  let retriedServers = [];
  try {
    // Pass eggConfig agar engine yang dipilih user (Python/Node.js) diteruskan ke API Pterodactyl
    const result = await createPanelForUser(username, plan, userId, userId, async (serverIndexProgress, totalServers) => {
      retriedServers.push(serverIndexProgress);
      const retryNote = retriedServers.length > 1
        ? ` (Retry → V${serverIndexProgress} dari ${totalServers} server)`
        : ` (Server V${serverIndexProgress})`;
      await updateStep(`${steps[Math.min(stepIdx++, steps.length - 1)]}${retryNote}`);
    }, eggConfig);

    const serverAttr = result.server?.attributes || {};
    const loginUrl   = cleanDomain(result.serverDomain);
    const invNo      = `INV-${Date.now().toString().slice(-8)}`;
    const invDate    = new Date().toLocaleDateString('id-ID', {
      timeZone: config.timezone || 'Asia/Jakarta',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const caption = eMulti([
      {
        title: '✅ PANEL BERHASIL DIBUAT',
        lines: [
          `No. Invoice ┈ <code>${invNo}</code>`,
          `Tanggal     ┈ ${invDate}`,
          '',
          `Login    ┈ ${htmlEscape(loginUrl)}`,
          `Username ┈ <b>${htmlEscape(result.finalUsername)}</b>`,
          `Password ┈ <code>${htmlEscape(result.user?.password || '-')}</code>`,
          `Paket    ┈ <b>${htmlEscape(plan.name)}</b>`,
          `Engine   ┈ <b>${eggConfig.name}</b>`,
          `RAM      ┈ <b>${plan.memory === 0 ? '∞ Unlimited' : `${plan.memory} MB`}</b>`,
          `Disk     ┈ <b>${plan.disk   === 0 ? '∞ Unlimited' : `${plan.disk} MB`}</b>`,
          `CPU      ┈ <b>${plan.cpu    === 0 ? '∞ Unlimited' : `${plan.cpu}%`}</b>`,
          `Server   ┈ <b>V${result.serverIndex}</b>`,
          `SID      ┈ <code>${htmlEscape(serverAttr.identifier || serverAttr.uuid || '-')}</code>`,
          result.adjusted ? `Note  ┈ ${htmlEscape(result.requested)} ➜ ${htmlEscape(result.finalUsername)}` : `Note  ┈ Username langsung dipakai`,
          `Owner    ┈ ${htmlEscape(config.ownerName || 'HanzPiw Official')}`,
        ]
      },
      {
        title: '📌 KETENTUAN',
        lines: [
          'Garansi 15 hari  •  1x replace  •  No DDoS',
          'Jangan share  •  Dilarang tindakan ilegal',
          '✅ Powered by CPanel HanzPiw X Jayss • @itshanzpiw',
        ]
      },
    ]);

    recordPanelStat(userId, result.serverIndex);
    await notifyOwnerNewPanel(ctx, { plan, username: result.finalUsername, userId, password: result.user?.password, serverIndex: result.serverIndex, pteroServerId: result.server?.attributes?.id, pteroUserId: result.user?.attributes?.id });

    const keyboard = resultActionKeyboard(loginUrl, result.finalUsername, result.user?.password);

    try {
      await ctx.deleteMessage();
    } catch (_) {}

    if (['group', 'supergroup'].includes(ctx.chat?.type)) {
      try {
        await sendDirectCard(userId, caption, keyboard);
        const notifCaption = [
          `${'✅'} <b>Panel ${htmlEscape(plan.name)} (${htmlEscape(eggConfig.name)}) berhasil Dibuat!</b>`, '',
          `<b>📌 Nama Panel:</b> <code>${htmlEscape(result.finalUsername)}</code>`,
          `<b>👤 Pembuat:</b> ${htmlEscape(ctx.from?.username ? `@${ctx.from.username}` : [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User')}`,
          `<b>🆔 Id Server:</b> <code>V${result.serverIndex}</code> (Ptero: <code>${htmlEscape(String(result.server?.attributes?.id || '-'))}</code>)`,
          '',
          `<blockquote><b>📦 Paket:</b> ${htmlEscape(plan.name)}`,
          `<b>🥚 Egg:</b> ${htmlEscape(eggConfig.name)} (${eggConfig.egg})`,
          `<b>🧠 RAM:</b> ${htmlEscape(plan.memory === 0 ? '∞ Unlimited' : `${plan.memory} MB`)}`,
          `<b>💾 Disk:</b> ${htmlEscape(plan.disk === 0 ? '∞ Unlimited' : `${plan.disk} MB`)}`,
          `<b>⚙️ CPU:</b> ${htmlEscape(plan.cpu === 0 ? '∞ Unlimited' : `${plan.cpu}%`)}`,
          '</blockquote>',
          '',
          `<blockquote><b>✅ Data akun ( Email & Password ) telah dikirim ke Private Chat Anda</b>`,
          '</blockquote>'
        ].join('\n');
        await ctx.reply(notifCaption, { parse_mode: 'HTML' });
      } catch (_) {
        await renderCard(ctx, caption, keyboard);
      }
    } else {
      await renderCard(ctx, caption, keyboard);
    }

    panelSessions.delete(sessionKey);

  } catch (error) {
    panelSessions.delete(sessionKey);
    const errMsg  = String(error?.message || error);
    let errHint   = '';
    if (/alokasi|allocation|port/i.test(errMsg))
      errHint = '\n💡 <i>Hint: Server penuh alokasi. Coba pilih server lain dengan /Xgbv2, /Xgbv3, dst.</i>';
    else if (/domain|ENOTFOUND|fetch|network/i.test(errMsg))
      errHint = '\n💡 <i>Hint: Koneksi ke panel gagal. Cek apakah domain server masih valid dengan /cekserver.</i>';
    else if (/username|taken|exist/i.test(errMsg))
      errHint = '\n💡 <i>Hint: Username sudah ada di panel. Coba username yang berbeda.</i>';
    else if (/unauthorized|403|401/i.test(errMsg))
      errHint = '\n💡 <i>Hint: API key panel mungkin kadaluarsa. Hubungi owner untuk update key.</i>';
    else if (/timeout/i.test(errMsg))
      errHint = '\n💡 <i>Hint: Timeout — panel mungkin tetap dibuat. Cek di dashboard panel kamu.</i>';
    else
      errHint = '\n💡 <i>Hint: Hubungi owner jika error berulang. Sertakan pesan error di atas.</i>';
    if (bot._debugErr) bot._debugErr(`panel_choose error: ${errMsg}`);
    try {
      await ctx.editMessageText(
        `${'❌'} <b>Gagal membuat panel</b>\n\n<code>${htmlEscape(errMsg)}</code>${errHint}`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {
      await ctx.reply(
        `${'❌'} <b>Gagal membuat panel</b>\n<code>${htmlEscape(errMsg)}</code>${errHint}`,
        { parse_mode: 'HTML' }
      );
    }
  }
});

bot.action('menu', async (ctx) => {
  await safeAnswer(ctx);
  try { await ctx.deleteMessage(); } catch (_) {}
  await sendMenu(ctx, {});
});

bot.action('panel_menu', async (ctx) => {
  await safeAnswer(ctx);
  try { await ctx.deleteMessage(); } catch (_) {}
  const richHtml = [
    richTitle('🎁', 'Pterodactyl Menu'),
    richTable(
      ['⚙️ Command', 'Deskripsi'],
      [
        ['/1gb ─ /20gb [user]',   'Panel Ram 1GB-20GB (Server 1)'],
        ['/1gbv2 ─ /20gbv2 [user]',   'Panel Ram 1GB-20GB (Server 2)'],
        ['/1gbv3 ─ /20gbv3 [user]',   'Panel Ram 1GB-20GB (Server 3)'],
        ['/1gbv4 ─ /20gbv4 [user]',   'Panel Ram 1GB-20GB (Server 4)'],
        ['/1gbv5 ─ /20gbv5 [user]',   'Panel Ram 1GB-20GB (Server 5)'],
      ]
    ),
    richTable(
      ['⚙️ Command', 'Deskripsi'],
      [
        ['/unli [user]',   'Panel Ram Unlimited (Server 1)'],
        ['/unliv2 [user]',   'Panel Ram Unlimited (Server 2)'],
        ['/unliv3 [user]',   'Panel Ram Unlimited (Server 3)'],
        ['/unliv4 [user]',   'Panel Ram Unlimited (Server 4)'],
        ['/unliv5 [user]',   'Panel Ram Unlimited (Server 5)'],
      ]
    ),
    richTable(
      ['⚙️ Command', 'Deskripsi'],
      [
        ['/cadp [user]',   'Admin Panel (Server 1)'],
        ['/cadpv2 [user]',   'Admin Panel (Server 2)'],
        ['/cadpv3 [user]',   'Admin Panel (Server 3)'],
        ['/cadpv4 [user]',   'Admin Panel (Server 4)'],
        ['/cadpv5 [user]',   'Admin Panel (Server 5)'],
      ]
    ),
    richTable(
      ['⚙️ Command', 'Deskripsi'],
      [
        ['/cekserver', 'Status semua server aktif'],
        ['/listserver', 'List semia server'],
        ['/listuser', 'List semua user'],
        ['/delserver', 'Hapus server'],
        ['/deluser', 'Hapus user'],
        ['/del ID_SERVER', 'Hapus panel by server ID'],
      ]
    ),
  ].join('\n');
  return renderCard(ctx, richHtml, Markup.inlineKeyboard([
    [{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: "danger"}],
  ]), { thumb: true });
});

bot.action('profile', async (ctx) => { await safeAnswer(ctx); try { await ctx.deleteMessage(); } catch (_) {} await sendProfile(ctx); });
bot.action('info', async (ctx) => { await safeAnswer(ctx); await sendInfo(ctx, null, null, { edit: true }); });
bot.action('ping', async (ctx) => { await safeAnswer(ctx, 'Pong'); try { await ctx.deleteMessage(); } catch (_) {} await sendPing(ctx); });
bot.action('help_menu', async (ctx) => { await safeAnswer(ctx); await sendHelp(ctx, { edit: true }); });

bot.action('server_menu', async (ctx) => {
  await safeAnswer(ctx);
  try { await ctx.deleteMessage(); } catch (_) {}
  await sendServerMenu(ctx, {});
});
bot.action('info_user', async (ctx) => {
  await safeAnswer(ctx);
  try { await ctx.deleteMessage(); } catch (_) {}
  await sendInfoUserMenu(ctx, {});
});
bot.action('pusat_kontrol', async (ctx) => {
  await safeAnswer(ctx);
  try { await ctx.deleteMessage(); } catch (_) {}
  await sendPusatKontrol(ctx, {});
});
bot.action('thanks_to', async (ctx) => {
  await safeAnswer(ctx);
  try { await ctx.deleteMessage(); } catch (_) {}
  await sendThanksTo(ctx, {});
});
bot.action('developer', async (ctx) => {
  await safeAnswer(ctx);
  try { await ctx.deleteMessage(); } catch (_) {}
  await sendDeveloper(ctx, {});
});

bot.action('owner_menu', async (ctx) => {
  await safeAnswer(ctx);
  try { await ctx.deleteMessage(); } catch (_) {}
  await sendOwnerMenu(ctx, {});
});
bot.action('owner_stats', async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return ctx.reply(eBox('⛔ AKSES DITOLAK', ['Hanya Owner!']), { parse_mode: 'HTML' });
  const statsCmd = { message: { ...ctx.callbackQuery.message, text: '/stats', from: ctx.from }, from: ctx.from, chat: ctx.chat, reply: ctx.reply.bind(ctx) };
  await bot.telegram.sendMessage(ctx.chat.id, '/stats');
});
bot.action('list_users', async (ctx) => { await safeAnswer(ctx); await sendListUsers(ctx, { edit: true }); });

bot.action('lr_back_tier', async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return;
  await sendListUsers(ctx, { edit: true });
});
bot.action(/^lr_tier_(akma|akme|akti)$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return;
  await sendListRolesByTier(ctx, ctx.match[1], { edit: true });
});
bot.action(/^lr_role_(\w+)_(\d+)$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return;
  await sendListRolesByRole(ctx, ctx.match[1], Number(ctx.match[2]), { edit: true });
});

bot.action(/^list_servers_(\d+)$/, async (ctx) => {
  await safeAnswer(ctx);
  await sendListServers(ctx, Number(ctx.match[1]), { edit: true });
});
bot.action('del_panel_help', async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Menu ini khusus owner.', Markup.inlineKeyboard([]), { edit: true });
  return renderCard(ctx, '🗑️ <b>HAPUS PANEL</b>\n\nKirim:\n<code>/del ID_SERVER</code>\n\nContoh: <code>/del 123</code>', ownerMenuKeyboard(), { edit: true });
});
bot.action('ptero_test', async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Menu ini khusus owner.', Markup.inlineKeyboard([]), { edit: true });
  try {
    const results = await testPterodactylConnection();
    const lines = results.map(r => r.ok ? `✅ V${r.index}: OK (${r.total} user)` : `❌ V${r.index}: ${r.error}`);
    return renderCard(ctx, `🔧 <b>TEST KONEKSI</b>\n\n${lines.join('\n')}`, ownerMenuKeyboard(), { edit: true });
  } catch (error) {
    return renderCard(ctx, `❌ ${htmlEscape(String(error?.message || error))}`, ownerMenuKeyboard(), { edit: true });
  }
});
bot.action(/^confirm_del_server_(\d+)$/, async (ctx) => {
  await safeAnswer(ctx, 'Memproses...');
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  const serverId = ctx.match[1];
  try {
    await pteroRequest(`/api/application/servers/${Number(serverId)}`, { method: 'DELETE' });
    serverStatusCache = { ts: 0, data: null };
  onlineServersCache = { ts: 0, count: null };
    return renderCard(ctx, `✅ Server ID <code>${htmlEscape(serverId)}</code> berhasil dihapus.`, ownerMenuKeyboard(), { edit: true });
  } catch (error) {
    return renderCard(ctx, `❌ Gagal hapus server ${htmlEscape(serverId)}.\n\n${htmlEscape(error.message || error)}`, ownerMenuKeyboard(), { edit: true });
  }
});
bot.action('copy_pass_existing', async (ctx) => {
  try { await ctx.answerCbQuery('Password: gunakan password existing / lama user ini.', { show_alert: true }); } catch (_) {}
});

bot.action(/^confirm_del_server_v([1-5])_(\d+)$/, async (ctx) => {
  await safeAnswer(ctx, 'Memproses...');
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  const vn       = Number(ctx.match[1]);
  const serverId = ctx.match[2];
  const servers  = getActiveServers();
  const server   = servers.find(s => s.index === vn);
  if (!server) return renderCard(ctx, `❌ Server V${vn} tidak aktif.`, ownerMenuKeyboard(), { edit: true });
  try {
    await pteroRequestFor(server, `/api/application/servers/${Number(serverId)}`, { method: 'DELETE' });
    serverStatusCache = { ts: 0, data: null };
  onlineServersCache = { ts: 0, count: null };
    return renderCard(ctx,
      `✅ Server ID <code>${htmlEscape(serverId)}</code> di <b>V${vn}</b> berhasil dihapus.`,
      ownerMenuKeyboard(), { edit: true }
    );
  } catch (error) {
    return renderCard(ctx,
      `❌ Gagal hapus server ${htmlEscape(serverId)} di V${vn}.\n\n${htmlEscape(error.message || error)}`,
      ownerMenuKeyboard(), { edit: true }
    );
  }
});

async function renderDelServerListPage(ctx, vn, page, options = {}) {
  const servers = getActiveServers();
  const server  = servers.find(s => s.index === vn);
  if (!server) return renderCard(ctx, `❌ Server V${vn} tidak aktif.`, ownerMenuKeyboard(), options);
  try {
    const resp       = await pteroRequestFor(server, `/api/application/servers?per_page=8&page=${page}`);
    const items      = Array.isArray(resp?.data) ? resp.data : [];
    const pagination = resp?.meta?.pagination || {};
    const totalPages = Number(pagination.total_pages || 1);
    const total      = Number(pagination.total || items.length);
    if (!total && page === 1) {
      return renderCard(ctx, `✅ Tidak ada server di V${vn}.`, ownerMenuKeyboard(), options);
    }
    const rows = items.map(srv => {
      const a    = srv?.attributes || {};
      const id   = a.id;
      const name = String(a.name || `Server ${id}`).slice(0, 22);
      return [{ text: eF(`${name} [${id}]`), callback_data: `delserver_pick_v${vn}_${id}`, style: 'danger' }];
    });
    const navRow = [];
    if (page > 1)          navRow.push({ text: eF('『 ◀ 』 Prev'), callback_data: `delserver_page_v${vn}_${page - 1}`, style: 'primary'});
    if (page < totalPages) navRow.push({ text: eF('『 ▶ 』 Next'), callback_data: `delserver_page_v${vn}_${page + 1}`, style: 'primary'});
    if (navRow.length) rows.push(navRow);
    rows.push([{ text: eF(`『 🗑️ 』 Hapus Semua (${total}) Di V${vn}`), callback_data: `delserver_allslot_v${vn}`, style: 'danger'}]);
    rows.push([{ text: eF('『 ✖️ 』 Batal'), callback_data: 'owner_menu', style: 'success'}]);
    const caption = [
      `🗑️ <b>PILIH SERVER · V${vn}</b>`, '',
      `<blockquote>Panel: <b>${htmlEscape(cleanDomain(server.domain))}</b>\nTotal: <b>${total}</b> server · Halaman ${page}/${totalPages}\n\nPilih server yang ingin dihapus, atau hapus semua sekaligus.</blockquote>`,
    ].join('\n');
    return renderCard(ctx, caption, Markup.inlineKeyboard(rows), options);
  } catch (error) {
    return renderCard(ctx, `❌ Gagal mengambil daftar server V${vn}.\n\n${htmlEscape(String(error.message || error))}`, ownerMenuKeyboard(), options);
  }
}

bot.action(/^delserver_slot_v([1-5])$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  await renderDelServerListPage(ctx, Number(ctx.match[1]), 1, { edit: true });
});

bot.action(/^delserver_page_v([1-5])_(\d+)$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  await renderDelServerListPage(ctx, Number(ctx.match[1]), Number(ctx.match[2]), { edit: true });
});

bot.action(/^delserver_pick_v([1-5])_(\d+)$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  const vn       = Number(ctx.match[1]);
  const serverId = ctx.match[2];
  const servers  = getActiveServers();
  const server   = servers.find(s => s.index === vn);
  if (!server) return renderCard(ctx, `❌ Server V${vn} tidak aktif.`, ownerMenuKeyboard(), { edit: true });
  try {
    const resp = await pteroRequestFor(server, `/api/application/servers/${Number(serverId)}`);
    const a    = resp?.attributes || {};
    return renderCard(ctx,
      [
        '⚠️ <b>KONFIRMASI HAPUS SERVER</b>', '',
        `<blockquote>Slot: <b>V${vn}</b>\nNama: <b>${htmlEscape(a.name || '-')}</b>\nID: <code>${htmlEscape(String(a.id || serverId))}</code>\nIdentifier: <code>${htmlEscape(a.identifier || '-')}</code>\n\n⛔ Tindakan ini tidak bisa dibatalkan!</blockquote>`,
      ].join('\n'),
      Markup.inlineKeyboard([
        [{ text: eF('『 🗑️ 』 Ya, Hapus Server Ini'), callback_data: `confirm_del_server_v${vn}_${serverId}`, style: 'danger'}],
        [{ text: eF('『 ↩️ 』 Kembali'), callback_data: `delserver_slot_v${vn}`, style: 'primary'}],
      ]),
      { edit: true }
    );
  } catch (error) {
    return renderCard(ctx, `❌ Server ID ${htmlEscape(serverId)} tidak ditemukan di V${vn}.`, ownerMenuKeyboard(), { edit: true });
  }
});

bot.action(/^delserver_allslot_v([1-5])$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  const vn = Number(ctx.match[1]);
  return renderCard(ctx,
    [
      `⚠️ <b>KONFIRMASI HAPUS SEMUA SERVER · V${vn}</b>`, '',
      `<blockquote>Semua server di slot V${vn} akan dihapus permanen.\n\n⛔ Tidak bisa dibatalkan setelah dieksekusi!</blockquote>`,
    ].join('\n'),
    Markup.inlineKeyboard([
      [{ text: eF(`『 🗑️ 』 Ya, Hapus Semua Di V${vn}`), callback_data: `confirm_delserver_slot_v${vn}`, style: 'danger'}],
      [{ text: eF('『 ↩️ 』 Kembali'), callback_data: `delserver_slot_v${vn}`, style: 'primary'}],
    ]),
    { edit: true }
  );
});

bot.action('delserver_all', async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  return renderCard(ctx,
    [
      '⚠️ <b>KONFIRMASI HAPUS SEMUA SERVER</b>', '',
      '<blockquote>Tindakan ini akan menghapus <b>SEMUA</b> panel server dari seluruh slot aktif.\n\n⛔ Tidak bisa dibatalkan setelah dieksekusi!\n\nYakin ingin melanjutkan?</blockquote>',
    ].join('\n'),
    delAllServersConfirmKeyboard(),
    { edit: true }
  );
});

bot.action(/^confirm_delserver_slot_v([1-5])$/, async (ctx) => {
  await safeAnswer(ctx, 'Memproses...');
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  const vn      = Number(ctx.match[1]);
  const servers = getActiveServers();
  const server  = servers.find(s => s.index === vn);
  if (!server) return renderCard(ctx, `❌ Server V${vn} tidak aktif.`, ownerMenuKeyboard(), { edit: true });
  try {
    let page = 1, panelServers = [];
    while (page <= 100) {
      const resp = await pteroRequestFor(server, `/api/application/servers?per_page=100&page=${page}`);
      const rows = Array.isArray(resp?.data) ? resp.data : [];
      panelServers.push(...rows);
      const pagination = resp?.meta?.pagination;
      if (!rows.length || !pagination || page >= Number(pagination.total_pages || page)) break;
      page++;
    }
    if (!panelServers.length) return renderCard(ctx, `✅ Tidak ada server di V${vn} yang perlu dihapus.`, ownerMenuKeyboard(), { edit: true });
    let deleted = 0, failed = 0;
    for (const srv of panelServers) {
      const srvId = srv?.attributes?.id;
      if (!srvId) { failed++; continue; }
      try { await pteroRequestFor(server, `/api/application/servers/${srvId}`, { method: 'DELETE' }); deleted++; }
      catch (_) { failed++; }
    }
    serverStatusCache = { ts: 0, data: null };
  onlineServersCache = { ts: 0, count: null };
    return renderCard(ctx,
      [`💣 <b>HAPUS SERVER V${vn} SELESAI</b>`, '',
       `<blockquote>Total server: ${panelServers.length}\n✅ Berhasil: ${deleted}\n❌ Gagal: ${failed}</blockquote>`].join('\n'),
      ownerMenuKeyboard(), { edit: true }
    );
  } catch (error) {
    return renderCard(ctx, `❌ Gagal: ${htmlEscape(String(error?.message || error))}`, ownerMenuKeyboard(), { edit: true });
  }
});

async function renderDelUserListPage(ctx, vn, page, options = {}) {
  const servers = getActiveServers();
  const server  = servers.find(s => s.index === vn);
  if (!server) return renderCard(ctx, `❌ Server V${vn} tidak aktif.`, ownerMenuKeyboard(), options);
  try {
    const resp       = await pteroRequestFor(server, `/api/application/users?per_page=8&page=${page}`);
    const items      = Array.isArray(resp?.data) ? resp.data : [];
    const pagination = resp?.meta?.pagination || {};
    const totalPages = Number(pagination.total_pages || 1);
    const total      = Number(pagination.total || items.length);
    if (!total && page === 1) {
      return renderCard(ctx, `✅ Tidak ada user di V${vn}.`, ownerMenuKeyboard(), options);
    }
    const rows = items.map(u => {
      const a        = u?.attributes || {};
      const id       = a.id;
      const username = String(a.username || `User ${id}`).slice(0, 26);
      const icon     = a.root_admin ? '👑' : '👤';
      return [{ text: eF(`${icon} ${username}`), callback_data: `deluser_pick_v${vn}_${id}`, style: 'danger' }];
    });
    const navRow = [];
    if (page > 1)          navRow.push({ text: eF('『 ◀ 』 Prev'), callback_data: `deluser_page_v${vn}_${page - 1}`, style: 'primary'});
    if (page < totalPages) navRow.push({ text: eF('『 ▶ 』 Next'), callback_data: `deluser_page_v${vn}_${page + 1}`, style: 'primary'});
    if (navRow.length) rows.push(navRow);
    rows.push([{ text: eF(`『 👥 』 Hapus Semua (${total}) Di V${vn}`), callback_data: `deluser_allslot_v${vn}`, style: 'danger'}]);
    rows.push([{ text: eF('『 ✖️ 』 Batal'), callback_data: 'owner_menu', style: 'success'}]);
    const caption = [
      `👤 <b>PILIH USER · V${vn}</b>`, '',
      `<blockquote>Panel: <b>${htmlEscape(cleanDomain(server.domain))}</b>\nTotal: <b>${total}</b> user · Halaman ${page}/${totalPages}\n\n👑 = root admin  ·  Pilih user yang ingin dihapus.</blockquote>`,
    ].join('\n');
    return renderCard(ctx, caption, Markup.inlineKeyboard(rows), options);
  } catch (error) {
    return renderCard(ctx, `❌ Gagal mengambil daftar user V${vn}.\n\n${htmlEscape(String(error.message || error))}`, ownerMenuKeyboard(), options);
  }
}

bot.action(/^deluser_slot_v([1-5])$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  await renderDelUserListPage(ctx, Number(ctx.match[1]), 1, { edit: true });
});

bot.action(/^deluser_page_v([1-5])_(\d+)$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  await renderDelUserListPage(ctx, Number(ctx.match[1]), Number(ctx.match[2]), { edit: true });
});

bot.action(/^deluser_pick_v([1-5])_(\d+)$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  const vn      = Number(ctx.match[1]);
  const userId  = ctx.match[2];
  const servers = getActiveServers();
  const server  = servers.find(s => s.index === vn);
  if (!server) return renderCard(ctx, `❌ Server V${vn} tidak aktif.`, ownerMenuKeyboard(), { edit: true });
  try {
    const resp = await pteroRequestFor(server, `/api/application/users/${Number(userId)}`);
    const a    = resp?.attributes || {};
    const adminNote = a.root_admin ? '\n\n⚠️ <b>User ini adalah root admin!</b>' : '';
    return renderCard(ctx,
      [
        '⚠️ <b>KONFIRMASI HAPUS USER</b>', '',
        `<blockquote>Slot: <b>V${vn}</b>\nUsername: <b>${htmlEscape(a.username || '-')}</b>\nEmail: <code>${htmlEscape(a.email || '-')}</code>\nID: <code>${htmlEscape(String(a.id || userId))}</code>${adminNote}\n\n⛔ Tindakan ini tidak bisa dibatalkan!</blockquote>`,
      ].join('\n'),
      Markup.inlineKeyboard([
        [{ text: eF('『 🗑️ 』 Ya, Hapus User Ini'), callback_data: `confirm_deluser_v${vn}_${userId}`, style: 'danger'}],
        [{ text: eF('『 ↩️ 』 Kembali'), callback_data: `deluser_slot_v${vn}`, style: 'primary'}],
      ]),
      { edit: true }
    );
  } catch (error) {
    return renderCard(ctx, `❌ User ID ${htmlEscape(userId)} tidak ditemukan di V${vn}.`, ownerMenuKeyboard(), { edit: true });
  }
});

bot.action(/^confirm_deluser_v([1-5])_(\d+)$/, async (ctx) => {
  await safeAnswer(ctx, 'Memproses...');
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  const vn      = Number(ctx.match[1]);
  const userId  = ctx.match[2];
  const servers = getActiveServers();
  const server  = servers.find(s => s.index === vn);
  if (!server) return renderCard(ctx, `❌ Server V${vn} tidak aktif.`, ownerMenuKeyboard(), { edit: true });
  try {
    await pteroRequestFor(server, `/api/application/users/${Number(userId)}`, { method: 'DELETE' });
    return renderCard(ctx,
      `✅ User ID <code>${htmlEscape(userId)}</code> di <b>V${vn}</b> berhasil dihapus.`,
      ownerMenuKeyboard(), { edit: true }
    );
  } catch (error) {
    return renderCard(ctx, `❌ Gagal hapus user ${htmlEscape(userId)} di V${vn}.\n\n${htmlEscape(String(error.message || error))}`, ownerMenuKeyboard(), { edit: true });
  }
});

bot.action(/^deluser_allslot_v([1-5])$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  const vn = Number(ctx.match[1]);
  return renderCard(ctx,
    [
      `⚠️ <b>KONFIRMASI HAPUS SEMUA USER · V${vn}</b>`, '',
      `<blockquote>Semua user <b>tanpa panel</b> di slot V${vn} akan dihapus permanen.\nRoot admin tidak akan dihapus.\n\n⛔ Tidak bisa dibatalkan setelah dieksekusi!</blockquote>`,
    ].join('\n'),
    Markup.inlineKeyboard([
      [{ text: eF(`『 👥 』 Ya, Hapus Semua User Di V${vn}`), callback_data: `confirm_deluser_slot_v${vn}`, style: 'danger'}],
      [{ text: eF('『 ↩️ 』 Kembali'), callback_data: `deluser_slot_v${vn}`, style: 'primary'}],
    ]),
    { edit: true }
  );
});

bot.action('deluser_all', async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  return renderCard(ctx,
    [
      '⚠️ <b>KONFIRMASI HAPUS SEMUA USER</b>', '',
      '<blockquote>Semua user <b>tanpa panel</b> dari <b>seluruh slot</b> aktif akan dihapus permanen.\nRoot admin tidak akan dihapus.\n\n⛔ Tidak bisa dibatalkan setelah dieksekusi!</blockquote>',
    ].join('\n'),
    Markup.inlineKeyboard([
      [{ text: eF('『 👥 』 Ya, Hapus Semua User!'), callback_data: 'confirm_deluser_all', style: 'danger'}],
      [{ text: eF('『 ✖️ 』 Batal'), callback_data: 'owner_menu', style: 'success'}],
    ]),
    { edit: true }
  );
});

bot.action(/^confirm_deluser_slot_v([1-5])$/, async (ctx) => {
  await safeAnswer(ctx, 'Memproses...');
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  const vn      = Number(ctx.match[1]);
  const servers = getActiveServers();
  const server  = servers.find(s => s.index === vn);
  if (!server) return renderCard(ctx, `❌ Server V${vn} tidak aktif.`, ownerMenuKeyboard(), { edit: true });
  try {
    const users   = await getAllPterodactylUsersOn(server);
    const targets = users.filter(u => {
      const attrs   = u?.attributes || {};
      if (attrs.root_admin) return false;
      const srvList = u?.relationships?.servers?.data;
      return Array.isArray(srvList) ? srvList.length === 0 : false;
    });
    if (!targets.length) return renderCard(ctx, `✅ Tidak ada user tanpa panel di V${vn}.`, ownerMenuKeyboard(), { edit: true });
    let deleted = 0, failed = 0;
    for (const user of targets) {
      const uId = user?.attributes?.id;
      if (!uId) { failed++; continue; }
      try { await pteroRequestFor(server, `/api/application/users/${uId}`, { method: 'DELETE' }); deleted++; }
      catch (_) { failed++; }
    }
    return renderCard(ctx,
      [`👤 <b>HAPUS USER V${vn} SELESAI</b>`, '',
       `<blockquote>Total ditemukan: ${targets.length}\n✅ Berhasil: ${deleted}\n❌ Gagal: ${failed}</blockquote>`].join('\n'),
      ownerMenuKeyboard(), { edit: true }
    );
  } catch (error) {
    return renderCard(ctx, `❌ Gagal: ${htmlEscape(String(error?.message || error))}`, ownerMenuKeyboard(), { edit: true });
  }
});

bot.action('confirm_deluser_all', async (ctx) => {
  await safeAnswer(ctx, 'Memproses...');
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  try {
    const servers = getActiveServers();
    if (!servers.length) return renderCard(ctx, '❌ Tidak ada server aktif.', ownerMenuKeyboard(), { edit: true });
    let totalFound = 0, deleted = 0, failed = 0;
    for (const server of servers) {
      const users   = await getAllPterodactylUsersOn(server);
      const targets = users.filter(u => {
        const attrs   = u?.attributes || {};
        if (attrs.root_admin) return false;
        const srvList = u?.relationships?.servers?.data;
        return Array.isArray(srvList) ? srvList.length === 0 : false;
      });
      totalFound += targets.length;
      for (const user of targets) {
        const uId = user?.attributes?.id;
        if (!uId) { failed++; continue; }
        try { await pteroRequestFor(server, `/api/application/users/${uId}`, { method: 'DELETE' }); deleted++; }
        catch (_) { failed++; }
      }
    }
    return renderCard(ctx,
      [`👤 <b>HAPUS SEMUA USER SELESAI</b>`, '',
       `<blockquote>Total ditemukan: ${totalFound}\n✅ Berhasil: ${deleted}\n❌ Gagal: ${failed}</blockquote>`].join('\n'),
      ownerMenuKeyboard(), { edit: true }
    );
  } catch (error) {
    return renderCard(ctx, `❌ Gagal: ${htmlEscape(String(error?.message || error))}`, ownerMenuKeyboard(), { edit: true });
  }
});

bot.action(/^addrole_tier_(akma|akme|akti)$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!canUseAddrole(ctx.from.id)) return;
  const tier = ctx.match[1];
  const state = pendingRole.get(String(ctx.from.id));
  if (!state) return ctx.answerCbQuery('⚠️ Session expired. Ketik /addrole lagi.', { show_alert: true });
  const callerRank = state.callerRank ?? getCallerAddroleRank(ctx.from.id);
  const tierHasAllowed = Object.values(ROLE_DEFINITIONS).some(d => d.tier === tier && d.rankOrder < callerRank);
  if (!tierHasAllowed) return ctx.answerCbQuery('❌ Tidak ada izin untuk tier ini.', { show_alert: true });
  pendingRole.set(String(ctx.from.id), { ...state, tier, role: undefined, callerRank });
  const msgId = ctx.callbackQuery?.message?.message_id;
  const kbRole = roleSelectionKeyboard(tier, callerRank);
  try {
    await ctx.editMessageText(
      `🎭 <b>Tambah Role</b>\n\nTarget: <code>${htmlEscape(state.targetId)}</code> (${htmlEscape(state.targetDisplay)})\nTier: <b>${htmlEscape(TIER_LABELS[tier])}</b>\n\nPilih role:`,
      { parse_mode: 'HTML', ...kbRole }
    );
    if (msgId && kbRole.reply_markup) startButtonAnim(ctx.chat.id, msgId, kbRole.reply_markup);
  } catch (_) {}
});

bot.action(/^addrole_role_(.+)$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!canUseAddrole(ctx.from.id)) return;
  const role = ctx.match[1];
  if (!ROLE_DEFINITIONS[role]) return ctx.answerCbQuery('Role tidak valid.', { show_alert: true });
  const state = pendingRole.get(String(ctx.from.id));
  if (!state) return ctx.answerCbQuery('⚠️ Session expired. Ketik /addrole lagi.', { show_alert: true });
  const callerRank = state.callerRank ?? getCallerAddroleRank(ctx.from.id);
  if (ROLE_DEFINITIONS[role].rankOrder >= callerRank) {
    return ctx.answerCbQuery('❌ Kamu tidak bisa assign role setara atau di atas levelmu.', { show_alert: true });
  }
  pendingRole.set(String(ctx.from.id), { ...state, role, callerRank });
  const def = ROLE_DEFINITIONS[role];
  const msgId2 = ctx.callbackQuery?.message?.message_id;
  const kbDur = durationSelectionKeyboard();
  try {
    await ctx.editMessageText(
      `🎭 <b>Tambah Role</b>\n\nTarget: <code>${htmlEscape(state.targetId)}</code> (${htmlEscape(state.targetDisplay)})\nTier: <b>${htmlEscape(TIER_LABELS[def.tier])}</b>\nRole: <b>${htmlEscape(def.label)}</b>\n\nPilih durasi:`,
      { parse_mode: 'HTML', ...kbDur }
    );
    if (msgId2 && kbDur.reply_markup) startButtonAnim(ctx.chat.id, msgId2, kbDur.reply_markup);
  } catch (_) {}
});

bot.action(/^addrole_dur_(permanent|\d+)$/, async (ctx) => {
  await safeAnswer(ctx);
  if (!canUseAddrole(ctx.from.id)) return;
  const durStr = ctx.match[1];
  const state = pendingRole.get(String(ctx.from.id));
  if (!state || !state.role) return ctx.answerCbQuery('⚠️ Session expired. Ketik /addrole lagi.', { show_alert: true });
  const callerRank = state.callerRank ?? getCallerAddroleRank(ctx.from.id);
  if (ROLE_DEFINITIONS[state.role].rankOrder >= callerRank) {
    pendingRole.delete(String(ctx.from.id));
    try { await ctx.editMessageText('❌ Akses ditolak. Role target tidak dalam jangkauan izinmu.', { parse_mode: 'HTML' }); } catch (_) {}
    return;
  }
  const days = durStr === 'permanent' ? null : Number(durStr);
  const result = db.setUserRole(state.targetId, state.role, ctx.from.id, days);
  pendingRole.delete(String(ctx.from.id));
  if (!result) {
    try { await ctx.editMessageText('❌ Gagal menyimpan role. Coba lagi.', { parse_mode: 'HTML' }); } catch (_) {}
    return;
  }
  const def = ROLE_DEFINITIONS[state.role];
  const expiredText = days ? `${days} Hari` : 'Permanent';
  const expiredDisplay = result.expiresAt ? formatDateId(result.expiresAt) : 'Permanent';
  const remainingDisplay = result.expiresAt ? formatRemainingTime(result.expiresAt) : 'Permanent';
  const msgId3 = ctx.callbackQuery?.message?.message_id;
  const chatId3 = ctx.chat?.id;
  const successCaption = [
    `${'✅'} <b>Role Berhasil Ditambahkan!</b>`, '',
    `<b>${'✌️'} User ID   :</b> <code>${htmlEscape(state.targetId)}</code>`,
    `<b>${'👤'} User     :</b> ${htmlEscape(state.targetDisplay)}`,
    `<b>${'⭐'} Role     :</b> ${htmlEscape(def.label)}`,
    `<b>${'📊'} Tier    :</b> ${htmlEscape(def.tierLabel)}`,
    `<b>${'🗓️'} Durasi   :</b> ${htmlEscape(expiredText)}`,
    `<b>${'⌛'} Sisa   :</b> ${htmlEscape(remainingDisplay)}`,
    `<b>${'🖥️'} Akses  :</b> V${(TIER_ALLOWED_SERVERS[def.tier] || []).join(', V')}`,
    `<b>${'👤'} Oleh    :</b> ${htmlEscape(getDisplayUsername(ctx))}`,
  ].join('\n');
  try { if (msgId3 && chatId3) await bot.telegram.deleteMessage(chatId3, msgId3); } catch (_) {}
  if (msgId3 && chatId3) stopButtonAnim(`${chatId3}:${msgId3}`);
  try {
    if (hasMenuImage()) {
      await ctx.replyWithPhoto(menuPhotoSource(), { caption: successCaption, parse_mode: 'HTML' });
    } else {
      await ctx.reply(successCaption, { parse_mode: 'HTML' });
    }
  } catch (_) {
    try { await ctx.reply(successCaption, { parse_mode: 'HTML' }); } catch (_2) {}
  }
  try {
    await bot.telegram.sendMessage(state.targetId, [
      '✅ <b>𝗔𝗞𝗦𝗘𝗦 𝗥𝗢𝗟𝗘 𝗔𝗞𝗧𝗜𝗙</b>', '',
      '<blockquote>',
      `🎭 Role       : ${htmlEscape(def.label)}`,
      `📊 Tier       : ${htmlEscape(def.tierLabel)}`,
      `📅 Aktif s/d  : ${htmlEscape(expiredDisplay)}`,
      `⏳ Sisa waktu : ${htmlEscape(remainingDisplay)}`,
      `⚙️ Akses Srv  : V${(TIER_ALLOWED_SERVERS[def.tier] || []).join(', V')}`,
      `👤 Ditambahkan : ${htmlEscape(getDisplayUsername(ctx))}`,
      '</blockquote>',
      '',
      'Silahkan gunakan bot untuk create panel sekarang.'
    ].join('\n'), { parse_mode: 'HTML' });
  } catch (_) {}

  const actorName = USERS_SECURITY[String(ctx.from.id)];
  if (actorName) {
    addStoranEntry(ctx.from.id, actorName, 'addrole', {
      'Target ID':  state.targetId,
      'Target':     state.targetDisplay,
      'Role':       def.label,
      'Tier':       def.tierLabel,
      'Durasi':     expiredText,
    });
  }
});

bot.action('addrole_back_tier', async (ctx) => {
  await safeAnswer(ctx);
  if (!canUseAddrole(ctx.from.id)) return;
  const state = pendingRole.get(String(ctx.from.id));
  if (!state) return ctx.answerCbQuery('⚠️ Session expired. Ketik /addrole lagi.', { show_alert: true });
  const callerRank = state.callerRank ?? getCallerAddroleRank(ctx.from.id);
  pendingRole.set(String(ctx.from.id), { targetId: state.targetId, targetDisplay: state.targetDisplay, messageId: state.messageId, chatId: state.chatId, callerRank });
  const msgId4 = ctx.callbackQuery?.message?.message_id;
  const kbTier = tierSelectionKeyboard(callerRank);
  try {
    await ctx.editMessageText(
      `🎭 <b>Tambah Role</b>\n\nTarget: <code>${htmlEscape(state.targetId)}</code> (${htmlEscape(state.targetDisplay)})\n\nPilih tier:`,
      { parse_mode: 'HTML', ...kbTier }
    );
    if (msgId4 && kbTier.reply_markup) startButtonAnim(ctx.chat.id, msgId4, kbTier.reply_markup);
  } catch (_) {}
});

bot.action('addrole_back_role', async (ctx) => {
  await safeAnswer(ctx);
  if (!canUseAddrole(ctx.from.id)) return;
  const state = pendingRole.get(String(ctx.from.id));
  if (!state || !state.tier) return ctx.answerCbQuery('⚠️ Session expired. Ketik /addrole lagi.', { show_alert: true });
  const callerRank = state.callerRank ?? getCallerAddroleRank(ctx.from.id);
  pendingRole.set(String(ctx.from.id), { ...state, role: undefined, callerRank });
  const msgId5 = ctx.callbackQuery?.message?.message_id;
  const kbRoleBack = roleSelectionKeyboard(state.tier, callerRank);
  try {
    await ctx.editMessageText(
      `🎭 <b>Tambah Role</b>\n\nTarget: <code>${htmlEscape(state.targetId)}</code> (${htmlEscape(state.targetDisplay)})\nTier: <b>${htmlEscape(TIER_LABELS[state.tier])}</b>\n\nPilih role:`,
      { parse_mode: 'HTML', ...kbRoleBack }
    );
    if (msgId5 && kbRoleBack.reply_markup) startButtonAnim(ctx.chat.id, msgId5, kbRoleBack.reply_markup);
  } catch (_) {}
});

bot.action('addrole_cancel', async (ctx) => {
  await safeAnswer(ctx, 'Dibatalkan');
  pendingRole.delete(String(ctx.from.id));
  const msgId = ctx.callbackQuery?.message?.message_id;
  const chatId = ctx.chat?.id;
  if (msgId && chatId) stopButtonAnim(`${chatId}:${msgId}`);
  try { await ctx.editMessageText('❌ /addrole dibatalkan.'); } catch (_) {}
});

bot.action('cek_server', async (ctx) => {
  await safeAnswer(ctx, 'Mengecek server...');
  if (!isOwner(ctx.from.id)) return;
  await sendCekServer(ctx, { edit: true });
});

bot.action('del_srv_off', async (ctx) => {
  await safeAnswer(ctx, 'Mencari server offline...');
  if (!isOwner(ctx.from.id)) return;
  try {
    const panelServers = await getAllPanelServers();
    const offlineServers = panelServers.filter(s => {
      const status = s?.attributes?.status;
      return status === 'suspended' || status === 'install_failed';
    });
    if (!offlineServers.length) {
      return renderCard(ctx, '✅ Tidak ada server offline/suspended ditemukan.', ownerMenuKeyboard(), { edit: true });
    }
    let deleted = 0, failed = 0;
    for (const srv of offlineServers) {
      const srvId = srv?.attributes?.id;
      const serverObj = srv._server;
      if (!srvId || !serverObj) { failed++; continue; }
      try {
        await pteroRequestFor(serverObj, `/api/application/servers/${srvId}`, { method: 'DELETE' });
        deleted++;
      } catch (_) { failed++; }
    }
    serverStatusCache = { ts: 0, data: null };
  onlineServersCache = { ts: 0, count: null };
    const caption = [
      '🗑️ <b>HAPUS SERVER OFFLINE</b>', '',
      `<blockquote>Total ditemukan: ${offlineServers.length}\n✅ Berhasil dihapus: ${deleted}\n❌ Gagal: ${failed}</blockquote>`
    ].join('\n');
    return renderCard(ctx, caption, ownerMenuKeyboard(), { edit: true });
  } catch (error) {
    return renderCard(ctx, `❌ ${htmlEscape(String(error?.message || error))}`, ownerMenuKeyboard(), { edit: true });
  }
});

bot.action('del_usr_off', async (ctx) => {
  await safeAnswer(ctx, 'Mencari user tanpa server...');
  if (!isOwner(ctx.from.id)) return;
  try {
    const servers = getActiveServers();
    if (!servers.length) return renderCard(ctx, '❌ Tidak ada server aktif.', ownerMenuKeyboard(), { edit: true });
    let totalFound = 0, deleted = 0, failed = 0;
    for (const server of servers) {
      const users = await getAllPterodactylUsersOn(server);
      const noServerUsers = users.filter(u => {
        const attrs = u?.attributes || {};
        if (attrs.root_admin) return false;
        const srvList = u?.relationships?.servers?.data;
        return Array.isArray(srvList) ? srvList.length === 0 : false;
      });
      totalFound += noServerUsers.length;
      for (const user of noServerUsers) {
        const userId = user?.attributes?.id;
        if (!userId) { failed++; continue; }
        try {
          await pteroRequestFor(server, `/api/application/users/${userId}`, { method: 'DELETE' });
          deleted++;
        } catch (_) { failed++; }
      }
    }
    const caption = [
      '👤 <b>HAPUS USER TANPA SERVER</b>', '',
      `<blockquote>Total ditemukan: ${totalFound}\n✅ Berhasil dihapus: ${deleted}\n❌ Gagal: ${failed}</blockquote>`
    ].join('\n');
    return renderCard(ctx, caption, ownerMenuKeyboard(), { edit: true });
  } catch (error) {
    return renderCard(ctx, `❌ ${htmlEscape(String(error?.message || error))}`, ownerMenuKeyboard(), { edit: true });
  }
});

bot.action('del_srv_all_confirm', async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return;
  return renderCard(ctx,
    [
      '⚠️ <b>KONFIRMASI HAPUS SEMUA SERVER</b>', '',
      '<blockquote>Tindakan ini akan menghapus <b>SEMUA</b> panel server dari semua server aktif.',
      '',
      '⛔ Tidak bisa dibatalkan setelah dieksekusi!',
      '',
      'Yakin ingin melanjutkan?</blockquote>'
    ].join('\n'),
    delAllServersConfirmKeyboard(),
    { edit: true }
  );
});

bot.action('confirm_del_srv_all', async (ctx) => {
  await safeAnswer(ctx, 'Memproses...');
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Akses ditolak.', ownerMenuKeyboard(), { edit: true });
  try {
    const panelServers = await getAllPanelServers();
    if (!panelServers.length) {
      return renderCard(ctx, '✅ Tidak ada server yang perlu dihapus.', ownerMenuKeyboard(), { edit: true });
    }
    let deleted = 0, failed = 0;
    for (const srv of panelServers) {
      const srvId = srv?.attributes?.id;
      const serverObj = srv._server;
      if (!srvId || !serverObj) { failed++; continue; }
      try {
        await pteroRequestFor(serverObj, `/api/application/servers/${srvId}`, { method: 'DELETE' });
        deleted++;
      } catch (_) { failed++; }
    }
    serverStatusCache = { ts: 0, data: null };
  onlineServersCache = { ts: 0, count: null };
    const caption = [
      '💣 <b>HAPUS SEMUA SERVER SELESAI</b>', '',
      `<blockquote>Total server: ${panelServers.length}\n✅ Berhasil dihapus: ${deleted}\n❌ Gagal: ${failed}</blockquote>`
    ].join('\n');
    return renderCard(ctx, caption, ownerMenuKeyboard(), { edit: true });
  } catch (error) {
    return renderCard(ctx, `❌ ${htmlEscape(String(error?.message || error))}`, ownerMenuKeyboard(), { edit: true });
  }
});

bot.action('backup_info', async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return renderCard(ctx, '❌ Menu ini khusus owner.', Markup.inlineKeyboard([]), { edit: true });
  const caption = [
    '📦 <b>BACKUP BOT</b>', '',
    `Tujuan: <b><code>${FIXED_BACKUP_CHAT_ID}</code></b>`, '',
    '<b>Commands:</b>',
    '• <code>/backup</code> — backup manual sekarang',
  ].join('\n');
  return renderCard(ctx, caption, Markup.inlineKeyboard([[{ text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: "danger"}, { text: eF('『 👑 』 Owner Menu'), callback_data: 'owner_menu', style: "primary"}]]), { edit: true });
});

bot.command('top10', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(`${'❌'} Command ini khusus owner.`);
  const db = monDbLoad();
  if (!db.lastUpdated) {
    return ctx.reply(`${'⌛'} Data belum tersedia, tunggu siklus monitoring berikutnya (±30 detik).`);
  }
  await ctx.reply(monBuildTop10Msg(db), { parse_mode: 'HTML' });
});

bot.command('unsuspend', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(`${'❌'} Command ini khusus owner.`);
  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const serverId = args[0]?.trim();
  if (!serverId) {
    return ctx.reply(`${'❓'} Format: <code>/unsuspend ID_SERVER</code>\nContoh: <code>/unsuspend 42</code>`, { parse_mode: 'HTML' });
  }
  const allSrv = getActiveServers();
  let found = false;
  for (const srv of allSrv) {
    try {
      const data = await pteroRequestFor(srv, `/api/application/servers/${serverId}`);
      const attrs = data?.attributes;
      if (!attrs) continue;
      await pteroRequestFor(srv, `/api/application/servers/${serverId}/unsuspend`, { method: 'POST' });
      const uuid = attrs.uuid;
      if (uuid) { monSuspended.delete(uuid); monRecovered.delete(uuid); }
      await ctx.reply(`${'✅'} <b>Berhasil di-unsuspend!</b>\n${'📌'} <code>${htmlEscape(attrs.name)}</code>\n${'✌️'} ID: <code>${serverId}</code>`, { parse_mode: 'HTML' });
      found = true;
      break;
    } catch (_) {}
  }
  if (!found) {
    await ctx.reply(`${'❌'} Server ID <code>${htmlEscape(serverId)}</code> tidak ditemukan atau gagal di-unsuspend.`, { parse_mode: 'HTML' });
  }
});

bot.command('monitorstatus', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(`${'❌'} Command ini khusus owner.`);
  const uptime = process.uptime();
  const uptStr = `${Math.floor(uptime/3600)}j ${Math.floor((uptime%3600)/60)}m`;
  const cpuWarned = [...monCpuHistory.values()].filter(r => r.count > 0).length;
  const status = MONITOR_ENABLED && MONITOR_CHAT_ID ? `${'✅'} Aktif` : `${'❌'} Nonaktif`;
  const caption = eMulti([
    {
      title: '📡 STATUS MONITORING',
      lines: [
        `Status       ┈ ${status}`,
        `Bot Uptime   ┈ <b>${htmlEscape(uptStr)}</b>`,
        `Tersuspend   ┈ <b>${monSuspended.size} server</b>`,
        `CPU warned   ┈ <b>${cpuWarned} server</b>`,
        `Disk tracked ┈ <b>${monDiskHistory.size} server</b>`,
        `Notif chat   ┈ <code>${htmlEscape(MONITOR_CHAT_ID || '—')}</code>`,
      ]
    },
    {
      title: '⚙️ THRESHOLD CONFIG',
      lines: [
        `RAM thresh  ┈ ${RAM_THRESHOLD_PCT}% / abs ${monFmtMiB(RAM_ABS_MAX_MIB)}`,
        `Disk thresh ┈ ${DISK_THRESHOLD_PCT}% / abs ${monFmtMiB(DISK_ABS_MAX_MIB)}`,
        `CPU thresh  ┈ ${CPU_STOP_THRESH}%`,
        `Interval    ┈ ${POLL_MS/1000}s`,
      ]
    },
  ]);
  return ctx.reply(caption, { parse_mode: 'HTML' });
});

bot.command('monitoron', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(`${'❌'} Command ini khusus owner.`);
  config.monitorEnabled = true;
  await ctx.reply(`${'✅'} <b>Auto Monitoring diaktifkan.</b>\n<i>Monitoring akan berjalan di siklus berikutnya.</i>`, { parse_mode: 'HTML' });
});

bot.command('monitoroff', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(`${'❌'} Command ini khusus owner.`);
  config.monitorEnabled = false;
  await ctx.reply(`${'❌'} <b>Auto Monitoring dinonaktifkan.</b>\n<i>Monitoring berhenti setelah siklus saat ini selesai.</i>`, { parse_mode: 'HTML' });
});

const MYQURAN_API_BASE = 'https://api.myquran.com/v2/sholat';
const PRAYER_NAMES = { subuh: 'Subuh', dzuhur: 'Dzuhur', ashar: 'Ashar', maghrib: 'Maghrib', isya: 'Isya' };
let prayerCache       = { date: null, timings: null };
let prayerTickRunning = false;
let _prayerKotaId     = null;

function getPrayerDb() {
  const data = fbRead(PRAYER_DB_FILE, { sent: {}, groups: [] });
  if (!data.sent  || typeof data.sent  !== 'object') data.sent  = {};
  if (!Array.isArray(data.groups))                   data.groups = [];
  return data;
}
function savePrayerDb(data) { fbWrite(PRAYER_DB_FILE, data); }
function jakartaDateParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { date: `${map.year}-${map.month}-${map.day}`, hour: map.hour, minute: map.minute };
}

function getHijriDateStr() {
  try {
    const now   = new Date();
    const parts = new Intl.DateTimeFormat('en-u-ca-islamic', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jakarta',
    }).formatToParts(now);
    const m         = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const monthName = new Intl.DateTimeFormat('en-u-ca-islamic', {
      month: 'long', timeZone: 'Asia/Jakarta',
    }).format(now);
    return `Hijri ${m.day}-${m.month}-${m.year} ${monthName}`;
  } catch (_) { return 'Hijri'; }
}

function buildPrayerRichTable(timings, currentKey = null) {
  const WN = 8, WT = 5;
  const br  = (l, m, r) => `${l}${'─'.repeat(WN + 2)}${m}${'─'.repeat(WT + 2)}${r}`;
  const rw  = (n, t, mark = '') => `│ ${n.padEnd(WN)} │ ${t.padEnd(WT)} │${mark}`;
  return [
    br('┌', '┬', '┐'),
    rw('waktu', 'jam'),
    br('├', '┼', '┤'),
    ...Object.entries(PRAYER_NAMES).map(([k, name]) =>
      rw(name, timings[k] || '--:--', k === currentKey ? ' ⬅️' : '')
    ),
    br('└', '┴', '┘'),
  ].join('\n');
}

async function resolvePrayerCityId(cityName) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res  = await fetch(`${MYQURAN_API_BASE}/kota/cari/${encodeURIComponent(cityName)}`, { signal: ctrl.signal });
    const json = await res.json();
    const list = json?.data;
    if (!Array.isArray(list) || !list.length) throw new Error('kota tidak ditemukan');
    const exact = list.find(c => c.lokasi?.toLowerCase() === cityName.toLowerCase());
    const pick  = exact || list[0];
    return String(pick.id);
  } catch (err) {
    console.warn('[PRAYER] Gagal resolve kota, fallback Jakarta:', err.message);
    return '1301';
  } finally { clearTimeout(t); }
}

async function fetchJakartaPrayerTimes(dateKey) {
  if (prayerCache.date === dateKey && prayerCache.timings) return prayerCache.timings;
  const [y, mo, d] = dateKey.split('-');
  const url  = `${MYQURAN_API_BASE}/jadwal/${_prayerKotaId}/${y}/${mo}/${d}`;
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res  = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json   = await res.json();
    const jadwal = json?.data?.jadwal;
    if (!jadwal) throw new Error('field jadwal tidak ada di response');
    const timings = {
      subuh:   jadwal.subuh   || null,
      dzuhur:  jadwal.dzuhur  || null,
      ashar:   jadwal.ashar   || null,
      maghrib: jadwal.maghrib || null,
      isya:    jadwal.isya    || null,
    };
    prayerCache = { date: dateKey, timings };
    return timings;
  } catch (err) {
    console.warn('[PRAYER FETCH] Error:', err.message);
    return { subuh: null, dzuhur: null, ashar: null, maghrib: null, isya: null };
  } finally { clearTimeout(t); }
}

async function prayerLockGroup(groupId) {
  try {
    await bot.telegram.setChatPermissions(groupId, {
      can_send_messages:       false, can_send_audios:         false,
      can_send_documents:      false, can_send_photos:         false,
      can_send_videos:         false, can_send_video_notes:    false,
      can_send_voice_notes:    false, can_send_polls:          false,
      can_send_other_messages: false,
    });
  } catch (err) { console.warn(`[PRAYER LOCK ${groupId}]`, err.message); }
}

async function prayerUnlockGroup(groupId, prayerName) {
  try {
    await bot.telegram.setChatPermissions(groupId, {
      can_send_messages:         true, can_send_audios:           true,
      can_send_documents:        true, can_send_photos:           true,
      can_send_videos:           true, can_send_video_notes:      true,
      can_send_voice_notes:      true, can_send_polls:            true,
      can_send_other_messages:   true, can_add_web_page_previews: true,
      can_invite_users:          true, can_pin_messages:          true,
    });
    await bot.telegram.sendMessage(
      groupId,
      `${'✅'} Grup telah dibuka kembali. Semoga ibadah <b>${prayerName}</b> kita diterima Allah SWT. 🤲`,
      { parse_mode: 'HTML' }
    );
  } catch (err) { console.warn(`[PRAYER UNLOCK ${groupId}]`, err.message); }
}

async function sendPrayerReminder(prayerKey, prayerTime, dateKey, allTimings) {
  const dbData    = getPrayerDb();
  const sentKey   = `${dateKey}:${prayerKey}:${prayerTime}`;
  if (dbData.sent[sentKey]) return;

  const prayerName  = PRAYER_NAMES[prayerKey];
  const hijriStr    = getHijriDateStr();
  const lockMenit   = Number(config.lockDurasiMenit ?? 10);
  const adzanUrl    = String(config.adzanUrl || '');
  const targetGroup = String(config.groupSholat || '');
  const kotaName    = String(config.kotaSholat || 'Jakarta');

  const tableRows = Object.entries(PRAYER_NAMES).map(([k, name]) => {
    const time     = richEscape(allTimings[k] || '--:--');
    const nameCell = k === prayerKey ? `<b>${name}</b> ⬅️` : name;
    return [nameCell, `<b>${time}</b>`];
  });

  const mainRich = [
    richTitle('🕌', `JADWAL SHOLAT · ${kotaName}`),
    richTable(['Waktu Sholat', 'Jam'], tableRows),
    richQuote(
      `${richEscape(hijriStr)} · Sekarang masuk waktu <b>${prayerName}</b>.`,
      'Jangan lupa sholat.'
    ),
  ].join('\n');
  const mainView = makeView(mainRich);

  const groupIds = targetGroup
    ? [targetGroup]
    : [...new Set(dbData.groups.map(id => String(id)))];

  let sentCount = 0;
  for (const groupId of groupIds) {
    try {
      await sendRich(groupId, mainView, {});
      sentCount++;
    } catch (error) {
      console.error(`[PRAYER MSG ${groupId}]`, error.message || error);
      continue;
    }

    if (adzanUrl) {
      try {
        await bot.telegram.sendAudio(
          groupId,
          adzanUrl,
          {
            caption:    `🔔 Adzan ${prayerName}`,
            parse_mode: 'HTML',
            title:      `Adzan ${prayerName}`,
            performer:  'Muadzin',
          }
        );
      } catch (err) {
        console.warn(`[PRAYER AUDIO ${groupId}]`, err.message);
      }
    }

    await prayerLockGroup(groupId);
    setTimeout(() => prayerUnlockGroup(groupId, prayerName), lockMenit * 60 * 1000);
  }

  if (sentCount > 0) {
    dbData.sent[sentKey] = { sentAt: new Date().toISOString(), recipients: sentCount };
    const keys = Object.keys(dbData.sent);
    if (keys.length > 100) for (const k of keys.slice(0, keys.length - 100)) delete dbData.sent[k];
    savePrayerDb(dbData);
  }
  console.log(`[PRAYER] ${prayerName} ${prayerTime} WIB -> ${sentCount} grup`);
}

async function checkPrayerSchedule() {
  if (prayerTickRunning) return;
  prayerTickRunning = true;
  try {
    const now     = jakartaDateParts();
    const timings = await fetchJakartaPrayerTimes(now.date);
    const nowTime = `${now.hour}:${now.minute}`;
    for (const prayerKey of Object.keys(PRAYER_NAMES)) {
      if (timings?.[prayerKey] === nowTime)
        await sendPrayerReminder(prayerKey, timings[prayerKey], now.date, timings);
    }
  } catch (error) { console.error('[PRAYER SCHEDULE ERROR]', error.message || error); }
  finally { prayerTickRunning = false; }
}

async function startPrayerScheduler() {
  const kota   = String(config.kotaSholat || 'Jakarta');
  _prayerKotaId = await resolvePrayerCityId(kota);
  checkPrayerSchedule();
  setInterval(checkPrayerSchedule, 20 * 1000);
  return { kota, kotaId: _prayerKotaId, lock: config.lockDurasiMenit ?? 10 };
}

bot.action('monitor_menu', async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return;
  const db = monDbLoad();
  const updated = db.lastUpdated
    ? new Date(db.lastUpdated).toLocaleString('id-ID', { hour12: false, timeZone: 'Asia/Jakarta' })
    : 'Belum ada data';
  const status = MONITOR_ENABLED && MONITOR_CHAT_ID ? `${'✅'} Aktif` : `${'❌'} Nonaktif`;
  const caption = eMulti([
    {
      title: '📡 AUTO MONITORING',
      lines: [
        `Status      ┈ ${status}`,
        `Tersuspend  ┈ <b>${monSuspended.size}</b>`,
        `Last update ┈ ${htmlEscape(updated)}`,
      ]
    },
    {
      title: '⚡ ATURAN AUTO',
      lines: [
        `CPU ≥ ${CPU_STOP_THRESH}% → Stop → jika berulang → Suspend`,
        `RAM ≥ ${RAM_THRESHOLD_PCT}% → Suspend`,
        `Disk ≥ ${DISK_THRESHOLD_PCT}% → Suspend`,
        'Auto-delete server tersuspend > 7 jam',
      ]
    },
    {
      title: '📋 COMMANDS',
      lines: [
        '/top10          ─ top 10 disk & cpu',
        '/unsuspend [id] ─ unsuspend server',
        '/monitoron · /monitoroff',
      ]
    },
  ]);
  return renderCard(ctx, caption, Markup.inlineKeyboard([
    [{ text: eF('『 📊 』 Top10 Stats'), callback_data: 'monitor_top10', style: "primary"}],
    [{ text: eF('『 🔄 』 Refresh Status'), callback_data: 'monitor_menu', style: "primary"}, { text: eF('『 🏠 』 Back To Menu'), callback_data: 'menu', style: "danger"}, { text: eF('『 👑 』 Owner Menu'), callback_data: 'owner_menu', style: "primary"}]
  ]), { edit: true });
});

bot.action('monitor_top10', async (ctx) => {
  await safeAnswer(ctx, 'Loading...');
  if (!isOwner(ctx.from.id)) return;
  const db = monDbLoad();
  if (!db.lastUpdated) {
    return ctx.answerCbQuery(`${'⌛'} Belum ada data monitoring`, { show_alert: true });
  }
  await bot.telegram.sendMessage(ctx.chat.id, monBuildTop10Msg(db), { parse_mode: 'HTML' });
});

bot.action(/^unli_choose_(nodejs|python)_(\d+)$/, async (ctx) => {
  try {
    await safeAnswer(ctx);
    const eggType = ctx.match[1];
    const userId = Number(ctx.match[2]);

    if (userId !== ctx.from.id) {
      return ctx.answerCbQuery('❌ Button ini bukan untuk kamu', true).catch(() => {});
    }

    await createPanelWithEgg(ctx, eggType, userId);
  } catch (e) {
    console.error('[UNLI EGG CHOICE ERROR]', e);
    ctx.answerCbQuery('❌ Gagal memproses pilihan', true).catch(() => {});
  }
});

bot.action(/^unli_v(\d+)_choose_(nodejs|python)_(\d+)$/, async (ctx) => {
  try {
    await safeAnswer(ctx);
    const serverIndex = Number(ctx.match[1]);
    const eggType = ctx.match[2];
    const userId = Number(ctx.match[3]);

    if (userId !== ctx.from.id) {
      return ctx.answerCbQuery('❌ Button ini bukan untuk kamu', true).catch(() => {});
    }

    await createPanelWithEggForServer(ctx, eggType, userId, serverIndex);
  } catch (e) {
    console.error('[UNLIV EGG CHOICE ERROR]', e);
    ctx.answerCbQuery('❌ Gagal memproses pilihan', true).catch(() => {});
  }
});

bot.action(/^list_server_detail_(\d+)(?:_(\d+))?$/, async (ctx) => {
  let loadingMsg;
  try {
    try { await ctx.answerCbQuery(''); } catch (_) {}
    try { await ctx.deleteMessage(); } catch (_) {}
    const serverIndex = Number(ctx.match[1]);
    const page = ctx.match[2] ? Number(ctx.match[2]) : 1;
    loadingMsg = await ctx.reply(
      `⏳ <b>Mengambil data Server V${serverIndex}... Mohon tunggu.</b>`,
      { parse_mode: 'HTML' }
    );
    await showServerDetail(ctx, serverIndex, page);
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
  } catch (e) {
    console.error('[LIST SERVER DETAIL ERROR]', e);
    if (loadingMsg) try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    ctx.answerCbQuery('❌ Gagal', true);
  }
});

bot.action('list_server_choose', async (ctx) => {
  try {
    try { await ctx.answerCbQuery(''); } catch (_) {}
    try { await ctx.deleteMessage(); } catch (_) {}
    await sendServerSelectionMenu(ctx, 'ls');
  } catch (e) {
    console.error('[LIST SERVER CHOOSE ERROR]', e);
    ctx.answerCbQuery('❌ Gagal', true);
  }
});

bot.action(/^ls_select_v(\d+)$/, async (ctx) => {
  let loadingMsg;
  try {
    try { await ctx.answerCbQuery(''); } catch (_) {}
    try { await ctx.deleteMessage(); } catch (_) {}
    const serverIndex = Number(ctx.match[1]);
    loadingMsg = await ctx.reply(
      `⏳ <b>Sedang mengambil data Server V${serverIndex}...</b>`,
      { parse_mode: 'HTML' }
    );
    await showServerDetail(ctx, serverIndex, 1);
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
  } catch (e) {
    console.error('[LS SELECT ERROR]', e);
    if (loadingMsg) try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    ctx.answerCbQuery('❌ Gagal', true);
  }
});

bot.action('ls_cancel', async (ctx) => {
  try {
    try { await ctx.answerCbQuery('Dibatalkan'); } catch (_) {}
    try {
      await ctx.deleteMessage();
    } catch (_) {
      try {
        await bot.telegram.editMessageReplyMarkup(
          ctx.chat.id, ctx.callbackQuery.message.message_id, undefined,
          { inline_keyboard: [] }
        );
      } catch (_) {}
    }
  } catch (e) {
    console.error('[LS CANCEL ERROR]', e);
  }
});

bot.action(/^lu_select_v(\d+)$/, async (ctx) => {
  let loadingMsg;
  try {
    try { await ctx.answerCbQuery(''); } catch (_) {}
    try { await ctx.deleteMessage(); } catch (_) {}
    const serverIndex = Number(ctx.match[1]);
    loadingMsg = await ctx.reply(
      `⏳ <b>Sedang mengambil data user Server V${serverIndex}...</b>`,
      { parse_mode: 'HTML' }
    );
    await sendListUsersForServer(ctx, serverIndex, 1);
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
  } catch (e) {
    console.error('[LU SELECT ERROR]', e);
    if (loadingMsg) try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    ctx.answerCbQuery('❌ Gagal', true);
  }
});

bot.action(/^lu_page_v(\d+)_(\d+)$/, async (ctx) => {
  let loadingMsg;
  try {
    try { await ctx.answerCbQuery(''); } catch (_) {}
    try { await ctx.deleteMessage(); } catch (_) {}
    const serverIndex = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    loadingMsg = await ctx.reply(
      `⏳ <b>Mengambil data user Server V${serverIndex}... Mohon tunggu.</b>`,
      { parse_mode: 'HTML' }
    );
    await sendListUsersForServer(ctx, serverIndex, page);
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
  } catch (e) {
    console.error('[LU PAGE ERROR]', e);
    if (loadingMsg) try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (_) {}
    ctx.answerCbQuery('❌ Gagal', true);
  }
});

bot.action('lu_back', async (ctx) => {
  try {
    try { await ctx.answerCbQuery(''); } catch (_) {}
    try { await ctx.deleteMessage(); } catch (_) {}
    await sendServerSelectionMenu(ctx, 'lu');
  } catch (e) {
    console.error('[LU BACK ERROR]', e);
    ctx.answerCbQuery('❌ Gagal', true);
  }
});

bot.action('lu_cancel', async (ctx) => {
  try {
    try { await ctx.answerCbQuery('Dibatalkan'); } catch (_) {}
    try {
      await ctx.deleteMessage();
    } catch (_) {
      try {
        await bot.telegram.editMessageReplyMarkup(
          ctx.chat.id, ctx.callbackQuery.message.message_id, undefined,
          { inline_keyboard: [] }
        );
      } catch (_) {}
    }
  } catch (e) {
    console.error('[LU CANCEL ERROR]', e);
  }
});

bot.action(/^list_users_(\d+)$/, async (ctx) => {
  try {
    try { await ctx.answerCbQuery(''); } catch (_) {}
    const page = Number(ctx.match[1]);
    await sendListPterodactylUsers(ctx, page, { edit: true });
  } catch (e) {
    console.error('[LIST USERS ERROR]', e);
    ctx.answerCbQuery('❌ Gagal', true);
  }
});

async function launch() {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username || '';

    await fbInit();
    const fbStats = getCacheStats();

    const _fbOverrides = fbRead(CONFIG_OVERRIDE_FILE, {});
    const overrideKeys = Object.keys(_fbOverrides);
    if (overrideKeys.length > 0) Object.assign(config, _fbOverrides);

    const servers = getActiveServers();

    const prayerInfo  = await startPrayerScheduler();
    const offlineInfo = startOfflineTrackerScheduler();
    const monitorInfo = startMonitorScheduler();

    const { printStartupBanner } = require('./lib/logger');
    printStartupBanner({
      botName:   config.botName || 'CPanel Bot',
      username:  me.username    || 'unknown',
      firebase:  fbStats,
      overrides: overrideKeys,
      servers: {
        list:  servers.map(s => ({ index: s.index, domain: cleanDomain(s.domain) })),
        total: 5,
      },
      services: [
        {
          name: 'Prayer',
          ok:   true,
          info: prayerInfo
            ? `${prayerInfo.kota} (${prayerInfo.kotaId}) — lock ${prayerInfo.lock} menit`
            : 'Gagal',
        },
        {
          name: 'Offline',
          ok:   offlineInfo?.ok ?? false,
          info: offlineInfo?.info ?? '-',
        },
        {
          name: 'Monitor',
          ok:   monitorInfo?.ok ?? false,
          info: monitorInfo?.info ?? '-',
        },
        { name: 'Features',  ok: true, info: '43 fitur + all new features' },
        { name: 'Scheduler', ok: true, info: 'All schedulers started' },
      ],
      startTime: new Date(),
    });

    await bot.launch({ dropPendingUpdates: true });

    const { startUpdateChecker } = require('./lib/updater');
    const ownerIds = (() => {
      const raw = config.ownerIds ?? config.ownerId;
      return Array.isArray(raw)
        ? raw.map(String).filter(Boolean)
        : [String(raw || '')].filter(Boolean);
    })();
    startUpdateChecker(bot.telegram, config, () => ownerIds);
  } catch (error) { console.error('[BOOT ERROR]', error); process.exit(1); }
}

const activityLog = [];
function addActivityLog(userId, username, action, detail) {
  activityLog.push({
    timestamp: new Date().toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' }),
    userId, username: username || 'unknown', action, detail: detail || '-'
  });
  if (activityLog.length > 200) activityLog.shift();
}

const lockState = { unli: false, adp: false };

bot.command('ban', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(eBox('⛔ AKSES DITOLAK', ['Hanya Owner yang boleh menggunakan command ini!']), { parse_mode: 'HTML' });
  const args = ctx.message.text.split(/\s+/).slice(1);
  const targetId = parseInt(args[0]);
  if (!targetId || isNaN(targetId)) return ctx.reply(eBox('❌ FORMAT SALAH', ['/ban user_id', 'Contoh: /ban 123456789']), { parse_mode: 'HTML' });
  if (isOwner(targetId)) return ctx.reply(eBox('⛔ TIDAK BISA', ['Tidak bisa ban Owner!']), { parse_mode: 'HTML' });

  const blPath = path.join(__dirname, 'database', 'blacklist.json');
  const bl = fbRead(blPath, []);
  if (!bl.includes(String(targetId))) bl.push(String(targetId));
  fbWrite(blPath, bl);

  addActivityLog(ctx.from.id, ctx.from.username, 'BAN', `Target: ${targetId}`);
  try { await bot.telegram.sendMessage(targetId, eBox('🚫 KAMU DI-BAN', ['Kamu di-ban dari bot ini oleh owner.']), { parse_mode: 'HTML' }); } catch (_) {}
  await ctx.reply(eBox('✅ BAN BERHASIL', [`User <code>${targetId}</code> berhasil di-ban!`]), { parse_mode: 'HTML' });

  const actorName = USERS_SECURITY[String(ctx.from.id)];
  if (actorName) {
    addStoranEntry(ctx.from.id, actorName, 'ban', { 'Target ID': String(targetId) });
  }
});

bot.command('unban', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(eBox('⛔ AKSES DITOLAK', ['Hanya Owner yang boleh menggunakan command ini!']), { parse_mode: 'HTML' });
  const args = ctx.message.text.split(/\s+/).slice(1);
  const targetId = parseInt(args[0]);
  if (!targetId || isNaN(targetId)) return ctx.reply(eBox('❌ FORMAT SALAH', ['/unban user_id', 'Contoh: /unban 123456789']), { parse_mode: 'HTML' });

  const blPath = path.join(__dirname, 'database', 'blacklist.json');
  const bl = fbRead(blPath, []).filter(id => id !== String(targetId));
  fbWrite(blPath, bl);

  addActivityLog(ctx.from.id, ctx.from.username, 'UNBAN', `Target: ${targetId}`);
  try { await bot.telegram.sendMessage(targetId, eBox('✅ KAMU DI-UNBAN', ['Kamu sudah di-unban! Silakan gunakan bot.']), { parse_mode: 'HTML' }); } catch (_) {}
  return ctx.reply(eBox('✅ UNBAN BERHASIL', [`User <code>${targetId}</code> berhasil di-unban!`]), { parse_mode: 'HTML' });
});

bot.command('setcd', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(eBox('⛔ AKSES DITOLAK', ['Hanya Owner!']), { parse_mode: 'HTML' });
  const args = ctx.message.text.split(/\s+/).slice(1);
  const hours = parseInt(args[0]);
  if (!hours || isNaN(hours) || hours < 1) return ctx.reply(eBox('❌ FORMAT SALAH', ['/setcd jam', 'Contoh: /setcd 12', 'Minimal: 1 jam']), { parse_mode: 'HTML' });

  const ovr = fbRead(CONFIG_OVERRIDE_FILE, {});
  ovr.rateLimitMs = hours * 60 * 60 * 1000;
  fbWrite(CONFIG_OVERRIDE_FILE, ovr);

  addActivityLog(ctx.from.id, ctx.from.username, 'SETCD', `${hours} jam`);
  return ctx.reply(eBox('✅ COOLDOWN DIUBAH', [`Cooldown global diubah menjadi: <b>${hours} jam</b>`, 'Berlaku untuk semua panel command!']), { parse_mode: 'HTML' });
});

bot.command('lockunli', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(eBox('⛔ AKSES DITOLAK', ['Hanya Owner!']), { parse_mode: 'HTML' });
  lockState.unli = true;
  addActivityLog(ctx.from.id, ctx.from.username, 'LOCKUNLI', 'Locked');
  return ctx.reply(eBox('🔒 PANEL UNLI DIKUNCI', ['Command /unli sekarang terkunci!', 'Gunakan /unlockunli untuk membuka.']), { parse_mode: 'HTML' });
});
bot.command('unlockunli', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(eBox('⛔ AKSES DITOLAK', ['Hanya Owner!']), { parse_mode: 'HTML' });
  lockState.unli = false;
  addActivityLog(ctx.from.id, ctx.from.username, 'UNLOCKUNLI', 'Unlocked');
  return ctx.reply(eBox('🔓 PANEL UNLI DIBUKA', ['Command /unli sekarang aktif kembali!']), { parse_mode: 'HTML' });
});
bot.command('lockadp', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(eBox('⛔ AKSES DITOLAK', ['Hanya Owner!']), { parse_mode: 'HTML' });
  lockState.adp = true;
  addActivityLog(ctx.from.id, ctx.from.username, 'LOCKADP', 'Locked');
  return ctx.reply(eBox('🔒 PANEL ADP DIKUNCI', ['Command /cadp & /cadmin sekarang terkunci!', 'Gunakan /unlockadp untuk membuka.']), { parse_mode: 'HTML' });
});
bot.command('unlockadp', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(eBox('⛔ AKSES DITOLAK', ['Hanya Owner!']), { parse_mode: 'HTML' });
  lockState.adp = false;
  addActivityLog(ctx.from.id, ctx.from.username, 'UNLOCKADP', 'Unlocked');
  return ctx.reply(eBox('🔓 PANEL ADP DIBUKA', ['Command /cadp & /cadmin sekarang aktif kembali!']), { parse_mode: 'HTML' });
});

bot.command('log', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(eBox('⛔ AKSES DITOLAK', ['Hanya Owner!']), { parse_mode: 'HTML' });
  if (!activityLog.length) return ctx.reply(eBox('📭 LOG KOSONG', ['Belum ada aktivitas yang tercatat.']), { parse_mode: 'HTML' });
  const recent = activityLog.slice(-20).reverse();
  const lines = recent.map(l => `[${l.timestamp}] ${l.username} (${l.userId})\n  » ${l.action}: ${l.detail}`);
  const caption = eBox(`📋 LOG ACTIVITY (${activityLog.length})`, lines.slice(0, 15));
  return ctx.reply(caption, { parse_mode: 'HTML' });
});

bot.command('config', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(eBox('⛔ AKSES DITOLAK', ['Hanya Owner!']), { parse_mode: 'HTML' });
  const roles = db.getAllRoles();
  const tierCount = {};
  Object.values(roles).forEach(u => {
    const def = ROLE_DEFINITIONS[u.role];
    if (def) tierCount[def.tier] = (tierCount[def.tier] || 0) + 1;
  });
  const servers = getActiveServers();
  const ovr = fbRead(CONFIG_OVERRIDE_FILE, {});
  const cdMs = ovr.rateLimitMs || RATE_LIMIT_MS;
  const cdMin = Math.round(cdMs / 60000);
  const caption = eMulti([
    {
      title: '⚙️ KONFIGURASI BOT',
      lines: [
        `Owner ID    ┈ <code>${config.ownerId || '-'}</code>`,
        `Bot Name    ┈ ${htmlEscape(config.botName || 'Cpanel Jayss X HanzPiw')}`,
        `Server Aktif┈ ${servers.length}/5`,
        `Cooldown    ┈ ${cdMin} menit`,
        `Timezone    ┈ ${config.timezone || 'Asia/Jakarta'}`,
      ]
    },
    {
      title: '👥 DISTRIBUSI ROLE',
      lines: Object.entries(tierCount).map(([t, c]) => `${TIER_LABELS[t] || t} ┈ ${c} user`).concat([`Total ┈ ${Object.values(roles).length} user`])
    },
    {
      title: '🔒 STATUS LOCK',
      lines: [
        `/unli ┈ ${lockState.unli ? '🔒 Terkunci' : '🔓 Terbuka'}`,
        `/adp  ┈ ${lockState.adp  ? '🔒 Terkunci' : '🔓 Terbuka'}`,
      ]
    },
  ]);
  return ctx.reply(caption, { parse_mode: 'HTML' });
});

const autocpuState = { enabled: false, threshold: 80, interval: 60 };
let autocpuTimer = null;

async function runAutoCpuCheck() {
  const servers = getActiveServers();
  if (!servers.length) return;
  const sv = servers[0];
  try {
    const res = await fetch(`${cleanDomain(sv.domain)}/api/application/servers?per_page=1000`, {
      headers: { Authorization: `Bearer ${sv.plta}` }
    });
    const data = await res.json();
    const list = data?.data || [];
    for (const s of list) {
      const uuid = s.attributes?.uuid;
      const sId  = s.attributes?.id;
      const sName= s.attributes?.name;
      if (!uuid) continue;
      try {
        const rRes = await fetch(`${cleanDomain(sv.domain)}/api/client/servers/${uuid}/resources`, {
          headers: { Authorization: `Bearer ${sv.pltc}` }
        });
        const rData = await rRes.json();
        const cpu = parseFloat(rData?.attributes?.cpu_percentage || 0);
        if (cpu > autocpuState.threshold) {
          await fetch(`${cleanDomain(sv.domain)}/api/client/servers/${uuid}/power`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${sv.pltc}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ signal: 'stop' })
          });
          const ownerChatId = config.ownerId || config.ownerChannelId;
          if (ownerChatId) {
            await bot.telegram.sendMessage(ownerChatId,
              eBox('⚠️ AUTO CPU STOP', [`Server: <b>${htmlEscape(sName)}</b> (ID: ${sId})`, `CPU: <b>${cpu.toFixed(1)}%</b> melewati threshold ${autocpuState.threshold}%`, 'Server otomatis di-STOP!']),
              { parse_mode: 'HTML' }
            );
          }
          addActivityLog(0, 'AUTOCPU', 'STOP', `Server ${sName} CPU ${cpu.toFixed(1)}%`);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

bot.command('autocpu', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(eBox('⛔ AKSES DITOLAK', ['Hanya Owner!']), { parse_mode: 'HTML' });
  const args = ctx.message.text.split(/\s+/).slice(1);
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === 'status') {
    return ctx.reply(eBox('⚙️ AUTOCPU SETTINGS', [
      `Status    ┈ ${autocpuState.enabled ? '🟢 Aktif' : '🔴 Nonaktif'}`,
      `Threshold ┈ <b>${autocpuState.threshold}%</b>`,
      `Interval  ┈ <b>${autocpuState.interval} detik</b>`,
      '',
      '<b>Usage:</b>',
      '/autocpu on       ─ aktifkan',
      '/autocpu off      ─ nonaktifkan',
      '/autocpu threshold 80',
      '/autocpu interval 60',
      '/autocpu report   ─ laporan sekarang',
    ]), { parse_mode: 'HTML' });
  }
  if (sub === 'on') {
    autocpuState.enabled = true;
    if (autocpuTimer) clearInterval(autocpuTimer);
    autocpuTimer = setInterval(runAutoCpuCheck, autocpuState.interval * 1000);
    addActivityLog(ctx.from.id, ctx.from.username, 'AUTOCPU_ON', '');
    return ctx.reply(eBox('✅ AUTOCPU DIAKTIFKAN', [`Threshold: ${autocpuState.threshold}%`, `Interval : ${autocpuState.interval}s`]), { parse_mode: 'HTML' });
  }
  if (sub === 'off') {
    autocpuState.enabled = false;
    if (autocpuTimer) { clearInterval(autocpuTimer); autocpuTimer = null; }
    addActivityLog(ctx.from.id, ctx.from.username, 'AUTOCPU_OFF', '');
    return ctx.reply(eBox('🔴 AUTOCPU DINONAKTIFKAN', ['AutoCPU berhasil dimatikan.']), { parse_mode: 'HTML' });
  }
  if (sub === 'threshold') {
    const val = parseInt(args[1]);
    if (!val || isNaN(val) || val < 1 || val > 100) return ctx.reply('❌ Masukkan angka 1-100', { parse_mode: 'HTML' });
    autocpuState.threshold = val;
    return ctx.reply(eBox('✅ THRESHOLD DIUBAH', [`Threshold CPU baru: <b>${val}%</b>`]), { parse_mode: 'HTML' });
  }
  if (sub === 'interval') {
    const val = parseInt(args[1]);
    if (!val || isNaN(val) || val < 10) return ctx.reply('❌ Minimal 10 detik', { parse_mode: 'HTML' });
    autocpuState.interval = val;
    if (autocpuState.enabled && autocpuTimer) {
      clearInterval(autocpuTimer);
      autocpuTimer = setInterval(runAutoCpuCheck, val * 1000);
    }
    return ctx.reply(eBox('✅ INTERVAL DIUBAH', [`Interval AutoCPU baru: <b>${val} detik</b>`]), { parse_mode: 'HTML' });
  }
  if (sub === 'report') {
    await ctx.reply(eBox('📊 AUTOCPU REPORT', ['Mengambil data CPU semua server...']), { parse_mode: 'HTML' });
    await runAutoCpuCheck();
    return ctx.reply(eBox('✅ REPORT SELESAI', ['Laporan CPU berhasil dikirim!']), { parse_mode: 'HTML' });
  }
  return ctx.reply(eBox('❓ AUTOCPU HELP', ['/autocpu on|off|threshold N|interval N|report|status']), { parse_mode: 'HTML' });
});

async function fetchWithFallback(urls, opts = {}) {
  for (const url of urls) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
      if (r.ok) return r;
    } catch (_) {}
  }
  return null;
}

bot.command('hardenc', async (ctx) => {
  const reply = ctx.message?.reply_to_message;
  if (!reply?.document?.file_name?.endsWith('.js')) {
    return ctx.reply(eBox('❌ HARDENC', ['Reply file .js terlebih dahulu!', 'Contoh: reply file JS lalu ketik /hardenc']), { parse_mode: 'HTML' });
  }
  const fileId   = reply.document.file_id;
  const fileName = reply.document.file_name;
  await ctx.reply(eBox('🔒 HARD ENCRYPT', ['Memproses enkripsi file JS...']), { parse_mode: 'HTML' });
  try {
    const fileLink = await bot.telegram.getFileLink(fileId);
    const res = await fetch(fileLink.href);
    let code = await res.text();

    code = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const reserved = new Set(['require','module','exports','console','process','Buffer','setInterval','setTimeout','clearInterval','clearTimeout','Promise','JSON','Math','Date','Array','Object','String','Number','Boolean','Error','RegExp','Map','Set','global','globalThis']);
    const varReg = /\b(let|var|const|function)\s+(\w+)/g;
    const rmap = {};
    let m;
    const genId = () => '_0x' + Math.random().toString(16).slice(2, 10);
    while ((m = varReg.exec(code)) !== null) {
      if (!rmap[m[2]] && !reserved.has(m[2]) && m[2].length > 1) rmap[m[2]] = genId();
    }
    for (const [k, v] of Object.entries(rmap)) code = code.replace(new RegExp(`\\b${k}\\b`, 'g'), v);
    code = code.replace(/\s{2,}/g, ' ').replace(/\n/g, '').replace(/; /g, ';').replace(/ \{/g, '{').replace(/\{ /g, '{').replace(/ \}/g, '}');

    const banner = `// ══════════════════════════════════\n// 🔒 HARD ENCRYPT BY HanzPiw Cpanel\n// 📁 File: ${fileName}\n// ══════════════════════════════════\n\n`;
    const tmpPath = `/tmp/HENC-${Date.now()}-${fileName}`;
    fs.writeFileSync(tmpPath, banner + code);
    await ctx.replyWithDocument({ source: tmpPath, filename: `HARD-BY-HANZ-${fileName}` }, { caption: eBox('✅ ENKRIPSI BERHASIL', [`File: <code>${fileName}</code>`, 'Hard Encrypt by HanzPiw Cpanel']), parse_mode: 'HTML' });
    fs.unlinkSync(tmpPath);
    addActivityLog(ctx.from.id, ctx.from.username, 'HARDENC', `File: ${fileName}`);
  } catch (e) {
    return ctx.reply(eBox('❌ HARDENC GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('openenc', async (ctx) => {
  const reply = ctx.message?.reply_to_message;
  if (!reply?.document?.file_name?.endsWith('.js')) {
    return ctx.reply(eBox('❌ OPENENC', ['Reply file .js terlebih dahulu!']), { parse_mode: 'HTML' });
  }
  const fileId   = reply.document.file_id;
  const fileName = reply.document.file_name;
  await ctx.reply(eBox('🔓 OPEN ENCRYPT', ['Memproses deobfuscate file JS...']), { parse_mode: 'HTML' });
  try {
    const fileLink = await bot.telegram.getFileLink(fileId);
    const res = await fetch(fileLink.href);
    let code = await res.text();
    code = code.replace(/var\s+_[a-zA-Z0-9]+\s*=\s*function\s*\(\)\s*\{[\s\S]*?\}\s*\)?;?/g, '');
    code = code.replace(/globalThis\./g, '');
    code = code.replace(/;/g, ';\n').replace(/\{/g, '{\n').replace(/\}/g, '\n}').replace(/\n\s*\n/g, '\n');
    code = code.replace(/[\u200B-\u200D\uFEFF]/g, '');

    const banner = `// ══════════════════════════════════\n// 🔓 OPEN ENCRYPT BY HanzPiw Cpanel\n// 📁 File: ${fileName}\n// ══════════════════════════════════\n\n`;
    const tmpPath = `/tmp/OENC-${Date.now()}-${fileName}`;
    fs.writeFileSync(tmpPath, banner + code);
    await ctx.replyWithDocument({ source: tmpPath, filename: `OPEN-BY-HANZ-${fileName}` }, { caption: eBox('✅ DEOBFUSCATE BERHASIL', [`File: <code>${fileName}</code>`, 'Open Encrypt by HanzPiw Cpanel']), parse_mode: 'HTML' });
    fs.unlinkSync(tmpPath);
    addActivityLog(ctx.from.id, ctx.from.username, 'OPENENC', `File: ${fileName}`);
  } catch (e) {
    return ctx.reply(eBox('❌ OPENENC GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('getcode', async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1);
  const url  = args[0]?.trim();
  if (!url) return ctx.reply(eBox('❌ GETCODE', ['/getcode url', 'Contoh: /getcode https://example.com']), { parse_mode: 'HTML' });

  await ctx.reply(eBox('📥 GETCODE', ['Mengambil source code website...']), { parse_mode: 'HTML' });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    const html = await res.text();
    const domain = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const tmpPath = `/tmp/getcode-${Date.now()}-${domain}.html`;
    fs.writeFileSync(tmpPath, html);
    await ctx.replyWithDocument(
      { source: tmpPath, filename: `${domain}.html` },
      { caption: eBox('✅ GETCODE BERHASIL', [`Domain: <code>${domain}</code>`, `Size: ${(html.length/1024).toFixed(1)} KB`]), parse_mode: 'HTML' }
    );
    fs.unlinkSync(tmpPath);
    addActivityLog(ctx.from.id, ctx.from.username, 'GETCODE', `URL: ${url}`);
  } catch (e) {
    return ctx.reply(eBox('❌ GETCODE GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('checkdomain', async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1);
  let url  = args[0]?.trim();
  if (!url) return ctx.reply(eBox('❌ CHECKDOMAIN', ['/checkdomain url', 'Contoh: /checkdomain https://example.com']), { parse_mode: 'HTML' });
  if (!url.startsWith('http')) url = 'https://' + url;

  await ctx.reply(eBox('🔍 CHECKDOMAIN', ['Mengecek domain...']), { parse_mode: 'HTML' });
  try {
    const start = Date.now();
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000), redirect: 'follow' });
    const ms  = Date.now() - start;
    const domain = new URL(url).hostname;
    const lines = [
      `Domain  ┈ <code>${domain}</code>`,
      `Status  ┈ <b>${res.status} ${res.statusText}</b>`,
      `Ping    ┈ <b>${ms}ms</b>`,
      `Online  ┈ ${res.ok ? '✅ Ya' : '⚠️ HTTP Error'}`,
    ];
    const server = res.headers.get('server');
    if (server) lines.push(`Server  ┈ ${htmlEscape(server)}`);
    return ctx.reply(eBox('✅ CHECKDOMAIN RESULT', lines), { parse_mode: 'HTML' });
  } catch (e) {
    return ctx.reply(eBox('❌ DOMAIN TIDAK BISA DIAKSES', [`URL: ${htmlEscape(url)}`, `Error: ${e.message}`]), { parse_mode: 'HTML' });
  }
});

bot.command('tiktok', async (ctx) => {
  const url = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!url) return ctx.reply(eBox('❌ TIKTOK', ['/tiktok url', 'Contoh: /tiktok https://vm.tiktok.com/xxx']), { parse_mode: 'HTML' });
  await ctx.reply(eBox('📥 TIKTOK', ['Mengunduh dari TikTok...']), { parse_mode: 'HTML' });
  try {
    const apiRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(20000) });
    const data = await apiRes.json();
    if (data.code !== 0 || !data.data) return ctx.reply(eBox('❌ GAGAL', ['URL TikTok tidak valid atau error API.']), { parse_mode: 'HTML' });
    const v = data.data;
    const videoUrl = v.play || v.hdplay || v.wmplay;
    if (!videoUrl) return ctx.reply(eBox('❌ GAGAL', ['Tidak ada link video.']), { parse_mode: 'HTML' });

    const caption = eBox('✅ TIKTOK DOWNLOAD', [
      `Title   ┈ ${htmlEscape((v.title || '').slice(0, 60))}`,
      `Author  ┈ @${htmlEscape(v.author?.unique_id || '?')}`,
      `Views   ┈ ${v.play_count || 'N/A'}`,
      `Likes   ┈ ${v.digg_count || 'N/A'}`,
    ]);
    await ctx.replyWithVideo({ url: videoUrl }, { caption, parse_mode: 'HTML' });
    addActivityLog(ctx.from.id, ctx.from.username, 'TIKTOK', url);
  } catch (e) {
    return ctx.reply(eBox('❌ TIKTOK GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('instagram', async (ctx) => {
  const url = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!url) return ctx.reply(eBox('❌ INSTAGRAM', ['/instagram url', 'Contoh: /instagram https://www.instagram.com/reel/...']), { parse_mode: 'HTML' });
  await ctx.reply(eBox('📥 INSTAGRAM', ['Mengunduh media dari Instagram...']), { parse_mode: 'HTML' });
  try {
    const apis = [
      `https://api.vreden.web.id/api/igdl?url=${encodeURIComponent(url)}`,
      `https://api.ryzendesu.vip/api/downloader/igdl?url=${encodeURIComponent(url)}`,
    ];
    let mediaUrl = null;
    for (const api of apis) {
      try {
        const r = await fetch(api, { signal: AbortSignal.timeout(15000) });
        const d = await r.json();
        const result = d.result;
        if (Array.isArray(result) && result.length > 0) { mediaUrl = result[0].url || result[0]; break; }
        if (result?.url) { mediaUrl = result.url; break; }
      } catch (_) {}
    }
    if (!mediaUrl) return ctx.reply(eBox('❌ GAGAL', ['Media tidak ditemukan, coba lagi nanti.']), { parse_mode: 'HTML' });
    const caption = eBox('✅ INSTAGRAM DOWNLOAD', ['Media berhasil diunduh!', `URL: <code>${htmlEscape(url.slice(0, 50))}</code>`]);
    await ctx.replyWithVideo({ url: mediaUrl }, { caption, parse_mode: 'HTML' }).catch(async () => {
      await ctx.replyWithPhoto({ url: mediaUrl }, { caption, parse_mode: 'HTML' });
    });
    addActivityLog(ctx.from.id, ctx.from.username, 'INSTAGRAM', url);
  } catch (e) {
    return ctx.reply(eBox('❌ INSTAGRAM GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('tourl', async (ctx) => {
  const reply = ctx.message?.reply_to_message;
  const doc   = reply?.document || (reply?.photo ? { file_id: reply.photo.at(-1).file_id, file_name: 'image.jpg' } : null)
             || (reply?.video   ? { file_id: reply.video.file_id,   file_name: reply.video.file_name   || 'video.mp4' } : null)
             || (reply?.audio   ? { file_id: reply.audio.file_id,   file_name: reply.audio.file_name   || 'audio.mp3' } : null);
  if (!doc) return ctx.reply(eBox('❌ TOURL', ['Reply file/foto/video/audio terlebih dahulu!']), { parse_mode: 'HTML' });

  await ctx.reply(eBox('📤 UPLOAD', ['Mengupload ke Catbox.moe...']), { parse_mode: 'HTML' });
  try {
    const fileLink = await bot.telegram.getFileLink(doc.file_id);
    const fileRes  = await fetch(fileLink.href);
    const buffer   = Buffer.from(await fileRes.arrayBuffer());
    const boundary = `---${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${doc.file_name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upRes = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(60000),
    });
    const result = (await upRes.text()).trim();
    if (!result.startsWith('http')) return ctx.reply(eBox('❌ UPLOAD GAGAL', [result || 'Catbox menolak file']), { parse_mode: 'HTML' });
    addActivityLog(ctx.from.id, ctx.from.username, 'TOURL', `${doc.file_name} -> ${result}`);
    return ctx.reply(eBox('✅ UPLOAD BERHASIL (CATBOX)', [`File : <code>${htmlEscape(doc.file_name)}</code>`, `URL  : ${htmlEscape(result)}`]), { parse_mode: 'HTML' });
  } catch (e) {
    return ctx.reply(eBox('❌ TOURL GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('tourlv2', async (ctx) => {
  const reply = ctx.message?.reply_to_message;
  const doc   = reply?.document || (reply?.photo ? { file_id: reply.photo.at(-1).file_id, file_name: 'image.jpg' } : null)
             || (reply?.video   ? { file_id: reply.video.file_id,   file_name: reply.video.file_name   || 'video.mp4' } : null)
             || (reply?.audio   ? { file_id: reply.audio.file_id,   file_name: reply.audio.file_name   || 'audio.mp3' } : null);
  if (!doc) return ctx.reply(eBox('❌ TOURLV2', ['Reply file/foto/video/audio terlebih dahulu!']), { parse_mode: 'HTML' });

  await ctx.reply(eBox('📤 UPLOAD V2', ['Mengupload ke Uguu.se...']), { parse_mode: 'HTML' });
  try {
    const fileLink = await bot.telegram.getFileLink(doc.file_id);
    const fileRes  = await fetch(fileLink.href);
    const buffer   = Buffer.from(await fileRes.arrayBuffer());
    const boundary = `---${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files[]"; filename="${doc.file_name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upRes = await fetch('https://uguu.se/upload.php', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(60000),
    });
    const data = await upRes.json();
    const fileUrl = data?.files?.[0]?.url;
    if (!fileUrl) return ctx.reply(eBox('❌ UPLOAD GAGAL', ['Uguu menolak file.']), { parse_mode: 'HTML' });
    addActivityLog(ctx.from.id, ctx.from.username, 'TOURLV2', `${doc.file_name} -> ${fileUrl}`);
    return ctx.reply(eBox('✅ UPLOAD BERHASIL (UGUU)', [`File : <code>${htmlEscape(doc.file_name)}</code>`, `URL  : ${htmlEscape(fileUrl)}`]), { parse_mode: 'HTML' });
  } catch (e) {
    return ctx.reply(eBox('❌ TOURLV2 GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('bypassurl', async (ctx) => {
  const url = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!url) return ctx.reply(eBox('❌ BYPASSURL', ['/bypassurl url', 'Contoh: /bypassurl https://sfl.gl/xxxx']), { parse_mode: 'HTML' });
  await ctx.reply(eBox('🔄 BYPASS URL', ['Mem-bypass URL...']), { parse_mode: 'HTML' });
  try {
    const apis = [
      `https://bintangapi.my.id/api/tools/bypassurl2?url=${encodeURIComponent(url)}`,
      `https://api.vreden.web.id/api/bypass?url=${encodeURIComponent(url)}`,
    ];
    let result = null;
    for (const api of apis) {
      try {
        const r = await fetch(api, { signal: AbortSignal.timeout(15000) });
        const d = await r.json();
        result = d.result || d.bypassed;
        if (result) break;
      } catch (_) {}
    }
    if (!result) return ctx.reply(eBox('⚠️ BYPASS GAGAL', ['Server API sibuk, coba lagi nanti.', `Original: ${htmlEscape(url)}`]), { parse_mode: 'HTML' });
    addActivityLog(ctx.from.id, ctx.from.username, 'BYPASSURL', `${url} -> ${result}`);
    return ctx.reply(eBox('✅ BYPASS BERHASIL', [`Original ┈ <code>${htmlEscape(url)}</code>`, `Result   ┈ ${htmlEscape(result)}`]), { parse_mode: 'HTML' });
  } catch (e) {
    return ctx.reply(eBox('❌ BYPASSURL GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('generateimage', async (ctx) => {
  const prompt = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!prompt) return ctx.reply(eBox('❌ GENERATEIMAGE', ['/generateimage prompt', 'Contoh: /generateimage kucing lucu']), { parse_mode: 'HTML' });
  await ctx.reply(eBox('🎨 GENERATE IMAGE', [`Prompt: ${htmlEscape(prompt)}`, 'Sedang membuat gambar AI...']), { parse_mode: 'HTML' });
  try {
    const seed = Math.floor(Math.random() * 999999);
    const imgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;
    const caption = eBox('✅ IMAGE BERHASIL DIBUAT', [`Prompt: ${htmlEscape(prompt)}`, 'Dibuat oleh HanzPiw Cpanel AI']);
    await ctx.replyWithPhoto({ url: imgUrl }, { caption, parse_mode: 'HTML' });
    addActivityLog(ctx.from.id, ctx.from.username, 'GENERATEIMAGE', prompt);
  } catch (e) {
    return ctx.reply(eBox('❌ GENERATEIMAGE GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('promt', async (ctx) => {
  const text = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!text) return ctx.reply(eBox('❌ PROMT', ['/promt text', 'Contoh: /promt kucing tidur']), { parse_mode: 'HTML' });
  await ctx.reply(eBox('🤖 GENERATE PROMPT', [`Input: ${htmlEscape(text)}`, 'Sedang generating...']), { parse_mode: 'HTML' });
  try {
    const r = await fetch(`https://api.ryzendesu.vip/api/ai/midjourney-prompt?prompt=${encodeURIComponent(text)}`, { signal: AbortSignal.timeout(20000) });
    const d = await r.json();
    const result = d.prompt || d.result || `${text}, ultra detailed, photorealistic 8k, golden ratio, studio lights, award winning, masterpiece style`;
    addActivityLog(ctx.from.id, ctx.from.username, 'PROMT', text);
    return ctx.reply(eBox('✅ PROMPT BERHASIL', [`Input  ┈ ${htmlEscape(text)}`, `Result ┈ ${htmlEscape(String(result).slice(0, 300))}`]), { parse_mode: 'HTML' });
  } catch (e) {
    const fallback = `${text}, ultra detailed, photorealistic 8k, golden ratio, studio lights`;
    return ctx.reply(eBox('✅ PROMPT (FALLBACK)', [htmlEscape(fallback)]), { parse_mode: 'HTML' });
  }
});

bot.command('carbon', async (ctx) => {
  const reply = ctx.message?.reply_to_message;
  let code = reply?.text || reply?.caption;
  if (!code && reply?.document) {
    try {
      const fl = await bot.telegram.getFileLink(reply.document.file_id);
      const r  = await fetch(fl.href);
      code = await r.text();
    } catch (_) {}
  }
  if (!code) return ctx.reply(eBox('❌ CARBON', ['Reply text/kode dengan /carbon', 'Akan dikonversi ke gambar Carbon estetis!']), { parse_mode: 'HTML' });
  await ctx.reply(eBox('🎨 CARBON', ['Membuat gambar Carbon...']), { parse_mode: 'HTML' });
  try {
    const r = await fetch('https://carbonara.solopov.dev/api/cook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`API error ${r.status}`);
    const imgBuf = Buffer.from(await r.arrayBuffer());
    const tmpPath = `/tmp/carbon-${Date.now()}.png`;
    fs.writeFileSync(tmpPath, imgBuf);
    await ctx.replyWithPhoto({ source: tmpPath }, { caption: eBox('✅ CARBON SELESAI', ['Code berhasil dijadikan gambar Carbon!']), parse_mode: 'HTML' });
    fs.unlinkSync(tmpPath);
    addActivityLog(ctx.from.id, ctx.from.username, 'CARBON', `${code.length} chars`);
  } catch (e) {
    return ctx.reply(eBox('❌ CARBON GAGAL', [e.message || 'API Carbon tidak tersedia']), { parse_mode: 'HTML' });
  }
});

bot.command('ytmp4', async (ctx) => {
  const url = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!url) return ctx.reply(eBox('❌ YTMP4', ['/ytmp4 url_youtube', 'Contoh: /ytmp4 https://youtube.com/watch?v=...']), { parse_mode: 'HTML' });
  await ctx.reply(eBox('📥 YTMP4', ['Memproses download YouTube...']), { parse_mode: 'HTML' });
  try {
    const apis = [
      `https://api.vreden.web.id/api/ytmp4?url=${encodeURIComponent(url)}`,
      `https://api.ryzendesu.vip/api/downloader/ytmp4?url=${encodeURIComponent(url)}`,
    ];
    let fileUrl = null;
    for (const api of apis) {
      try {
        const r = await fetch(api, { signal: AbortSignal.timeout(20000) });
        const d = await r.json();
        fileUrl = d?.result?.url || d?.download?.url || d?.url;
        if (fileUrl) break;
      } catch (_) {}
    }
    if (!fileUrl) return ctx.reply(eBox('❌ YTMP4 GAGAL', ['Link download tidak ditemukan.']), { parse_mode: 'HTML' });
    const caption = eBox('✅ YTMP4 BERHASIL', [`Video siap! Jika tidak terkirim, download manual:`, htmlEscape(fileUrl)]);
    await ctx.replyWithVideo({ url: fileUrl }, { caption, parse_mode: 'HTML' }).catch(async () => {
      await ctx.reply(eBox('⚠️ YTMP4 LINK', [`Download manual: ${htmlEscape(fileUrl)}`]), { parse_mode: 'HTML' });
    });
    addActivityLog(ctx.from.id, ctx.from.username, 'YTMP4', url);
  } catch (e) {
    return ctx.reply(eBox('❌ YTMP4 GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('play', async (ctx) => {
  const query = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!query) return ctx.reply(eBox('❌ PLAY', ['/play nama_lagu', 'Contoh: /play Alan Walker Faded']), { parse_mode: 'HTML' });
  await ctx.reply(eBox('🎵 PLAY', [`Mencari: ${htmlEscape(query)}`]), { parse_mode: 'HTML' });
  try {
    const r = await fetch(`https://api.vreden.web.id/api/ytsearch?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    const video = d?.result?.[0] || d?.videos?.[0];
    if (!video) return ctx.reply(eBox('❌ PLAY', ['Lagu tidak ditemukan!']), { parse_mode: 'HTML' });
    const lines = [
      `Title    ┈ ${htmlEscape((video.title || video.name || '?').slice(0, 60))}`,
      `Author   ┈ ${htmlEscape(video.author?.name || video.channel || '?')}`,
      `Duration ┈ ${video.duration?.timestamp || video.duration || 'N/A'}`,
      `Views    ┈ ${video.views || video.view_count || 'N/A'}`,
      `URL      ┈ ${htmlEscape(video.url || video.link || '?')}`,
    ];
    const ytUrl = video.url || video.link;
    const dlUrl = ytUrl ? `https://api.vreden.web.id/api/ytmp3?url=${encodeURIComponent(ytUrl)}` : null;
    return ctx.reply(eBox('🎵 MUSIK DITEMUKAN', lines), {
      parse_mode: 'HTML',
      ...(dlUrl ? Markup.inlineKeyboard([[{ text: eF('『 🎵 』 Download Audio'), url: dlUrl }]]) : {}),
    });
  } catch (e) {
    return ctx.reply(eBox('❌ PLAY GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('brainly', async (ctx) => {
  const question = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!question) return ctx.reply(eBox('❌ BRAINLY', ['/brainly pertanyaan', 'Contoh: /brainly rumus luas segitiga']), { parse_mode: 'HTML' });
  await ctx.reply(eBox('📚 BRAINLY', [`Mencari jawaban: ${htmlEscape(question)}`]), { parse_mode: 'HTML' });
  try {
    const apis = [
      `https://api.vreden.web.id/api/brainly?query=${encodeURIComponent(question)}`,
      `https://api.ryzendesu.vip/api/brainly?query=${encodeURIComponent(question)}`,
    ];
    for (const api of apis) {
      try {
        const r = await fetch(api, { signal: AbortSignal.timeout(15000) });
        const d = await r.json();
        if (d.status === 'success' || d.result) {
          const answer = String(d.result?.answer || d.result || '').replace(/<[^>]*>/g, '').slice(0, 3000);
          if (answer) {
            addActivityLog(ctx.from.id, ctx.from.username, 'BRAINLY', question);
            return ctx.reply(eBox('✅ BRAINLY JAWABAN', [
              `Pertanyaan ┈ ${htmlEscape(question)}`,
              `Jawaban    ┈ ${htmlEscape(answer)}`,
            ]), { parse_mode: 'HTML' });
          }
        }
      } catch (_) {}
    }
    return ctx.reply(eBox('❌ BRAINLY', ['Jawaban tidak ditemukan untuk pertanyaan ini.']), { parse_mode: 'HTML' });
  } catch (e) {
    return ctx.reply(eBox('❌ BRAINLY GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('gimage', async (ctx) => {
  const query = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!query) return ctx.reply(eBox('❌ GIMAGE', ['/gimage query', 'Contoh: /gimage kucing lucu']), { parse_mode: 'HTML' });
  await ctx.reply(eBox('🔍 GIMAGE', [`Mencari gambar: ${htmlEscape(query)}`]), { parse_mode: 'HTML' });
  try {
    const apis = [
      `https://api.vreden.web.id/api/gimage?query=${encodeURIComponent(query)}`,
      `https://api.ryzendesu.vip/api/search/gimage?query=${encodeURIComponent(query)}`,
    ];
    for (const api of apis) {
      try {
        const r = await fetch(api, { signal: AbortSignal.timeout(12000) });
        const d = await r.json();
        if (d.status === 'success' && Array.isArray(d.result) && d.result.length > 0) {
          const imgUrl = d.result[Math.floor(Math.random() * Math.min(d.result.length, 5))];
          addActivityLog(ctx.from.id, ctx.from.username, 'GIMAGE', query);
          return ctx.replyWithPhoto({ url: imgUrl }, { caption: eBox('✅ GIMAGE RESULT', [`Pencarian: ${htmlEscape(query)}`]), parse_mode: 'HTML' });
        }
      } catch (_) {}
    }
    return ctx.reply(eBox('❌ GIMAGE', ['Gambar tidak ditemukan.']), { parse_mode: 'HTML' });
  } catch (e) {
    return ctx.reply(eBox('❌ GIMAGE GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('shorturl', async (ctx) => {
  const url = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!url) return ctx.reply(eBox('❌ SHORTURL', [
    '/shorturl <url>',
    'Contoh: /shorturl https://example.com/long/url',
    '',
    '📊 Stats: /surlstats',
  ]), { parse_mode: 'HTML' });
  const loadMsg = await ctx.reply(eBox('🔗 SHORTURL', ['⏳ Memperpendek URL...']), { parse_mode: 'HTML' });
  try {
    const apis = [
      `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
      `https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`,
    ];
    for (const api of apis) {
      try {
        const r = await fetch(api, { signal: AbortSignal.timeout(10000) });
        const t = (await r.text()).trim();
        if (t.startsWith('http')) {
          addActivityLog(ctx.from.id, ctx.from.username, 'SHORTURL', `${url} -> ${t}`);

          if (bot._trackShortUrl) {
            const key = t.split('/').pop() || t.replace(/^https?:\/\//, '');
            bot._trackShortUrl(key, url);
          }
          try { await bot.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch (_) {}
          return ctx.reply(eBox('✅ SHORTURL BERHASIL', [
            `Original ┈ <code>${htmlEscape(url.length > 60 ? url.slice(0,60)+'…' : url)}</code>`,
            `Short    ┈ <b>${htmlEscape(t)}</b>`,
            ``,
            `💡 Track clicks: /surlstats`,
          ]), { parse_mode: 'HTML' });
        }
      } catch (_) {}
    }
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch (_) {}
    return ctx.reply(eBox('❌ SHORTURL GAGAL', ['Semua API gagal, coba lagi nanti.']), { parse_mode: 'HTML' });
  } catch (e) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch (_) {}
    return ctx.reply(eBox('❌ SHORTURL GAGAL', [e.message]), { parse_mode: 'HTML' });
  }
});

bot.command('calc', async (ctx) => {
  const expr = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!expr) return ctx.reply(eBox('❌ CALC', [
    '/calc <rumus>',
    'Contoh: /calc (2+3)*5/2',
    'Contoh: /calc sqrt(144)',
    'Contoh: /calc sin(90 deg)',
    'Contoh: /calc 2^10',
  ]), { parse_mode: 'HTML' });
  try {

    const math   = require('mathjs');
    const result = math.evaluate(expr);
    const fmt    = typeof result === 'number'
      ? (Number.isInteger(result) ? result : parseFloat(result.toFixed(10)))
      : String(result);
    addActivityLog(ctx.from.id, ctx.from.username, 'CALC', `${expr} = ${fmt}`);
    return ctx.reply(eBox('🧮 HASIL PERHITUNGAN', [
      `Rumus  ┈ <code>${htmlEscape(expr)}</code>`,
      `Hasil  ┈ <b>${htmlEscape(String(fmt))}</b>`,
    ]), { parse_mode: 'HTML' });
  } catch (e) {
    return ctx.reply(eBox('❌ CALC ERROR', [
      'Rumus tidak valid atau tidak didukung.',
      `Input: <code>${htmlEscape(expr)}</code>`,
      `Error: <i>${htmlEscape(e.message.slice(0, 100))}</i>`,
    ]), { parse_mode: 'HTML' });
  }
});

const STATIC_QUOTES = [
  { q: 'Satu-satunya cara untuk melakukan pekerjaan hebat adalah dengan mencintai apa yang Anda lakukan.', a: 'Steve Jobs' },
  { q: 'Hambatan tidak bisa menghentikanmu. Jika kamu menabrak tembok, jangan berbalik dan menyerah.', a: 'Michael Jordan' },
  { q: 'Waktumu terbatas, jadi jangan sia-siakan dengan menjalani hidup orang lain.', a: 'Steve Jobs' },
  { q: 'Kegagalan adalah bumbu yang memberi rasa pada kesuksesan.', a: 'Truman Capote' },
  { q: 'Jangan takut untuk melangkah perlahan, takutlah untuk berdiri diam.', a: 'Pepatah Jepang' },
  { q: 'Orang yang berhenti belajar akan menjadi tua, baik pada usia 20 atau 80 tahun.', a: 'Henry Ford' },
  { q: 'Kesempatan tidak datang dengan sendirinya, kamu yang menciptakannya.', a: 'Chris Grosser' },
  { q: 'Jadilah dirimu sendiri, karena semua orang sudah diambil.', a: 'Oscar Wilde' },
  { q: 'Masa depan adalah milik mereka yang percaya pada keindahan mimpi mereka.', a: 'Eleanor Roosevelt' },
  { q: 'Code seperti humor — jika harus dijelaskan, itu tidak bagus.', a: 'Cory House' },
];

bot.command('quotes', async (ctx) => {
  let quote = STATIC_QUOTES[Math.floor(Math.random() * STATIC_QUOTES.length)];
  try {
    const r = await fetch('https://api.vreden.web.id/api/quotes', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if (d.result?.quotes) quote = { q: d.result.quotes, a: d.result.author || 'Anonim' };
  } catch (_) {}
  return ctx.reply(eBox('✍️ QUOTES HARI INI', [
    `❝ ${htmlEscape(quote.q)} ❞`,
    `— ${htmlEscape(quote.a)}`,
  ]), { parse_mode: 'HTML' });
});

function readPmUsersDb() {
  return fbRead(PM_USERS_FILE, { users: {} });
}
function savePmUsersDb(data) {
  fbWrite(PM_USERS_FILE, data);
}
function getPmUser(userId) {
  const db = readPmUsersDb();
  return db.users[String(userId)] || null;
}
function setPmUser(userId, role, divisi, setBy) {
  const db = readPmUsersDb();
  db.users[String(userId)] = {
    userId: String(userId),
    role,
    divisi,
    setBy: String(setBy),
    setAt: new Date().toISOString(),
  };
  savePmUsersDb(db);
  return db.users[String(userId)];
}

const STORAN_SCORE = {
  addrole:    +2,
  broadcast:  +1,
  ai_detect:  +2,
  delrole:    +1,
  resetguest: +1,
  blacklist:  +1,
  ban:        +1,
};

function readStoranDb() {
  return fbRead(STORAN_DB_FILE, { users: {}, logs: [], period_start: new Date().toISOString() });
}
function saveStoranDb(data) {
  fbWrite(STORAN_DB_FILE, data);
}
function storanUserEntry(sdb, userId, name) {
  const id = String(userId);
  if (!sdb.users[id]) {
    sdb.users[id] = {
      name, score: 0,
      addrole: 0, delrole: 0, broadcast: 0,
      ai_detect: 0, resetguest: 0, blacklist: 0, ban: 0,
      last_active: null, period_start: sdb.period_start,
    };
  } else if (name) {
    sdb.users[id].name = name;
  }
  return sdb.users[id];
}

async function addStoranEntry(actorId, actorName, type, detail = {}) {
  const gid = String(config.groupStoran || '').trim();
  if (!gid) return;

  const sdb  = readStoranDb();
  const user = storanUserEntry(sdb, actorId, actorName);
  const pts  = STORAN_SCORE[type] ?? 0;

  user.score     += pts;
  user.last_active = new Date().toISOString();
  if (user[type] !== undefined) user[type]++;

  const logEntry = {
    ts:    new Date().toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' }),
    actor: actorName,
    actorId: String(actorId),
    type,
    pts,
    detail,
  };
  sdb.logs.unshift(logEntry);
  if (sdb.logs.length > 200) sdb.logs = sdb.logs.slice(0, 200);
  saveStoranDb(sdb);

  const ptsText = pts >= 0 ? `+${pts}` : `${pts}`;
  const badge = {
    addrole:    `${'✅'} ADDROLE`,
    delrole:    `${'🗑️'} DELROLE`,
    broadcast:  `${'📣'} BROADCAST`,
    ai_detect:  `${'🧠'} AI DETECT`,
    resetguest: `${'🔄'} RESETGUEST`,
    blacklist:  `${'🚫'} BLACKLIST`,
    ban:        `${'⛔'} BAN`,
  }[type] || type.toUpperCase();

  const detailLines = Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${htmlEscape(k.padEnd(10))} ┈ ${htmlEscape(String(v))}`);

  const totalScore = user.score;
  const rankList   = buildStoranRanking(sdb);
  const myRank     = rankList.findIndex(r => r.id === String(actorId)) + 1;

  const caption = [
    `${'📊'} <b>STORAN LOG — ${badge}</b>`,
    `<code>${ptsText} poin  •  Total: ${totalScore} poin  •  Rank #${myRank}</code>`,
    '',
    '<blockquote>',
    `${'👤'} Oleh     ┈ <b>${htmlEscape(actorName)}</b> (<code>${actorId}</code>)`,
    `${'🗓️'} Waktu    ┈ ${logEntry.ts}`,
    ...detailLines,
    '</blockquote>',
  ].join('\n');

  try {
    await bot.telegram.sendMessage(gid, caption, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('[STORAN SEND ERROR]', e?.message || e);
  }
}

function buildStoranRanking(sdb) {
  return Object.entries(sdb.users)
    .map(([id, u]) => ({ id, name: u.name, score: u.score, data: u }))
    .sort((a, b) => b.score - a.score);
}

function storanLastActiveFmt(iso) {
  if (!iso) return 'Belum aktif';
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'Barusan';
  if (h < 24) return `${h} jam lalu`;
  return `${Math.floor(h / 24)} hari lalu`;
}

async function sendStoranDailyRecap() {
  const gid = String(config.groupStoran || '').trim();
  if (!gid) return;
  const sdb     = readStoranDb();
  const ranking = buildStoranRanking(sdb);
  if (!ranking.length) return;

  const now     = new Date().toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' });
  const medals  = ['🥇', '🥈', '🥉'];

  const rows = ranking.map((r, i) => {
    const m  = medals[i] || `${'📊'}`;
    const u  = r.data;
    return [
      `${m} <b>${htmlEscape(r.name)}</b> — <b>${r.score} poin</b>`,
      `   Add:${u.addrole} | BC:${u.broadcast} | AI:${u.ai_detect} | Del:${u.delrole}`,
      `   Terakhir: ${storanLastActiveFmt(u.last_active)}`,
    ].join('\n');
  });

  const caption = [
    `${'📊'} <b>REKAP HARIAN STORAN</b>`,
    `<code>${now}</code>`,
    '',
    rows.join('\n\n'),
    '',
    `<i>Total ${ranking.length} security terdaftar</i>`,
  ].join('\n');

  try {
    await bot.telegram.sendMessage(gid, caption, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('[STORAN RECAP ERROR]', e?.message || e);
  }
}

function startStoranDailyScheduler() {
  const tz   = config.timezone || 'Asia/Jakarta';
  const hour = Number(config.storanRecapHour ?? 23);
  function scheduleNext() {
    const now  = new Date();
    const next = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    next.setHours(hour, 0, 0, 0);
    if (next <= new Date(now.toLocaleString('en-US', { timeZone: tz }))) next.setDate(next.getDate() + 1);
    const diff = next.getTime() - now.getTime() + (next.getTimezoneOffset() - now.getTimezoneOffset()) * 60000;
    const msUntil = Math.max(diff, 1000);
    setTimeout(async () => {
      await sendStoranDailyRecap();
      scheduleNext();
    }, msUntil);
  }
  scheduleNext();
}

const securityInteractions = new Map();

const AI_RESOLVE_KEYWORDS = [
  'terima kasih', 'makasih', 'terimakasih', 'thanks', 'thank you', 'thank u', 'thx',
  'beres', 'kelar', 'selesai', 'solved', 'fixed', 'fix', 'done', 'berhasil',
  'udah bisa', 'udah jalan', 'udah work', 'jalan', 'works', 'worked',
  'mantap', 'mantul', 'perfect', 'sip', 'siap', 'oke fix', 'ok fix',
  'oke beres', 'ok beres', 'oke solved', 'ok solved',
];

function containsResolveKeyword(text) {
  const t = text.toLowerCase();
  return AI_RESOLVE_KEYWORDS.some(kw => t.includes(kw));
}

async function sendCekUser(ctx, targetId, targetName, targetUsername) {
  const roleInfo   = getUserRoleDisplay(targetId);
  const roleLabel  = getRoleDisplayLabel(targetId);
  const serverAccess = getServerAccessDisplay(targetId);
  const hasAccess  = hasAccessForPanel(targetId);
  const entry      = db.getRoleEntry(targetId);
  const guestDb    = readGuestPanelDb();
  const guestData  = guestDb[String(targetId)];

  const expStr = roleInfo?.expiresAt
    ? `${formatDateId(roleInfo.expiresAt)} (${formatRemainingTime(roleInfo.expiresAt)} lagi)`
    : (roleInfo ? 'Permanent ∞' : '—');

  const displayName     = targetName || (entry?.username || '—');
  const displayUsername = targetUsername || (entry?.username ? `@${entry.username}` : '—');

  const statusText = isOwner(targetId)
    ? `${'👑'} Owner Bot`
    : hasAccess
      ? `${'🟢'} Akses Panel Aktif`
      : entry
        ? `${'⚠️'} Role Aktif (Akses Terbatas)`
        : guestData
          ? `${'⚠️'} Tidak Ada Role (Trial Terpakai)`
          : `${'🔴'} Belum Di-Add Admin`;

  const trialText = guestData
    ? `${'❌'} Sudah Pakai — ${formatDateId(guestData.usedAt)}`
    : `${'✅'} Belum Digunakan`;

  const caption = eMulti([
    {
      title: `${'🔍'} INFO USER`,
      lines: [
        `ID       ┈ <code>${htmlEscape(String(targetId))}</code>`,
        `Nama     ┈ <b>${htmlEscape(displayName)}</b>`,
        `Username ┈ ${htmlEscape(displayUsername)}`,
        `Role     ┈ ${htmlEscape(roleLabel)}`,
        ...(roleInfo ? [`Tier     ┈ ${htmlEscape(roleInfo.tierLabel)}`] : []),
        `Expired  ┈ ${htmlEscape(expStr)}`,
        ...(entry?.addedAt ? [`Di-Add   ┈ ${htmlEscape(formatDateId(entry.addedAt))}`] : []),
        `Status   ┈ ${statusText}`,
        `Trial 1× ┈ ${trialText}`,
      ]
    },
    {
      title: `${'🖥️'} AKSES SERVER`,
      lines: serverAccess.map(s =>
        `V${s.index} ┈ ${s.allowed ? `${'✅'} Diberikan` : `${'❌'} Tidak Ada Akses`}`
      )
    },
    ...(guestData ? [{
      title: `${'⚠️'} DATA PANEL TAMU`,
      lines: [
        `Paket    ┈ ${htmlEscape(guestData.planKey || '-')}`,
        `Username ┈ <code>${htmlEscape(guestData.username || '-')}</code>`,
        `Server   ┈ V${htmlEscape(String(guestData.serverIndex || '-'))}`,
        `Dibuat   ┈ ${htmlEscape(formatDateId(guestData.usedAt))}`,
      ]
    }] : []),
  ]);

  return renderCard(ctx, caption, Markup.inlineKeyboard([]));
}

bot.command('cek', async (ctx) => {

  if (!isOwner(ctx.from.id) && !db.getUserRole(ctx.from.id)) {
    return ctx.reply('❌ Command ini hanya untuk admin atau user yang sudah memiliki role.', { parse_mode: 'HTML' });
  }
  try {
    let targetId = null, targetName = null, targetUsername = null;

    const replyUser = ctx.message?.reply_to_message?.from;
    if (replyUser) {
      targetId      = String(replyUser.id);
      targetName    = [replyUser.first_name, replyUser.last_name].filter(Boolean).join(' ') || null;
      targetUsername = replyUser.username ? `@${replyUser.username}` : null;
    } else {
      const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
      const arg  = args[0] || '';

      if (/^\d+$/.test(arg)) {

        targetId = arg;
      } else if (arg.length > 0) {

        const entities = ctx.message?.entities || [];
        const mentionEntity = entities.find(e => e.type === 'mention' || e.type === 'text_mention');
        if (mentionEntity) {
          if (mentionEntity.type === 'text_mention' && mentionEntity.user) {

            targetId       = String(mentionEntity.user.id);
            targetName     = [mentionEntity.user.first_name, mentionEntity.user.last_name].filter(Boolean).join(' ') || null;
            targetUsername = mentionEntity.user.username ? `@${mentionEntity.user.username}` : null;
          } else {

            const msgText   = ctx.message.text || '';
            const mentioned = msgText.substring(mentionEntity.offset, mentionEntity.offset + mentionEntity.length);
            targetUsername  = mentioned;
            const allRoles  = db.getAllRoles ? db.getAllRoles() : {};
            const found     = Object.values(allRoles).find(
              e => e.username && e.username.toLowerCase() === mentioned.replace('@', '').toLowerCase()
            );
            if (found) {
              targetId   = String(found.userId);
              targetName = found.username || null;
            } else {

              try {
                const member = await bot.telegram.getChatMember(ctx.chat.id, mentioned);
                const tgUser = member.user;
                targetId       = String(tgUser.id);
                targetName     = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || null;
                targetUsername = tgUser.username ? `@${tgUser.username}` : mentioned;
              } catch (_) {

                return await sendInfoNotFound(ctx, mentioned);
              }
            }
          }
        } else {

          const cleanArg = arg.replace('@', '');
          const allRoles = db.getAllRoles ? db.getAllRoles() : {};
          const found    = Object.values(allRoles).find(
            e => e.username && e.username.toLowerCase() === cleanArg.toLowerCase()
          );
          if (found) {
            targetId       = String(found.userId);
            targetUsername = `@${cleanArg}`;
            targetName     = found.username || null;
          } else if (arg.startsWith('@')) {

            try {
              const member = await bot.telegram.getChatMember(ctx.chat.id, arg);
              const tgUser = member.user;
              targetId       = String(tgUser.id);
              targetName     = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || null;
              targetUsername = tgUser.username ? `@${tgUser.username}` : arg;
            } catch (_) {
              return await sendInfoNotFound(ctx, arg);
            }
          }
        }
      }
    }

    if (!targetId) {
      return await ctx.reply(
        eBox(`${'🔍'} CEK USER`, [
          'Format:',
          `• /cek @username`,
          `• /cek 123456789`,
          `• Reply ke pesan user lalu ketik /cek`,
          '',
          `Contoh: /cek @itshanzpiw`,
        ]),
        { parse_mode: 'HTML' }
      );
    }

    await sendCekUser(ctx, targetId, targetName, targetUsername);
  } catch (e) {
    console.error('[CEK ERROR]', e);
    await ctx.reply('❌ Gagal mengambil info user.', { parse_mode: 'HTML' });
  }
});

bot.command('resetguest', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const targetId = resolveTargetUserId(ctx, args);
  if (!targetId) {
    return ctx.reply(
      '❌ Format: <code>/resetguest userId</code> atau reply ke user\nContoh: <code>/resetguest 12345678</code>',
      { parse_mode: 'HTML' }
    );
  }
  const reset = resetGuestPanel(targetId);
  await ctx.reply(
    reset
      ? `✅ Jatah panel tamu user <code>${htmlEscape(targetId)}</code> berhasil direset.\n<i>User sekarang bisa membuat 1× panel tamu lagi.</i>`
      : `❌ User <code>${htmlEscape(targetId)}</code> tidak memiliki data panel tamu.`,
    { parse_mode: 'HTML' }
  );

  if (reset) {
    const actorName = USERS_SECURITY[String(ctx.from.id)];
    if (actorName) {
      addStoranEntry(ctx.from.id, actorName, 'resetguest', {
        'Target ID': targetId,
      });
    }
  }
});

bot.command('storan', async (ctx) => {
  const isSecurity = db.getUserRole(ctx.from.id) === 'security';
  if (!isOwner(ctx.from.id) && !isSecurity) return ctx.reply(`${'❌'} Command ini hanya untuk owner dan security.`, { parse_mode: 'HTML' });
  const sdb     = readStoranDb();
  const ranking = buildStoranRanking(sdb);

  const replyUser = ctx.message?.reply_to_message?.from;
  const args      = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const arg0      = args[0] || '';
  let targetId    = null;

  if (replyUser) {
    targetId = String(replyUser.id);
  } else if (/^\d+$/.test(arg0)) {
    targetId = arg0;
  } else if (arg0.startsWith('@')) {
    const uname = arg0.replace('@', '').toLowerCase();
    const found = Object.entries(USERS_SECURITY).find(([, name]) =>
      name.toLowerCase().replace(/\s/g, '') === uname
    );
    if (found) targetId = found[0];
  }

  if (targetId) {

    const u = sdb.users[String(targetId)];
    if (!u) return ctx.reply(`${'❌'} User <code>${htmlEscape(targetId)}</code> belum ada di data storan.`, { parse_mode: 'HTML' });

    const rank     = ranking.findIndex(r => r.id === String(targetId)) + 1;
    const medals   = ['🥇', '🥈', '🥉'];
    const medalBadge = medals[rank - 1] || '📊';

    const myLogs = sdb.logs.filter(l => l.actorId === String(targetId)).slice(0, 5);
    const logLines = myLogs.map(l => {
      const d = Object.values(l.detail || {}).join(' • ');
      return `• ${l.ts} — <b>${l.type.toUpperCase()}</b> ${d ? `[${htmlEscape(d)}]` : ''}`;
    });

    const caption = eMulti([
      {
        title: `${medalBadge} STORAN DETAIL — ${htmlEscape(u.name)}`,
        lines: [
          `ID            ┈ <code>${targetId}</code>`,
          `Total Poin    ┈ <b>${u.score}</b>`,
          `Rank          ┈ <b>#${rank}</b> dari ${ranking.length} security`,
          `Terakhir Aktif┈ ${storanLastActiveFmt(u.last_active)}`,
          `Periode Mulai ┈ ${formatDateId(u.period_start)}`,
        ]
      },
      {
        title: `${'📊'} RINCIAN AKSI`,
        lines: [
          `${'✅'}  Addrole    ┈ ${u.addrole}× (+${u.addrole * 2} poin)`,
          `${'🗑️'}  Delrole    ┈ ${u.delrole}× (+${u.delrole * 1} poin)`,
          `${'📣'}   Broadcast  ┈ ${u.broadcast}× (+${u.broadcast * 1} poin)`,
          `${'🧠'}  AI Detect  ┈ ${u.ai_detect}× (+${u.ai_detect * 2} poin)`,
          `${'🔄'} Resetguest ┈ ${u.resetguest}× (+${u.resetguest * 1} poin)`,
          `${'🚫'}  Blacklist  ┈ ${u.blacklist}× (+${u.blacklist * 1} poin)`,
          `${'⛔'}    Ban        ┈ ${u.ban}× (+${u.ban * 1} poin)`,
        ]
      },
      ...(logLines.length ? [{
        title: `${'🔖'} 5 AKTIVITAS TERAKHIR`,
        lines: logLines,
      }] : []),
    ]);

    return renderCard(ctx, caption);
  }

  const medals = ['🥇', '🥈', '🥉'];
  const rows   = ranking.map((r, i) => {
    const m = medals[i] || `${i + 1}.`;
    return `${m} <b>${htmlEscape(r.name)}</b> — <b>${r.score} poin</b>  [Add:${r.data.addrole} BC:${r.data.broadcast} AI:${r.data.ai_detect}]`;
  });

  const now = new Date().toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' });

  const caption = eMulti([
    {
      title: `${'📊'} STORAN — LEADERBOARD SECURITY`,
      lines: [
        `Update: ${now}`,
        `Periode: ${formatDateId(sdb.period_start)}`,
        '',
        ...rows,
      ]
    },
    {
      title: `${'🔖'} SISTEM POIN`,
      lines: [
        `${'✅'}  Addrole    ┈ +2 poin`,
        `${'🗑️'}  Delrole    ┈ +1 poin`,
        `${'📣'}   Broadcast  ┈ +1 poin`,
        `${'🧠'}  AI Detect  ┈ +2 poin`,
        `${'🔄'} Resetguest ┈ +1 poin`,
        `${'🚫'}  Blacklist  ┈ +1 poin`,
        `${'⛔'}    Ban        ┈ +1 poin`,
      ]
    }
  ]);

  const storanKb = isOwner(ctx.from.id)
    ? Markup.inlineKeyboard([[{ text: eF('『 📊 』 Rekap Sekarang'), callback_data: 'storan_recap_now', style: 'primary'}]])
    : Markup.inlineKeyboard([]);
  return renderCard(ctx, caption, storanKb);
});

bot.action('storan_recap_now', async (ctx) => {
  await safeAnswer(ctx);
  if (!isOwner(ctx.from.id)) return;

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
  await sendStoranDailyRecap();
  try {
    await bot.telegram.editMessageText(
      ctx.chat.id, ctx.callbackQuery.message.message_id, null,
      `${'✅'} Rekap berhasil dikirim ke grup storan.`,
      { parse_mode: 'HTML' }
    );
  } catch (_) {}
});

bot.command('storanreset', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply(`${'❌'} Command ini khusus owner.`, { parse_mode: 'HTML' });
  const sdb = readStoranDb();
  const now = new Date().toISOString();

  for (const id of Object.keys(sdb.users)) {
    const u = sdb.users[id];
    u.score = 0; u.addrole = 0; u.delrole = 0; u.broadcast = 0;
    u.ai_detect = 0; u.resetguest = 0; u.blacklist = 0; u.ban = 0;
    u.period_start = now;
  }
  sdb.logs         = [];
  sdb.period_start = now;
  saveStoranDb(sdb);
  return ctx.reply(
    `${'✅'} <b>Data storan berhasil direset.</b>\n<i>Periode baru dimulai dari sekarang.</i>`,
    { parse_mode: 'HTML' }
  );
});

bot.on('message', async (ctx, next) => {
  try {
    const from   = ctx.from;
    const msg    = ctx.message;
    const chatId = ctx.chat?.id;
    const text   = (msg?.text || msg?.caption || '').trim();
    if (!from || !msg || !text) return next();

    const fromId   = String(from.id);

    if (isOwner(from.id) && pendingPM.has(fromId) && !text.startsWith('/')) {
      const state = pendingPM.get(fromId);

      if (state.step === 'role') {
        const role = text.trim();
        pendingPM.set(fromId, { ...state, role, step: 'divisi' });
        await ctx.reply(
          [
            `✅ Role: <b>${htmlEscape(role)}</b>`,
            ``,
            `Sekarang ketik <b>Divisi</b> yang ingin di-set:`,
            `<i>Contoh: Security</i>`,
          ].join('\n'),
          { parse_mode: 'HTML' }
        );
        return;
      }

      if (state.step === 'divisi') {
        const divisi = text.trim();
        pendingPM.delete(fromId);
        setPmUser(state.targetId, state.role, divisi, fromId);
        const ownerDisplay = getDisplayUsername(ctx);
        await ctx.reply(
          [
            `✅ <b>Role PM Berhasil Disimpan!</b>`,
            ``,
            `<blockquote>`,
            `👤 User ID  : <code>${htmlEscape(state.targetId)}</code> (${htmlEscape(state.targetDisplay)})`,
            `🎭 Role     : <b>${htmlEscape(state.role)}</b>`,
            `📊 Divisi   : <b>${htmlEscape(divisi)}</b>`,
            `👤 Di-set   : ${htmlEscape(ownerDisplay)}`,
            `</blockquote>`,
          ].join('\n'),
          { parse_mode: 'HTML' }
        );
        return;
      }
    }

    const secName  = USERS_SECURITY[fromId];
    const isGroup  = ['group', 'supergroup'].includes(ctx.chat?.type);

    if (!isGroup) return next();

    if (secName) {
      const replyTo = msg.reply_to_message?.from;
      if (replyTo && !USERS_SECURITY[String(replyTo.id)] && !isOwner(replyTo.id)) {
        securityInteractions.set(String(replyTo.id), {
          securityId:   fromId,
          securityName: secName,
          chatId,
          ts:           Date.now(),
        });
      }
    }

    if (!secName && !isOwner(from.id) && containsResolveKeyword(text)) {
      const pending = securityInteractions.get(fromId);
      if (pending) {
        const age = Date.now() - pending.ts;
        if (age <= 30 * 60 * 1000) {
          securityInteractions.delete(fromId);
          const userName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || fromId;
          addStoranEntry(pending.securityId, pending.securityName, 'ai_detect', {
            'User':    `${userName} (${fromId})`,
            'Keyword': text.substring(0, 50),
            'Jeda':    `${Math.round(age / 60000)} menit`,
          });
        } else {
          securityInteractions.delete(fromId);
        }
      }
    }

  } catch (_) {}
  return next();
});

bot.command('hanzgokil', async (ctx) => {
  try {
    const now     = jakartaDateParts();
    const timings = await fetchJakartaPrayerTimes(now.date);
    const nowTime = `${now.hour}:${now.minute}`;

    let activeKey = null;
    for (const key of Object.keys(PRAYER_NAMES)) {
      if (timings[key] && timings[key] <= nowTime) activeKey = key;
    }

    const hijriStr   = getHijriDateStr();
    const kotaName   = String(config.kotaSholat || 'Jakarta');
    const activeName = activeKey ? PRAYER_NAMES[activeKey] : null;

    const tableRows = Object.entries(PRAYER_NAMES).map(([k, name]) => {
      const time     = richEscape(timings[k] || '--:--');
      const nameCell = k === activeKey ? `<b>${name}</b> ⬅️` : name;
      return [nameCell, `<b>${time}</b>`];
    });

    const rich = [
      richTitle('🕌', `JADWAL SHOLAT · ${kotaName}`),
      richTable(['Waktu Sholat', 'Jam'], tableRows),
      richQuote(
        `${richEscape(hijriStr)}${activeName ? ` · Sekarang masuk waktu <b>${activeName}</b>` : ''}.`,
        'Jangan lupa sholat.'
      ),
    ].join('\n');

    return sendRich(ctx.chat.id, makeView(rich), {});
  } catch (err) {
    console.error('[HANZGOKIL]', err.message);
    return ctx.reply(`${'❌'} Gagal mengambil jadwal sholat.`, { parse_mode: 'HTML' });
  }
});

bot.command('addpm', async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.reply('❌ Command ini khusus owner.', { parse_mode: 'HTML' });
  }

  const args = (ctx.message?.text || '').trim().split(/\s+/).slice(1);
  let targetId, targetDisplay;

  const replyUser = ctx.message?.reply_to_message?.from;
  if (replyUser) {
    targetId      = String(replyUser.id);
    targetDisplay = replyUser.username ? `@${replyUser.username}` : (replyUser.first_name || targetId);
  } else if (args[0] && /^\d+$/.test(args[0])) {
    targetId      = args[0];
    targetDisplay = `User ${targetId}`;
  } else {
    return ctx.reply(
      '❌ Format: <code>/addpm userId</code> atau reply ke user\nContoh: <code>/addpm 12345678</code>',
      { parse_mode: 'HTML' }
    );
  }

  pendingPM.set(String(ctx.from.id), {
    targetId,
    targetDisplay,
    chatId: String(ctx.chat.id),
    step: 'role',
    role: null,
    divisi: null,
  });

  await ctx.reply(
    [
      `🎭 <b>Set Role PM</b>`,
      ``,
      `Target  : <code>${htmlEscape(targetId)}</code> (${htmlEscape(targetDisplay)})`,
      ``,
      `Ketik <b>Role</b> yang ingin di-set:`,
      `<i>Contoh: Anggota PM</i>`,
    ].join('\n'),
    { parse_mode: 'HTML' }
  );
});

function absenEscape(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

bot.command('absen', async (ctx) => {
  try {
    const fromId = String(ctx.from.id);

    if (!USERS_SECURITY[fromId]) {
      return ctx.reply('❌ Command ini khusus anggota security.');
    }

    const from     = ctx.from;
    const username = from.username ? `@${from.username}` : (from.first_name || fromId);
    const tanggal  = new Intl.DateTimeFormat('id-ID', {
      day: '2-digit', month: 'long', year: 'numeric',
      timeZone: config.timezone || 'Asia/Jakarta',
    }).format(new Date());

    const pmData = getPmUser(fromId);

    if (!pmData) {
      const formatManual = [
        `Username :`,
        `Id Akun  :`,
        `Tanggal  :`,
        `Role     :`,
        `Divisi   :`,
        `Status   :`,
        `Tag      : @Kenken2764`,
      ].join('\n');

      await ctx.reply(
        [
          `⚠️ Role dan divisi anda belum di-set oleh owner, mohon isi format absen secara manual.`,
          ``,
          `<b>Format Absen:</b>`,
          `<code>${absenEscape(formatManual)}</code>`,
        ].join('\n'),
        { parse_mode: 'HTML' }
      );
      return;
    }

    const formatPending = [
      `Username : ${absenEscape(username)}`,
      `Id Akun  : ${fromId}`,
      `Tanggal  : ${absenEscape(tanggal)}`,
      `Role     : ${absenEscape(pmData.role)}`,
      `Divisi   : ${absenEscape(pmData.divisi)}`,
      `Status   : ...`,
      `Tag      : @Kenken2764`,
    ].join('\n');

    const absenButtons = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Hadir', `absen_status_${fromId}_hadir`),
        Markup.button.callback('🏖️ Cuti',  `absen_status_${fromId}_cuti`),
      ],
    ]);

    await ctx.reply(
      [
        `<b>TENTANG CARA ABSEN, AGAR KINERJA KALIAN TERLIHAT</b>`,
        ``,
        `Setiap anggota wajib absen setiap hari, dengan mengisi format =`,
        ``,
        `<code>${formatPending}</code>`,
        ``,
        `Pilih status absen kamu:`,
      ].join('\n'),
      { parse_mode: 'HTML', ...absenButtons }
    );
  } catch (e) {
    console.error('[ABSEN ERROR]', e?.message || e);
    try { await ctx.reply('❌ Gagal memproses absen. Coba lagi.'); } catch (_) {}
  }
});

bot.action(/^absen_status_(\d+)_(hadir|cuti)$/, async (ctx) => {
  try {
    await safeAnswer(ctx);
    const targetId = ctx.match[1];
    const status   = ctx.match[2];

    if (String(ctx.from.id) !== targetId) {
      return ctx.answerCbQuery('❌ Tombol ini bukan milikmu.', { show_alert: true });
    }

    if (!USERS_SECURITY[targetId]) {
      return ctx.answerCbQuery('❌ Akses ditolak.', { show_alert: true });
    }

    const from     = ctx.from;
    const username = from.username ? `@${from.username}` : (from.first_name || targetId);
    const tanggal  = new Intl.DateTimeFormat('id-ID', {
      day: '2-digit', month: 'long', year: 'numeric',
      timeZone: config.timezone || 'Asia/Jakarta',
    }).format(new Date());

    const pmData = getPmUser(targetId);
    if (!pmData) {
      return ctx.answerCbQuery('❌ Data role belum di-set oleh owner.', { show_alert: true });
    }

    const statusLabel = status === 'hadir' ? 'Hadir' : 'Cuti';

    const formatFinal = [
      `Username : ${absenEscape(username)}`,
      `Id Akun  : ${targetId}`,
      `Tanggal  : ${absenEscape(tanggal)}`,
      `Role     : ${absenEscape(pmData.role)}`,
      `Divisi   : ${absenEscape(pmData.divisi)}`,
      `Status   : ${statusLabel}`,
      `Tag      : @Kenken2764`,
    ].join('\n');

    await ctx.editMessageText(
      [
        `<b>TENTANG CARA ABSEN, AGAR KINERJA KALIAN TERLIHAT</b>`,
        ``,
        `Setiap anggota wajib absen setiap hari, dengan mengisi format =`,
        ``,
        `<code>${formatFinal}</code>`,
        ``,
        `Nanti Dansatpam kalian bakal react "👍", artinya absen kalian diterima.`,
        ``,
        `Jika ingin cuti karena ada kesibukan di RL, ubah status menjadi "Cuti".`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('[ABSEN STATUS ERROR]', e?.message || e);
    try { await ctx.answerCbQuery('❌ Gagal update absen.', { show_alert: true }); } catch (_) {}
  }
});

startStoranDailyScheduler();

try {
  const registerFeatures = require('./lib/features');
  registerFeatures(bot, {
    db, config, ROLE_DEFINITIONS, TIER_LABELS, PANEL_PLANS,
    TIER_ALLOWED_SERVERS, TIER_CAN_ADMIN_PANEL,
    Markup,
    isOwner,
    isPrimaryOwner: isOwner,
    htmlEscape, eBox, eMulti,
    eSect: eMulti,
    renderCard, sendDirectCard,
    formatDateId: (d) => new Date(d).toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' }),
    richTitle, richTable, richFold, richPara, richQuote, richEscape, makeView,
    getActiveServers, getServerStatus, pteroRequestFor,
    getAllPterodactylUsersOn: async (sv) => {
      const res = await pteroRequestFor(sv, '/api/application/users?per_page=1000');
      return res?.data || [];
    },
    STARTED_USERS_FILE, DB_DIR,
    progressBar, formatDuration,
    BROADCAST_USERS, USERS_SECURITY,
    backToMenuKeyboard,
    getUserTier, getUserRoleDisplay, hasAccessForPanel,
    readBlacklist, saveBlacklist,
    cleanDomain, getMaintenanceStatus,
    safeAnswer, eF,
    BROADCAST_USERS,
    // Stub agar destructuring di features.js tidak menghasilkan undefined
    pe: () => {}, E: (s) => s,
  });
} catch (e) {
  console.error('[FEATURES ADDON] Gagal load:', e.message);
}

const _sharedDeps = {
  db, config, ROLE_DEFINITIONS, TIER_LABELS, PANEL_PLANS,
  TIER_ALLOWED_SERVERS, Markup,
  isOwner, isPrimaryOwner: isOwner,
  htmlEscape, eBox, eMulti, eSect: eMulti,
  renderCard, sendDirectCard,
  sendRich,
  formatDateId: (d) => new Date(d).toLocaleString('id-ID', { timeZone: config.timezone || 'Asia/Jakarta' }),
  richTitle, richTable, richFold, richPara, richQuote, richEscape, makeView,
  getActiveServers, getServerStatus, pteroRequestFor,
  STARTED_USERS_FILE, DB_DIR,
  progressBar, formatDuration, BROADCAST_USERS,
  backToMenuKeyboard, getUserTier, getUserRoleDisplay, hasAccessForPanel,
  readBlacklist, saveBlacklist, cleanDomain, getMaintenanceStatus,
  safeAnswer, eF,
  // Stub agar destructuring di features2.js tidak menghasilkan undefined
  pe: () => {}, E: (s) => s,
};
try {
  const registerFeatures2 = require('./lib/features2');
  registerFeatures2(bot, _sharedDeps);
} catch (e) {
  console.error('[FEATURES2] Gagal load:', e.message, e.stack);
}

try {
  const startSchedulers = require('./lib/scheduler');
  startSchedulers(bot, _sharedDeps);
} catch (e) {
  console.error('[SCHEDULER-NEW] Gagal load:', e.message);
}

try {
  startAutoServerCheck(bot, _sharedDeps);
} catch (e) {
  console.error('[AUTO-CHECK] Gagal start:', e.message);
}

launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
