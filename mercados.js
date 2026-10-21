// Ligas da Kiron disponíveis no TsonTips
const LIGAS = {
  brasil: 'Brasil',
  inglaterra: 'Inglaterra',
  italia: 'Itália',
  espanha: 'Espanha',
  liga_dos_campeoes: 'Liga dos Campeões',
  copa_do_mundo: 'Copa do Mundo',
  mundial: 'Mundial',
};

// Cada mercado: nome, campo da odd e como saber se bateu
const total = (j) => j.gc + j.gf;
const MERCADOS = {
  ambas_sim:  { nome: 'Ambas marcam: Sim',  odd: 'odd_ambas_sim', ok: (j) => j.gc > 0 && j.gf > 0 },
  ambas_nao:  { nome: 'Ambas marcam: Não',  odd: 'odd_ambas_nao', ok: (j) => !(j.gc > 0 && j.gf > 0) },
  over_15:    { nome: 'Over 1.5 gols',      odd: 'odd_over_15',   ok: (j) => total(j) >= 2 },
  over_25:    { nome: 'Over 2.5 gols',      odd: 'odd_over_25',   ok: (j) => total(j) >= 3 },
  over_35:    { nome: 'Over 3.5 gols',      odd: 'odd_over_35',   ok: (j) => total(j) >= 4 },
  under_15:   { nome: 'Under 1.5 gols',     odd: 'odd_under_15',  ok: (j) => total(j) <= 1 },
  under_25:   { nome: 'Under 2.5 gols',     odd: 'odd_under_25',  ok: (j) => total(j) <= 2 },
  under_35:   { nome: 'Under 3.5 gols',     odd: 'odd_under_35',  ok: (j) => total(j) <= 3 },
  casa:       { nome: 'Vitória do mandante', odd: 'odd_casa',     ok: (j) => j.gc > j.gf },
  empate:     { nome: 'Empate',             odd: 'odd_empate',    ok: (j) => j.gc === j.gf },
  fora:       { nome: 'Vitória do visitante', odd: 'odd_fora',    ok: (j) => j.gf > j.gc },
  ht_empate:  { nome: 'Empate no 1º tempo', odd: 'odd_ht_empate', ok: (j) => j.gc_ht != null && j.gc_ht === j.gf_ht },
  casa_marca: { nome: 'Mandante marca',     odd: 'odd_casa_marcar_sim', ok: (j) => j.gc > 0 },
  fora_marca: { nome: 'Visitante marca',    odd: 'odd_fora_marcar_sim', ok: (j) => j.gf > 0 },
  gols_impar: { nome: 'Total de gols ímpar', odd: 'odd_impar',    ok: (j) => total(j) % 2 === 1 },
  gols_par:   { nome: 'Total de gols par',  odd: 'odd_par',       ok: (j) => total(j) % 2 === 0 },
};

function oddDo(jogo, mercado) {
  const m = MERCADOS[mercado];
  if (!m || !jogo.odds) return null;
  const v = Number(jogo.odds[m.odd]);
  return v > 1 ? v : null;
}

function bateu(jogo, mercado) {
  return MERCADOS[mercado].ok(jogo);
}

// Mercados complementares: servem para tirar a margem da casa da odd
const GRUPOS = [
  ['ambas_sim', 'ambas_nao'], ['over_15', 'under_15'], ['over_25', 'under_25'],
  ['over_35', 'under_35'], ['casa', 'empate', 'fora'], ['gols_impar', 'gols_par'],
];

// Probabilidade "justa" que a odd indica (sem a margem da casa)
function probJusta(jogo, mercado) {
  const o = oddDo(jogo, mercado);
  if (!o) return null;
  const g = GRUPOS.find((x) => x.includes(mercado));
  if (!g) return 1 / o;
  const odds = g.map((m) => oddDo(jogo, m));
  if (odds.some((x) => !x)) return 1 / o;
  const soma = odds.reduce((s, x) => s + 1 / x, 0);
  return (1 / o) / soma;
}

module.exports = { LIGAS, MERCADOS, oddDo, bateu, probJusta };
