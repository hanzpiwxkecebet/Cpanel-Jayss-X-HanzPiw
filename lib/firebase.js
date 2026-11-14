'use strict';

const admin = require('firebase-admin');
const path  = require('path');

const serviceAccount = require('../KeyHanzPiw.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://database-cpanel-default-rtdb.asia-southeast1.firebasedatabase.app/',
  });
}

const fbdb = admin.database();

const _cache = new Map();

function pathToKey(fp) {
  return path.basename(String(fp || ''), '.json');
}

function fbRead(fp, def) {
  const key = pathToKey(fp);
  if (_cache.has(key)) return _cache.get(key);
  return def !== undefined ? def : {};
}

function fbWrite(fp, data) {
  const key = pathToKey(fp);
  _cache.set(key, data);

  if (data === null || data === undefined) return;
  fbdb.ref(key).set(data).catch(err =>
    console.error(`[Firebase] Write error [${key}]:`, err.message)
  );
}

const ALL_KEYS = [

  'alert_settings', 'audio_feedback', 'audit_log', 'banwords',
  'blocked_cmds', 'bulk_track', 'cmd_history', 'cmd_stats',
  'config_override', 'confirm2', 'confirm_sessions', 'contact',
  'cpu_hourly', 'daily_report_cfg', 'failed_cmds', 'feedback',
  'flood_cfg', 'guest_panels', 'harga_cfg', 'integrity_log',
  'invoice_seq', 'lang_prefs', 'limit', 'locked_users',
  'locks', 'maintenance', 'maintenance_schedule', 'maintenance_v2',
  'monitor-top10', 'mypanels', 'notice', 'offline_tracker',
  'offline_tracker_v2', 'onboarding', 'owner_sessions', 'panel_stats',
  'pm_users', 'polls', 'prayer', 'quick_menus', 'ratings',
  'repeat_broadcast', 'roles', 'rules', 'server_capacity',
  'server_recovery', 'shorturl_clicks', 'started_users', 'storan',
  'user_activity', 'user_history', 'user_lang', 'weekly_report',
  'welcome_cfg', 'whitelisted_groups',

  'faq', 'tutorial', 'scheduled_bc', 'peak_hours',
  'blacklist_durations', 'blocked_cmds_user', 'custom_roles',
  'secondary_roles', 'debug_mode',

  'rules_consent', 'daily_report_config', 'tips_prefs',
  'celebration_media', 'flood_warn', 'audio_prefs',
  'failed_attempts', 'invoices', 'harga',

  'backup_status', 'blacklist', 'user_favorites',

  'role_history', 'uptime_tracker', 'panel_down_state',
  'auto_delete_config', 'reseller_stats', 'github_check',
  'join_leave_tracker', 'panel_queue',

  'update_state',

  'plan_stats', 'role_logs', 'welcome_messages',
];

async function fbInit() {
  const unique = [...new Set(ALL_KEYS)];
  await Promise.all(unique.map(async (key) => {
    try {
      const snap = await fbdb.ref(key).once('value');
      const val  = snap.val();
      if (val !== null && val !== undefined) { _cache.set(key, val); }
    } catch (err) {
      console.error(`[Firebase] Init error [${key}]:`, err.message);
    }
  }));
}

function getCacheStats() {
  return { loaded: _cache.size, total: [...new Set(ALL_KEYS)].length };
}

module.exports = { fbRead, fbWrite, fbInit, getCacheStats, ALL_KEYS };
