// Backtest honesto: a regra é medida em duas metades do histórico.
// "Treino" = primeira metade (onde você descobriu a ideia)
// "Teste"  = segunda metade (jogos que a regra "não viu")
const { LIGAS, MERCADOS, oddDo, bateu } = require('./mercados');
const { avaliar, ligasDaRegra } = require('./regras');
const jogos = require('./jogos');
const { db } = require('./db');

const JANELA_HIST = 60; // quantos jogos anteriores a regra pode olhar

function estatisticas(entradas) {
  const n = entradas.length;
  const acertos = entradas.filter((e) => e.acerto).length;
  const comOdd = entradas.filter((e) => e.odd);
  const lucro = comOdd.reduce((s, e) => s + (e.acerto ? e.odd - 1 : -1), 0);
  const esperado = comOdd.reduce((s, e) => s + 1 / e.odd, 0);
  const variancia = comOdd.reduce((s, e) => s + (1 / e.odd) * (1 - 1 / e.odd), 0);
  const acertosComOdd = comOdd.filter((e) => e.acerto).length;
  const oddMedia = comOdd.length ? comOdd.reduce((s, e) => s + e.odd, 0) / comOdd.length : null;
  return {
    n,
    acertos,
    taxa: n ? +(acertos / n * 100).toFixed(1) : null,
    oddMedia: oddMedia ? +oddMedia.toFixed(2) : null,
    taxaEquilibrio: oddMedia ? +(100 / oddMedia).toFixed(1) : null, // acerto mínimo para não perder
    lucro: +lucro.toFixed(2),
    roi: comOdd.length ? +(lucro / comOdd.length * 100).toFixed(1) : null,
    // z > 2 = acertou bem acima do que as odds previam (provavelmente não é sorte)
    z: variancia > 0 ? +((acertosComOdd - esperado) / Math.sqrt(variancia)).toFixed(2) : null,
  };
}

function classificar(treino, teste) {
  if (teste.n < 30) return { codigo: 'amostra_pequena', texto: 'Amostra pequena: ainda não dá para concluir nada' };
  if (teste.n >= 100 && teste.roi > 0 && treino.roi > 0 && teste.z >= 2)
    return { codigo: 'aprovada', texto: 'Aprovada: lucrou no treino e no teste, com amostra grande' };
  if (teste.roi > 0 && treino.roi > 0)
    return { codigo: 'promissora', texto: 'Promissora: lucro nas duas metades, mas falta amostra/confiança' };
  if (treino.roi > 0 && teste.roi <= 0)
    return { codigo: 'ilusao', texto: 'Ilusão: funcionou no passado e falhou nos jogos novos' };
  return { codigo: 'reprovada', texto: 'Reprovada: não supera a margem da casa' };
}

// Percorre todos os jogos das ligas da regra e simula o sinal
function simular(regra) {
  const todas = Object.keys(LIGAS);
  const entradas = [];
  for (const liga of ligasDaRegra(regra, todas)) {
    const arr = jogos.daLiga(liga);
    const intervalo = jogos.intervaloTipico(arr);
    for (let i = 1; i < arr.length; i++) {
      // só vale se o alvo é o jogo logo depois do último resultado conhecido
      if (arr[i].t - arr[i - 1].t > intervalo * 1.6) continue;
      const hist = arr.slice(Math.max(0, i - JANELA_HIST), i);
      if (!avaliar(regra, hist, arr[i])) continue;
      entradas.push({ t: arr[i].t, liga, acerto: bateu(arr[i], regra.mercado), odd: oddDo(arr[i], regra.mercado) });
    }
  }
  entradas.sort((a, b) => a.t - b.t);
  return entradas;
}

function pontoDeCorte(ligasLista) {
  const ts = [];
  for (const l of ligasLista) for (const j of jogos.daLiga(l)) ts.push(j.t);
  if (!ts.length) return 0;
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];
}

// Base de comparação: apostar no mercado em TODOS os jogos das mesmas ligas
function base(regra, corte) {
  const tr = [], te = [];
  for (const liga of ligasDaRegra(regra, Object.keys(LIGAS))) {
    for (const j of jogos.daLiga(liga)) {
      const e = { acerto: bateu(j, regra.mercado), odd: oddDo(j, regra.mercado) };
      (j.t < corte ? tr : te).push(e);
    }
  }
  return { treino: estatisticas(tr), teste: estatisticas(te) };
}

function aoVivo(regraId) {
  if (!regraId) return null;
  const rows = db.prepare(`SELECT status, odd FROM sinais WHERE regra_id = ? AND status IN ('green','red')`).all(regraId);
  return estatisticas(rows.map((r) => ({ acerto: r.status === 'green', odd: r.odd })));
}

function backtest(regra) {
  if (!MERCADOS[regra.mercado]) throw new Error('Mercado inválido');
  const ligasLista = ligasDaRegra(regra, Object.keys(LIGAS));
  const corte = pontoDeCorte(ligasLista);
  const entradas = simular(regra);
  const treino = estatisticas(entradas.filter((e) => e.t < corte));
  const teste = estatisticas(entradas.filter((e) => e.t >= corte));
  const totalJogos = ligasLista.reduce((s, l) => s + jogos.daLiga(l).length, 0);
  return {
    em: new Date().toISOString(),
    totalJogos,
    corte: corte ? new Date(corte).toISOString() : null,
    treino,
    teste,
    base: base(regra, corte),
    aoVivo: aoVivo(regra.id),
    status: classificar(treino, teste),
    frequencia: totalJogos ? +(entradas.length / totalJogos * 100).toFixed(2) : 0,
  };
}

// Taxas de cada mercado por liga (aba "Estatísticas")
function panorama() {
  const out = [];
  for (const [liga, nome] of Object.entries(LIGAS)) {
    const arr = jogos.daLiga(liga);
    const linha = { liga, nome, jogos: arr.length, mercados: {} };
    for (const m of Object.keys(MERCADOS)) {
      linha.mercados[m] = estatisticas(arr.map((j) => ({ acerto: bateu(j, m), odd: oddDo(j, m) })));
    }
    out.push(linha);
  }
  return out;
}

module.exports = { backtest, panorama, estatisticas };
