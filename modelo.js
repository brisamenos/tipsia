// Modelo de valor: calcula a chance de cada mercado em cada jogo e compara com a odd.
// - Começa igual à odd (que já embute quase tudo) e aprende só o que a odd não explica.
// - É testado "dia a dia": para prever o dia D, só treina com os dias anteriores (walk-forward).
// - Só indica entrada quando a chance do modelo × odd passa de 1 + margem (valor).
const { LIGAS, MERCADOS, oddDo, bateu, probJusta } = require('./mercados');
const jogos = require('./jogos');
const { getConfig, setConfig, log } = require('./db');

const BASE = ['ambas_sim', 'over_15', 'over_25', 'over_35', 'casa', 'empate', 'fora', 'gols_impar'];
const COMPLEMENTO = { ambas_nao: 'ambas_sim', under_15: 'over_15', under_25: 'over_25', under_35: 'over_35', gols_par: 'gols_impar' };
const LISTA_LIGAS = Object.keys(LIGAS);
const estado = { rodando: false, progresso: '', em: null };

let pesos = getConfig('modelo_pesos', {}) || {};   // modelo "ao vivo" (treinado com tudo)
const oos = new Map();                              // previsões fora da amostra: `${base}|${idJogo}` -> p

const sig = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(Math.min(Math.max(p, 1e-4), 1 - 1e-4) / (1 - Math.min(Math.max(p, 1e-4), 1 - 1e-4)));
const diaDe = (t) => new Date(t - 3 * 3600e3).toISOString().slice(0, 10);
const pausa = () => new Promise((r) => setImmediate(r));

function baseDe(mercado) {
  if (BASE.includes(mercado)) return { base: mercado, inverte: false };
  if (COMPLEMENTO[mercado]) return { base: COMPLEMENTO[mercado], inverte: true };
  return null;
}

// taxa recente do mercado nos jogos de um time (como mandante ou visitante)
function taxaTime(arr, fim, time, base, n = 10) {
  if (!time) return 0.5;
  let qtd = 0, sim = 0;
  for (let k = fim - 1, passos = 0; k >= 0 && qtd < n && passos < 250; k--, passos++) {
    const j = arr[k];
    if (j.time_casa === time || j.time_fora === time) { qtd++; if (bateu(j, base)) sim++; }
  }
  return qtd >= 3 ? sim / qtd : 0.5;
}

function freq(arr, fim, base, n) {
  let q = 0, s = 0;
  for (let k = fim - 1; k >= 0 && q < n; k--) { q++; if (bateu(arr[k], base)) s++; }
  return q ? s / q : 0.5;
}

function sequencia(arr, fim, base) {
  if (fim < 1) return 0;
  const ult = bateu(arr[fim - 1], base);
  let k = 0;
  for (let i = fim - 1; i >= 0 && k < 10 && bateu(arr[i], base) === ult; i--) k++;
  return (ult ? 1 : -1) * k / 10;
}

// movimento: quanto a chance indicada pela odd mudou desde a primeira odd vista
function movimento(alvo, base) {
  const ab = alvo.abertura;
  if (!ab || (ab._visto && alvo.t - ab._visto < 180000)) return [0, 0];
  const agora = probJusta(alvo, base);
  const antes = probJusta({ odds: ab }, base);
  if (!agora || !antes) return [0, 0];
  return [logit(agora) - logit(antes), 1];
}

// arr = jogos da liga em ordem; fim = quantos jogos já são conhecidos; alvo = jogo a prever
function features(arr, fim, alvo, base) {
  const pj = probJusta(alvo, base);
  if (!pj || fim < 30) return null;
  const ant = arr[fim - 1];
  const ang = (2 * Math.PI * (Number(alvo.minuto) || 0)) / 60;
  const angH = (2 * Math.PI * (Number(alvo.hora) || 0)) / 24;
  const [mov, temMov] = movimento(alvo, base);
  const tc = taxaTime(arr, fim, alvo.time_casa, base), tf = taxaTime(arr, fim, alvo.time_fora, base);
  return [
    logit(pj),                                   // 0: o que a odd diz (peso inicial 1)
    1,                                           // 1: viés
    mov, temMov,
    freq(arr, fim, base, 5) - 0.5, freq(arr, fim, base, 10) - 0.5, freq(arr, fim, base, 30) - 0.5,
    sequencia(arr, fim, base),
    ant ? (ant.gc + ant.gf) / 5 : 0,
    ant && ant.gc_ht != null ? (ant.gc_ht + ant.gf_ht) / 3 : 0,
    tc - 0.5, tf - 0.5,
    Math.sin(ang), Math.cos(ang), Math.sin(angH), Math.cos(angH),
    ...LISTA_LIGAS.map((l) => (l === alvo.liga ? 1 : 0)),
  ];
}

function pesoInicial(tam) { const w = new Array(tam).fill(0); w[0] = 1; return w; }

function treinarPesos(amostras, epocas = 6, taxa = 0.01, l2 = 0.002) {
  const w = pesoInicial(amostras[0].x.length);
  for (let ep = 0; ep < epocas; ep++) {
    for (const a of amostras) {
      let z = 0; for (let k = 0; k < w.length; k++) z += a.x[k] * w[k];
      const err = sig(z) - a.y;
      for (let k = 0; k < w.length; k++) {
        const alvoPeso = k === 0 ? 1 : 0;           // "puxa" o modelo de volta para a odd (evita decorar sorte)
        w[k] -= taxa * (err * a.x[k] + l2 * (w[k] - alvoPeso));
      }
    }
  }
  return w;
}

const prob = (w, x) => { let z = 0; for (let k = 0; k < w.length; k++) z += x[k] * (w[k] || 0); return sig(z); };

function logLoss(ps, ys) {
  let s = 0;
  for (let i = 0; i < ps.length; i++) { const p = Math.min(Math.max(ps[i], 1e-6), 1 - 1e-6); s += ys[i] ? -Math.log(p) : -Math.log(1 - p); }
  return ps.length ? s / ps.length : null;
}

// ---------- Previsão (usada pelas regras e pelo robô) ----------
// Retorna a chance (0 a 1) do mercado no jogo alvo, ou null se não houver modelo/odd.
function prever(mercado, arr, alvo, fim) {
  const b = baseDe(mercado);
  if (!b) return null;
  let p = alvo && alvo.id ? oos.get(`${b.base}|${alvo.id}`) : undefined;   // backtest: só previsão fora da amostra
  if (p === undefined) {
    if (alvo && alvo.gc != null) return null;                                // jogo do histórico sem previsão honesta
    const w = pesos[b.base];
    if (!w) return null;
    const x = features(arr, fim ?? arr.length, alvo, b.base);
    if (!x) return null;
    p = prob(w, x);
  }
  return b.inverte ? 1 - p : p;
}

// Análise completa de um jogo para a mensagem do Telegram
// Nos mercados de resultado (1x2) conta vitórias/empates do time; nos de gols, conta o próprio mercado
function contagemTime(arr, time, mercado, n = 10) {
  if (!time) return null;
  const ehResultado = ['casa', 'fora', 'empate'].includes(mercado);
  let qtd = 0, sim = 0;
  for (let k = arr.length - 1, passos = 0; k >= 0 && qtd < n && passos < 300; k--, passos++) {
    const j = arr[k];
    const emCasa = j.time_casa === time;
    if (!emCasa && j.time_fora !== time) continue;
    qtd++;
    if (!ehResultado) { if (bateu(j, mercado)) sim++; }
    else if (mercado === 'empate') { if (j.gc === j.gf) sim++; }
    else if (emCasa ? j.gc > j.gf : j.gf > j.gc) sim++;
  }
  return qtd >= 3 ? { sim, n: qtd, rotulo: !ehResultado ? null : mercado === 'empate' ? 'empatou' : 'venceu' } : null;
}

function analiseJogo(mercado, arr, alvo, seguintes = []) {
  const odd = oddDo(alvo, mercado);
  const pOdd = probJusta(alvo, mercado);
  const pModelo = prever(mercado, arr, alvo);
  const out = {
    pModelo: pModelo != null ? +(pModelo * 100).toFixed(1) : null,
    pOdd: pOdd != null ? +(pOdd * 100).toFixed(1) : null,
    vantagem: pModelo != null && odd ? +((pModelo * odd - 1) * 100).toFixed(1) : null,
    casa: contagemTime(arr, alvo.time_casa, mercado),
    fora: contagemTime(arr, alvo.time_fora, mercado),
    movimento: null,
    chanceTiros: null,
  };
  const ab = alvo.abertura;
  const o0 = ab && MERCADOS[mercado] ? Number(ab[MERCADOS[mercado].odd]) : null;
  if (o0 && odd && (!ab._visto || alvo.t - ab._visto >= 120000) && Math.abs(o0 - odd) >= 0.01) out.movimento = { de: o0, para: odd };
  if (seguintes.length) {
    const ps = [alvo, ...seguintes].map((j) => prever(mercado, arr, j) ?? probJusta(j, mercado));
    if (ps.every((p) => p != null)) out.chanceTiros = +((1 - ps.reduce((q, p) => q * (1 - p), 1)) * 100).toFixed(1);
  }
  return out;
}

const mercadoCoberto = (mercado) => !!baseDe(mercado);

function temModelo(mercado) { const b = baseDe(mercado); return !!(b && pesos[b.base]); }

// ---------- Treino + teste dia a dia ----------
async function treinar() {
  if (estado.rodando) return getConfig('modelo_resultado');
  estado.rodando = true;
  const { defasagem, estatisticas, porDia, classificar } = require('./validador');
  try {
    const margem = Number(getConfig('modelo_margem', 5)) / 100;
    const resultado = { em: new Date().toISOString(), margem: margem * 100, mercados: [], dias: 0 };
    const novosPesos = {};
    oos.clear();
    for (const base of BASE) {
      estado.progresso = MERCADOS[base].nome;
      // monta as amostras de todas as ligas
      const amostras = [];
      for (const liga of LISTA_LIGAS) {
        const arr = jogos.daLiga(liga);
        const d = defasagem(liga);
        for (let i = 30 + d; i < arr.length; i++) {
          const x = features(arr, i - d, arr[i], base);
          if (!x) continue;
          amostras.push({ t: arr[i].t, dia: diaDe(arr[i].t), id: arr[i].id, liga, x, y: bateu(arr[i], base) ? 1 : 0, j: arr[i] });
        }
        await pausa();
      }
      amostras.sort((a, b) => a.t - b.t);
      const dias = [...new Set(amostras.map((a) => a.dia))];
      resultado.dias = Math.max(resultado.dias, dias.length);
      if (amostras.length < 3000 || dias.length < 3) continue;

      // walk-forward: para cada dia a partir do 3º, treina só com os anteriores
      for (let k = 2; k < dias.length; k++) {
        const treino = amostras.filter((a) => a.dia < dias[k]);
        const w = treinarPesos(treino);
        for (const a of amostras) if (a.dia === dias[k]) oos.set(`${base}|${a.id}`, prob(w, a.x));
        await pausa();
      }
      novosPesos[base] = treinarPesos(amostras);

      // avaliação fora da amostra (o mercado base e o complemento)
      const fora = amostras.filter((a) => oos.has(`${base}|${a.id}`));
      const ps = fora.map((a) => oos.get(`${base}|${a.id}`));
      const llModelo = logLoss(ps, fora.map((a) => a.y));
      const llOdds = logLoss(fora.map((a) => a.x && sig(a.x[0])), fora.map((a) => a.y));
      for (const mercado of [base, ...Object.keys(COMPLEMENTO).filter((c) => COMPLEMENTO[c] === base)]) {
        const inv = mercado !== base;
        const entradas = [];
        const porLigaMap = {};
        fora.forEach((a, i) => {
          const p = inv ? 1 - ps[i] : ps[i];
          const odd = oddDo(a.j, mercado);
          if (!odd || p * odd < 1 + margem) return;
          const e = { t: a.t, acerto: bateu(a.j, mercado), odd, pImpl: probJusta(a.j, mercado) ?? 1 / odd };
          entradas.push(e);
          (porLigaMap[a.liga] ||= []).push(e);
        });
        const meio = Math.floor(entradas.length / 2);
        const st = estatisticas(entradas);
        const pd = porDia(entradas);
        const porLiga = Object.fromEntries(Object.entries(porLigaMap).map(([l, es]) => { const x = estatisticas(es); return [l, { n: x.n, taxa: x.taxa, roi: x.roi }]; }));
        resultado.mercados.push({
          mercado, nome: MERCADOS[mercado].nome,
          amostras: fora.length,
          logLossModelo: llModelo != null ? +llModelo.toFixed(4) : null,
          logLossOdds: llOdds != null ? +llOdds.toFixed(4) : null,
          melhora: llModelo && llOdds ? +((1 - llModelo / llOdds) * 100).toFixed(2) : null,
          valor: st,
          dias: { total: pd.total, positivos: pd.positivos },
          status: classificar(estatisticas(entradas.slice(0, meio)), estatisticas(entradas.slice(meio)), { dias: pd }),
          porLiga,
        });
      }
    }
    pesos = novosPesos;
    setConfig('modelo_pesos', pesos);
    resultado.mercados.sort((a, b) => (b.valor.roi ?? -999) - (a.valor.roi ?? -999));
    setConfig('modelo_resultado', resultado);
    estado.em = resultado.em;
    log('info', `Modelo de valor treinado: ${resultado.mercados.length} mercados, ${resultado.dias} dias de dados`);
    return resultado;
  } catch (e) {
    log('erro', `Modelo de valor: ${e.message}`);
    return null;
  } finally {
    estado.rodando = false;
    estado.progresso = '';
  }
}

function situacao() {
  return { rodando: estado.rodando, progresso: estado.progresso, resultado: getConfig('modelo_resultado'),
    margem: Number(getConfig('modelo_margem', 5)), consenso: getConfig('consenso', false) };
}

module.exports = { mercadoCoberto, analiseJogo, prever, temModelo, treinar, situacao, BASE, COMPLEMENTO };
