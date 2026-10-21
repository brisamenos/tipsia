require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const { db, getConfig, setConfig, log } = require('./db');
const { LIGAS, MERCADOS } = require('./mercados');
const { validarEstrutura, TIPOS_CONDICAO } = require('./regras');
const { backtest, panorama } = require('./validador');
const { avaliarIA } = require('./ia');
const jogos = require('./jogos');
const tson = require('./tsontips');
const tg = require('./telegram');
const robo = require('./robo');

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
app.use(express.json({ limit: '200kb' }));

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

const exigeLogin = (req, res, next) => {
  if (req.session.usuario) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'Faça login' });
  return res.redirect('/login.html');
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
    exigirAprovacao: getConfig('exigir_aprovacao', true),
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
  const info = db.prepare('INSERT INTO regras (nome, ligas, mercado, condicoes, modo) VALUES (?, ?, ?, ?, ?)')
    .run(r.nome, JSON.stringify(r.ligas), r.mercado, JSON.stringify(r.condicoes), r.modo);
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
  db.prepare('UPDATE regras SET nome = ?, ligas = ?, mercado = ?, condicoes = ?, modo = ? WHERE id = ?')
    .run(r.nome, JSON.stringify(r.ligas), r.mercado, JSON.stringify(r.condicoes), r.modo, atual.id);
  const v = backtest({ ...r, id: atual.id });
  db.prepare('UPDATE regras SET validacao = ? WHERE id = ?').run(JSON.stringify(v), atual.id);
  res.json(regraDaLinha(db.prepare('SELECT * FROM regras WHERE id = ?').get(atual.id)));
});

app.delete('/api/regras/:id', (req, res) => {
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

// ---------- IA ----------
app.get('/api/ia/:mercado', (req, res) => {
  try { res.json(avaliarIA(req.params.mercado, Number(req.query.margem) || 0.03)); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

// ---------- Configurações ----------
app.post('/api/config', (req, res) => {
  const b = req.body || {};
  if (b.telegram_chat_id !== undefined) setConfig('telegram_chat_id', String(b.telegram_chat_id || '').trim() || null);
  if (b.exigir_aprovacao !== undefined) setConfig('exigir_aprovacao', !!b.exigir_aprovacao);
  res.json({ ok: true });
});

app.post('/api/config/sessao', async (req, res) => {
  try {
    tson.salvarSessaoDeCookie(req.body.cookie, req.body.ch);
    await tson.api('/api/me/plan?date=' + new Date().toISOString().slice(0, 10));
    res.json({ ok: true, sessao: tson.infoSessao() });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
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
});
