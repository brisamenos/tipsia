// IA (OpenAI) que estuda os jogos e SUGERE sinais.
// A IA escolhe as ideias; a porcentagem mostrada é sempre calculada pelo sistema
// no histórico real (nunca inventada pela IA). Nada é enviado sem a sua aprovação.
const { db, getConfig, setConfig, log } = require('./db');
const { LIGAS, MERCADOS, oddDo, bateu } = require('./mercados');
const { validarEstrutura, TIPOS_CONDICAO } = require('./regras');
const { backtest, estatisticas, aoVivo } = require('./validador');
const jogos = require('./jogos');

const MERCADOS_PRINCIPAIS = ['ambas_sim', 'ambas_nao', 'over_15', 'over_25', 'over_35', 'under_25', 'casa', 'empate', 'fora'];
const estado = { rodando: false, ultimoErro: null, ultimaVez: null };

// Provedor da IA: 'openai' (ChatGPT) ou 'anthropic' (Claude)
const provedor = () => (getConfig('ia_provedor') || process.env.IA_PROVEDOR || 'openai') === 'anthropic' ? 'anthropic' : 'openai';
const chave = () => provedor() === 'anthropic'
  ? process.env.ANTHROPIC_API_KEY || getConfig('anthropic_key') || ''
  : process.env.OPENAI_API_KEY || getConfig('openai_key') || '';
const modelo = () => provedor() === 'anthropic'
  ? getConfig('anthropic_modelo') || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'
  : getConfig('openai_modelo') || process.env.OPENAI_MODEL || 'gpt-5.4-mini';

// ---------- Mudanças recentes no comportamento de cada liga ----------
function mudancas(janela = 150) {
  const out = [];
  for (const liga of Object.keys(LIGAS)) {
    const arr = jogos.daLiga(liga);
    if (arr.length < janela * 2) continue;
    const rec = arr.slice(-janela), ant = arr.slice(-janela * 2, -janela);
    for (const m of MERCADOS_PRINCIPAIS) {
      const pr = rec.filter((j) => bateu(j, m)).length / rec.length;
      const pa = ant.filter((j) => bateu(j, m)).length / ant.length;
      const p = (pr + pa) / 2;
      const ep = Math.sqrt(p * (1 - p) * (2 / janela));
      const z = ep > 0 ? (pr - pa) / ep : 0;
      if (Math.abs(z) >= 2) {
        out.push({ liga, nomeLiga: LIGAS[liga], mercado: m, nomeMercado: MERCADOS[m].nome,
          antes: +(pa * 100).toFixed(1), agora: +(pr * 100).toFixed(1), z: +z.toFixed(2) });
      }
    }
  }
  return out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}

// ---------- Memória: como foram as sugestões anteriores da IA ----------
function resumoRegra(r, vivo) {
  const v = r.validacao ? (typeof r.validacao === 'string' ? JSON.parse(r.validacao) : r.validacao) : null;
  return {
    nome: r.nome, mercado: r.mercado,
    ligas: typeof r.ligas === 'string' ? JSON.parse(r.ligas) : r.ligas,
    condicoes: typeof r.condicoes === 'string' ? JSON.parse(r.condicoes) : r.condicoes,
    tiros: r.tiros || 1,
    situacao: { pendente: 'aguardando aprovação', telegram: 'aprovada (Telegram)', observacao: 'em observação', desligado: 'pausada' }[r.modo] || r.modo,
    prova_final: v && v.prova ? { n: v.prova.n, taxa: v.prova.taxa, roi: v.prova.roi } : null,
    ao_vivo: vivo && vivo.n ? { sinais: vivo.n, taxa: vivo.taxa, roi: vivo.roi } : null,
  };
}

// Guarda o resultado de uma regra da IA antes de ela ser excluída
function lembrarExcluida(regraRow) {
  if (!regraRow || regraRow.origem !== 'ia') return;
  const vivo = aoVivo(regraRow.id);
  const mem = getConfig('ia_memoria', []) || [];
  mem.unshift({ ...resumoRegra(regraRow, vivo), situacao: 'excluída pelo usuário', em: new Date().toISOString() });
  setConfig('ia_memoria', mem.slice(0, 60));
}

function memoria() {
  const atuais = db.prepare(`SELECT * FROM regras WHERE origem = 'ia'`).all().map((r) => resumoRegra(r, aoVivo(r.id)));
  const antigas = getConfig('ia_memoria', []) || [];
  return { atuais, excluidas: antigas.slice(0, 30) };
}

function resumoModelo() {
  const r = getConfig('modelo_resultado');
  if (!r) return null;
  return { margem_percent: r.margem, dias_de_dados: r.dias, mercados: (r.mercados || []).map((m) => ({
    mercado: m.mercado, melhora_sobre_odds_percent: m.melhora, entradas_com_valor: m.valor.n, taxa: m.valor.taxa,
    roi: m.valor.roi, z: m.valor.z, dias_positivos: m.dias, status: m.status.codigo, por_liga: m.porLiga })) };
}

// ---------- Resumo dos dados para a IA ----------
function contexto() {
  const ligas = {};
  for (const liga of Object.keys(LIGAS)) {
    const arr = jogos.daLiga(liga);
    if (arr.length < 100) continue;
    const ult = arr.slice(-300);
    const linha = { jogos: arr.length, mercados: {} };
    for (const m of MERCADOS_PRINCIPAIS) {
      const st = estatisticas(ult.map((j) => ({ acerto: bateu(j, m), odd: oddDo(j, m) })));
      linha.mercados[m] = { taxa_ult300: st.taxa, odd_media: st.oddMedia, roi_apostando_tudo: st.roi };
    }
    linha.ultimos_20 = arr.slice(-20).map((j) => `${j.gc}-${j.gf}`).join(' ');
    ligas[liga] = linha;
  }
  const desc = getConfig('descoberta');
  const p = (x) => (x ? { n: x.n, taxa: x.taxa, roi: x.roi, z: x.z } : null);
  const resumir = (r) => ({ nome: r.nome, mercado: r.mercado, ligas: r.ligas, condicoes: r.condicoes, tiros: r.tiros,
    treino: p(r.treino), validacao: p(r.validacao), prova_final: p(r.prova), dias_positivos: r.dias });
  return {
    ligas,
    mudancas_recentes: mudancas().slice(0, 15),
    candidatas_que_se_sustentaram: desc ? (desc.sustentaram || []).slice(0, 25).map(resumir) : [],
    candidatas_melhores_no_treino: desc ? (desc.ranking || []).slice(0, 10).map(resumir) : [],
    modelo_de_valor: resumoModelo(),
    suas_sugestoes_anteriores: memoria(),
  };
}

function instrucoes(qtd, tiros, pedido) {
  return `Você é um analista quantitativo de futebol virtual da Kiron (jogos gerados por algoritmo, sem jogadores reais).
Seu trabalho: propor até ${qtd} regras de sinal para o sistema testar. O usuário aprova manualmente antes de qualquer envio.

Regras importantes:
- Use SOMENTE os dados enviados. Não invente estatísticas nem porcentagens: o sistema recalcula tudo no histórico real.
- O histórico é dividido em 3 partes: treino (50%), validação (25%) e prova final (25%, a mais recente).
  Prefira ideias com ROI positivo nas 3 partes, amostra grande e lucro na maioria dos dias. Considere as mudanças recentes das ligas.
- APRENDA com "suas_sugestoes_anteriores": é o resultado REAL do que você já sugeriu.
  Evite repetir mercados/ligas/condições que deram ROI ao vivo negativo ou foram excluídos pelo usuário.
  Reforce o tipo de ideia que está com ROI ao vivo positivo. Não repita uma regra que já existe.
  Diga em "observacoes" o que aprendeu com esses resultados.
- Seja honesto: se nada parece ter vantagem real sobre a odd, proponha menos regras e diga isso em "observacoes".
- Cada sinal pode ter de 1 a 3 tiros (o sinal vale para até N jogos seguidos). Padrão do usuário: ${tiros}.

Formato das regras:
- liga: "*" (todas) ou uma destas chaves: ${Object.keys(LIGAS).join(', ')}
- mercado: uma destas chaves: ${Object.keys(MERCADOS).join(', ')}
- condicoes: lista (todas precisam ser verdadeiras). Tipos permitidos:
  {"tipo":"sequencia","mercado":"<chave>","n":1-10,"valor":true|false}  (últimos n jogos seguidos com/sem o mercado)
  {"tipo":"frequencia","mercado":"<chave>","n":5-30,"op":">="|"<=","qtd":<número>}
  {"tipo":"placar_anterior","placar":"1-1"}  (pode listar vários: "0-0, 1-0")
  {"tipo":"gols_anterior","op":">="|"<=","qtd":<número>}
  {"tipo":"minuto","valores":[<minutos>]}  {"tipo":"hora","valores":[<horas>]}
  {"tipo":"odd","min":<número ou "">,"max":<número ou "">}  (odd do próprio mercado da regra)
  {"tipo":"modelo","margem":5}  (só entra quando o MODELO DE VALOR vê vantagem de pelo menos "margem"% sobre a odd)
- Veja "modelo_de_valor": são os mercados em que o modelo estatístico achou valor fora da amostra.
  Combinar uma condição simples com {"tipo":"modelo"} costuma filtrar melhor do que só regras de sequência.
${pedido ? `\nPedido do usuário: ${pedido}\n` : ''}
Responda APENAS com JSON no formato:
{"sugestoes":[{"nome":"curto e claro em português","liga":"...","mercado":"...","condicoes":[...],"tiros":1,"justificativa":"1-2 frases em português"}],"observacoes":"análise geral em português, 2-4 frases"}`;
}

function lerJSON(txt) {
  try { return JSON.parse(txt); } catch { /* tenta extrair */ }
  const i = String(txt || '').indexOf('{'), f = String(txt || '').lastIndexOf('}');
  if (i >= 0 && f > i) { try { return JSON.parse(txt.slice(i, f + 1)); } catch { /* inválido */ } }
  throw new Error('A IA respondeu num formato inválido. Tente de novo.');
}

async function chamarIA(sistema, dados) {
  const nomeProv = provedor() === 'anthropic' ? 'Claude' : 'OpenAI';
  if (!chave()) throw new Error(`Coloque a API Key do ${nomeProv} na aba IA Sinais.`);
  const conteudo = 'Dados atuais (JSON):\n' + JSON.stringify(dados);
  if (provedor() === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': chave(), 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelo(), max_tokens: 4000, system: sistema + '\nResponda somente com o JSON, sem texto antes ou depois.',
        messages: [{ role: 'user', content: conteudo }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Claude: ${(j.error && j.error.message) || r.status}`);
    return lerJSON((j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
  }
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${chave()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelo(),
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sistema }, { role: 'user', content: conteudo }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI: ${(j.error && j.error.message) || r.status}`);
  return lerJSON(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
}

function limparCondicao(c) {
  const t = c && c.tipo;
  if (!TIPOS_CONDICAO[t]) return null;
  switch (t) {
    case 'sequencia': return { tipo: t, mercado: c.mercado, n: Math.min(10, Math.max(1, +c.n || 1)), valor: c.valor === true || c.valor === 'true' };
    case 'frequencia': return { tipo: t, mercado: c.mercado, n: Math.min(30, Math.max(3, +c.n || 10)), op: ['>=', '<=', '=', '>', '<'].includes(c.op) ? c.op : '>=', qtd: +c.qtd || 0 };
    case 'placar_anterior': return { tipo: t, placar: String(c.placar || '') };
    case 'gols_anterior': return { tipo: t, op: ['>=', '<=', '=', '>', '<'].includes(c.op) ? c.op : '>=', qtd: +c.qtd || 0 };
    case 'minuto': case 'hora': return { tipo: t, valores: [].concat(c.valores || []).map(Number).filter((x) => !Number.isNaN(x)) };
    case 'odd': return { tipo: t, min: c.min === '' || c.min == null ? '' : +c.min, max: c.max === '' || c.max == null ? '' : +c.max };
    case 'modelo': return { tipo: t, margem: Math.min(30, Math.max(1, +c.margem || 5)) };
  }
  return null;
}

async function sugerir(pedido = '') {
  if (estado.rodando) throw new Error('A IA já está analisando. Aguarde.');
  if (!jogos.ligas().length) throw new Error('Ainda não há jogos no banco. Deixe o coletor rodar primeiro.');
  estado.rodando = true;
  estado.ultimoErro = null;
  try {
    const qtd = Math.min(10, Math.max(1, Number(getConfig('ia_qtd', 5)) || 5));
    const tirosPadrao = Math.min(3, Math.max(1, Number(getConfig('tiros_padrao', 1)) || 1));
    const resp = await chamarIA(instrucoes(qtd, tirosPadrao, String(pedido).slice(0, 500)), contexto());
    const criadas = [];
    const ins = db.prepare(`INSERT INTO regras (nome, ligas, mercado, condicoes, modo, tiros, origem, justificativa)
      VALUES (?, ?, ?, ?, 'pendente', ?, 'ia', ?)`);
    const upd = db.prepare('UPDATE regras SET validacao = ? WHERE id = ?');
    for (const sug of (resp.sugestoes || []).slice(0, qtd)) {
      const liga = sug.liga === '*' || LIGAS[sug.liga] ? sug.liga : '*';
      const regra = {
        nome: String(sug.nome || 'Sinal da IA').slice(0, 80),
        ligas: [liga],
        mercado: sug.mercado,
        condicoes: (sug.condicoes || []).map(limparCondicao).filter(Boolean),
        modo: 'observacao',
        tiros: Math.min(3, Math.max(1, Number(sug.tiros) || tirosPadrao)),
      };
      if (validarEstrutura(regra).length || jaExisteParecida(regra)) continue;
      const info = ins.run(regra.nome, JSON.stringify(regra.ligas), regra.mercado, JSON.stringify(regra.condicoes),
        regra.tiros, String(sug.justificativa || '').slice(0, 400));
      const v = backtest({ ...regra, id: info.lastInsertRowid });
      upd.run(JSON.stringify(v), info.lastInsertRowid);
      criadas.push(info.lastInsertRowid);
    }
    const res = { em: new Date().toISOString(), modelo: modelo(), criadas: criadas.length, observacoes: String(resp.observacoes || '').slice(0, 1200) };
    setConfig('ia_ultima', res);
    estado.ultimaVez = res.em;
    log('info', `IA sugeriu ${criadas.length} sinais (${modelo()})`);
    return res;
  } catch (e) {
    estado.ultimoErro = e.message;
    log('erro', `IA: ${e.message}`);
    throw e;
  } finally {
    estado.rodando = false;
  }
}

// ---------- Evitar estratégias repetidas ----------
function assinatura(r) {
  const ligas = (typeof r.ligas === 'string' ? JSON.parse(r.ligas) : r.ligas).slice().sort().join(',');
  const conds = (typeof r.condicoes === 'string' ? JSON.parse(r.condicoes) : r.condicoes)
    .map((c) => `${c.tipo}:${c.mercado || ''}`).sort().join('+');
  return `${ligas}|${r.mercado}|${conds}`;
}
function jaExisteParecida(regra) {
  const a = assinatura(regra);
  return db.prepare(`SELECT ligas, mercado, condicoes FROM regras WHERE modo IN ('telegram','observacao','pendente')`).all()
    .some((r) => assinatura(r) === a);
}

// Cria a regra pendente, testa no histórico e só mantém se tiver lucro nas 3 partes
function criarPendente(sug, { substitui = null, ligaObrigatoria = null } = {}) {
  const tirosPadrao = Math.min(3, Math.max(1, Number(getConfig('tiros_padrao', 1)) || 1));
  const liga = ligaObrigatoria || (sug.liga === '*' || LIGAS[sug.liga] ? sug.liga : null);
  if (!liga) return { ok: false, motivo: 'liga inválida' };
  const regra = {
    nome: String(sug.nome || 'Sinal da IA').slice(0, 80),
    ligas: [liga],
    mercado: sug.mercado,
    condicoes: (sug.condicoes || []).map(limparCondicao).filter(Boolean),
    modo: 'observacao',
    tiros: Math.min(3, Math.max(1, Number(sug.tiros) || tirosPadrao)),
  };
  if (validarEstrutura(regra).length) return { ok: false, motivo: 'formato inválido' };
  if (jaExisteParecida(regra)) return { ok: false, motivo: 'parecida com uma que já existe' };
  const v = backtest(regra);
  const lucraTudo = v.treino.roi > 0 && v.validacao.roi > 0 && v.prova.n >= 10 && v.prova.roi > 0;
  if (!lucraTudo || !['aprovada', 'promissora'].includes(v.status.codigo)) return { ok: false, motivo: 'não lucrou nas 3 partes do teste' };
  const info = db.prepare(`INSERT INTO regras (nome, ligas, mercado, condicoes, modo, tiros, origem, justificativa, substitui, validacao)
    VALUES (?, ?, ?, ?, 'pendente', ?, 'ia', ?, ?, ?)`).run(regra.nome, JSON.stringify(regra.ligas), regra.mercado,
    JSON.stringify(regra.condicoes), regra.tiros, String(sug.justificativa || '').slice(0, 400), substitui, JSON.stringify(v));
  return { ok: true, id: info.lastInsertRowid, regra, v };
}

// ---------- Revisão: substitutas e cobertura de ligas ----------
function precisamSubstituta(somenteId = null) {
  const regras = db.prepare(`SELECT * FROM regras WHERE modo IN ('telegram','desligado')`).all();
  const temSubstituta = new Set(db.prepare(`SELECT substitui FROM regras WHERE modo = 'pendente' AND substitui IS NOT NULL`).all().map((x) => x.substitui));
  const out = [];
  for (const r of regras) {
    if (somenteId && r.id !== somenteId) continue;
    if (temSubstituta.has(r.id)) continue;
    const vivo = aoVivo(r.id);
    let motivo = null;
    if (r.modo === 'desligado' && r.pausada_por === 'stop') motivo = 'pausada pelo stop automático';
    else if (r.modo === 'telegram' && vivo && vivo.n >= 10 && vivo.roi < 0) motivo = `fraca ao vivo (ROI ${vivo.roi}% em ${vivo.n} sinais)`;
    if (motivo) out.push({ id: r.id, ...resumoRegra(r, vivo), motivo });
  }
  return out.slice(0, 5);
}

function cobertura() {
  const ativos = db.prepare(`SELECT ligas FROM regras WHERE modo = 'telegram'`).all();
  const c = {};
  for (const l of Object.keys(LIGAS)) c[l] = 0;
  for (const r of ativos) for (const l of JSON.parse(r.ligas)) {
    if (l === '*') for (const k of Object.keys(c)) c[k]++;
    else if (c[l] !== undefined) c[l]++;
  }
  return c;
}

function instrucoesRevisao() {
  return `Você é o revisor das estratégias de futebol virtual Kiron do usuário. Nada que você propõe vai ao Telegram sem a aprovação dele.
Tarefas:
1) Para cada item de "precisam_substituta", proponha UMA estratégia substituta da MESMA liga (campo "substitui" = id do item).
2) Para cada liga de "ligas_sem_estrategia", proponha no máximo UMA estratégia, escolhendo entre as "candidatas" daquela liga.
   Se nenhuma candidata tiver ROI positivo no treino, na validação e na prova final, NÃO proponha nada para essa liga.
Regras:
- Não repita nem faça variações de estratégias já ativas ("estrategias_ativas") ou já sugeridas e recusadas ("suas_sugestoes_anteriores").
- Não invente números: o sistema retesta tudo e descarta o que não lucrar nas 3 partes.
- Prefira condições simples e amostras grandes. Use o formato de condições permitido:
  sequencia {mercado,n,valor}, frequencia {mercado,n,op,qtd}, placar_anterior {placar}, gols_anterior {op,qtd}, minuto {valores}, hora {valores}, odd {min,max}.
- mercado: ${Object.keys(MERCADOS).join(', ')}
Responda APENAS com JSON:
{"trocas":[{"substitui":<id>,"nome":"...","mercado":"...","condicoes":[...],"tiros":1,"justificativa":"..."}],
 "novas":[{"liga":"<chave>","nome":"...","mercado":"...","condicoes":[...],"tiros":1,"justificativa":"..."}],
 "observacoes":"2-3 frases em português"}`;
}

async function revisar(motivo = 'agendada', somenteId = null) {
  if (!chave() || estado.rodando || !jogos.ligas().length) return null;
  const precisam = precisamSubstituta(somenteId);
  const cob = cobertura();
  const desc = getConfig('descoberta') || {};
  const ligasComTroca = new Set(precisam.flatMap((p) => p.ligas));
  const semEstrategia = somenteId ? [] : Object.entries(cob).filter(([l, n]) => n === 0 && !ligasComTroca.has(l) && jogos.daLiga(l).length > 200).map(([liga]) => ({
    liga, nomeLiga: LIGAS[liga],
    candidatas: ((desc.porLiga || {})[liga] || []).filter((r) => r.prova && r.prova.roi > 0)
      .map((r) => ({ nome: r.nome, mercado: r.mercado, condicoes: r.condicoes, tiros: r.tiros,
        treino: { n: r.treino.n, roi: r.treino.roi }, validacao: { n: r.validacao.n, roi: r.validacao.roi }, prova_final: { n: r.prova.n, roi: r.prova.roi } })),
  })).filter((x) => x.candidatas.length);
  setConfig('ia_ultima_revisao', new Date().toISOString());
  if (!precisam.length && !semEstrategia.length) {
    setConfig('ia_revisao', { em: new Date().toISOString(), motivo, criadas: 0, observacoes: 'Nada para revisar: nenhuma estratégia precisa de troca e não há ideias lucrativas para as ligas sem cobertura.' });
    return { criadas: 0 };
  }
  estado.rodando = true;
  try {
    const ativas = db.prepare(`SELECT * FROM regras WHERE modo IN ('telegram','observacao','pendente')`).all().map((r) => resumoRegra(r, aoVivo(r.id)));
    const resp = await chamarIA(instrucoesRevisao(), {
      precisam_substituta: precisam, ligas_sem_estrategia: semEstrategia, estrategias_ativas: ativas,
      suas_sugestoes_anteriores: memoria(), mudancas_recentes: mudancas().slice(0, 10),
    });
    const linhas = [];
    const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let criadas = 0;
    for (const t of (resp.trocas || []).slice(0, 5)) {
      const alvo = precisam.find((p) => p.id === Number(t.substitui));
      if (!alvo) continue;
      const r = criarPendente(t, { substitui: alvo.id, ligaObrigatoria: alvo.ligas[0] });
      if (r.ok) { criadas++; linhas.push(`🔄 Troca · ${esc(LIGAS[alvo.ligas[0]] || 'Todas')}: ${esc(alvo.nome)} → <b>${esc(r.regra.nome)}</b> (prova final ROI ${r.v.prova.roi > 0 ? '+' : ''}${r.v.prova.roi}%)`); }
    }
    for (const n of (resp.novas || []).slice(0, 7)) {
      if (!semEstrategia.find((x) => x.liga === n.liga)) continue;
      const r = criarPendente(n, { ligaObrigatoria: n.liga });
      if (r.ok) { criadas++; linhas.push(`🆕 Nova · ${esc(LIGAS[n.liga])}: <b>${esc(r.regra.nome)}</b> (prova final ROI ${r.v.prova.roi > 0 ? '+' : ''}${r.v.prova.roi}%)`); }
    }
    const res = { em: new Date().toISOString(), motivo, criadas, observacoes: String(resp.observacoes || '').slice(0, 800) };
    setConfig('ia_revisao', res);
    log('info', `Revisão da IA (${motivo}): ${criadas} sugestão(ões) aguardando aprovação`);
    if (criadas) {
      const tg = require('./telegram');
      await tg.enviar(`🤖 <b>REVISÃO DA IA</b>\n\n${linhas.join('\n')}\n\nAprove ou recuse no painel, aba <b>IA Sinais</b>.`
        + (res.observacoes ? `\n\n💬 ${esc(res.observacoes)}` : ''));
    }
    return res;
  } catch (e) {
    estado.ultimoErro = e.message;
    log('erro', `Revisão da IA: ${e.message}`);
    return null;
  } finally {
    estado.rodando = false;
  }
}

// Aprovar uma troca: a nova entra no Telegram e a antiga é pausada
function aprovarTroca(id) {
  const nova = db.prepare('SELECT * FROM regras WHERE id = ?').get(id);
  if (!nova) throw new Error('Sugestão não encontrada');
  db.prepare(`UPDATE regras SET modo = 'telegram', pausada_por = NULL WHERE id = ?`).run(id);
  if (nova.substitui) db.prepare(`UPDATE regras SET modo = 'desligado', pausada_por = 'troca' WHERE id = ?`).run(nova.substitui);
  return { ok: true };
}

function situacao() {
  const k = chave();
  return {
    ...estado,
    provedor: provedor(),
    temChave: !!k,
    chaveFinal: k ? '••••' + k.slice(-4) : null,
    chaveNoServidor: provedor() === 'anthropic' ? !!process.env.ANTHROPIC_API_KEY : !!process.env.OPENAI_API_KEY,
    modelo: modelo(),
    qtd: getConfig('ia_qtd', 5),
    auto: getConfig('ia_auto', false),
    revisaoHoras: Number(getConfig('ia_revisao_horas', 6)),
    ultimaRevisao: getConfig('ia_revisao'),
    cobertura: cobertura(),
    ultima: getConfig('ia_ultima'),
    mudancas: mudancas().slice(0, 20),
  };
}

module.exports = { sugerir, revisar, aprovarTroca, situacao, mudancas, lembrarExcluida };
