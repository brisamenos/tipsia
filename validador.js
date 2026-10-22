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
      t: arr[i].t, tr: arr[Math.min(arr.length - 1, i + (tiro || tiros) - 1)].t, liga, acerto: tiro > 0, tiro,
      odd: oddDo(arr[i], regra.mercado),
      lucro: semOdd ? null : +lucro.toFixed(4),
      apostas: tiro || tiros,
      pImpl: semOdd ? null : 1 - q,
    });
    ocupadoAte = i + (tiro || tiros) - 1;
  }
  return out;
}

// extra (opcional): { prova, dias } para uma classificação mais rígida
function classificar(treino, teste, extra = {}) {
  const { prova, dias } = extra;
  if (teste.n < 30) return { codigo: 'amostra_pequena', texto: 'Amostra pequena: ainda não dá para concluir nada' };
  const lucrou = teste.roi > 0 && treino.roi > 0;
  const provaOk = !prova || prova.n < 15 || prova.roi > 0;
  const diasOk = !dias || dias.total < 3 || dias.positivos / dias.total >= 0.6;
  if (lucrou && (!provaOk || (dias && dias.total >= 3 && dias.positivos / dias.total < 0.5)))
    return { codigo: 'instavel', texto: 'Instável: lucrou no total, mas falhou na prova final ou oscila demais entre os dias' };
  if (teste.n >= 100 && lucrou && teste.z >= 2 && provaOk && diasOk)
    return { codigo: 'aprovada', texto: 'Aprovada: lucrou no treino, na validação e na prova final, na maioria dos dias' };
  if (lucrou)
    return { codigo: 'promissora', texto: 'Promissora: lucro em todas as partes, mas falta amostra/confiança' };
  if (treino.roi > 0 && teste.roi <= 0)
    return { codigo: 'ilusao', texto: 'Ilusão: funcionou no passado e falhou nos jogos novos' };
  return { codigo: 'reprovada', texto: 'Reprovada: não supera a margem da casa' };
}

// Estatísticas de RED: onde caíram, distância média, maior sequência e o teste "depois do RED"
function estatRed(entradas) {
  const lista = [...entradas].sort((a, b) => a.t - b.t);
  const n = lista.length;
  const reds = lista.filter((e) => !e.acerto);
  let seqR = 0, seqG = 0, maxR = 0, maxG = 0;
  const aposRed = [];
  lista.forEach((e, i) => {
    if (e.acerto) { seqG++; seqR = 0; } else { seqR++; seqG = 0; }
    maxR = Math.max(maxR, seqR); maxG = Math.max(maxG, seqG);
    if (i > 0 && !lista[i - 1].acerto) aposRed.push(e.acerto);
  });
  const taxa = (arr) => (arr.length ? +(arr.filter(Boolean).length / arr.length * 100).toFixed(1) : null);
  return {
    n,
    reds: reds.length,
    ultimos: reds.slice(-3).reverse().map((e) => new Date(e.tr || e.t).toISOString()),
    cada: reds.length ? +(n / reds.length).toFixed(1) : null,   // 1 RED a cada X sinais
    maiorSeqRed: maxR,
    maiorSeqGreen: maxG,
    seqAtual: n ? { tipo: lista[n - 1].acerto ? 'green' : 'red', n: lista[n - 1].acerto ? seqG : seqR } : null,
    geral: taxa(lista.map((e) => e.acerto)),
    aposRed: { n: aposRed.length, taxa: taxa(aposRed) },
  };
}

// Pontos de corte: 50% (fim do treino) e 75% (fim da validação). Os últimos 25% são a "prova final".
function cortes(ligasLista) {
  const ts = [];
  for (const l of ligasLista) for (const j of jogos.daLiga(l)) ts.push(j.t);
  if (!ts.length) return { c50: 0, c75: 0 };
  ts.sort((a, b) => a - b);
  return { c50: ts[Math.floor(ts.length * 0.5)], c75: ts[Math.floor(ts.length * 0.75)] };
}

// Lucro dia a dia (horário de Brasília/Fortaleza)
function porDia(entradas) {
  const mapa = {};
  for (const e of entradas) {
    const dia = new Date(e.t - 3 * 3600e3).toISOString().slice(0, 10);
    const d = (mapa[dia] ||= { dia, n: 0, lucro: 0 });
    d.n++;
    d.lucro += e.lucro !== undefined ? (e.lucro || 0) : e.odd ? (e.acerto ? e.odd - 1 : -1) : 0;
  }
  const lista = Object.values(mapa).sort((a, b) => a.dia.localeCompare(b.dia)).map((d) => ({ ...d, lucro: +d.lucro.toFixed(2) }));
  const validos = lista.filter((d) => d.n >= 3);
  return { total: validos.length, positivos: validos.filter((d) => d.lucro > 0).length, lista };
}

// Separa as entradas nas 3 partes e calcula tudo
function analisar(entradas, c50, c75) {
  const tr = [], va = [], pr = [];
  for (const e of entradas) (e.t < c50 ? tr : e.t < c75 ? va : pr).push(e);
  const treino = estatisticas(tr), validacao = estatisticas(va), prova = estatisticas(pr);
  const teste = estatisticas(va.concat(pr));
  const dias = porDia(entradas);
  return { treino, validacao, prova, teste, dias, status: classificar(treino, teste, { prova, dias }) };
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
  const { c50, c75 } = cortes(ligasLista);
  const entradas = simular(regra);
  const a = analisar(entradas, c50, c75);
  const totalJogos = ligasLista.reduce((s, l) => s + jogos.daLiga(l).length, 0);
  return {
    em: new Date().toISOString(),
    totalJogos,
    corte: c50 ? new Date(c50).toISOString() : null,
    corteProva: c75 ? new Date(c75).toISOString() : null,
    ...a,
    reds: estatRed(entradas),
    base: base(regra, c50),
    aoVivo: aoVivo(regra.id),
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

module.exports = { backtest, panorama, estatisticas, classificar, simularLiga, defasagem, cortes, analisar, porDia, aoVivo, estatRed };
