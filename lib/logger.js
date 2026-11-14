'use strict';

const c = {
  r:   '\x1b[0m',
  b:   '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  grn: '\x1b[32m',
  ylw: '\x1b[33m',
  blu: '\x1b[34m',
  mag: '\x1b[35m',
  cyn: '\x1b[36m',
  wht: '\x1b[37m',
  gry: '\x1b[90m',
};

const W   = 54;
const BRD = c.cyn;
const R   = c.r;

function vlen(s) { return s.replace(/\x1b\[[0-9;]*m/g, '').length; }

function vpad(s, w) { return s + ' '.repeat(Math.max(0, w - vlen(s))); }

function row(content) {
  return `${BRD}║${R} ${vpad(content, W - 2)} ${BRD}║${R}`;
}

function emptyRow() { return row(''); }

function sep() { return `${BRD}╠${'═'.repeat(W)}╣${R}`; }

function tierColor(index) {
  if (index <= 2) return c.ylw;
  if (index <= 4) return c.blu;
  return c.red;
}
function tierLabel(index) {
  if (index <= 2) return 'AKMA';
  if (index <= 4) return 'AKME';
  return 'AKTI';
}

function printStartupBanner({ botName, username, firebase, overrides, servers, services, startTime }) {
  const lines = [];

  lines.push('');
  lines.push(`${BRD}╔${'═'.repeat(W)}╗${R}`);
  lines.push(row(`${c.b}${c.ylw}  🤖  ${botName}${R}`));
  lines.push(row(`${c.gry}       @${username}${R}`));

  lines.push(sep());
  lines.push(row(`${c.b}${c.blu}  ☁   DATABASE${R}`));

  const fbColor = firebase.loaded > 0 ? c.grn : c.red;
  lines.push(row(`${c.gry}       Node    ${R}${fbColor}${c.b}${firebase.loaded}${R}${c.gry} / ${firebase.total} termuat${R}`));

  if (overrides.length > 0) {
    const max    = 4;
    const shown  = overrides.slice(0, max).join(', ');
    const extra  = overrides.length > max ? ` ${c.gry}+${overrides.length - max} lainnya${R}` : '';
    lines.push(row(`${c.gry}       Override ${R}${c.cyn}${shown}${extra}${R}`));
  }

  lines.push(sep());
  const svColor = servers.list.length === 0 ? c.red : c.grn;
  lines.push(row(`${c.b}${c.blu}  🖥   SERVERS${R}  ${c.gry}(${svColor}${c.b}${servers.list.length}${R}${c.gry} / ${servers.total} aktif)${R}`));

  if (servers.list.length === 0) {
    lines.push(row(`${c.red}       ⚠  Tidak ada server — isi config.js!${R}`));
  } else {
    for (const s of servers.list) {
      const tc  = tierColor(s.index);
      const tl  = tierLabel(s.index);
      const dom = s.domain.length > 30 ? s.domain.slice(0, 28) + '..' : s.domain;
      lines.push(row(
        `       ${c.grn}✓${R}  ${c.b}V${s.index}${R}  ${c.wht}${vpad(dom, 32)}${R}  ${tc}${tl}${R}`
      ));
    }
  }

  lines.push(sep());
  lines.push(row(`${c.b}${c.blu}  ⚙   SERVICES${R}`));

  for (const svc of services) {
    const icon = svc.ok ? `${c.grn}✅${R}` : `${c.red}❌${R}`;
    const name = `${c.b}${c.wht}${vpad(svc.name, 11)}${R}`;
    const info = `${c.gry}${svc.info || '-'}${R}`;
    lines.push(row(`       ${icon}  ${name}${info}`));
  }

  lines.push(sep());
  const time = startTime.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour12: false,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  lines.push(row(`  ${c.b}${c.grn}🚀  BOT ONLINE${R}  ${c.gry}${time} WIB${R}`));
  lines.push(`${BRD}╚${'═'.repeat(W)}╝${R}`);
  lines.push('');

  console.log(lines.join('\n'));
}

module.exports = { printStartupBanner };
