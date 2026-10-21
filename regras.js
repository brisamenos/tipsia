// Motor de regras: decide se uma regra dispara para o "jogo alvo",
// olhando só para os jogos que já terminaram ANTES dele (hist).
const { MERCADOS, oddDo, bateu } = require('./mercados');

const TIPOS_CONDICAO = {
  sequencia: 'Últimos N jogos seguidos com / sem o mercado',
  frequencia: 'Quantas vezes o mercado saiu nos últimos N jogos',
  placar_anterior: 'Placar do jogo anterior',
  gols_anterior: 'Total de gols do jogo anterior',
  minuto: 'Minuto do jogo alvo',
  hora: 'Hora do jogo alvo',
  odd: 'Faixa de odd do jogo alvo (no mercado da regra)',
};

function comparar(a, op, b) {
  switch (op) {
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '=': return a === b;
    case '>': return a > b;
    case '<': return a < b;
    default: return false;
  }
}

function listaNumeros(v) {
  if (Array.isArray(v)) return v.map(Number);
  return String(v || '').split(/[,;\s]+/).filter(Boolean).map(Number);
}

// hist: jogos anteriores da mesma liga (do mais antigo ao mais recente)
// alvo: { minuto, hora, odds, ... }
// fim (opcional): usa só hist[0..fim-1], evita copiar arrays no backtest
function avaliar(regra, hist, alvo, fim) {
  if (!regra.condicoes || !regra.condicoes.length) return false;
  const L = fim ?? hist.length;
  for (const c of regra.condicoes) {
    switch (c.tipo) {
      case 'sequencia': {
        const n = Number(c.n) || 1;
        if (L < n || !MERCADOS[c.mercado]) return false;
        const querido = c.valor !== false && c.valor !== 'false';
        for (let k = 1; k <= n; k++) {
          if (bateu(hist[L - k], c.mercado) !== querido) return false;
        }
        break;
      }
      case 'frequencia': {
        const n = Number(c.n) || 10;
        if (L < n || !MERCADOS[c.mercado]) return false;
        let qtd = 0;
        for (let k = 1; k <= n; k++) if (bateu(hist[L - k], c.mercado)) qtd++;
        if (!comparar(qtd, c.op || '>=', Number(c.qtd))) return false;
        break;
      }
      case 'placar_anterior': {
        const u = hist[L - 1];
        if (!u) return false;
        const lista = String(c.placar || '').split(/[,;\s]+/).filter(Boolean);
        if (!lista.includes(`${u.gc}-${u.gf}`)) return false;
        break;
      }
      case 'gols_anterior': {
        const u = hist[L - 1];
        if (!u || !comparar(u.gc + u.gf, c.op || '>=', Number(c.qtd))) return false;
        break;
      }
      case 'minuto':
        if (!listaNumeros(c.valores).includes(Number(alvo.minuto))) return false;
        break;
      case 'hora':
        if (!listaNumeros(c.valores).includes(Number(alvo.hora))) return false;
        break;
      case 'odd': {
        const o = oddDo(alvo, regra.mercado);
        if (o == null) return false;
        if (c.min !== '' && c.min != null && o < Number(c.min)) return false;
        if (c.max !== '' && c.max != null && o > Number(c.max)) return false;
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

function ligasDaRegra(regra, todas) {
  const l = regra.ligas || ['*'];
  return l.includes('*') ? todas : l.filter((x) => todas.includes(x));
}

function validarEstrutura(r) {
  const erros = [];
  if (!r.nome || !String(r.nome).trim()) erros.push('Dê um nome para a regra.');
  if (!MERCADOS[r.mercado]) erros.push('Escolha o mercado da entrada.');
  if (!Array.isArray(r.condicoes) || !r.condicoes.length) erros.push('Adicione pelo menos uma condição.');
  for (const c of r.condicoes || []) {
    if (!TIPOS_CONDICAO[c.tipo]) erros.push('Tipo de condição inválido.');
    if ((c.tipo === 'sequencia' || c.tipo === 'frequencia') && !MERCADOS[c.mercado]) erros.push('Escolha o mercado da condição.');
  }
  if (!['desligado', 'observacao', 'telegram'].includes(r.modo || 'observacao')) erros.push('Modo inválido.');
  return erros;
}

module.exports = { avaliar, ligasDaRegra, validarEstrutura, TIPOS_CONDICAO };
