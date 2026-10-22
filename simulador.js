// Simulador de banca: aposta "de mentira" em cada sinal enviado no Telegram,
// com valor fixo ou % da banca, stop do dia e saldo em tempo real. Nenhum dinheiro de verdade.
const { db, getConfig, setConfig, log } = require('./db');

const PADRAO = { ativo: false, bancaInicial: 100, modo: 'percentual', valor: 1, percentual: 1, stopLossDia: 10, stopGainDia: 0, inicio: null };

function cfg() { return { ...PADRAO, ...(getConfig('simulador', {}) || {}) }; }

function salvar(novo) {
  const c = { ...cfg(), ...novo };
  c.bancaInicial = Math.max(1, Number(c.bancaInicial) || 100);
  c.valor = Math.max(0.01, Number(c.valor) || 1);
  c.percentual = Math.min(20, Math.max(0.1, Number(c.percentual) || 1));
  c.stopLossDia = Math.min(100, Math.max(0, Number(c.stopLossDia) || 0));
  c.stopGainDia = Math.min(500, Math.max(0, Number(c.stopGainDia) || 0));
  c.modo = c.modo === 'fixo' ? 'fixo' : 'percentual';
  c.ativo = !!c.ativo;
  if (c.ativo && !c.inicio) c.inicio = new Date().toISOString();
  setConfig('simulador', c);
  return c;
}

function reiniciar() {
  const c = salvar({ inicio: new Date().toISOString() });
  setConfig('sim_aviso', null);
  log('info', `Simulador reiniciado com banca de R$ ${c.bancaInicial.toFixed(2)}`);
  return c;
}

const r2 = (x) => Math.round(x * 100) / 100;
const reais = (x) => 'R$ ' + Number(x || 0).toFixed(2).replace('.', ',');
const sinal = (x) => (x >= 0 ? '+' : '−') + reais(Math.abs(x));
const pctTxt = (x) => (x >= 0 ? '+' : '−') + String(Math.abs(x)).replace('.', ',') + '%';
// início do dia no horário de Brasília (UTC-3)
function inicioDoDia(t = Date.now()) {
  const d = new Date(t - 3 * 3600e3);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 3 * 3600e3).toISOString();
}

function somaLucro(desde, ate = null) {
  const c = cfg();
  if (!c.inicio) return 0;
  const de = desde && desde > c.inicio ? desde : c.inicio;
  const row = ate
    ? db.prepare(`SELECT COALESCE(SUM(sim_lucro),0) AS s FROM sinais WHERE sim_lucro IS NOT NULL AND inicio >= ? AND inicio < ?`).get(de, ate)
    : db.prepare(`SELECT COALESCE(SUM(sim_lucro),0) AS s FROM sinais WHERE sim_lucro IS NOT NULL AND inicio >= ?`).get(de);
  return row.s || 0;
}

function banca() { return r2(cfg().bancaInicial + somaLucro(null)); }
function lucroHoje() { return r2(somaLucro(inicioDoDia())); }
function bancaInicioDia() { return r2(banca() - lucroHoje()); }

// O stop do dia foi atingido? Retorna o motivo ou null
function stopDoDia() {
  const c = cfg();
  const base = bancaInicioDia(), hoje = lucroHoje();
  if (c.stopLossDia > 0 && hoje <= -(base * c.stopLossDia) / 100) return `stop loss do dia (−${c.stopLossDia}%)`;
  if (c.stopGainDia > 0 && hoje >= (base * c.stopGainDia) / 100) return `stop gain do dia (+${c.stopGainDia}%)`;
  return null;
}

// Valor de cada tiro para um sinal novo, ou { valor: null, motivo } se não for simular
function entrada(tiros = 1) {
  const c = cfg();
  if (!c.ativo || !c.inicio) return { valor: null, motivo: 'simulador desligado' };
  const stop = stopDoDia();
  if (stop) return { valor: null, motivo: stop };
  const v = c.modo === 'fixo' ? c.valor : r2(Math.max(0.01, (bancaInicioDia() * c.percentual) / 100));
  const emJogo = db.prepare(`SELECT COALESCE(SUM(sim_valor * tiros_max),0) AS s FROM sinais WHERE status = 'pendente' AND sim_valor IS NOT NULL`).get().s || 0;
  if (banca() - emJogo < v * tiros) return { valor: null, motivo: 'banca sem saldo' };
  return { valor: v, banca: banca() };
}

// Avisa uma vez por dia quando o stop é atingido ou a banca acaba
async function avisar(tg) {
  const c = cfg();
  if (!c.ativo) return;
  const dia = inicioDoDia();
  const motivo = banca() <= 0.01 ? 'banca zerada' : stopDoDia();
  if (!motivo) return;
  const chave = `${dia}|${motivo}`;
  if (getConfig('sim_aviso') === chave) return;
  setConfig('sim_aviso', chave);
  const hoje = lucroHoje();
  await tg.enviar(`💼 <b>SIMULADOR · ${motivo.toUpperCase()}</b>\n\nResultado de hoje: <b>${sinal(hoje)}</b>\nBanca: <b>${reais(banca())}</b>\n\n`
    + (motivo === 'banca zerada' ? 'A simulação parou. Reinicie no painel (aba Simulador) para começar de novo.' : 'Os próximos sinais de hoje continuam chegando, mas não entram na simulação até amanhã.'));
}

function resumo() {
  const c = cfg();
  const rows = c.inicio ? db.prepare(`SELECT s.id, s.inicio, s.liga, s.mercado, s.status, s.sim_valor, s.sim_lucro, s.tiros_max, s.tiro_green, s.tiro_atual, s.odd, r.nome AS regra
    FROM sinais s LEFT JOIN regras r ON r.id = s.regra_id WHERE s.sim_valor IS NOT NULL AND s.inicio >= ? ORDER BY s.inicio`).all(c.inicio) : [];
  let saldo = c.bancaInicial, pico = saldo, maiorQueda = 0, apostado = 0, g = 0, rd = 0;
  const serie = [{ t: c.inicio, banca: r2(saldo) }];
  for (const s of rows) {
    if (s.sim_lucro == null) continue;
    saldo += s.sim_lucro;
    apostado += s.sim_valor * (s.status === 'green' ? (s.tiro_green || 1) : (s.tiro_atual || s.tiros_max || 1));
    s.status === 'green' ? g++ : rd++;
    pico = Math.max(pico, saldo);
    maiorQueda = Math.max(maiorQueda, pico - saldo);
    serie.push({ t: s.inicio, banca: r2(saldo) });
  }
  const total = r2(saldo - c.bancaInicial);
  return {
    config: c,
    banca: r2(saldo),
    lucroTotal: total,
    lucroTotalPct: r2((total / c.bancaInicial) * 100),
    lucroHoje: lucroHoje(),
    bancaInicioDia: bancaInicioDia(),
    apostado: r2(apostado),
    roi: apostado ? r2((total / apostado) * 100) : null,
    greens: g, reds: rd,
    emAndamento: rows.filter((s) => s.status === 'pendente').length,
    maiorQueda: r2(maiorQueda),
    maiorQuedaPct: r2((maiorQueda / Math.max(pico, 1)) * 100),
    stop: c.ativo ? stopDoDia() : null,
    proximaEntrada: c.ativo ? entrada(1).valor : null,
    serie: serie.slice(-500),
    ultimas: rows.slice(-60).reverse(),
  };
}

function textoRelatorio(dia) {
  const c = cfg();
  if (!c.ativo || !c.inicio) return '';
  const ini = new Date(`${dia}T00:00:00-03:00`).toISOString();
  const fim = new Date(Date.parse(ini) + 86400e3).toISOString();
  const doDia = r2(somaLucro(ini, fim));
  const bancaFim = r2(c.bancaInicial + somaLucro(null, fim));
  const bancaIni = r2(bancaFim - doDia);
  const pct = bancaIni ? r2((doDia / bancaIni) * 100) : 0;
  const total = r2(bancaFim - c.bancaInicial);
  return `\n\n💼 <b>Simulador de banca</b>\nBanca no início do dia: ${reais(bancaIni)}\nResultado do dia: <b>${sinal(doDia)}</b> (${pctTxt(pct)})\nBanca agora: <b>${reais(bancaFim)}</b>\nDesde o início: ${sinal(total)} (${pctTxt(r2((total / c.bancaInicial) * 100))})`;
}

module.exports = { sinal, cfg, salvar, reiniciar, entrada, banca, avisar, resumo, textoRelatorio, reais };
