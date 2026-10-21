const TZ = 'America/Fortaleza';
const fmtHora = (iso) => iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '-';
const fmtDataHora = (iso) => iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '-';

async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('sessão'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
  return j;
}

function regraVazia() {
  return { id: null, nome: '', ligas: ['*'], mercado: 'ambas_sim', modo: 'observacao', tiros: 1, condicoes: [condicaoVazia('sequencia')] };
}
function condicaoVazia(tipo) {
  return { tipo, mercado: 'ambas_sim', n: 3, valor: false, op: '>=', qtd: 7, placar: '0-0', valores: '', min: '', max: '' };
}

function painel() {
  return {
    aba: 'inicio',
    meta: { ligas: {}, mercados: {}, oddCampos: {}, tiposCondicao: {} },
    status: null,
    regras: [],
    editando: null,
    resultadoTeste: null,
    testando: false,
    sinais: [],
    filtroSinais: { regra: '', enviados: false },
    panorama: [],
    metricaPanorama: 'taxa',
    ia: { mercado: 'ambas_sim', margem: 3, res: null, carregando: false },
    jogosLiga: 'italia', jogosMercado: 'ambas_sim', jogosDados: null,
    cfg: { chat: '', cookie: '', ch: '', senhaAtual: '', senhaNova: '' },
    toastMsg: '',
    fmtHora, fmtDataHora,

    async iniciar() {
      this.meta = await api('/api/meta');
      await this.carregarStatus();
      await this.carregarRegras();
      setInterval(() => { if (this.aba === 'inicio') this.carregarStatus(); }, 30000);
    },
    toast(m) { this.toastMsg = m; setTimeout(() => (this.toastMsg = ''), 3500); },
    async ir(aba) {
      this.aba = aba;
      if (aba === 'inicio') this.carregarStatus();
      if (aba === 'regras') this.carregarRegras();
      if (aba === 'sinais') this.carregarSinais();
      if (aba === 'estatisticas') this.panorama = await api('/api/panorama');
      if (aba === 'descobrir') this.carregarDescoberta();
      if (aba === 'iasinais') { if (!this.status) await this.carregarStatus(); this.carregarIA(); }
      if (aba === 'jogos') this.carregarJogos();
      if (aba === 'config') { await this.carregarStatus(); this.cfg.chat = this.status.telegram.chatId || ''; }
    },
    async sair() { await api('/api/logout', { method: 'POST' }); location.href = '/login.html'; },

    // ---- Status
    async carregarStatus() { this.status = await api('/api/status'); },
    resumoSinais(lista) {
      const g = (lista || []).find((x) => x.status === 'green') || { n: 0, lucro: 0 };
      const r = (lista || []).find((x) => x.status === 'red') || { n: 0, lucro: 0 };
      const p = (lista || []).find((x) => x.status === 'pendente') || { n: 0 };
      const tot = g.n + r.n;
      return { g: g.n, r: r.n, p: p.n, taxa: tot ? (g.n / tot * 100).toFixed(1) : '-', lucro: (g.lucro + r.lucro).toFixed(2) };
    },

    // ---- Regras
    async carregarRegras() { this.regras = await api('/api/regras'); },
    nova() { this.editando = regraVazia(); this.editando.tiros = this.status?.tirosPadrao || 1; this.resultadoTeste = null; },
    editar(r) {
      this.editando = JSON.parse(JSON.stringify(r));
      this.editando.condicoes = this.editando.condicoes.map((c) => ({ ...condicaoVazia(c.tipo), ...c, valores: Array.isArray(c.valores) ? c.valores.join(', ') : (c.valores || '') }));
      this.resultadoTeste = r.validacao;
    },
    addCondicao() { this.editando.condicoes.push(condicaoVazia('sequencia')); },
    trocarTipo(c) { Object.assign(c, { ...condicaoVazia(c.tipo), tipo: c.tipo }); },
    alternarLiga(l) {
      const e = this.editando;
      if (l === '*') { e.ligas = ['*']; return; }
      let s = e.ligas.filter((x) => x !== '*');
      s = s.includes(l) ? s.filter((x) => x !== l) : [...s, l];
      e.ligas = s.length ? s : ['*'];
    },
    corpoRegra() {
      const e = this.editando;
      return {
        nome: e.nome, ligas: e.ligas, mercado: e.mercado, modo: e.modo, tiros: +e.tiros || 1,
        condicoes: e.condicoes.map((c) => {
          switch (c.tipo) {
            case 'sequencia': return { tipo: c.tipo, mercado: c.mercado, n: +c.n, valor: c.valor === true || c.valor === 'true' };
            case 'frequencia': return { tipo: c.tipo, mercado: c.mercado, n: +c.n, op: c.op, qtd: +c.qtd };
            case 'placar_anterior': return { tipo: c.tipo, placar: c.placar };
            case 'gols_anterior': return { tipo: c.tipo, op: c.op, qtd: +c.qtd };
            case 'minuto': case 'hora': return { tipo: c.tipo, valores: String(c.valores).split(/[,;\s]+/).filter(Boolean).map(Number) };
            case 'odd': return { tipo: c.tipo, min: c.min === '' ? '' : +c.min, max: c.max === '' ? '' : +c.max };
          }
          return c;
        }),
      };
    },
    async testar() {
      this.testando = true;
      try { this.resultadoTeste = await api('/api/regras/testar', { method: 'POST', body: { ...this.corpoRegra(), nome: this.editando.nome || 'teste' } }); }
      catch (e) { this.toast(e.message); }
      this.testando = false;
    },
    async salvar() {
      try {
        const r = this.editando.id
          ? await api(`/api/regras/${this.editando.id}`, { method: 'PUT', body: this.corpoRegra() })
          : await api('/api/regras', { method: 'POST', body: this.corpoRegra() });
        this.toast('Regra salva');
        this.resultadoTeste = r.validacao;
        this.editando.id = r.id;
        await this.carregarRegras();
      } catch (e) { this.toast(e.message); }
    },
    async mudarModo(r, modo) {
      await api(`/api/regras/${r.id}`, { method: 'PUT', body: { modo } });
      await this.carregarRegras();
      if (modo === 'telegram' && this.status && this.status.exigirAprovacao && r.validacao?.status?.codigo !== 'aprovada') {
        this.toast('Modo Telegram ligado, mas os sinais só serão enviados se a regra for aprovada no teste.');
      }
    },
    async excluir(r) {
      if (!confirm(`Excluir a regra "${r.nome}" e todos os sinais dela?`)) return;
      await api(`/api/regras/${r.id}`, { method: 'DELETE' });
      if (this.editando && this.editando.id === r.id) this.editando = null;
      await this.carregarRegras();
    },
    descreverCond(c) {
      const m = this.meta.mercados[c.mercado] || c.mercado;
      switch (c.tipo) {
        case 'sequencia': return `${c.n} jogos seguidos ${c.valor ? 'COM' : 'SEM'} ${m}`;
        case 'frequencia': return `${m} ${c.op} ${c.qtd}x nos últimos ${c.n}`;
        case 'placar_anterior': return `jogo anterior terminou ${c.placar}`;
        case 'gols_anterior': return `jogo anterior com gols ${c.op} ${c.qtd}`;
        case 'minuto': return `minuto ${[].concat(c.valores).join(', ')}`;
        case 'hora': return `hora ${[].concat(c.valores).join(', ')}`;
        case 'odd': return `odd ${c.min !== '' ? 'de ' + c.min : ''} ${c.max !== '' ? 'até ' + c.max : ''}`;
      }
      return c.tipo;
    },
    nomesLigas(l) { return l.includes('*') ? 'Todas' : l.map((x) => this.meta.ligas[x]).join(', '); },
    clsNum(v) { return v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : ''; },

    // ---- Sinais
    async carregarSinais() {
      const q = new URLSearchParams({ limite: 300 });
      if (this.filtroSinais.regra) q.set('regra', this.filtroSinais.regra);
      if (this.filtroSinais.enviados) q.set('enviados', '1');
      this.sinais = await api('/api/sinais?' + q);
    },

    // ---- Estatísticas
    celula(m) {
      if (!m || !m.n) return '-';
      if (this.metricaPanorama === 'taxa') return m.taxa + '%';
      if (this.metricaPanorama === 'roi') return m.roi == null ? '-' : m.roi + '%';
      return m.oddMedia ?? '-';
    },

    // ---- IA
    async rodarIA() {
      this.ia.carregando = true; this.ia.res = null;
      try { this.ia.res = await api(`/api/ia/${this.ia.mercado}?margem=${this.ia.margem / 100}`); }
      catch (e) { this.toast(e.message); }
      this.ia.carregando = false;
    },

    // ---- Jogos
    async carregarJogos() { this.jogosDados = await api(`/api/jogos?liga=${this.jogosLiga}&n=150`); },
    bateuMercado(j, m) {
      const t = j.gc + j.gf;
      return ({
        ambas_sim: j.gc > 0 && j.gf > 0, ambas_nao: !(j.gc > 0 && j.gf > 0),
        over_15: t >= 2, over_25: t >= 3, over_35: t >= 4, under_15: t <= 1, under_25: t <= 2, under_35: t <= 3,
        casa: j.gc > j.gf, empate: j.gc === j.gf, fora: j.gf > j.gc, ht_empate: j.gc_ht != null && j.gc_ht === j.gf_ht,
        casa_marca: j.gc > 0, fora_marca: j.gf > 0, gols_impar: t % 2 === 1, gols_par: t % 2 === 0,
      })[m];
    },

    // ---- Conexão em 1 clique (favorito que roda dentro do TsonTips)
    linkConectar() {
      const painel = location.origin;
      const js = `(function(){
if(location.hostname.indexOf('tsontips.com.br')<0){alert('Abra o TsonTips (já logado) e toque neste favorito de novo.');return;}
var P='${painel}';
var w=window.open(P+'/coletor.html','labsinais');
if(!w){alert('O navegador bloqueou a janela. Permita pop-ups para o TsonTips e tente de novo.');return;}
if(window.__lab)window.removeEventListener('message',window.__lab);
window.__lab=function(e){
if(e.origin!==P)return;var d=e.data||{};
if(d.tipo!=='pedir'||String(d.caminho).indexOf('/api/')!==0)return;
fetch(d.caminho,{credentials:'include',headers:{Accept:'application/json'}}).then(function(r){
return r.text().then(function(t){e.source.postMessage({tipo:'dados',id:d.id,status:r.status,texto:t},P);});
}).catch(function(x){e.source.postMessage({tipo:'dados',id:d.id,status:0,texto:String(x)},P);});};
window.addEventListener('message',window.__lab);
})();`;
      return 'javascript:' + encodeURIComponent(js.replace(/\n/g, ''));
    },
    async copiarLink() {
      try { await navigator.clipboard.writeText(this.linkConectar()); this.toast('Código do favorito copiado'); }
      catch { this.toast('Não consegui copiar. Segure o botão e copie o link.'); }
    },

    // ---- Descobrir padrões
    descoberta: null,
    abaDescoberta: 'sustentaram',
    async carregarDescoberta() { this.descoberta = await api('/api/descobrir'); },
    async iniciarDescoberta() {
      try { await api('/api/descobrir', { method: 'POST' }); }
      catch (e) { return this.toast(e.message); }
      const t = setInterval(async () => {
        await this.carregarDescoberta();
        if (!this.descoberta.rodando) clearInterval(t);
      }, 1500);
      await this.carregarDescoberta();
    },
    async ativarIdeia(r, modo) {
      try {
        await api('/api/regras', { method: 'POST', body: { nome: r.nome.slice(0, 80), ligas: r.ligas, mercado: r.mercado, condicoes: r.condicoes, modo, tiros: r.tiros || 1, origem: 'descoberta' } });
        this.toast(modo === 'telegram' ? 'Regra criada no modo Telegram' : 'Regra criada em observação');
        this.carregarRegras();
      } catch (e) { this.toast(e.message); }
    },

    // ---- IA Sinais (OpenAI)
    iaS: null,
    iaCfg: { chave: '', modelo: '', qtd: 5, pedido: '' },
    iaFiltro: 'pendente',
    iaPedindo: false,
    async carregarIA() {
      this.iaS = await api('/api/ia-sinais');
      this.iaCfg.modelo = this.iaS.modelo;
      this.iaCfg.qtd = this.iaS.qtd;
    },
    async salvarIA(extra = {}) {
      try {
        await api('/api/ia-sinais/config', { method: 'POST', body: { chave: this.iaCfg.chave, modelo: this.iaCfg.modelo, qtd: this.iaCfg.qtd, ...extra } });
        this.iaCfg.chave = '';
        this.toast('Configuração da IA salva');
        this.carregarIA();
      } catch (e) { this.toast(e.message); }
    },
    async pedirIA() {
      this.iaPedindo = true;
      try {
        const r = await api('/api/ia-sinais/sugerir', { method: 'POST', body: { pedido: this.iaCfg.pedido } });
        this.toast(`A IA sugeriu ${r.criadas} sinal(is). Revise e aprove.`);
        this.iaFiltro = 'pendente';
        await this.carregarIA();
      } catch (e) { this.toast(e.message); }
      this.iaPedindo = false;
    },
    iaLista() {
      if (!this.iaS) return [];
      const f = this.iaFiltro;
      return this.iaS.regras.filter((r) => f === 'pendente' ? r.modo === 'pendente'
        : f === 'ativos' ? (r.modo === 'telegram' || r.modo === 'observacao') : r.modo === 'desligado');
    },
    contaIA(f) { const v = this.iaFiltro; this.iaFiltro = f; const n = this.iaLista().length; this.iaFiltro = v; return n; },
    async modoIA(r, modo) {
      await api(`/api/regras/${r.id}`, { method: 'PUT', body: { modo } });
      this.toast({ telegram: 'Aprovado: os sinais vão para o Telegram', observacao: 'Em observação (registra sem enviar)', desligado: 'Pausado' }[modo]);
      this.carregarIA();
    },
    async tirosIA(r, tiros) {
      await api(`/api/regras/${r.id}`, { method: 'PUT', body: { tiros: +tiros } });
      this.toast('Tiros alterados e assertividade recalculada');
      this.carregarIA();
    },
    async excluirIA(r) { await this.excluir(r); this.carregarIA(); },
    assertividade(r) {
      const v = r.validacao;
      if (!v) return null;
      if (v.aoVivo && v.aoVivo.n >= 20) return { rotulo: 'ao vivo', ...v.aoVivo };
      return v.teste && v.teste.n ? { rotulo: 'no histórico', ...v.teste } : null;
    },
    async salvarTempo() {
      await api('/api/config', { method: 'POST', body: { tiros_padrao: this.status.tirosPadrao, antecedencia_seg: this.status.antecedencia } });
      this.toast('Salvo');
    },

    // ---- Config
    async salvarChat() { await api('/api/config', { method: 'POST', body: { telegram_chat_id: this.cfg.chat } }); this.toast('Chat salvo'); this.carregarStatus(); },
    async alternarAprovacao() {
      await api('/api/config', { method: 'POST', body: { exigir_aprovacao: !this.status.exigirAprovacao } });
      await this.carregarStatus();
    },
    async testarTelegram() { try { await api('/api/telegram/teste', { method: 'POST' }); this.toast('Mensagem enviada'); } catch (e) { this.toast(e.message); } },
    async relatorioAgora() { await api('/api/telegram/relatorio', { method: 'POST' }); this.toast('Relatório enviado'); },
    async salvarSessao() {
      try {
        await api('/api/config/sessao', { method: 'POST', body: { cookie: this.cfg.cookie, ch: this.cfg.ch } });
        this.cfg.cookie = ''; this.cfg.ch = '';
        this.toast('Sessão do TsonTips conectada');
        this.carregarStatus();
      } catch (e) { this.toast(e.message); }
    },
    async trocarSenha() {
      try {
        await api('/api/senha', { method: 'POST', body: { atual: this.cfg.senhaAtual, nova: this.cfg.senhaNova } });
        this.cfg.senhaAtual = ''; this.cfg.senhaNova = '';
        this.toast('Senha alterada');
      } catch (e) { this.toast(e.message); }
    },
  };
}
