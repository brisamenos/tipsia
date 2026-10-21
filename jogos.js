// Cache em memória dos jogos por liga, em ordem cronológica.
const { db } = require('./db');

const porLiga = new Map();
let carregado = false;

function linhaParaJogo(r) {
  return {
    id: r.id, liga: r.liga, inicio: r.inicio, t: Date.parse(r.inicio),
    hora: r.hora, minuto: r.minuto, time_casa: r.time_casa, time_fora: r.time_fora,
    gc: r.gc, gf: r.gf, gc_ht: r.gc_ht, gf_ht: r.gf_ht,
    odds: r.odds ? JSON.parse(r.odds) : {},
  };
}

function carregar() {
  porLiga.clear();
  const rows = db.prepare('SELECT * FROM jogos ORDER BY inicio').all();
  for (const r of rows) {
    if (!porLiga.has(r.liga)) porLiga.set(r.liga, []);
    porLiga.get(r.liga).push(linhaParaJogo(r));
  }
  carregado = true;
}

function garantir() { if (!carregado) carregar(); }

function adicionar(jogo) {
  garantir();
  if (!porLiga.has(jogo.liga)) porLiga.set(jogo.liga, []);
  const arr = porLiga.get(jogo.liga);
  arr.push(jogo);
  // mantém ordenado (normalmente já chega em ordem)
  if (arr.length > 1 && arr[arr.length - 2].t > jogo.t) arr.sort((a, b) => a.t - b.t);
}

function daLiga(liga) { garantir(); return porLiga.get(liga) || []; }
function ligas() { garantir(); return [...porLiga.keys()]; }

// Intervalo típico entre jogos da liga (mediana dos últimos 50), em ms
function intervaloTipico(arr) {
  const dif = [];
  for (let i = Math.max(1, arr.length - 50); i < arr.length; i++) dif.push(arr[i].t - arr[i - 1].t);
  if (!dif.length) return 3 * 60000;
  dif.sort((a, b) => a - b);
  return dif[Math.floor(dif.length / 2)] || 3 * 60000;
}

module.exports = { carregar, adicionar, daLiga, ligas, intervaloTipico, linhaParaJogo };
