// "Descobrir padrões": gera e testa automaticamente milhares de ideias de regra.
// A escolha das melhores é feita SÓ no treino (1ª metade). O teste (2ª metade)
// mostra se a ideia continuou funcionando em jogos que ela não viu.
const { LIGAS, MERCADOS, oddDo, bateu } = require('./mercados');
const { simularLiga, analisar, cortes } = require('./validador');
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

// testa uma ideia em um conjunto de ligas (com os tiros configurados), nas 3 partes
function testar(regra, ligas, c50, c75, tiros) {
  const entradas = [];
  for (const liga of ligas) entradas.push(...simularLiga(regra, liga, tiros));
  return analisar(entradas, c50, c75);
}

async function rodar() {
  if (estado.rodando) return;
  estado.rodando = true;
  estado.iniciadoEm = new Date().toISOString();
  estado.progresso = 0;
  try {
    const todasLigas = Object.keys(LIGAS).filter((l) => jogos.daLiga(l).length > 100);
    const opcoesLiga = [['*', todasLigas], ...todasLigas.map((l) => [l, [l]])];
    const { c50, c75 } = cortes(todasLigas);
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
      const a = testar(regra, ligas, c50, c75, tiros);
      if (a.treino.roi != null && a.treino.n >= 40) {
        resultados.push({
          mercado, ligas: [chave], condicoes: c.condicoes, tiros,
          nome: `${MERCADOS[mercado].nome} · ${chave === '*' ? 'Todas' : LIGAS[chave]} · ${c.desc}`,
          treino: a.treino, validacao: a.validacao, prova: a.prova, teste: a.teste,
          dias: { total: a.dias.total, positivos: a.dias.positivos }, status: a.status,
        });
      }
      estado.progresso = k + 1;
      if (k % 25 === 0) await pausa();
    }

    // 1) lucrou no treino; 2) escolhidas usando SÓ treino + validação; 3) a prova final fica intocada
    const lucraramTreino = resultados.filter((r) => r.treino.roi > 0);
    const passaramValidacao = lucraramTreino.filter((r) => r.validacao.n >= 10 && r.validacao.roi > 0);
    const confirmaram = passaramValidacao.filter((r) => r.prova.n >= 10 && r.prova.roi > 0);
    const ranking = [...lucraramTreino].sort((a, b) => (b.treino.z ?? -99) - (a.treino.z ?? -99)).slice(0, 40);
    const sustentaram = [...passaramValidacao].sort((a, b) =>
      Math.min(b.treino.z ?? -99, b.validacao.z ?? -99) - Math.min(a.treino.z ?? -99, a.validacao.z ?? -99)).slice(0, 40);
    const continuaram = confirmaram;

    const res = {
      em: new Date().toISOString(),
      corte: new Date(c50).toISOString(),
      corteProva: new Date(c75).toISOString(),
      passaramValidacao: passaramValidacao.length,
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
    log('info', `Descobrir padrões: ${planos.length} ideias testadas, ${passaramValidacao.length} passaram na validação, ${confirmaram.length} confirmaram na prova final`);
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
