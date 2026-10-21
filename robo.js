// Robô: coleta os jogos, gera sinais, confere resultados e manda no Telegram.
const { db, getConfig, setConfig, log } = require('./db');
const { LIGAS, MERCADOS, oddDo, bateu } = require('./mercados');
const { avaliar, ligasDaRegra } = require('./regras');
const { backtest } = require('./validador');
const jogos = require('./jogos');
const tson = require('./tsontips');
const tg = require('./telegram');

const TZ = process.env.TZ_EXIBICAO || 'America/Fortaleza';
const LISTA_LIGAS = Object.keys(LIGAS);
const proximas = new Map();        // liga -> jogos agendados
const oddsAgendadas = new Map();   // liga|inicio -> odds vistas antes do jogo
const ultimoAvaliado = new Map();  // liga -> inicio do último alvo avaliado
const estado = { ultimaColeta: null, ultimoErro: null, rodando: false };

const hhmm = (iso) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const hojeLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function pegarOdds(p) {
  const o = {};
  for (const [k, v] of Object.entries(p)) if (k.startsWith('odd_') && v != null && Number(v) > 1) o[k] = Number(v);
  return o;
}

function normalizar(p, liga, comPlacar) {
  if (!p.hora_inicio) return null;
  const inicio = new Date(p.hora_inicio).toISOString();
  const chave = `${liga}|${inicio}`;
  const j = {
    id: chave, liga, inicio, t: Date.parse(inicio),
    hora: Number(p.hora ?? new Date(inicio).getHours()), minuto: parseInt(p.minuto, 10),
    time_casa: p.time_casa, time_fora: p.time_fora,
    odds: { ...(oddsAgendadas.get(chave) || {}), ...pegarOdds(p) },
  };
  if (Number.isNaN(j.minuto)) j.minuto = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, minute: 'numeric' }).format(new Date(inicio)));
  if (comPlacar) {
    if (p.gols_casa == null || p.gols_fora == null) return null;
    Object.assign(j, {
      gc: Number(p.gols_casa), gf: Number(p.gols_fora),
      gc_ht: p.gols_casa_ht == null ? null : Number(p.gols_casa_ht),
      gf_ht: p.gols_fora_ht == null ? null : Number(p.gols_fora_ht),
    });
  }
  return j;
}

const inserir = db.prepare(`INSERT OR IGNORE INTO jogos
  (id, liga, inicio, hora, minuto, time_casa, time_fora, gc, gf, gc_ht, gf_ht, odds)
  VALUES (@id, @liga, @inicio, @hora, @minuto, @time_casa, @time_fora, @gc, @gf, @gc_ht, @gf_ht, @odds)`);

const caminhoColeta = (periodo) => `/api/matches/all?period=${periodo}&leagues=${LISTA_LIGAS.join(',')}&stale=1`;

function periodoAtual() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM jogos').get().n;
  const parado = !estado.ultimaColeta || Date.now() - Date.parse(estado.ultimaColeta) > 50 * 60000;
  return total < 200 ? '120h' : parado ? '24h' : '1h';
}

// Recebe a resposta do TsonTips (vinda do navegador ou do servidor) e grava os jogos novos
function processar(dados) {
  const novos = [];
  const agora = Date.now();
  for (const [liga, bloco] of Object.entries(dados.leagues || {})) {
    if (!LIGAS[liga]) continue;
    // jogos agendados (com odds)
    const prox = [];
    for (const p of bloco.proximas || []) {
      const j = normalizar(p, liga, false);
      if (!j) continue;
      oddsAgendadas.set(j.id, j.odds);
      if (j.t > agora) prox.push(j);
    }
    prox.sort((a, b) => a.t - b.t);
    proximas.set(liga, prox);
    // jogos encerrados
    const fins = (bloco.partidas || []).map((p) => normalizar(p, liga, true)).filter(Boolean).sort((a, b) => a.t - b.t);
    for (const j of fins) {
      const r = inserir.run({ ...j, odds: JSON.stringify(j.odds) });
      if (r.changes) { jogos.adicionar(j); novos.push(j); }
    }
  }
  // limpa odds antigas da memória
  for (const [k] of oddsAgendadas) if (Date.parse(k.split('|')[1]) < agora - 6 * 3600e3) oddsAgendadas.delete(k);
  return novos;
}

// ---------- Resultados dos sinais ----------
const pendentesDoJogo = db.prepare(`SELECT * FROM sinais WHERE status = 'pendente' AND liga = ? AND inicio = ?`);
const fecharSinal = db.prepare(`UPDATE sinais SET status = ?, placar = ?, lucro = ? WHERE id = ?`);

async function conferirResultados(novos) {
  for (const j of novos) {
    for (const s of pendentesDoJogo.all(j.liga, j.inicio)) {
      const ok = bateu(j, s.mercado);
      const lucro = s.odd ? +(ok ? s.odd - 1 : -1).toFixed(2) : null;
      fecharSinal.run(ok ? 'green' : 'red', `${j.gc}-${j.gf}`, lucro, s.id);
      if (s.enviado) {
        const txt = `${ok ? '✅ <b>GREEN</b>' : '❌ <b>RED</b>'} · ${esc(LIGAS[j.liga])} ${hhmm(j.inicio)}\n` +
          `${esc(j.time_casa)} ${j.gc} x ${j.gf} ${esc(j.time_fora)}` +
          (j.gc_ht != null ? ` (1ºT ${j.gc_ht}-${j.gf_ht})` : '') +
          `\n🎯 ${esc(MERCADOS[s.mercado].nome)}` + (lucro != null ? ` · ${lucro > 0 ? '+' : ''}${lucro.toFixed(2)} unid.` : '');
        await tg.enviar(txt, { responderA: s.telegram_msg_id });
      }
    }
  }
  // anula sinais que ficaram sem resultado por mais de 2 horas
  db.prepare(`UPDATE sinais SET status = 'anulado' WHERE status = 'pendente' AND inicio < ?`)
    .run(new Date(Date.now() - 2 * 3600e3).toISOString());
}

// ---------- Geração de sinais ----------
const inserirSinal = db.prepare(`INSERT OR IGNORE INTO sinais
  (regra_id, liga, inicio, time_casa, time_fora, mercado, odd) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const marcarEnviado = db.prepare(`UPDATE sinais SET enviado = 1, telegram_msg_id = ? WHERE id = ?`);

function regrasAtivas() {
  return db.prepare(`SELECT * FROM regras WHERE modo != 'desligado'`).all().map((r) => ({
    ...r, ligas: JSON.parse(r.ligas), condicoes: JSON.parse(r.condicoes), validacao: r.validacao ? JSON.parse(r.validacao) : null,
  }));
}

async function gerarSinais() {
  const regras = regrasAtivas();
  if (!regras.length) return;
  const exigirAprovacao = getConfig('exigir_aprovacao', true);
  const agora = Date.now();
  for (const liga of LISTA_LIGAS) {
    const hist = jogos.daLiga(liga);
    if (!hist.length) continue;
    const ultimo = hist[hist.length - 1];
    const intervalo = jogos.intervaloTipico(hist);
    const alvo = (proximas.get(liga) || []).find((p) => p.t > ultimo.t);
    if (!alvo || alvo.t - ultimo.t > intervalo * 1.6 || alvo.t - agora < 10000) continue;
    if (ultimoAvaliado.get(liga) === alvo.inicio) continue;
    ultimoAvaliado.set(liga, alvo.inicio);

    const janela = hist.slice(-60);
    for (const regra of regras) {
      if (!ligasDaRegra(regra, LISTA_LIGAS).includes(liga)) continue;
      if (!avaliar(regra, janela, alvo)) continue;
      const odd = oddDo(alvo, regra.mercado);
      const r = inserirSinal.run(regra.id, liga, alvo.inicio, alvo.time_casa, alvo.time_fora, regra.mercado, odd);
      if (!r.changes) continue;
      const aprovada = regra.validacao && regra.validacao.status && regra.validacao.status.codigo === 'aprovada';
      if (regra.modo !== 'telegram' || (exigirAprovacao && !aprovada)) continue;

      const v = regra.validacao && regra.validacao.teste;
      const txt = `🔔 <b>SINAL · Kiron ${esc(LIGAS[liga])}</b>\n` +
        `⚽ ${esc(alvo.time_casa)} x ${esc(alvo.time_fora)}\n` +
        `🕐 ${hhmm(alvo.inicio)}\n` +
        `🎯 <b>${esc(MERCADOS[regra.mercado].nome)}</b>` + (odd ? ` · odd ${odd.toFixed(2)}` : '') + '\n' +
        `📋 ${esc(regra.nome)}` +
        (v && v.n ? `\n📊 No teste: ${v.taxa}% de acerto em ${v.n} entradas (ROI ${v.roi}%)` : '');
      const msgId = await tg.enviar(txt);
      if (msgId) marcarEnviado.run(msgId, r.lastInsertRowid);
    }
  }
}

// ---------- Validação periódica ----------
function revalidarTodas() {
  const rows = db.prepare('SELECT * FROM regras').all();
  const upd = db.prepare('UPDATE regras SET validacao = ? WHERE id = ?');
  for (const r of rows) {
    try {
      const regra = { ...r, ligas: JSON.parse(r.ligas), condicoes: JSON.parse(r.condicoes) };
      upd.run(JSON.stringify(backtest(regra)), r.id);
    } catch (e) { log('erro', `Validação da regra ${r.id}: ${e.message}`); }
  }
}

// ---------- Relatório diário ----------
function textoRelatorio(dia = hojeLocal()) {
  const ini = new Date(`${dia}T00:00:00-03:00`).toISOString();
  const fim = new Date(Date.parse(ini) + 86400e3).toISOString();
  const linhas = db.prepare(`SELECT r.nome, s.status, s.lucro, s.enviado FROM sinais s JOIN regras r ON r.id = s.regra_id
    WHERE s.inicio >= ? AND s.inicio < ? AND s.status IN ('green','red')`).all(ini, fim);
  if (!linhas.length) return `📊 <b>Relatório ${dia.split('-').reverse().join('/')}</b>\nNenhum sinal conferido hoje.`;
  const porRegra = {};
  for (const l of linhas) {
    const p = (porRegra[l.nome] ||= { g: 0, r: 0, lucro: 0, env: 0 });
    l.status === 'green' ? p.g++ : p.r++;
    p.lucro += l.lucro || 0;
    if (l.enviado) p.env++;
  }
  let txt = `📊 <b>Relatório ${dia.split('-').reverse().join('/')}</b>\n`;
  let tg2 = 0, tr = 0, tl = 0;
  for (const [nome, p] of Object.entries(porRegra)) {
    const taxa = ((p.g / (p.g + p.r)) * 100).toFixed(0);
    txt += `\n<b>${esc(nome)}</b>${p.env ? '' : ' (observação)'}\n✅ ${p.g}  ❌ ${p.r}  · ${taxa}% · ${p.lucro >= 0 ? '+' : ''}${p.lucro.toFixed(2)} unid.\n`;
    tg2 += p.g; tr += p.r; tl += p.lucro;
  }
  txt += `\n<b>Total:</b> ✅ ${tg2}  ❌ ${tr} · ${((tg2 / (tg2 + tr)) * 100).toFixed(0)}% · ${tl >= 0 ? '+' : ''}${tl.toFixed(2)} unid.`;
  return txt;
}

async function talvezRelatorio() {
  const agora = new Date();
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(agora);
  const dia = hojeLocal();
  if (hm >= '23:55' && getConfig('ultimo_relatorio') !== dia) {
    setConfig('ultimo_relatorio', dia);
    await tg.enviar(textoRelatorio(dia));
  }
}

// ---------- Laço principal ----------
async function aposColeta(novos, periodo) {
  estado.ultimaColeta = new Date().toISOString();
  estado.ultimoErro = null;
  if (getConfig('tson_alerta_enviado')) setConfig('tson_alerta_enviado', false);
  if (periodo !== '1h') log('info', `Coleta (${periodo}): ${novos.length} jogos novos`);
  if (novos.length) {
    await conferirResultados(novos);
    if (periodo !== '1h') revalidarTodas();
  }
  await gerarSinais();
  await talvezRelatorio();
}

// Coleta feita no navegador (o TsonTips só aceita a sessão no seu aparelho/IP)
async function receber(dados) {
  if (!dados || typeof dados !== 'object' || !dados.leagues) throw new Error('Resposta do TsonTips sem dados de jogos');
  if (estado.rodando) throw new Error('Painel ocupado, tente de novo em instantes');
  estado.rodando = true;
  try {
    const periodo = periodoAtual();
    const novos = processar(dados);
    await aposColeta(novos, periodo);
    return { novos: novos.length };
  } catch (e) {
    estado.ultimoErro = e.message;
    log('erro', `Coleta: ${e.message}`);
    throw e;
  } finally {
    estado.rodando = false;
  }
}

// Modo antigo (o servidor busca sozinho). Só funciona se o TsonTips aceitar o IP do servidor.
async function cicloServidor() {
  if (estado.rodando) return;
  estado.rodando = true;
  try {
    const periodo = periodoAtual();
    const novos = processar(await tson.api(caminhoColeta(periodo)));
    await aposColeta(novos, periodo);
  } catch (e) {
    estado.ultimoErro = e.message;
    log('erro', `Coleta: ${e.message}`);
    if (e instanceof tson.SessaoExpirada && !getConfig('tson_alerta_enviado')) {
      setConfig('tson_alerta_enviado', true);
      await tg.enviar('⚠️ <b>A sessão do TsonTips caiu.</b>');
    }
  } finally {
    estado.rodando = false;
  }
}

// Vigia o coletor do navegador e avisa se ele parar
async function ciclo() {
  if (process.env.COLETA_SERVIDOR === '1') return cicloServidor();
  try {
    const parado = !estado.ultimaColeta || Date.now() - Date.parse(estado.ultimaColeta) > 10 * 60000;
    if (parado) {
      estado.ultimoErro = 'Coletor parado. Abra o TsonTips (logado) e toque no favorito Lab Sinais.';
      if (estado.ultimaColeta && !getConfig('tson_alerta_enviado')) {
        setConfig('tson_alerta_enviado', true);
        await tg.enviar('⚠️ <b>O coletor parou.</b>\nAbra o TsonTips (logado) e toque no favorito Lab Sinais. Até lá, não há coleta nem sinais.');
      }
    }
    await talvezRelatorio();
  } catch (e) { log('erro', `Vigia: ${e.message}`); }
}

function iniciar() {
  jogos.carregar();
  const seg = Math.max(30, Number(process.env.COLETA_INTERVALO) || 60);
  tg.registrarComandos({
    '/status': async () => {
      const n = db.prepare('SELECT COUNT(*) AS n FROM jogos').get().n;
      return `🤖 Robô ligado\nJogos no banco: ${n}\nÚltima coleta: ${estado.ultimaColeta ? hhmm(estado.ultimaColeta) : 'ainda não'}` +
        (estado.ultimoErro ? `\n⚠️ Último erro: ${esc(estado.ultimoErro)}` : '');
    },
    '/hoje': async () => textoRelatorio(),
  });
  tg.escutar();
  ciclo();
  setInterval(ciclo, seg * 1000);
  setInterval(revalidarTodas, 30 * 60000);
  setTimeout(revalidarTodas, 20000);
  log('info', `Robô iniciado (coleta a cada ${seg}s)`);
}

module.exports = { iniciar, ciclo, receber, caminhoColeta, periodoAtual, estado, revalidarTodas, textoRelatorio, proximas };
