'use strict';

const { fbRead } = require('./firebase');

async function checkAllSlots(deps) {
  const { config, pteroRequestFor, cleanDomain } = deps;

  // Merge config_override dari Firebase di atas config.js
  const overrides = fbRead('config_override', {});
  const merged    = Object.keys(overrides).length ? { ...config, ...overrides } : config;

  const slots = [
    { index: 1, domain: merged.domain,   plta: merged.plta   },
    { index: 2, domain: merged.domainv2, plta: merged.pltav2 },
    { index: 3, domain: merged.domainv3, plta: merged.pltav3 },
    { index: 4, domain: merged.domainv4, plta: merged.pltav4 },
    { index: 5, domain: merged.domainv5, plta: merged.pltav5 },
  ];

  const results = new Array(5).fill(null);

  await Promise.all(slots.map(async slot => {
    const domain = cleanDomain(slot.domain || '');
    const plta   = String(slot.plta || '');
    const ok = domain && /^https?:\/\//i.test(domain) &&
               plta && /^ptla_/i.test(plta) && !plta.includes('APPLICATION_API_KEY');

    if (!ok) {
      results[slot.index - 1] = { index: slot.index, status: 'not_configured' };
      return;
    }

    const t0 = Date.now();
    try {
      const res = await pteroRequestFor(slot, '/api/application/users?per_page=1&page=1');
      results[slot.index - 1] = {
        index: slot.index,
        status:  'online',
        total:   res?.meta?.pagination?.total ?? 0,
        latency: Date.now() - t0,
      };
    } catch (_) {
      results[slot.index - 1] = { index: slot.index, status: 'offline' };
    }
  }));

  return results;
}

async function buildCheckRich(deps) {
  const {
    config, getServerStatus,
    richTitle, richTable, richEscape,
  } = deps;

  const [stats, results] = await Promise.all([
    getServerStatus(),
    checkAllSlots(deps),
  ]);

  const onlineCount = results.filter(r => r?.status === 'online').length;
  const updateTime  = new Date().toLocaleString('id-ID', {
    timeZone: config.timezone || 'Asia/Jakarta',
    hour12:   false,
  });

  const serverRows = results.map(r => {
    if (!r || r.status === 'not_configured') return [`V${r?.index ?? '?'}`, '⚫ N/A', '—', '—'];
    if (r.status === 'online')               return [`V${r.index}`, '<b>🟢 Online</b>', `${r.total} user`, `${r.latency}ms`];
    return [`V${r.index}`, '<b>🔴 Offline</b>', '—', '—'];
  });

  return [
    richTitle('🖥️', 'Auto Server Check'),

    richTable(['Metrik', 'Nilai'], [
      ['Server Online', `<b>${onlineCount}/5</b>`],
      ['Update',        `<i>${richEscape(updateTime)}</i>`],
      ['Status VPS',    `<b>${richEscape(stats.statusLine)}</b>`],
    ]),

    richTable(['Server', 'Status', 'User', 'Ping'], serverRows),

    richTable(['📊 Resource', 'Usage'], [
      ['CPU',    `<b>${stats.cpuPercent}%</b>  ${stats.cpuBar}`],
      ['RAM',    `<b>${stats.ramUsedText}/${stats.ramTotalText}</b>  ${stats.ramBar}`],
      ['Disk',   `<b>${stats.diskUsedText}/${stats.diskTotalText}</b>  ${stats.diskBar}`],
      ['Uptime', `<b>${richEscape(stats.uptimeText)}</b>`],
    ]),
  ].join('\n');
}

function buildRedirectRich(channelId, deps) {
  const { richTitle, richTable, richEscape } = deps;

  return [
    richTitle('📡', 'Server Status'),
    richTable(['Info', 'Detail'], [
      ['Update',   '<b>Otomatis setiap 5 menit</b>'],
      ['Channel',  `<b>https://t.me/Informsiserver</b>`],
    ]),
  ].join('\n');
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 menit

let _intervalHandle = null; // guard: cegah scheduler ganda kalau startAutoServerCheck terpanggil >1x

function startAutoServerCheck(bot, deps) {
  const { config, makeView, sendRich } = deps;
  const channelId = String(config.channelServer || '').trim();

  if (!channelId) {
    console.warn('[AUTO-CHECK] ⚠️  config.channelServer belum diisi — auto check dinonaktifkan');
    return;
  }

  if (_intervalHandle) {
    console.warn('[AUTO-CHECK] ⚠️  startAutoServerCheck sudah berjalan — pemanggilan ganda diabaikan');
    return;
  }

  let lastMsgId  = null;
  let isChecking = false; // guard: cegah overlap kalau 1 siklus belum selesai tapi interval berikutnya sudah jatuh tempo

  const doCheck = async () => {
    if (isChecking) {
      console.warn('[AUTO-CHECK] ⏭️  Siklus sebelumnya masih berjalan, lewati siklus ini');
      return;
    }
    isChecking = true;
    try {
      const richHtml = await buildCheckRich(deps);
      const view     = makeView(richHtml);

      if (lastMsgId) {
        try { await bot.telegram.deleteMessage(channelId, lastMsgId); } catch (_) {}
        lastMsgId = null;
      }

      const sent = await sendRich(channelId, view, {});
      lastMsgId  = sent?.message_id ?? null;
      console.log(`[AUTO-CHECK] ✅ Dikirim ke ${channelId} (msg_id: ${lastMsgId})`);
    } catch (err) {
      console.error('[AUTO-CHECK] ❌ Gagal mengirim laporan:', err.message);
      // lastMsgId sengaja TIDAK direset di sini: kalau gagalnya di sendRich setelah
      // deleteMessage berhasil, lastMsgId memang sudah null; kalau gagal sebelum itu,
      // pesan lama (jika ada) masih valid untuk dihapus di siklus berikutnya.
    } finally {
      isChecking = false;
    }
  };

  // Jalankan sekali langsung saat start, lalu berulang tiap 5 menit.
  doCheck();
  _intervalHandle = setInterval(doCheck, CHECK_INTERVAL_MS);

  console.log(`[AUTO-CHECK] ✅ Aktif — channel: ${channelId} | interval: 5 menit`);
}

module.exports = { startAutoServerCheck, buildRedirectRich };
