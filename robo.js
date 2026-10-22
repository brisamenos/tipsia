// Robô: coleta os jogos, gera sinais, confere resultados e manda no Telegram.
const { db, getConfig, setConfig, log } = require('./db');
const { LIGAS, MERCADOS, oddDo, bateu } = require('./mercados');
const { avaliar, ligasDaRegra } = require('./regras');
const { backtest, aoVivo, estatRed } = require('./validador');
const jogos = require('./jogos');
const tson = require('./tsontips');
const tg = require('./telegram');
const modelo = require('./modelo');
const sim = require('./simulador');

const TZ = process.env.TZ_EXIBICAO || 'America/Fortaleza';
const LISTA_LIGAS = Object.keys(LIGAS);
const proximas = new Map();        // liga -> jogos agendados
const oddsAgendadas = new Map();   // liga|inicio -> odds vistas antes do jogo (as mais recentes)
const oddsAbertura = new Map();    // liga|inicio -> primeira odd vista (movimento)
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
  (id, liga, inicio, hora, minuto, time_casa, time_fora, gc, gf, gc_ht, gf_ht, odds, odds_abertura)
  VALUES (@id, @liga, @inicio, @hora, @minuto, @time_casa, @time_fora, @gc, @gf, @gc_ht, @gf_ht, @odds, @odds_abertura)`);

// "stale=1" devolve uma cópia em cache, atrasada 1-2 jogos. Só serve para carregar o histórico longo;
// a coleta do dia a dia (1h) precisa dos dados frescos para o sinal sair a tempo.
const caminhoColeta = (periodo) =>
  `/api/matches/all?period=${periodo}&leagues=${LISTA_LIGAS.join(',')}` + (periodo === '1h' ? '' : '&stale=1');

// Se faltou algum jogo nas últimas horas (coleta caiu e voltou), busca as últimas 24h para tapar o buraco
let ultimoReparo = 0;
function temBuraco() {
  const agora = Date.now();
  for (const liga of LISTA_LIGAS) {
    const arr = jogos.daLiga(liga);
    if (arr.length < 30) continue;
    const iv = jogos.intervaloTipico(arr);
    // parou de chegar jogo, mas a liga continua com jogos agendados (ligas que "dormem" à noite não contam)
    if ((proximas.get(liga) || []).length && agora - arr[arr.length - 1].t > iv * 4 + 120000) return true;
    for (let i = arr.length - 1; i > 0 && agora - arr[i].t < 3 * 3600e3; i--) {
      if (arr[i].t - arr[i - 1].t > iv * 2.5) return true;                       // buraco no meio
    }
  }
  return false;
}

function periodoAtual() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM jogos').get().n;
  if (total < 200) return '120h';
  const parado = !estado.ultimaColeta || Date.now() - Date.parse(estado.ultimaColeta) > 50 * 60000;
  if (parado) return '24h';
  if (Date.now() - ultimoReparo > 10 * 60000 && temBuraco()) { ultimoReparo = Date.now(); return '24h'; }
  return '1h';
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
      if (!oddsAbertura.has(j.id) && Object.keys(j.odds).length) oddsAbertura.set(j.id, { ...j.odds, _visto: agora });
      j.abertura = oddsAbertura.get(j.id) || null;
      if (j.t > agora) prox.push(j);
    }
    prox.sort((a, b) => a.t - b.t);
    proximas.set(liga, prox);
    // jogos encerrados
    const fins = (bloco.partidas || []).map((p) => normalizar(p, liga, true)).filter(Boolean).sort((a, b) => a.t - b.t);
    for (const j of fins) {
      const ab = oddsAbertura.get(j.id);
      // só vale como "abertura" se foi vista pelo menos 3 minutos antes do jogo
      j.abertura = ab && j.t - ab._visto >= 180000 ? ab : null;
      const r = inserir.run({ ...j, odds: JSON.stringify(j.odds), odds_abertura: j.abertura ? JSON.stringify(j.abertura) : null });
      if (r.changes) { jogos.adicionar(j); novos.push(j); }
    }
  }
  // limpa odds antigas da memória
  for (const [k] of oddsAgendadas) if (Date.parse(k.split('|')[1]) < agora - 6 * 3600e3) oddsAgendadas.delete(k);
  for (const [k] of oddsAbertura) if (Date.parse(k.split('|')[1]) < agora - 6 * 3600e3) oddsAbertura.delete(k);
  return novos;
}

// ---------- Resultados dos sinais ----------
// ---------- Mensagem do sinal (montada inteira a cada atualização) ----------
const LINHA = '━━━━━━━━━━━━━━━━';
const fmtOdd = (o) => (o ? `@${Number(o).toFixed(2)}` : '');

// Dados fixos do sinal guardados no envio: assertividade e nome da estratégia
function redsAoVivo(regraId) {
  const rows = db.prepare(`SELECT status, inicio, alvo_inicio, historico FROM sinais
    WHERE regra_id = ? AND status IN ('green','red') ORDER BY inicio`).all(regraId);
  return estatRed(rows.map((r) => {
    let fim = r.alvo_inicio || r.inicio;
    try { const h = JSON.parse(r.historico || '[]'); if (h.length) fim = h[h.length - 1].inicio; } catch { /* ok */ }
    return { t: Date.parse(r.inicio), tr: Date.parse(fim), acerto: r.status === 'green' };
  }));
}

function metaDaRegra(regra) {
  const v = regra && regra.validacao;
  const aoVivo = v && v.aoVivo && v.aoVivo.n >= 20 ? v.aoVivo : null;
  const base = aoVivo || (v && v.teste && v.teste.n ? v.teste : null);
  const reds = aoVivo && regra.id ? redsAoVivo(regra.id) : (v && v.reds) || null;
  return {
    nome: regra ? regra.nome : '',
    taxa: base ? base.taxa : null,
    n: base ? base.n : null,
    roi: base ? base.roi : null,
    fonte: aoVivo ? 'ao vivo' : 'histórico',
    reds: reds && reds.n ? { ultimos: reds.ultimos, cada: reds.cada, maiorSeqRed: reds.maiorSeqRed, total: reds.reds,
      maiorSeqGreen: reds.maiorSeqGreen, seqAtual: reds.seqAtual } : null,
  };
}

// "13:42" se foi hoje, "20/10 13:42" se foi outro dia
function quando(iso) {
  const dia = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
  const d = dia.format(new Date(iso));
  return d === dia.format(new Date()) ? hhmm(iso) : `${d} ${hhmm(iso)}`;
}

// Os jogos de cada tiro, já conhecidos no momento do envio
function planoDeTiros(liga, alvo, tiros, mercado) {
  const lista = [alvo, ...(proximas.get(liga) || []).filter((p) => p.t > alvo.t)].slice(0, tiros);
  const iv = jogos.intervaloTipico(jogos.daLiga(liga));
  while (lista.length < tiros) {
    const ult = lista[lista.length - 1];
    lista.push({ inicio: new Date(ult.t + iv).toISOString(), t: ult.t + iv, time_casa: null, time_fora: null, odds: {} });
  }
  return lista.map((j) => ({ inicio: j.inicio, casa: j.time_casa, fora: j.time_fora, odd: oddDo(j, mercado) }));
}

// final: null (aguardando) | 'proximo' | 'green' | 'red'
function montarMensagem({ liga, mercado, tiros, plano, hist = [], final = null, meta = {} }) {
  const titulo = final === 'green' ? '✅ <b>GREEN' + (hist.length > 1 ? ` NO ${hist.length}º TIRO` : '') + '</b>'
    : final === 'red' ? '🔴 <b>RED</b>'
    : '🚨 <b>SINAL CONFIRMADO</b>';

  let t = `${titulo}\n\n`;
  t += `🏆 <b>Kiron · ${esc(LIGAS[liga])}</b>\n`;
  t += `🎯 <b>${esc(MERCADOS[mercado].nome)}</b>\n`;
  t += `${LINHA}\n`;
  t += tiros > 1 ? `⚽ <b>ENTRADAS (até ${tiros} tiros)</b>\n` : '⚽ <b>ENTRADA</b>\n';

  for (let i = 0; i < tiros; i++) {
    const h = hist[i];
    const p = plano[i] || {};
    const rotulo = tiros > 1 ? `${i + 1}º tiro · ` : '';
    if (h) {
      t += `${h.ok ? '✅' : '❌'} ${rotulo}<b>${hhmm(h.inicio)}</b> · ${esc(h.casa)} <b>${h.gc}x${h.gf}</b> ${esc(h.fora)} ${fmtOdd(h.odd)}\n`;
    } else if (final === 'green' || final === 'red') {
      t += `➖ ${rotulo}${hhmm(p.inicio)} · não foi necessário\n`;
    } else {
      const atual = i === hist.length;
      const jogo = p.casa ? `${esc(p.casa)} x ${esc(p.fora)}` : 'jogo seguinte';
      t += `${atual ? '⏳' : '▫️'} ${rotulo}<b>${hhmm(p.inicio)}</b> · ${jogo} ${fmtOdd(p.odd)}\n`;
    }
  }

  t += `${LINHA}\n`;
  const a = meta.analise;
  if (a) {
    const linhas = [];
    if (a.pModelo != null) linhas.push(`• Chance pelo modelo: <b>${a.pModelo}%</b>` + (a.pOdd != null ? ` · pela odd: ${a.pOdd}%` : ''));
    else if (a.pOdd != null) linhas.push(`• Chance pela odd: <b>${a.pOdd}%</b> (modelo ainda em treino)`);
    if (a.vantagem != null) linhas.push(a.vantagem >= 0 ? `• Vantagem sobre a odd: <b>+${a.vantagem}%</b> ✅` : `• Vantagem sobre a odd: <b>${a.vantagem}%</b> ⚠️`);
    if (a.chanceTiros != null && tiros > 1) linhas.push(`• Chance de green em até ${tiros} tiros: <b>${a.chanceTiros}%</b>`);
    if (a.movimento) linhas.push(`• Odd: ${Number(a.movimento.de).toFixed(2)} → ${Number(a.movimento.para).toFixed(2)} ${a.movimento.para < a.movimento.de ? '📉 caiu' : '📈 subiu'}`);
    const curto = esc(MERCADOS[mercado].nome.replace(' gols', ''));
    const fase = (nome, x) => x.rotulo ? `• ${esc(nome)}: ${x.rotulo} ${x.sim} dos últimos ${x.n} jogos` : `• ${esc(nome)}: ${curto} em ${x.sim} dos últimos ${x.n} jogos`;
    if (a.casa) linhas.push(fase(plano[0] && plano[0].casa, a.casa));
    if (a.fora) linhas.push(fase(plano[0] && plano[0].fora, a.fora));
    if (linhas.length) t += `🧠 <b>ANÁLISE DO JOGO</b>\n${linhas.join('\n')}\n${LINHA}\n`;
  }
  if (meta.taxa != null) t += '📈 <b>ESTRATÉGIA</b>\n';
  if (meta.taxa != null) {
    t += `📊 Assertividade (${meta.fonte}): <b>${meta.taxa}%</b> em ${meta.n} sinais\n`;
    if (meta.roi != null) t += `💰 ROI: <b>${meta.roi > 0 ? '+' : ''}${meta.roi}%</b>\n`;
    if (meta.reds) {
      if (meta.reds.total) {
        t += `📉 Últimos REDs: ${meta.reds.ultimos.map(quando).join(' · ')}\n`;
        t += `🔁 1 RED a cada <b>${meta.reds.cada}</b> sinais · máx. <b>${meta.reds.maiorSeqRed}</b> seguido${meta.reds.maiorSeqRed > 1 ? 's' : ''}\n`;
      } else {
        t += `📉 Nenhum RED no período analisado\n`;
      }
      const sa = meta.reds.seqAtual;
      if (sa && sa.tipo === 'green') t += `🔥 Greens seguidos agora: <b>${sa.n}</b> · recorde: <b>${meta.reds.maiorSeqGreen}</b>\n`;
      else if (sa) t += `🧊 Vem de <b>${sa.n}</b> RED${sa.n > 1 ? 's' : ''} seguido${sa.n > 1 ? 's' : ''} · recorde de greens: <b>${meta.reds.maiorSeqGreen}</b>\n`;
    }
  }
  if (meta.nome) t += `📋 ${esc(meta.nome)}`;
  if (final === 'green' || final === 'red') {
    const lucro = hist.reduce((s2, h) => s2 + (h.ok ? (h.odd ? h.odd - 1 : 0) : -1), 0);
    if (hist.every((h) => h.odd)) t += `\n💵 Resultado: <b>${lucro >= 0 ? '+' : ''}${lucro.toFixed(2)} unid.</b> (1 unid. por tiro)`;
  }
  if (meta.sim) {
    t += `\n${LINHA}\n💼 <b>SIMULAÇÃO</b> · ${sim.reais(meta.sim.valor)} por tiro`;
    if (meta.simFinal) {
      const l = meta.simFinal.lucro;
      t += `\n${l >= 0 ? '🟢' : '🔴'} Resultado: <b>${l >= 0 ? '+' : '−'}${sim.reais(Math.abs(l))}</b>\n🏦 Banca agora: <b>${sim.reais(meta.simFinal.banca)}</b>`;
    } else {
      t += `\n🏦 Banca: <b>${sim.reais(meta.sim.banca)}</b>` + (tiros > 1 ? ` · risco máx.: ${sim.reais(meta.sim.valor * tiros)}` : '');
    }
  }
  return t.trim();
}

// ---------- Resultados dos sinais (com tiros) ----------
const pendentesDaLiga = db.prepare(`SELECT * FROM sinais WHERE status = 'pendente' AND liga = ?`);
const atualizarSinal = db.prepare(`UPDATE sinais SET status = @status, placar = @placar, lucro = @lucro,
  tiro_atual = @tiro_atual, tiro_green = @tiro_green, alvo_inicio = @alvo_inicio, odd_atual = @odd_atual, historico = @historico WHERE id = @id`);
const regraPorId = db.prepare('SELECT * FROM regras WHERE id = ?');

function proximoJogoDepois(liga, t) {
  // quando o coletor volta de uma pausa, o próximo jogo pode já ter terminado (está no histórico)
  const jaJogado = jogos.daLiga(liga).find((x) => x.t > t);
  if (jaJogado) return jaJogado;
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
        let simFinal = null;
        if (s.sim_valor && (final === 'green' || final === 'red') && lucro != null) {
          const simLucro = Math.round(lucro * s.sim_valor * 100) / 100;
          db.prepare('UPDATE sinais SET sim_lucro = ? WHERE id = ?').run(simLucro, s.id);
          simFinal = { lucro: simLucro, banca: sim.banca() };
        }
        if (s.enviado && s.telegram_msg_id) {
          let meta = {}, plano = null;
          try { const x = JSON.parse(s.texto); meta = x.meta || {}; plano = x.plano; } catch { /* sinal antigo */ }
          if (simFinal) meta.simFinal = simFinal;
          if (!plano) plano = [{ inicio: s.inicio, casa: s.time_casa, fora: s.time_fora, odd: s.odd }];
          if (prox && plano.length < tiro + 1) plano.push({ inicio: prox.inicio, casa: prox.time_casa, fora: prox.time_fora, odd: oddDo(prox, s.mercado) });
          const txt = montarMensagem({ liga, mercado: s.mercado, tiros: s.tiros_max || 1, plano, hist, final: final === 'proximo' ? null : final, meta });
          await tg.editar(s.telegram_msg_id, txt, s.chat_id);
        }
        if (final === 'green' || final === 'red') { await checarStop(s.regra_id); if (s.sim_valor) await sim.avisar(tg); }
      }
    }
  }
  // anula sinais que ficaram sem resultado por mais de 2 horas (ex.: coletor ficou parado e o jogo se perdeu)
  const limite = new Date(Date.now() - 2 * 3600e3).toISOString();
  const perdidos = db.prepare(`SELECT * FROM sinais WHERE status = 'pendente' AND COALESCE(alvo_inicio, inicio) < ?`).all(limite);
  for (const s of perdidos) {
    db.prepare(`UPDATE sinais SET status = 'anulado' WHERE id = ?`).run(s.id);
    if (s.enviado && s.telegram_msg_id) {
      let meta = {}, plano = null;
      try { const x = JSON.parse(s.texto); meta = x.meta || {}; plano = x.plano; } catch { /* sinal antigo */ }
      const hist = s.historico ? JSON.parse(s.historico) : [];
      const txt = montarMensagem({ liga: s.liga, mercado: s.mercado, tiros: s.tiros_max || 1,
        plano: plano || [{ inicio: s.inicio, casa: s.time_casa, fora: s.time_fora, odd: s.odd }], hist, meta })
        .replace('🚨 <b>SINAL CONFIRMADO</b>', '⚪ <b>ANULADO</b> · resultado não coletado (coletor parado)');
      await tg.editar(s.telegram_msg_id, txt, s.chat_id);
    }
  }
}

// ---------- Stop automático: pausa a regra sozinha quando o resultado ao vivo fica ruim ----------
function configStop() {
  return {
    ativo: getConfig('stop_ativo', true),
    minSinais: Number(getConfig('stop_min_sinais', 20)) || 20,
    roiMin: Number(getConfig('stop_roi_min', -15)),
    redsSeguidos: Number(getConfig('stop_reds_seguidos', 0)) || 0,
  };
}

let aoPausar = null;                      // a revisão da IA se inscreve aqui
function quandoPausar(fn) { aoPausar = fn; }

async function checarStop(regraId) {
  const cfg = configStop();
  if (!cfg.ativo) return;
  const regra = regraPorId.get(regraId);
  if (!regra || regra.modo !== 'telegram') return;
  const vivo = aoVivo(regraId);
  let motivo = null;
  if (vivo && vivo.n >= cfg.minSinais && vivo.roi != null && vivo.roi < cfg.roiMin) {
    motivo = `ROI ao vivo de ${vivo.roi}% em ${vivo.n} sinais (limite: ${cfg.roiMin}%)`;
  }
  if (!motivo && cfg.redsSeguidos > 0) {
    const ult = db.prepare(`SELECT status FROM sinais WHERE regra_id = ? AND status IN ('green','red')
      ORDER BY inicio DESC LIMIT ?`).all(regraId, cfg.redsSeguidos);
    if (ult.length === cfg.redsSeguidos && ult.every((x) => x.status === 'red')) motivo = `${cfg.redsSeguidos} REDs seguidos`;
  }
  if (!motivo) return;
  db.prepare(`UPDATE regras SET modo = 'desligado', pausada_por = 'stop' WHERE id = ?`).run(regraId);
  log('info', `Stop automático: regra "${regra.nome}" pausada (${motivo})`);
  await tg.enviar(`⛔ <b>STOP AUTOMÁTICO</b>\n\n📋 ${esc(regra.nome)}\n📉 ${esc(motivo)}\n\nA estratégia foi <b>pausada</b> e não envia mais sinais. Para reativar, use o painel.`);
  if (aoPausar) setTimeout(() => aoPausar(regraId), 2000);
}

// ---------- Geração de sinais ----------
const inserirSinal = db.prepare(`INSERT OR IGNORE INTO sinais
  (regra_id, liga, inicio, time_casa, time_fora, mercado, odd, tiros_max, tiro_atual, alvo_inicio)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
const marcarEnviado = db.prepare(`UPDATE sinais SET enviado = 1, telegram_msg_id = ?, texto = ?, chat_id = ? WHERE id = ?`);
const jaEnviado = db.prepare(`SELECT id FROM sinais WHERE liga = ? AND inicio = ? AND mercado = ? AND enviado = 1 AND id != ? LIMIT 1`);
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
      // consenso: o modelo de valor precisa concordar (não pode ver a entrada como desvantajosa)
      if (getConfig('consenso', false) && !regra.condicoes.some((c) => c.tipo === 'modelo') && modelo.temModelo(regra.mercado)) {
        const p = modelo.prever(regra.mercado, hist, alvo);
        if (p != null && odd && p * odd < 1) continue;
      }
      const tiros = Math.min(3, Math.max(1, Number(regra.tiros) || 1));
      const r = inserirSinal.run(regra.id, liga, alvo.inicio, alvo.time_casa, alvo.time_fora, regra.mercado, odd, tiros, alvo.inicio);
      if (!r.changes || regra.modo !== 'telegram') continue;
      // trava: outra estratégia já mandou este mesmo jogo + mercado? então não repete no Telegram
      const igual = jaEnviado.get(liga, alvo.inicio, regra.mercado, r.lastInsertRowid);
      if (igual) {
        db.prepare('UPDATE sinais SET duplicado_de = ? WHERE id = ?').run(igual.id, r.lastInsertRowid);
        continue;
      }
      const aprovada = regra.validacao && regra.validacao.status && regra.validacao.status.codigo === 'aprovada';
      if (exigirTeste && !aprovada) {
        if (Date.now() - (avisosBloqueio.get(regra.id) || 0) > 3600e3) {
          avisosBloqueio.set(regra.id, Date.now());
          log('info', `Sinal da regra "${regra.nome}" não enviado: ela não está aprovada no teste (opção ligada em Configurações)`);
        }
        continue;
      }
      const plano = planoDeTiros(liga, alvo, tiros, regra.mercado);
      const meta = metaDaRegra(regra);
      try {
        const seguintes = (proximas.get(liga) || []).filter((p) => p.t > alvo.t).slice(0, tiros - 1);
        meta.analise = modelo.analiseJogo(regra.mercado, hist, alvo, seguintes);
      } catch (e) { log('erro', `Análise do jogo: ${e.message}`); }
      const ent = sim.entrada(tiros);
      if (ent.valor) meta.sim = { valor: ent.valor, banca: ent.banca };
      const txt = montarMensagem({ liga, mercado: regra.mercado, tiros, plano, meta });
      const msgId = await tg.enviar(txt);
      // "texto" guarda os dados do envio para remontar a mensagem a cada tiro
      if (msgId) {
        marcarEnviado.run(msgId, JSON.stringify({ plano, meta }), String(tg.chatId()), r.lastInsertRowid);
        if (ent.valor) db.prepare('UPDATE sinais SET sim_valor = ? WHERE id = ?').run(ent.valor, r.lastInsertRowid);
      }
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
  // agrupa por estratégia (id) e ignora os sinais repetidos que não foram enviados
  const linhas = db.prepare(`SELECT r.id AS rid, r.nome, s.status, s.lucro, s.enviado, s.inicio, s.alvo_inicio FROM sinais s JOIN regras r ON r.id = s.regra_id
    WHERE s.inicio >= ? AND s.inicio < ? AND s.status IN ('green','red') AND s.duplicado_de IS NULL ORDER BY s.inicio`).all(ini, fim);
  const repetidos = db.prepare(`SELECT COUNT(*) AS n FROM sinais WHERE inicio >= ? AND inicio < ? AND duplicado_de IS NOT NULL`).get(ini, fim).n;
  if (!linhas.length) return `📊 <b>Relatório ${dia.split('-').reverse().join('/')}</b>\nNenhum sinal conferido hoje.` + sim.textoRelatorio(dia);
  const porRegra = {};
  for (const l of linhas) {
    const p = (porRegra[l.rid] ||= { nome: l.nome, g: 0, r: 0, lucro: 0, env: 0, horasRed: [], seq: 0, maxSeq: 0 });
    l.status === 'green' ? p.g++ : p.r++;
    if (l.status === 'red') { p.horasRed.push(hhmm(l.alvo_inicio || l.inicio)); p.seq++; p.maxSeq = Math.max(p.maxSeq, p.seq); } else p.seq = 0;
    p.lucro += l.lucro || 0;
    if (l.enviado) p.env++;
  }
  let txt = `📊 <b>Relatório ${dia.split('-').reverse().join('/')}</b>\n`;
  let tg2 = 0, tr = 0, tl = 0;
  for (const p of Object.values(porRegra)) {
    const nome = p.nome;
    const taxa = ((p.g / (p.g + p.r)) * 100).toFixed(0);
    txt += `\n<b>${esc(nome)}</b>${p.env ? '' : ' (observação)'}\n✅ ${p.g}  ❌ ${p.r}  · ${taxa}% · ${p.lucro >= 0 ? '+' : ''}${p.lucro.toFixed(2)} unid.\n`;
    if (p.horasRed.length) txt += `REDs: ${p.horasRed.join(', ')} · maior sequência: ${p.maxSeq}\n`;
    tg2 += p.g; tr += p.r; tl += p.lucro;
  }
  txt += `\n<b>Total:</b> ✅ ${tg2}  ❌ ${tr} · ${((tg2 / (tg2 + tr)) * 100).toFixed(0)}% · ${tl >= 0 ? '+' : ''}${tl.toFixed(2)} unid.`;
  const env = Object.values(porRegra).filter((p) => p.env);
  if (env.length && env.length < Object.keys(porRegra).length) {
    const g = env.reduce((a, p) => a + p.g, 0), r = env.reduce((a, p) => a + p.r, 0), l = env.reduce((a, p) => a + p.lucro, 0);
    txt += `\n<b>Só o que foi enviado no Telegram:</b> ✅ ${g}  ❌ ${r} · ${g + r ? ((g / (g + r)) * 100).toFixed(0) : 0}% · ${l >= 0 ? '+' : ''}${l.toFixed(2)} unid.`;
  }
  if (repetidos) txt += `\n<i>${repetidos} sinal(is) repetido(s) no mesmo jogo não foram enviados nem contados.</i>`;
  txt += sim.textoRelatorio(dia);
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
      estado.ultimoErro = 'Coletor parado. Confira o Chrome e a extensão Lab Sinais (ou o favorito, se ainda usa).';
      if (estado.ultimaColeta && !getConfig('tson_alerta_enviado')) {
        setConfig('tson_alerta_enviado', true);
        await tg.enviar('⚠️ <b>O coletor parou.</b>\nConfira se o computador está ligado, o Chrome aberto e a extensão Lab Sinais com o ícone verde. Se o ícone estiver vermelho, abra a aba do TsonTips e faça login. Até lá, não há coleta nem sinais.');
      }
    }
    await talvezRelatorio();
  } catch (e) { log('erro', `Vigia: ${e.message}`); }
}

function iniciar() {
  jogos.carregar();
  // os dados em cache fizeram o sistema "aprender" atrasos errados; zera uma vez
  if (getConfig('defasagem_versao') !== 2) {
    db.prepare("DELETE FROM config WHERE chave LIKE 'defasagem_%'").run();
    setConfig('defasagem_versao', 2);
    setTimeout(revalidarTodas, 5000);
  }
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

module.exports = { montarMensagem, quandoPausar, configStop, checarStop, iniciar, ciclo, receber, caminhoColeta, periodoAtual, estado, revalidarTodas, textoRelatorio, proximas };
