const { createCanvas } = require('@napi-rs/canvas');

const W = 600, H = 320;

const THEMES = {
  UNLI: {
    bg1: '#050d05', bg2: '#0a2010',
    acc: '#3a9e3a', brt: '#54c454',
    dim: '#1a4d1a', dmr: '#143d14',
    mut: '#427a42', pill: '#091d09',
  },
  CADP: {
    bg1: '#06060e', bg2: '#0a0a22',
    acc: '#4a58d8', brt: '#6878f4',
    dim: '#1a1f7a', dmr: '#14145a',
    mut: '#424888', pill: '#09092a',
  },
};

function generatePanelCard({ type, username, telegramId, server, createdBy, time, serverStatus = 'online' }) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const c = THEMES[type] || THEMES.UNLI;

  _bg(ctx, c);
  _border(ctx, c);
  _header(ctx, c);
  _serverIcon(ctx, 92, 158, c);
  _info(ctx, { type, username, telegramId, server, createdBy, time }, c);
  _footer(ctx, serverStatus, c);

  return canvas.toBuffer('image/png');
}

function _bg(ctx, c) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, c.bg1); g.addColorStop(.5, c.bg2); g.addColorStop(1, c.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function _border(ctx, c) {
  ctx.strokeStyle = c.dmr; ctx.lineWidth = 2;
  _rr(ctx, 2, 2, W-4, H-4, 12); ctx.stroke();

  [[22,22],[W-22,22],[22,H-22],[W-22,H-22]].forEach(([x, y]) => {
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI*2);
    ctx.fillStyle = c.dmr; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2);
    ctx.fillStyle = c.acc; ctx.fill();
  });
}

function _header(ctx, c) {
  ctx.font = 'bold 13px sans-serif';
  ctx.fillStyle = c.brt;
  ctx.textAlign = 'center';
  ctx.fillText('◆  NEW PANEL CREATED  ◆', W/2, 46);

  ctx.strokeStyle = c.dmr; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(36, 57); ctx.lineTo(W-36, 57); ctx.stroke();
}

function _serverIcon(ctx, cx, cy, c) {
  ctx.beginPath(); ctx.arc(cx, cy, 38, 0, Math.PI*2);
  ctx.strokeStyle = c.dmr; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 33, 0, Math.PI*2);
  ctx.fillStyle = '#010201'; ctx.fill();

  for (let i = 0; i < 3; i++) {
    const dy = cy - 16 + i * 14, dx = cx - 20;
    ctx.fillStyle = i === 0 ? c.dim : '#080d08';
    _rr(ctx, dx, dy, 40, 10, 3); ctx.fill();
    ctx.strokeStyle = i === 0 ? c.acc : c.dmr; ctx.lineWidth = .6;
    _rr(ctx, dx, dy, 40, 10, 3); ctx.stroke();
    ctx.fillStyle = i === 0 ? c.mut : '#162016';
    ctx.fillRect(dx+6, dy+3, 12, 1.5);
    ctx.fillRect(dx+6, dy+6.5, 8, 1.5);
    ctx.beginPath(); ctx.arc(dx+33, dy+5, 2.5, 0, Math.PI*2);
    ctx.fillStyle = i === 0 ? c.brt : c.dim; ctx.fill();
  }
}

function _info(ctx, { type, username, telegramId, server, createdBy, time }, c) {
  ctx.font = 'bold 44px sans-serif'; ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
  const u = username.length > 10 ? username.slice(0, 10) + '…' : username;
  ctx.fillText(u, 172, 113);

  ctx.fillStyle = c.pill;
  _rr(ctx, 172, 120, 68, 25, 6); ctx.fill();
  ctx.strokeStyle = c.dim; ctx.lineWidth = 1;
  _rr(ctx, 172, 120, 68, 25, 6); ctx.stroke();
  ctx.font = 'bold 12px sans-serif'; ctx.fillStyle = c.brt; ctx.textAlign = 'center';
  ctx.fillText(type, 206, 136);

  const rows = [
    ['Panel Type', type],
    ['Server Location', server],
    ['User ID', String(telegramId)],
    ['Dibuat Oleh', createdBy],
    ['Waktu', time],
  ];
  rows.forEach(([lbl, val], i) => {
    const y = 158 + i * 28;
    ctx.font = '11px sans-serif'; ctx.fillStyle = c.mut; ctx.textAlign = 'left';
    ctx.fillText(lbl, 174, y);
    ctx.font = 'bold 12px sans-serif'; ctx.fillStyle = '#c8c8e8';
    ctx.fillText(String(val), 308, y);
  });
}

function _footer(ctx, serverStatus, c) {
  ctx.strokeStyle = c.dmr; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(36, H-44); ctx.lineTo(W-36, H-44); ctx.stroke();

  ctx.beginPath(); ctx.arc(66, H-23, 4, 0, Math.PI*2);
  ctx.fillStyle = c.acc; ctx.fill();

  ctx.font = '11px sans-serif'; ctx.fillStyle = c.mut; ctx.textAlign = 'left';
  ctx.fillText(`Server Status: ${serverStatus}`, 80, H-18);

  ctx.textAlign = 'right'; ctx.fillStyle = c.dmr;
  ctx.fillText('Pterodactyl Panel Bot System', W-36, H-18);
}

function _rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y); ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r); ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r); ctx.closePath();
}

module.exports = { generatePanelCard };
