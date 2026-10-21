// IA (OpenAI) que estuda os jogos e SUGERE sinais.
// A IA escolhe as ideias; a porcentagem mostrada é sempre calculada pelo sistema
// no histórico real (nunca inventada pela IA). Nada é enviado sem a sua aprovação.
const { db, getConfig, setConfig, log } = require('./db');
const { LIGAS, MERCADOS, oddDo, bateu } = require('./mercados');
const { validarEstrutura, TIPOS_CONDICAO } = require('./regras');
const { backtest, estatisticas } = require('./validador');
const jogos = require('./jogos');

const MERCADOS_PRINCIPAIS = ['ambas_sim', 'ambas_nao', 'over_15', 'over_25', 'over_35', 'under_25', 'casa', 'empate', 'fora'];
const estado = { rodando: false, ultimoErro: null, ultimaVez: null };

const chave = () => process.env.OPENAI_API_KEY || getConfig('openai_key') || '';
const modelo = () => getConfig('openai_modelo') || process.env.OPENAI_MODEL || 'gpt-5.4-mini';

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
  const resumir = (r) => ({ nome: r.nome, mercado: r.mercado, ligas: r.ligas, condicoes: r.condicoes,
    treino: { n: r.treino.n, taxa: r.treino.taxa, roi: r.treino.roi, z: r.treino.z },
    teste: { n: r.teste.n, taxa: r.teste.taxa, roi: r.teste.roi, z: r.teste.z } });
  return {
    ligas,
    mudancas_recentes: mudancas().slice(0, 15),
    candidatas_que_se_sustentaram: desc ? (desc.sustentaram || []).slice(0, 25).map(resumir) : [],
    candidatas_melhores_no_treino: desc ? (desc.ranking || []).slice(0, 10).map(resumir) : [],
  };
}

function instrucoes(qtd, tiros, pedido) {
  return `Você é um analista quantitativo de futebol virtual da Kiron (jogos gerados por algoritmo, sem jogadores reais).
Seu trabalho: propor até ${qtd} regras de sinal para o sistema testar. O usuário aprova manualmente antes de qualquer envio.

Regras importantes:
- Use SOMENTE os dados enviados. Não invente estatísticas nem porcentagens: o sistema recalcula tudo no histórico real.
- Prefira ideias que se sustentaram no treino E no teste, com amostra grande e ROI positivo. Considere as mudanças recentes das ligas.
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
${pedido ? `\nPedido do usuário: ${pedido}\n` : ''}
Responda APENAS com JSON no formato:
{"sugestoes":[{"nome":"curto e claro em português","liga":"...","mercado":"...","condicoes":[...],"tiros":1,"justificativa":"1-2 frases em português"}],"observacoes":"análise geral em português, 2-4 frases"}`;
}

async function chamarOpenAI(sistema, dados) {
  if (!chave()) throw new Error('Coloque a API Key da OpenAI na aba IA Sinais.');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${chave()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelo(),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sistema },
        { role: 'user', content: 'Dados atuais (JSON):\n' + JSON.stringify(dados) },
      ],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI: ${(j.error && j.error.message) || r.status}`);
  const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  try { return JSON.parse(txt); } catch { throw new Error('A IA respondeu num formato inválido. Tente de novo.'); }
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
    const resp = await chamarOpenAI(instrucoes(qtd, tirosPadrao, String(pedido).slice(0, 500)), contexto());
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
      if (validarEstrutura(regra).length) continue;
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

function situacao() {
  const k = chave();
  return {
    ...estado,
    temChave: !!k,
    chaveFinal: k ? '••••' + k.slice(-4) : null,
    chaveNoServidor: !!process.env.OPENAI_API_KEY,
    modelo: modelo(),
    qtd: getConfig('ia_qtd', 5),
    auto: getConfig('ia_auto', false),
    ultima: getConfig('ia_ultima'),
    mudancas: mudancas().slice(0, 20),
  };
}

module.exports = { sugerir, situacao, mudancas };
