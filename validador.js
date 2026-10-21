// Backtest honesto: a regra é medida em duas metades do histórico.
// "Treino" = primeira metade (onde você descobriu a ideia)
// "Teste"  = segunda metade (jogos que a regra "não viu")
const { LIGAS, MERCADOS, oddDo, bateu } = require('./mercados');
const { avaliar, ligasDaRegra } = require('./regras');
const jogos = require('./jogos');
const { db, getConfig } = require('./db');


// Cada entrada: { acerto, odd } (1 tiro) ou, com tiros, também { lucro, apostas, pImpl, tiro }
function estatisticas(entradas) {
  const n = entradas.length;
  const acertos = entradas.filter((e) => e.acerto).length;
  const lucroDe = (e) => (e.lucro !== undefined ? e.lucro : e.odd ? (e.acerto ? e.odd - 1 : -1) : null);
  const comLucro = entradas.filter((e) => lucroDe(e) != null);
  const lucro = comLucro.reduce((s, e) => s + lucroDe(e), 0);
  const apostas = comLucro.reduce((s, e) => s + (e.apostas || 1), 0);
  const pDe = (e) => (e.pImpl != null ? e.pImpl : e.odd ? 1 / e.odd : null);
  const comP = entradas.filter((e) => pDe(e) != null);
  const esperado = comP.reduce((s, e) => s + pDe(e), 0);
  const variancia = comP.reduce((s, e) => s + pDe(e) * (1 - pDe(e)), 0);
  const acertosComP = comP.filter((e) => e.acerto).length;
  const comOdd = entradas.filter((e) => e.odd);
  const oddMedia = comOdd.length ? comOdd.reduce((s, e) => s + e.odd, 0) / comOdd.length : null;
  const umTiro = entradas.every((e) => !e.apostas || e.apostas === 1) && entradas.every((e) => !e.tiro || e.tiro <= 1);
  const porTiro = {};
  for (const e of entradas) if (e.tiro) porTiro[e.tiro] = (porTiro[e.tiro] || 0) + 1;
  return {
    n,
    acertos,
    taxa: n ? +(acertos / n * 100).toFixed(1) : null,
    oddMedia: oddMedia ? +oddMedia.toFixed(2) : null,
    taxaEquilibrio: oddMedia && umTiro ? +(100 / oddMedia).toFixed(1) : null, // acerto mínimo para não perder (1 tiro)
    lucro: +lucro.toFixed(2),
    roi: apostas ? +(lucro / apostas * 100).toFixed(1) : null,                // lucro por unidade apostada
    // z > 2 = acertou bem acima do que as odds previam (provavelmente não é sorte)
    z: variancia > 0 ? +((acertosComP - esperado) / Math.sqrt(variancia)).toFixed(2) : null,
    porTiro,
  };
}

// Quantos jogos ficam "no escuro" entre o último resultado conhecido e o jogo do sinal.
// Ex.: liga de 2 em 2 minutos e sinal 1 minuto antes = o jogo anterior ainda está rolando (1).
function defasagem(liga) {
  const cont = getConfig('defasagem_' + liga);
  if (cont && typeof cont === 'object') {
    const melhor = Object.entries(cont).sort((a, b) => b[1] - a[1])[0];
    if (melhor) return Number(melhor[0]);
  }
  const iv = jogos.intervaloTipico(jogos.daLiga(liga));
  return iv <= 150000 ? 1 : 0;
}

// Simula a regra em uma liga, com até N tiros (o sinal vale para N jogos seguidos)
function simularLiga(regra, liga, tiros = 1) {
  const arr = jogos.daLiga(liga);
  const iv = jogos.intervaloTipico(arr);
  const d = defasagem(liga);
  const out = [];
  let ocupadoAte = -1;
  for (let i = 1 + d; i < arr.length; i++) {
    if (i <= ocupadoAte) continue;                                  // já há um sinal rodando nesta liga
    if (arr[i].t - arr[i - 1 - d].t > iv * (d + 1) * 1.6) continue; // buraco na coleta
    if (!avaliar(regra, arr, arr[i], i - d)) continue;              // só enxerga até o último resultado conhecido
    let lucro = 0, semOdd = false, tiro = 0, q = 1, incompleto = false, k;
    for (k = 0; k < tiros; k++) {
      const j = i + k;
      if (j >= arr.length || (k > 0 && arr[j].t - arr[j - 1].t > iv * 1.6)) { incompleto = true; break; }
      const o = oddDo(arr[j], regra.mercado);
      if (o) q *= 1 - 1 / o; else semOdd = true;
      if (bateu(arr[j], regra.mercado)) { tiro = k + 1; if (o) lucro += o - 1; break; }
      lucro -= 1;
    }
    if (incompleto) continue;
    for (let k2 = k + 1; k2 < tiros && i + k2 < arr.length; k2++) { const o = oddDo(arr[i + k2], regra.mercado); if (o) q *= 1 - 1 / o; }
    out.push({
      t: arr[i].t, liga, acerto: tiro > 0, tiro,
      odd: oddDo(arr[i], regra.mercado),
      lucro: semOdd ? null : +lucro.toFixed(4),
      apostas: tiro || tiros,
      pImpl: semOdd ? null : 1 - q,
    });
    ocupadoAte = i + (tiro || tiros) - 1;
  }
  return out;
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
  const tiros = Math.min(3, Math.max(1, Number(regra.tiros) || 1));
  const entradas = [];
  for (const liga of ligasDaRegra(regra, Object.keys(LIGAS))) entradas.push(...simularLiga(regra, liga, tiros));
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
  const rows = db.prepare(`SELECT status, odd, lucro, tiro_atual, tiro_green FROM sinais WHERE regra_id = ? AND status IN ('green','red')`).all(regraId);
  return estatisticas(rows.map((r) => ({
    acerto: r.status === 'green', odd: r.odd, lucro: r.lucro,
    apostas: r.status === 'green' ? (r.tiro_green || 1) : (r.tiro_atual || 1), tiro: r.tiro_green || 0,
  })));
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
    tiros: Math.min(3, Math.max(1, Number(regra.tiros) || 1)),
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

module.exports = { backtest, panorama, estatisticas, classificar, simularLiga, defasagem };
