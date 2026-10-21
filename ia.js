// "IA" do laboratório: regressão logística treinada na 1ª metade
// e testada na 2ª metade. Compete com as odds da casa, de forma honesta.
const { LIGAS, MERCADOS, oddDo, bateu, probJusta } = require('./mercados');
const jogos = require('./jogos');
const { estatisticas } = require('./validador');

const LISTA_LIGAS = Object.keys(LIGAS);

function freq(hist, mercado, n) {
  const s = hist.slice(-n);
  if (!s.length) return 0.5;
  return s.filter((j) => bateu(j, mercado)).length / s.length;
}

function sequencia(hist, mercado) {
  if (!hist.length) return 0;
  const ult = bateu(hist[hist.length - 1], mercado);
  let k = 0;
  for (let i = hist.length - 1; i >= 0 && bateu(hist[i], mercado) === ult; i--) k++;
  return (ult ? 1 : -1) * Math.min(k, 10) / 10;
}

function features(hist, alvo, mercado, liga) {
  const pj = probJusta(alvo, mercado);
  const ang = (2 * Math.PI * (Number(alvo.minuto) || 0)) / 60;
  return [
    1, // viés
    pj ?? 0.5,
    freq(hist, mercado, 5),
    freq(hist, mercado, 10),
    freq(hist, mercado, 30),
    sequencia(hist, mercado),
    Math.sin(ang), Math.cos(ang),
    ...LISTA_LIGAS.map((l) => (l === liga ? 1 : 0)),
  ];
}

const sig = (z) => 1 / (1 + Math.exp(-z));

function treinar(X, y, epocas = 60, taxa = 0.05, l2 = 0.001) {
  const w = new Array(X[0].length).fill(0);
  for (let ep = 0; ep < epocas; ep++) {
    for (let i = 0; i < X.length; i++) {
      const p = sig(X[i].reduce((s, x, k) => s + x * w[k], 0));
      const err = p - y[i];
      for (let k = 0; k < w.length; k++) w[k] -= taxa * (err * X[i][k] + l2 * w[k]);
    }
  }
  return w;
}

function logLoss(ps, ys) {
  let s = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = Math.min(Math.max(ps[i], 1e-6), 1 - 1e-6);
    s += ys[i] ? -Math.log(p) : -Math.log(1 - p);
  }
  return ps.length ? +(s / ps.length).toFixed(4) : null;
}

// margem: só "aposta" quando a IA vê vantagem mínima sobre a odd (ex.: 0.03 = 3%)
function avaliarIA(mercado, margem = 0.03) {
  if (!MERCADOS[mercado]) throw new Error('Mercado inválido');
  const amostras = [];
  for (const liga of LISTA_LIGAS) {
    const arr = jogos.daLiga(liga);
    for (let i = 30; i < arr.length; i++) {
      const odd = oddDo(arr[i], mercado);
      if (!odd) continue;
      const hist = arr.slice(i - 30, i);
      amostras.push({
        t: arr[i].t, x: features(hist, arr[i], mercado, liga),
        y: bateu(arr[i], mercado) ? 1 : 0, odd, pj: probJusta(arr[i], mercado),
      });
    }
  }
  if (amostras.length < 400) {
    return { erro: 'Poucos jogos com odd para treinar a IA. Deixe a coleta rodar mais tempo.', amostras: amostras.length };
  }
  amostras.sort((a, b) => a.t - b.t);
  const meio = Math.floor(amostras.length / 2);
  const tr = amostras.slice(0, meio), te = amostras.slice(meio);
  const w = treinar(tr.map((a) => a.x), tr.map((a) => a.y));

  const pIA = te.map((a) => sig(a.x.reduce((s, x, k) => s + x * w[k], 0)));
  const pCasa = te.map((a) => Math.min(a.pj ?? 1 / a.odd, 0.99));
  const ys = te.map((a) => a.y);

  const entradas = [];
  te.forEach((a, i) => {
    if (pIA[i] * a.odd > 1 + margem) entradas.push({ acerto: !!a.y, odd: a.odd });
  });

  const llIA = logLoss(pIA, ys), llCasa = logLoss(pCasa, ys);
  return {
    mercado,
    nomeMercado: MERCADOS[mercado].nome,
    treinoJogos: tr.length,
    testeJogos: te.length,
    // log-loss: quanto MENOR, melhor a previsão
    logLossIA: llIA,
    logLossOdds: llCasa,
    iaPreveMelhorQueOdds: llIA < llCasa,
    entradasNoTeste: estatisticas(entradas),
    margem,
  };
}

module.exports = { avaliarIA };
