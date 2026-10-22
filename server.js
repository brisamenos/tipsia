require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const { db, getConfig, setConfig, log } = require('./db');
const { LIGAS, MERCADOS } = require('./mercados');
const { validarEstrutura, TIPOS_CONDICAO } = require('./regras');
const { backtest, panorama, aoVivo } = require('./validador');
const { avaliarIA } = require('./ia');
const jogos = require('./jogos');
const tson = require('./tsontips');
const tg = require('./telegram');
const robo = require('./robo');
const descobrir = require('./descobrir');
const iaSinais = require('./iasinais');
const modelo = require('./modelo');

// ---------- Usuário inicial ----------
if (!db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n) {
  const u = process.env.ADMIN_USER || 'admin';
  const s = process.env.ADMIN_PASS || 'admin123';
  db.prepare('INSERT INTO usuarios (usuario, senha_hash) VALUES (?, ?)').run(u, bcrypt.hashSync(s, 10));
  log('info', `Usuário inicial criado: ${u}`);
}

// ---------- Regras de exemplo (todas em observação) ----------
if (!db.prepare('SELECT COUNT(*) AS n FROM regras').get().n) {
  const ins = db.prepare('INSERT INTO regras (nome, ligas, mercado, condicoes, modo) VALUES (?, ?, ?, ?, ?)');
  ins.run('Ambas após 3 sem ambas', '["*"]', 'ambas_sim',
    JSON.stringify([{ tipo: 'sequencia', mercado: 'ambas_sim', n: 3, valor: false }]), 'observacao');
  ins.run('Over 2.5 após 3 unders', '["*"]', 'over_25',
    JSON.stringify([{ tipo: 'sequencia', mercado: 'over_25', n: 3, valor: false }]), 'observacao');
  ins.run('Ambas Não com odd baixa', '["*"]', 'ambas_nao',
    JSON.stringify([{ tipo: 'odd', min: '', max: 1.9 }]), 'observacao');
}

const app = express();
app.set('trust proxy', 1);
const jsonPequeno = express.json({ limit: '200kb' });
const jsonGrande = express.json({ limit: '30mb' });
app.use((req, res, next) => (req.path === '/api/ingest' ? jsonGrande : jsonPequeno)(req, res, next));

let segredo = process.env.SESSION_SECRET;
if (!segredo) {
  segredo = getConfig('session_secret') || crypto.randomBytes(32).toString('hex');
  setConfig('session_secret', segredo);
}
app.use(session({
  secret: segredo,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 86400e3 },
}));

// Chave da extensão do Chrome: permite enviar os jogos sem estar logado no painel
function chaveColetor() {
  let k = getConfig('ingest_token');
  if (!k) { k = crypto.randomBytes(16).toString('hex'); setConfig('ingest_token', k); }
  return k;
}
const chaveOk = (req) => {
  const k = String(req.get('x-lab-token') || '');
  const certa = chaveColetor();
  return k.length === certa.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(certa));
};

const exigeLogin = (req, res, next) => {
  if (req.session.usuario) return next();
  if (req.path.startsWith('/api/ingest') && chaveOk(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'Faça login' });
  return res.redirect('/login.html?volta=' + encodeURIComponent(req.originalUrl));
};

const regraDaLinha = (r) => ({
  ...r, ligas: JSON.parse(r.ligas), condicoes: JSON.parse(r.condicoes),
  validacao: r.validacao ? JSON.parse(r.validacao) : null,
});

// ---------- Autenticação ----------
const tentativas = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const t = tentativas.get(ip) || { n: 0, ate: 0 };
  if (t.ate > Date.now()) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  const { usuario, senha } = req.body || {};
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(String(usuario || ''));
  if (!u || !bcrypt.compareSync(String(senha || ''), u.senha_hash)) {
    t.n++; if (t.n >= 5) { t.ate = Date.now() + 10 * 60000; t.n = 0; }
    tentativas.set(ip, t);
    return res.status(401).json({ erro: 'Usuário ou senha incorretos' });
  }
  tentativas.delete(ip);
  req.session.regenerate(() => {
    req.session.usuario = u.usuario;
    res.json({ ok: true });
  });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// Todos os arquivos ficam na mesma pasta: só estes são servidos ao navegador
const PUB = __dirname;
app.get('/login.html', (req, res) => res.sendFile(path.join(PUB, 'login.html')));
app.get('/estilo.css', (req, res) => res.sendFile(path.join(PUB, 'estilo.css')));
app.use(exigeLogin);
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(PUB, 'index.html')));
app.get('/app.js', (req, res) => res.sendFile(path.join(PUB, 'app.js')));
app.get('/coletor.html', (req, res) => res.sendFile(path.join(PUB, 'coletor.html')));
app.get('/api/ingest/plano', (req, res) => res.json({ caminho: robo.caminhoColeta(robo.periodoAtual()), intervalo: 60 }));
app.post('/api/ingest', async (req, res) => {
  try { res.json({ ok: true, ...(await robo.receber(req.body)) }); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});
app.get('/conectar.html', (req, res) => res.sendFile(path.join(PUB, 'conectar.html')));

app.get('/api/me', (req, res) => res.json({ usuario: req.session.usuario }));

app.post('/api/senha', (req, res) => {
  const { atual, nova } = req.body || {};
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(req.session.usuario);
  if (!bcrypt.compareSync(String(atual || ''), u.senha_hash)) return res.status(400).json({ erro: 'Senha atual incorreta' });
  if (!nova || String(nova).length < 6) return res.status(400).json({ erro: 'A nova senha precisa ter pelo menos 6 caracteres' });
  db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(nova), 10), u.id);
  res.json({ ok: true });
});

// ---------- Dados gerais ----------
app.get('/api/meta', (req, res) => res.json({
  ligas: LIGAS,
  mercados: Object.fromEntries(Object.entries(MERCADOS).map(([k, v]) => [k, v.nome])),
  oddCampos: Object.fromEntries(Object.entries(MERCADOS).map(([k, v]) => [k, v.odd])),
  tiposCondicao: TIPOS_CONDICAO,
}));

app.get('/api/status', (req, res) => {
  const porLiga = db.prepare('SELECT liga, COUNT(*) AS n, MIN(inicio) AS de, MAX(inicio) AS ate FROM jogos GROUP BY liga').all();
  const sinais = db.prepare(`SELECT status, COUNT(*) AS n, ROUND(SUM(COALESCE(lucro,0)),2) AS lucro FROM sinais GROUP BY status`).all();
  const enviados = db.prepare(`SELECT status, COUNT(*) AS n, ROUND(SUM(COALESCE(lucro,0)),2) AS lucro FROM sinais WHERE enviado = 1 GROUP BY status`).all();
  res.json({
    robo: robo.estado,
    sessao: tson.infoSessao(),
    telegram: { token: !!process.env.TELEGRAM_BOT_TOKEN, chatId: tg.chatId() || null },
    chaveColetor: chaveColetor(),
    painelUrl: `${req.protocol}://${req.get('host')}`,
    exigirAprovacao: getConfig('exigir_aprovacao_teste', false),
    tirosPadrao: getConfig('tiros_padrao', 1),
    antecedencia: getConfig('antecedencia_seg', 60),
    stop: robo.configStop(),
    totalJogos: porLiga.reduce((s, l) => s + l.n, 0),
    porLiga,
    sinais,
    enviados,
    logs: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 30').all(),
  });
});

app.get('/api/panorama', (req, res) => res.json(panorama()));

// ---------- Regras ----------
app.get('/api/regras', (req, res) => {
  res.json(db.prepare('SELECT * FROM regras ORDER BY id DESC').all().map(regraDaLinha));
});

function lerRegra(body) {
  return {
    nome: String(body.nome || '').trim().slice(0, 80),
    ligas: Array.isArray(body.ligas) && body.ligas.length ? body.ligas : ['*'],
    mercado: body.mercado,
    condicoes: Array.isArray(body.condicoes) ? body.condicoes : [],
    modo: body.modo || 'observacao',
    tiros: Math.min(3, Math.max(1, Number(body.tiros) || Number(getConfig('tiros_padrao', 1)) || 1)),
    origem: ['manual', 'descoberta', 'ia', 'modelo'].includes(body.origem) ? body.origem : 'manual',
  };
}

app.post('/api/regras/testar', (req, res) => {
  const r = lerRegra(req.body);
  const erros = validarEstrutura({ ...r, nome: r.nome || 'teste' });
  if (erros.length) return res.status(400).json({ erro: erros.join(' ') });
  res.json(backtest(r));
});

app.post('/api/regras', (req, res) => {
  const r = lerRegra(req.body);
  const erros = validarEstrutura(r);
  if (erros.length) return res.status(400).json({ erro: erros.join(' ') });
  const info = db.prepare('INSERT INTO regras (nome, ligas, mercado, condicoes, modo, tiros, origem) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(r.nome, JSON.stringify(r.ligas), r.mercado, JSON.stringify(r.condicoes), r.modo, r.tiros, r.origem);
  const v = backtest({ ...r, id: info.lastInsertRowid });
  db.prepare('UPDATE regras SET validacao = ? WHERE id = ?').run(JSON.stringify(v), info.lastInsertRowid);
  res.json(regraDaLinha(db.prepare('SELECT * FROM regras WHERE id = ?').get(info.lastInsertRowid)));
});

app.put('/api/regras/:id', (req, res) => {
  const atual = db.prepare('SELECT * FROM regras WHERE id = ?').get(req.params.id);
  if (!atual) return res.status(404).json({ erro: 'Regra não encontrada' });
  const r = lerRegra({ ...regraDaLinha(atual), ...req.body });
  const erros = validarEstrutura(r);
  if (erros.length) return res.status(400).json({ erro: erros.join(' ') });
  db.prepare('UPDATE regras SET nome = ?, ligas = ?, mercado = ?, condicoes = ?, modo = ?, tiros = ?, origem = ? WHERE id = ?')
    .run(r.nome, JSON.stringify(r.ligas), r.mercado, JSON.stringify(r.condicoes), r.modo, r.tiros, r.origem, atual.id);
  if (req.body.modo && req.body.modo !== 'desligado') db.prepare('UPDATE regras SET pausada_por = NULL WHERE id = ?').run(atual.id);
  // só mudou o modo (aprovar, pausar...): não precisa testar de novo
  if (Object.keys(req.body).every((k) => k === 'modo')) {
    return res.json(regraDaLinha(db.prepare('SELECT * FROM regras WHERE id = ?').get(atual.id)));
  }
  const v = backtest({ ...r, id: atual.id });
  db.prepare('UPDATE regras SET validacao = ? WHERE id = ?').run(JSON.stringify(v), atual.id);
  res.json(regraDaLinha(db.prepare('SELECT * FROM regras WHERE id = ?').get(atual.id)));
});

app.delete('/api/regras/:id', (req, res) => {
  try { iaSinais.lembrarExcluida(db.prepare('SELECT * FROM regras WHERE id = ?').get(req.params.id)); } catch { /* segue */ }
  db.prepare('DELETE FROM sinais WHERE regra_id = ?').run(req.params.id);
  db.prepare('DELETE FROM regras WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/regras/revalidar', (req, res) => { robo.revalidarTodas(); res.json({ ok: true }); });

// ---------- Sinais ----------
app.get('/api/sinais', (req, res) => {
  const lim = Math.min(Number(req.query.limite) || 200, 1000);
  const params = [];
  let where = '1=1';
  if (req.query.regra) { where += ' AND s.regra_id = ?'; params.push(req.query.regra); }
  if (req.query.enviados === '1') where += ' AND s.enviado = 1';
  res.json(db.prepare(`SELECT s.*, r.nome AS regra FROM sinais s LEFT JOIN regras r ON r.id = s.regra_id
    WHERE ${where} ORDER BY s.inicio DESC LIMIT ${lim}`).all(...params));
});

app.get('/api/jogos', (req, res) => {
  const liga = LIGAS[req.query.liga] ? req.query.liga : 'italia';
  const arr = jogos.daLiga(liga).slice(-Math.min(Number(req.query.n) || 120, 600));
  res.json({ liga, jogos: arr.reverse(), proximas: (robo.proximas.get(liga) || []).slice(0, 5) });
});

// ---------- Descobrir padrões ----------
app.get('/api/descobrir', (req, res) => res.json(descobrir.situacao()));
app.post('/api/descobrir', (req, res) => {
  if (!jogos.ligas().length) return res.status(400).json({ erro: 'Ainda não há jogos no banco. Conecte o TsonTips e aguarde a coleta.' });
  descobrir.rodar();
  res.json({ ok: true });
});

// ---------- IA ----------
app.get('/api/ia/:mercado', (req, res) => {
  try { res.json(avaliarIA(req.params.mercado, Number(req.query.margem) || 0.03)); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

// ---------- Modelo de valor ----------
app.get('/api/modelo', (req, res) => res.json(modelo.situacao()));
app.post('/api/modelo/treinar', async (req, res) => {
  if (!jogos.ligas().length) return res.status(400).json({ erro: 'Ainda não há jogos no banco.' });
  modelo.treinar().then(() => robo.revalidarTodas());
  res.json({ ok: true });
});
app.post('/api/modelo/config', (req, res) => {
  const b = req.body || {};
  if (b.margem !== undefined) setConfig('modelo_margem', Math.min(30, Math.max(1, Number(b.margem) || 5)));
  if (b.consenso !== undefined) setConfig('consenso', !!b.consenso);
  res.json({ ok: true });
});
app.post('/api/modelo/estrategia', (req, res) => {
  const { mercado, liga } = req.body || {};
  if (!MERCADOS[mercado]) return res.status(400).json({ erro: 'Mercado inválido' });
  const lg = liga && LIGAS[liga] ? liga : '*';
  const margem = Number(getConfig('modelo_margem', 5));
  const r = { nome: `Modelo · ${MERCADOS[mercado].nome} · ${lg === '*' ? 'Todas' : LIGAS[lg]} · valor ≥ ${margem}%`, ligas: [lg], mercado,
    condicoes: [{ tipo: 'modelo', margem }], modo: 'observacao', tiros: 1, origem: 'modelo' };
  const info = db.prepare('INSERT INTO regras (nome, ligas, mercado, condicoes, modo, tiros, origem) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(r.nome, JSON.stringify(r.ligas), r.mercado, JSON.stringify(r.condicoes), r.modo, r.tiros, r.origem);
  db.prepare('UPDATE regras SET validacao = ? WHERE id = ?').run(JSON.stringify(backtest({ ...r, id: info.lastInsertRowid })), info.lastInsertRowid);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// ---------- IA Sinais (OpenAI) ----------
app.get('/api/ia-sinais', (req, res) => {
  const regras = db.prepare(`SELECT * FROM regras WHERE origem = 'ia' ORDER BY id DESC`).all().map(regraDaLinha);
  // estratégias que as sugestões de troca querem substituir (podem ser manuais ou do Descobrir)
  const antigas = {};
  for (const r of regras) if (r.substitui && !antigas[r.substitui]) {
    const a = db.prepare('SELECT * FROM regras WHERE id = ?').get(r.substitui);
    if (a) antigas[r.substitui] = { ...regraDaLinha(a), aoVivo: aoVivo(a.id) };
  }
  res.json({ ...iaSinais.situacao(), regras, antigas });
});
app.post('/api/ia-sinais/config', (req, res) => {
  const b = req.body || {};
  if (b.provedor !== undefined) setConfig('ia_provedor', b.provedor === 'anthropic' ? 'anthropic' : 'openai');
  const prov = (getConfig('ia_provedor') || 'openai') === 'anthropic' ? 'anthropic' : 'openai';
  if (b.chave !== undefined && String(b.chave).trim()) setConfig(prov + '_key', String(b.chave).trim());
  if (b.apagarChave) setConfig(prov + '_key', null);
  if (b.modelo !== undefined && b.provedor === undefined) setConfig(prov + '_modelo', String(b.modelo).trim() || null);
  if (b.qtd !== undefined) setConfig('ia_qtd', Math.min(10, Math.max(1, Number(b.qtd) || 5)));
  if (b.auto !== undefined) setConfig('ia_auto', !!b.auto);
  if (b.revisaoHoras !== undefined) setConfig('ia_revisao_horas', [0, 3, 6, 12].includes(Number(b.revisaoHoras)) ? Number(b.revisaoHoras) : 6);
  res.json({ ok: true });
});
app.post('/api/ia-sinais/revisar', async (req, res) => {
  const r = await iaSinais.revisar('manual');
  if (!r) return res.status(400).json({ erro: iaSinais.situacao().ultimoErro || 'Não foi possível revisar agora (sem API Key, sem jogos ou a IA já está trabalhando).' });
  res.json(r);
});
app.post('/api/regras/:id/aprovar-troca', (req, res) => {
  try { res.json(iaSinais.aprovarTroca(Number(req.params.id))); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});
app.post('/api/ia-sinais/sugerir', async (req, res) => {
  try { res.json(await iaSinais.sugerir((req.body || {}).pedido || '')); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

// ---------- Configurações ----------
app.post('/api/config', (req, res) => {
  const b = req.body || {};
  if (b.telegram_chat_id !== undefined) setConfig('telegram_chat_id', String(b.telegram_chat_id || '').trim() || null);
  if (b.exigir_aprovacao !== undefined) setConfig('exigir_aprovacao_teste', !!b.exigir_aprovacao);
  if (b.tiros_padrao !== undefined) {
    const t = Math.min(3, Math.max(1, Number(b.tiros_padrao) || 1));
    const mudou = t !== Number(getConfig('tiros_padrao', 1));
    setConfig('tiros_padrao', t);
    if (mudou && jogos.ligas().length) descobrir.rodar(); // refaz a análise com os novos tiros
  }
  if (b.stop_ativo !== undefined) setConfig('stop_ativo', !!b.stop_ativo);
  if (b.stop_min_sinais !== undefined) setConfig('stop_min_sinais', Math.min(500, Math.max(5, Number(b.stop_min_sinais) || 20)));
  if (b.stop_roi_min !== undefined) setConfig('stop_roi_min', Math.min(50, Math.max(-100, Number(b.stop_roi_min))));
  if (b.stop_reds_seguidos !== undefined) setConfig('stop_reds_seguidos', Math.min(20, Math.max(0, Number(b.stop_reds_seguidos) || 0)));
  if (b.antecedencia_seg !== undefined) setConfig('antecedencia_seg', Math.min(180, Math.max(30, Number(b.antecedencia_seg) || 60)));
  res.json({ ok: true });
});

app.post('/api/config/sessao', async (req, res) => {
  try {
    tson.salvarSessaoDeCookie(req.body.cookie, req.body.ch);
    await tson.api('/api/me/plan?date=' + new Date().toISOString().slice(0, 10));
    res.json({ ok: true, sessao: tson.infoSessao() });
  } catch (e) {
    const msg = e.message === 'fetch failed' ? 'O servidor não conseguiu acessar o TsonTips. Tente de novo em alguns minutos.' : e.message;
    res.status(400).json({ erro: msg });
  }
});

app.post('/api/config/nova-chave-coletor', (req, res) => {
  setConfig('ingest_token', crypto.randomBytes(16).toString('hex'));
  res.json({ ok: true, chave: chaveColetor() });
});

app.post('/api/telegram/teste', async (req, res) => {
  const id = await tg.enviar('✅ Teste do painel de sinais: o bot está funcionando.');
  if (!id) return res.status(400).json({ erro: 'Não consegui enviar. Confira o token no .env e o chat ID.' });
  res.json({ ok: true });
});

app.post('/api/telegram/relatorio', async (req, res) => {
  const id = await tg.enviar(robo.textoRelatorio());
  res.json({ ok: !!id });
});

app.use((err, req, res, next) => {
  log('erro', err.stack || err.message);
  res.status(500).json({ erro: 'Erro interno' });
});

const porta = Number(process.env.PORT) || 3000;
app.listen(porta, () => {
  log('info', `Painel rodando na porta ${porta}`);
  if (process.env.SEM_ROBO !== '1') robo.iniciar();
  else jogos.carregar();
  // atualiza a descoberta de padrões sozinho: 3 min depois de ligar e a cada 6 horas
  setTimeout(() => { if (jogos.ligas().length) descobrir.rodar(); }, 3 * 60000);
  setInterval(() => { if (jogos.ligas().length) descobrir.rodar(); }, 6 * 3600e3);
  // revisão da IA: no intervalo escolhido (3, 6 ou 12 horas) e na hora em que o stop pausar uma estratégia
  robo.quandoPausar((id) => iaSinais.revisar('stop', id).catch(() => {}));
  // modelo de valor: treina 1 minuto depois de ligar e a cada 2 horas, e recalcula as regras
  const treinarModelo = () => { if (jogos.ligas().length) modelo.treinar().then(() => robo.revalidarTodas()).catch(() => {}); };
  setTimeout(treinarModelo, 60000);
  setInterval(treinarModelo, 2 * 3600e3);
  setInterval(() => {
    const horas = Number(getConfig('ia_revisao_horas', 6));
    if (!horas) return;
    const ultima = Date.parse(getConfig('ia_ultima_revisao') || 0) || 0;
    if (Date.now() - ultima >= horas * 3600e3) iaSinais.revisar('agendada').catch(() => {});
  }, 10 * 60000);
});
