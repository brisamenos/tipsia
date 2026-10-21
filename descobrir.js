// "Descobrir padrões": gera e testa automaticamente milhares de ideias de regra.
// A escolha das melhores é feita SÓ no treino (1ª metade). O teste (2ª metade)
// mostra se a ideia continuou funcionando em jogos que ela não viu.
const { LIGAS, MERCADOS, oddDo, bateu } = require('./mercados');
const { estatisticas, classificar, simularLiga } = require('./validador');
const jogos = require('./jogos');
const { getConfig, setConfig, log } = require('./db');

const PLACARES = ['0-0', '1-0', '0-1', '1-1', '2-0', '0-2', '2-1', '1-2', '2-2'];
const estado = { rodando: false, progresso: 0, total: 0, iniciadoEm: null };

const pausa = () => new Promise((r) => setImmediate(r));

function faixasDeOdd(mercado) {
  const odds = [];
  for (const l of Object.keys(LIGAS)) for (const j of jogos.daLiga(l)) { const o = oddDo(j, mercado); if (o) odds.push(o); }
  if (odds.length < 300) return [];
  odds.sort((a, b) => a - b);
  const q = (p) => +odds[Math.floor(odds.length * p)].toFixed(2);
  const q1 = q(1 / 3), q2 = q(2 / 3);
  if (q1 >= q2) return [];
  return [
    { min: '', max: q1, nome: `odd até ${q1}` },
    { min: q1, max: q2, nome: `odd ${q1} a ${q2}` },
    { min: q2, max: '', nome: `odd acima de ${q2}` },
  ];
}

function candidatos(mercado) {
  const nm = MERCADOS[mercado].nome;
  const lista = [];
  const add = (condicoes, desc) => lista.push({ condicoes, desc });
  for (let n = 1; n <= 5; n++) {
    add([{ tipo: 'sequencia', mercado, n, valor: false }], `após ${n} jogo(s) seguido(s) SEM ${nm}`);
    add([{ tipo: 'sequencia', mercado, n, valor: true }], `após ${n} jogo(s) seguido(s) COM ${nm}`);
  }
  add([{ tipo: 'frequencia', mercado, n: 10, op: '<=', qtd: 3 }], `${nm} saiu 3x ou menos nos últimos 10`);
  add([{ tipo: 'frequencia', mercado, n: 10, op: '>=', qtd: 7 }], `${nm} saiu 7x ou mais nos últimos 10`);
  for (const p of PLACARES) add([{ tipo: 'placar_anterior', placar: p }], `jogo anterior terminou ${p}`);
  add([{ tipo: 'gols_anterior', op: '<=', qtd: 1 }], 'jogo anterior com 0 ou 1 gol');
  add([{ tipo: 'gols_anterior', op: '>=', qtd: 4 }], 'jogo anterior com 4 gols ou mais');
  const faixas = faixasDeOdd(mercado);
  for (const f of faixas) add([{ tipo: 'odd', min: f.min, max: f.max }], f.nome);
  for (const n of [2, 3]) for (const v of [false, true]) for (const f of faixas) {
    add([{ tipo: 'sequencia', mercado, n, valor: v }, { tipo: 'odd', min: f.min, max: f.max }],
      `após ${n} seguidos ${v ? 'COM' : 'SEM'} ${nm} + ${f.nome}`);
  }
  return lista;
}

function corteGlobal() {
  const ts = [];
  for (const l of Object.keys(LIGAS)) for (const j of jogos.daLiga(l)) ts.push(j.t);
  ts.sort((a, b) => a - b);
  return ts.length ? ts[Math.floor(ts.length / 2)] : 0;
}

// testa uma ideia em um conjunto de ligas (com os tiros configurados)
function testar(regra, ligas, corte, tiros) {
  const tr = [], te = [];
  for (const liga of ligas) for (const e of simularLiga(regra, liga, tiros)) (e.t < corte ? tr : te).push(e);
  return { treino: estatisticas(tr), teste: estatisticas(te) };
}

async function rodar() {
  if (estado.rodando) return;
  estado.rodando = true;
  estado.iniciadoEm = new Date().toISOString();
  estado.progresso = 0;
  try {
    const todasLigas = Object.keys(LIGAS).filter((l) => jogos.daLiga(l).length > 100);
    const opcoesLiga = [['*', todasLigas], ...todasLigas.map((l) => [l, [l]])];
    const corte = corteGlobal();
    const tiros = Math.min(3, Math.max(1, Number(getConfig('tiros_padrao', 1)) || 1));
    const planos = [];
    for (const mercado of Object.keys(MERCADOS)) {
      for (const c of candidatos(mercado)) for (const [chave, ligas] of opcoesLiga) planos.push({ mercado, c, chave, ligas });
    }
    estado.total = planos.length;
    const resultados = [];
    for (let k = 0; k < planos.length; k++) {
      const { mercado, c, chave, ligas } = planos[k];
      const regra = { mercado, condicoes: c.condicoes };
      const { treino, teste } = testar(regra, ligas, corte, tiros);
      if (treino.roi != null && treino.n >= 40) {
        resultados.push({
          mercado, ligas: [chave], condicoes: c.condicoes, tiros,
          nome: `${MERCADOS[mercado].nome} · ${chave === '*' ? 'Todas' : LIGAS[chave]} · ${c.desc}`,
          treino, teste, status: classificar(treino, teste),
        });
      }
      estado.progresso = k + 1;
      if (k % 25 === 0) await pausa();
    }

    const lucraramTreino = resultados.filter((r) => r.treino.roi > 0);
    const continuaram = lucraramTreino.filter((r) => r.teste.n >= 20 && r.teste.roi > 0);
    // ranking escolhido SÓ pelo treino (confiança z), como faria um apostador olhando o passado
    const ranking = [...lucraramTreino].sort((a, b) => (b.treino.z ?? -99) - (a.treino.z ?? -99)).slice(0, 40);
    // e as que se sustentaram nas duas metades
    const sustentaram = [...continuaram].sort((a, b) =>
      Math.min(b.treino.z ?? -99, b.teste.z ?? -99) - Math.min(a.treino.z ?? -99, a.teste.z ?? -99)).slice(0, 40);

    const res = {
      em: new Date().toISOString(),
      corte: new Date(corte).toISOString(),
      tiros,
      testadas: planos.length,
      comAmostra: resultados.length,
      lucraramTreino: lucraramTreino.length,
      continuaram: continuaram.length,
      aprovadas: resultados.filter((r) => r.status.codigo === 'aprovada').length,
      ranking,
      sustentaram,
    };
    setConfig('descoberta', res);
    log('info', `Descobrir padrões: ${planos.length} ideias testadas, ${continuaram.length} lucraram nas duas metades`);
  } catch (e) {
    log('erro', `Descobrir padrões: ${e.message}`);
  } finally {
    estado.rodando = false;
  }
}

function situacao() {
  return { ...estado, resultado: getConfig('descoberta') };
}

module.exports = { rodar, situacao };
