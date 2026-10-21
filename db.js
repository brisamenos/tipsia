const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });

const db = new Database(path.join(dir, 'sinais.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jogos (
  id TEXT PRIMARY KEY,               -- liga|inicioISO
  liga TEXT NOT NULL,
  inicio TEXT NOT NULL,              -- ISO UTC
  hora INTEGER,
  minuto INTEGER,
  time_casa TEXT,
  time_fora TEXT,
  gc INTEGER, gf INTEGER,
  gc_ht INTEGER, gf_ht INTEGER,
  odds TEXT,                         -- JSON com as odds do jogo
  coletado_em TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_jogos_liga_inicio ON jogos(liga, inicio);

CREATE TABLE IF NOT EXISTS regras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  ligas TEXT NOT NULL,               -- JSON: ["*"] ou ["italia","brasil"]
  mercado TEXT NOT NULL,
  condicoes TEXT NOT NULL,           -- JSON
  modo TEXT NOT NULL DEFAULT 'observacao',  -- desligado | observacao | telegram
  validacao TEXT,                    -- JSON do último backtest
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sinais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  regra_id INTEGER NOT NULL,
  liga TEXT NOT NULL,
  inicio TEXT NOT NULL,
  time_casa TEXT, time_fora TEXT,
  mercado TEXT NOT NULL,
  odd REAL,
  enviado INTEGER DEFAULT 0,
  telegram_msg_id INTEGER,
  status TEXT DEFAULT 'pendente',    -- pendente | green | red | anulado
  placar TEXT,
  lucro REAL,
  criado_em TEXT DEFAULT (datetime('now')),
  UNIQUE(regra_id, liga, inicio)
);
CREATE INDEX IF NOT EXISTS ix_sinais_pend ON sinais(status, liga, inicio);

CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nivel TEXT, mensagem TEXT,
  em TEXT DEFAULT (datetime('now'))
);
`);

function getConfig(chave, padrao = null) {
  const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
  if (!r) return padrao;
  try { return JSON.parse(r.valor); } catch { return padrao; }
}

function setConfig(chave, valor) {
  db.prepare(`INSERT INTO config (chave, valor) VALUES (?, ?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`)
    .run(chave, JSON.stringify(valor));
}

function log(nivel, mensagem) {
  const msg = String(mensagem).slice(0, 1000);
  console[nivel === 'erro' ? 'error' : 'log'](`[${nivel}] ${msg}`);
  db.prepare('INSERT INTO logs (nivel, mensagem) VALUES (?, ?)').run(nivel, msg);
  db.prepare('DELETE FROM logs WHERE id < (SELECT MAX(id) - 500 FROM logs)').run();
}

module.exports = { db, getConfig, setConfig, log };
