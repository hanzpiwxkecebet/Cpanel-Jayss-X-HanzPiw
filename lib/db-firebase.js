'use strict';

const { fbRead, fbWrite } = require('./firebase');
const path = require('path');

const DB_DIR     = path.join(__dirname, '..', 'database');
const ROLES_FILE = path.join(DB_DIR, 'roles.json');
const LIMIT_FILE = path.join(DB_DIR, 'limit.json');

const ROLE_DEFINITIONS = {
  reseller:   { tier: 'akma', tierLabel: 'Akses Pertama (Akma)',   label: 'Reseller Panel',   tierOrder: 1, rankOrder: 1  },
  premium:    { tier: 'akma', tierLabel: 'Akses Pertama (Akma)',   label: 'Premium Panel',    tierOrder: 1, rankOrder: 2  },
  adminpanel: { tier: 'akma', tierLabel: 'Akses Pertama (Akma)',   label: 'Admin Panel',      tierOrder: 1, rankOrder: 3  },
  security:   { tier: 'akma', tierLabel: 'Akses Pertama (Akma)',   label: 'Security Panel',   tierOrder: 1, rankOrder: 4  },
  staff:      { tier: 'akma', tierLabel: 'Akses Pertama (Akma)',   label: 'Staff Panel',      tierOrder: 1, rankOrder: 5  },
  svip:       { tier: 'akme', tierLabel: 'Akses Menengah (Akme)',  label: 'Svip Panel',       tierOrder: 2, rankOrder: 6  },
  manager:    { tier: 'akme', tierLabel: 'Akses Menengah (Akme)',  label: 'Manager Panel',    tierOrder: 2, rankOrder: 7  },
  direktur:   { tier: 'akme', tierLabel: 'Akses Menengah (Akme)',  label: 'Direktur Panel',   tierOrder: 2, rankOrder: 8  },
  komisaris:  { tier: 'akme', tierLabel: 'Akses Menengah (Akme)',  label: 'Komisaris Panel',  tierOrder: 2, rankOrder: 9  },
  eksekutif:  { tier: 'akti', tierLabel: 'Akses Tinggi (Akti)',    label: 'Eksekutif Panel',  tierOrder: 3, rankOrder: 10 },
  pimpinan:   { tier: 'akti', tierLabel: 'Akses Tinggi (Akti)',    label: 'Pimpinan Panel',   tierOrder: 3, rankOrder: 11 },
};

function getRolesDb() {
  const db = fbRead(ROLES_FILE, { users: {} });
  if (!db.users || typeof db.users !== 'object') db.users = {};
  return db;
}

function cleanupExpiredRoles() {
  const db  = getRolesDb();
  const now = Date.now();
  let changed = false;
  for (const [id, entry] of Object.entries(db.users)) {
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() < now) {
      delete db.users[id];
      changed = true;
    }
  }
  if (changed) fbWrite(ROLES_FILE, db);
  return db;
}

function getAllRoles() {
  return cleanupExpiredRoles().users;
}

function getRoleEntry(userId) {
  const id = String(userId);
  const db = cleanupExpiredRoles();
  return db.users[id] || null;
}

function getUserRole(userId) {
  const entry = getRoleEntry(userId);
  return entry ? (entry.role || null) : null;
}

function setUserRole(userId, role, addedBy = null, days = null) {
  const id = String(userId);
  if (!ROLE_DEFINITIONS[role]) return null;
  const db        = getRolesDb();
  const now       = new Date();
  const expiresAt = days
    ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
    : null;
  db.users[id] = {
    userId: id,
    role,
    addedBy:   addedBy ? String(addedBy) : null,
    addedAt:   now.toISOString(),
    expiresAt,
  };
  fbWrite(ROLES_FILE, db);
  return db.users[id];
}

function removeUserRole(userId) {
  const id  = String(userId);
  const db  = getRolesDb();
  const existed = Boolean(db.users[id]);
  delete db.users[id];
  fbWrite(ROLES_FILE, db);
  return existed;
}

function normalizeRoleName(input) {
  const clean = String(input || '').toLowerCase().trim().replace(/\s+/g, '');
  if (ROLE_DEFINITIONS[clean]) return clean;
  for (const [key, def] of Object.entries(ROLE_DEFINITIONS)) {
    const labelClean = def.label.toLowerCase().replace(/\s+/g, '');
    if (labelClean === clean || key === clean) return key;
  }
  for (const [key, def] of Object.entries(ROLE_DEFINITIONS)) {
    if (def.label.toLowerCase().startsWith(clean) || key.startsWith(clean)) return key;
  }
  return null;
}

function getLimitDb() {
  const db = fbRead(LIMIT_FILE, { users: {} });
  if (!db.users || typeof db.users !== 'object') db.users = {};
  return db;
}

function trackUser(userId) {
  try {
    const db = getLimitDb();
    const id = String(userId);
    if (!db.users[id]) {
      db.users[id] = { trackedAt: new Date().toISOString() };
      fbWrite(LIMIT_FILE, db);
    }
    return Object.keys(db.users).length;
  } catch (_) { return 0; }
}

function getTotalUserCount() {
  try {
    return Object.keys(getLimitDb().users || {}).length;
  } catch (_) { return 0; }
}

const LOCKED_FILE    = path.join(DB_DIR, 'locked_users.json');
const HISTORY_FILE   = path.join(DB_DIR, 'user_history.json');
const FAVORITES_FILE = path.join(DB_DIR, 'user_favorites.json');
const ACTIVITY_FILE  = path.join(DB_DIR, 'user_activity.json');
const CONSENT_FILE   = path.join(DB_DIR, 'rules_consent.json');

function getLockedDb() { return fbRead(LOCKED_FILE, {}); }

function lockUser(userId, lockedBy, reason = '-') {
  const db = getLockedDb();
  db[String(userId)] = {
    lockedAt: new Date().toISOString(),
    lockedBy: String(lockedBy),
    reason,
  };
  fbWrite(LOCKED_FILE, db);
}

function unlockUser(userId) {
  const db      = getLockedDb();
  const existed = Boolean(db[String(userId)]);
  delete db[String(userId)];
  fbWrite(LOCKED_FILE, db);
  return existed;
}

function isUserLocked(userId)  { return getLockedDb()[String(userId)] || null; }
function getLockedUsers()      { return getLockedDb(); }

const MAX_HISTORY  = 20;
const SENSITIVE_CMDS = ['addrole','delrole','setapikey','hardenc','openenc'];

function getHistoryDb() { return fbRead(HISTORY_FILE, {}); }

function addHistory(userId, cmdName, success = true) {
  if (SENSITIVE_CMDS.includes(cmdName)) return;
  const db  = getHistoryDb();
  const uid = String(userId);
  if (!db[uid]) db[uid] = [];
  db[uid].unshift({ cmd: cmdName, at: new Date().toISOString(), ok: success });
  if (db[uid].length > MAX_HISTORY) db[uid] = db[uid].slice(0, MAX_HISTORY);
  fbWrite(HISTORY_FILE, db);
}

function getHistory(userId) { return getHistoryDb()[String(userId)] || []; }

const MAX_FAVORITES = 5;

function getFavDb() { return fbRead(FAVORITES_FILE, {}); }

function getFavorites(userId) { return getFavDb()[String(userId)] || []; }

function addFavorite(userId, cmd) {
  const db  = getFavDb();
  const uid = String(userId);
  if (!db[uid]) db[uid] = [];
  if (db[uid].includes(cmd))          return 'already';
  if (db[uid].length >= MAX_FAVORITES) return 'limit';
  db[uid].push(cmd);
  fbWrite(FAVORITES_FILE, db);
  return 'ok';
}

function removeFavorite(userId, cmd) {
  const db  = getFavDb();
  const uid = String(userId);
  if (!db[uid] || !db[uid].includes(cmd)) return false;
  db[uid] = db[uid].filter(c => c !== cmd);
  fbWrite(FAVORITES_FILE, db);
  return true;
}

function getActivityDb() { return fbRead(ACTIVITY_FILE, {}); }

function trackActivity(userId, firstName, username, cmdName) {
  const db  = getActivityDb();
  const uid = String(userId);
  db[uid]   = {
    userId:    uid,
    firstName: firstName || 'User',
    username:  username  || null,
    lastCmd:   cmdName,
    lastAt:    new Date().toISOString(),
  };
  fbWrite(ACTIVITY_FILE, db);
}

function getActivity(userId)  { return getActivityDb()[String(userId)] || null; }
function getAllActivity()      { return getActivityDb(); }

function getInactiveUsers(days) {
  const db     = getActivityDb();
  const roles  = fbRead(ROLES_FILE, { users: {} }).users;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return Object.values(db).filter(u => {
    const ts = new Date(u.lastAt).getTime();
    return ts < cutoff && roles[u.userId];
  });
}

function getConsentDb() { return fbRead(CONSENT_FILE, {}); }

function hasAcceptedRules(userId) {
  return Boolean(getConsentDb()[String(userId)]?.accepted);
}

function setRulesConsent(userId, accepted) {
  const db = getConsentDb();
  db[String(userId)] = { accepted, at: new Date().toISOString() };
  fbWrite(CONSENT_FILE, db);
}

const ROLE_HISTORY_FILE = path.join(DB_DIR, 'role_history.json');
const MAX_ROLE_HISTORY  = 50;

function getRoleHistory(userId) {
  const all = fbRead(ROLE_HISTORY_FILE, {});
  return all[String(userId)] || [];
}

function addRoleHistory(userId, oldRole, newRole, changedBy = null) {
  const all = fbRead(ROLE_HISTORY_FILE, {});
  const uid = String(userId);
  if (!all[uid]) all[uid] = [];
  all[uid].unshift({
    oldRole:   oldRole   || null,
    newRole:   newRole   || null,
    changedBy: changedBy ? String(changedBy) : '-',
    at:        new Date().toISOString(),
  });
  if (all[uid].length > MAX_ROLE_HISTORY) all[uid] = all[uid].slice(0, MAX_ROLE_HISTORY);
  fbWrite(ROLE_HISTORY_FILE, all);
}

const _origSetUserRole = setUserRole;
function setUserRoleWithHistory(userId, role, addedBy = null, days = null) {
  const existing = getRoleEntry(userId);
  const oldRole  = existing?.role || null;
  const result   = _origSetUserRole(userId, role, addedBy, days);
  if (result) addRoleHistory(userId, oldRole, role, addedBy);
  return result;
}

const _origRemoveUserRole = removeUserRole;
function removeUserRoleWithHistory(userId, removedBy = null) {
  const existing = getRoleEntry(userId);
  const oldRole  = existing?.role || null;
  const existed  = _origRemoveUserRole(userId);
  if (existed && oldRole) addRoleHistory(userId, oldRole, null, removedBy);
  return existed;
}

module.exports = {
  ROLE_DEFINITIONS,
  getAllRoles,
  getRoleEntry,
  getUserRole,
  setUserRole:    setUserRoleWithHistory,
  removeUserRole: removeUserRoleWithHistory,
  normalizeRoleName,
  trackUser,
  getTotalUserCount,

  lockUser, unlockUser, isUserLocked, getLockedUsers,

  addHistory, getHistory,

  getFavorites, addFavorite, removeFavorite,

  trackActivity, getActivity, getAllActivity, getInactiveUsers,

  hasAcceptedRules, setRulesConsent,

  getRoleHistory, addRoleHistory,
};
