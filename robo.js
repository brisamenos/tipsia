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
// ---------- Mensagem do sinal ----------
function textoSinal(s, regra, extra = '') {
  const v = regra && regra.validacao;
  const aoVivo = v && v.aoVivo && v.aoVivo.n >= 20 ? v.aoVivo : null;
  const teste = v && v.teste && v.teste.n ? v.teste : null;
  const tiros = s.tiros_max || 1;
  let t = `🔔 <b>SINAL · Kiron ${esc(LIGAS[s.liga])}</b>\n` +
    `⚽ ${esc(s.time_casa)} x ${esc(s.time_fora)}\n` +
    `🕐 Entrada: <b>${hhmm(s.inicio)}</b>` + (tiros > 1 ? ` (até ${tiros} tiros)` : '') + '\n' +
    `🎯 <b>${esc(MERCADOS[s.mercado].nome)}</b>` + (s.odd ? ` · odd <b>${Number(s.odd).toFixed(2)}</b>` : '') + '\n';
  if (aoVivo) t += `📊 Assertividade ao vivo: <b>${aoVivo.taxa}%</b> (${aoVivo.n} sinais)\n`;
  else if (teste) t += `📊 Assertividade no histórico: <b>${teste.taxa}%</b> (${teste.n} sinais` + (tiros > 1 ? `, com ${tiros} tiros` : '') + ')\n';
  t += `📋 ${esc(regra ? regra.nome : '')}`;
  return t + extra;
}

function linhasHistorico(hist, final) {
  let t = '\n━━━━━━━━━━━━━━━';
  for (const h of hist) {
    const placar = `${esc(h.casa)} ${h.gc}x${h.gf} ${esc(h.fora)}`;
    t += h.ok
      ? `\n✅ <b>GREEN${h.tiro > 1 ? ` no ${h.tiro}º tiro` : ''}</b> · ${hhmm(h.inicio)} · ${placar}` + (h.odd ? ` · odd ${Number(h.odd).toFixed(2)}` : '')
      : `\n❌ ${h.tiro}º tiro · ${hhmm(h.inicio)} · ${placar}` + (h.odd ? ` · odd ${Number(h.odd).toFixed(2)}` : '');
  }
  if (final === 'red') t += '\n🔴 <b>RED</b>';
  else if (final === 'proximo') t += `\n⏭️ Indo para o ${hist.length + 1}º tiro`;
  return t;
}

// ---------- Resultados dos sinais (com tiros) ----------
const pendentesDaLiga = db.prepare(`SELECT * FROM sinais WHERE status = 'pendente' AND liga = ?`);
const atualizarSinal = db.prepare(`UPDATE sinais SET status = @status, placar = @placar, lucro = @lucro,
  tiro_atual = @tiro_atual, tiro_green = @tiro_green, alvo_inicio = @alvo_inicio, odd_atual = @odd_atual, historico = @historico WHERE id = @id`);
const regraPorId = db.prepare('SELECT * FROM regras WHERE id = ?');

function proximoJogoDepois(liga, t) {
  const p = (proximas.get(liga) || []).find((x) => x.t > t);
  if (p) return p;
  const arr = jogos.daLiga(liga);
  const iv = jogos.intervaloTipico(arr);
  return { inicio: new Date(t + iv).toISOString(), t: t + iv, estimado: true, odds: {} };
}

async function conferirResultados(novos) {
  const porLiga = {};
  for (const j of novos) (porLiga[j.liga] ||= []).push(j);
  for (const [liga, lista] of Object.entries(porLiga)) {
    lista.sort((a, b) => a.t - b.t);
    for (const j of lista) {
      for (const s of pendentesDaLiga.all(liga)) {
        const alvo = s.alvo_inicio || s.inicio;
        const tiro = s.tiro_atual || 1;
        const hist = s.historico ? JSON.parse(s.historico) : [];
        // 1º tiro: precisa ser exatamente o jogo do sinal; tiros seguintes: o primeiro jogo depois do anterior
        const ehAlvo = tiro === 1 || !hist.length ? j.inicio === alvo
          : j.t > Date.parse(hist[hist.length - 1].inicio) && j.t <= Date.parse(alvo) + 90000;
        if (!ehAlvo) continue;
        const odd = oddDo(j, s.mercado) || (tiro === 1 ? s.odd : null);
        const ok = bateu(j, s.mercado);
        hist.push({ tiro, inicio: j.inicio, casa: j.time_casa, fora: j.time_fora, gc: j.gc, gf: j.gf, odd, ok });
        const perdas = hist.filter((h) => !h.ok).length;
        const semOdd = hist.some((h) => !h.odd);
        let final, prox = null;
        if (ok) final = 'green';
        else if (tiro < (s.tiros_max || 1)) { final = 'proximo'; prox = proximoJogoDepois(liga, j.t); }
        else final = 'red';
        const lucro = final === 'proximo' || semOdd ? null : +((ok ? odd - 1 : 0) - perdas).toFixed(2);
        atualizarSinal.run({
          id: s.id,
          status: final === 'proximo' ? 'pendente' : final,
          placar: `${j.gc}-${j.gf}`,
          lucro,
          tiro_atual: final === 'proximo' ? tiro + 1 : tiro,
          tiro_green: ok ? tiro : null,
          alvo_inicio: prox ? prox.inicio : alvo,
          odd_atual: prox ? oddDo(prox, s.mercado) : odd,
          historico: JSON.stringify(hist),
        });
        if (s.enviado && s.telegram_msg_id) {
          const base = s.texto || textoSinal(s, null);
          await tg.editar(s.telegram_msg_id, base + linhasHistorico(hist, final), s.chat_id);
        }
      }
    }
  }
  // anula sinais que ficaram sem resultado por mais de 2 horas
  db.prepare(`UPDATE sinais SET status = 'anulado' WHERE status = 'pendente' AND COALESCE(alvo_inicio, inicio) < ?`)
    .run(new Date(Date.now() - 2 * 3600e3).toISOString());
}

// ---------- Geração de sinais ----------
const inserirSinal = db.prepare(`INSERT OR IGNORE INTO sinais
  (regra_id, liga, inicio, time_casa, time_fora, mercado, odd, tiros_max, tiro_atual, alvo_inicio)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
const marcarEnviado = db.prepare(`UPDATE sinais SET enviado = 1, telegram_msg_id = ?, texto = ?, chat_id = ? WHERE id = ?`);
const temPendente = db.prepare(`SELECT 1 FROM sinais WHERE regra_id = ? AND liga = ? AND status = 'pendente' LIMIT 1`);

function regrasAtivas() {
  return db.prepare(`SELECT * FROM regras WHERE modo IN ('observacao','telegram')`).all().map((r) => ({
    ...r, ligas: JSON.parse(r.ligas), condicoes: JSON.parse(r.condicoes), validacao: r.validacao ? JSON.parse(r.validacao) : null,
  }));
}

// aprende quantos jogos ficam "no escuro" em cada liga, para o histórico simular igual ao ao vivo
function registrarDefasagem(liga, d) {
  const c = getConfig('defasagem_' + liga) || {};
  const obj = typeof c === 'object' ? c : {};
  obj[d] = (obj[d] || 0) + 1;
  const tot = Object.values(obj).reduce((a, b) => a + b, 0);
  if (tot > 200) for (const k of Object.keys(obj)) obj[k] = Math.round(obj[k] / 2);
  setConfig('defasagem_' + liga, obj);
}

const avisosBloqueio = new Map();
async function gerarSinais() {
  const regras = regrasAtivas();
  if (!regras.length) return;
  if (!estado.ultimaColeta || Date.now() - Date.parse(estado.ultimaColeta) > 90000) return; // dados velhos
  const exigirTeste = getConfig('exigir_aprovacao_teste', false);
  const antec = Math.max(30, Number(getConfig('antecedencia_seg', 60))) * 1000;
  const agora = Date.now();
  for (const liga of LISTA_LIGAS) {
    const hist = jogos.daLiga(liga);
    if (hist.length < 30) continue;
    const ultimo = hist[hist.length - 1];
    const iv = jogos.intervaloTipico(hist);
    // próximo jogo que começa daqui a ~1 minuto (antecedência configurada)
    const alvo = (proximas.get(liga) || []).find((p) => p.t - agora >= Math.min(antec, 40000) && p.t > ultimo.t);
    if (!alvo || alvo.t - agora > antec + 45000) continue;
    const d = Math.round((alvo.t - ultimo.t) / iv) - 1;
    if (d < 0 || d > 2) continue;
    if (ultimoAvaliado.get(liga) === alvo.inicio) continue;
    ultimoAvaliado.set(liga, alvo.inicio);
    registrarDefasagem(liga, d);

    for (const regra of regras) {
      if (!ligasDaRegra(regra, LISTA_LIGAS).includes(liga)) continue;
      if (temPendente.get(regra.id, liga)) continue;          // ainda nos tiros do sinal anterior
      if (!avaliar(regra, hist, alvo)) continue;
      const odd = oddDo(alvo, regra.mercado);
      const tiros = Math.min(3, Math.max(1, Number(regra.tiros) || 1));
      const r = inserirSinal.run(regra.id, liga, alvo.inicio, alvo.time_casa, alvo.time_fora, regra.mercado, odd, tiros, alvo.inicio);
      if (!r.changes || regra.modo !== 'telegram') continue;
      const aprovada = regra.validacao && regra.validacao.status && regra.validacao.status.codigo === 'aprovada';
      if (exigirTeste && !aprovada) {
        if (Date.now() - (avisosBloqueio.get(regra.id) || 0) > 3600e3) {
          avisosBloqueio.set(regra.id, Date.now());
          log('info', `Sinal da regra "${regra.nome}" não enviado: ela não está aprovada no teste (opção ligada em Configurações)`);
        }
        continue;
      }
      const s = { liga, inicio: alvo.inicio, time_casa: alvo.time_casa, time_fora: alvo.time_fora, mercado: regra.mercado, odd, tiros_max: tiros };
      const txt = textoSinal(s, regra);
      const msgId = await tg.enviar(txt);
      if (msgId) marcarEnviado.run(msgId, txt, String(tg.chatId()), r.lastInsertRowid);
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
