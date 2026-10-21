// Cliente do TsonTips: usa a sessão da sua conta (cookie) e renova sozinho.
const { getConfig, setConfig, log } = require('./db');

const BASE = 'https://tsontips.com.br';
const SUPA = 'https://supabase.tsontips.com.br';
const NOME_COOKIE = 'sb-supabase-auth-token';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

class SessaoExpirada extends Error {}

let anonKey = process.env.TSON_ANON_KEY || null;

// Aceita: "base64-xxx", "sb-supabase-auth-token=base64-xxx" ou o header Cookie inteiro
function decodificarCookie(texto) {
  let v = String(texto || '').trim();
  const m = v.match(new RegExp(`${NOME_COOKIE}=([^;]+)`));
  if (m) v = m[1];
  v = decodeURIComponent(v);
  if (v.startsWith('base64-')) v = v.slice(7);
  const json = Buffer.from(v, 'base64url').toString('utf8');
  const sess = JSON.parse(json);
  if (!sess.access_token || !sess.refresh_token) throw new Error('Cookie não parece uma sessão válida do TsonTips');
  return sess;
}

function montarCookie(sess) {
  const valor = 'base64-' + Buffer.from(JSON.stringify(sess), 'utf8').toString('base64url');
  const MAX = 3180;
  let cookie;
  if (valor.length <= MAX) {
    cookie = `${NOME_COOKIE}=${valor}`;
  } else {
    const partes = [];
    for (let i = 0; i * MAX < valor.length; i++) partes.push(`${NOME_COOKIE}.${i}=${valor.slice(i * MAX, (i + 1) * MAX)}`);
    cookie = partes.join('; ');
  }
  const ch = getConfig('tson_ch') || process.env.TSON_CH_COOKIE;
  if (ch) cookie += `; _ch=${ch}`;
  return cookie;
}

function sessaoAtual() {
  let s = getConfig('tson_session');
  if (!s && process.env.TSON_COOKIE) {
    s = decodificarCookie(process.env.TSON_COOKIE);
    setConfig('tson_session', s);
  }
  return s;
}

function salvarSessaoDeCookie(texto, ch) {
  const s = decodificarCookie(texto);
  setConfig('tson_session', s);
  if (ch !== undefined) setConfig('tson_ch', ch ? String(ch).trim() : null);
  setConfig('tson_alerta_enviado', false);
  return s;
}

async function descobrirAnonKey() {
  if (anonKey) return anonKey;
  const salva = getConfig('tson_anon_key');
  if (salva) return (anonKey = salva);
  const html = await (await fetch(`${BASE}/login`, { headers: { 'User-Agent': UA } })).text();
  const urls = [...new Set(html.match(/\/_next\/static\/chunks\/[^"']+\.js/g) || [])];
  const preferidas = urls.filter((u) => u.includes('login')).concat(urls.filter((u) => !u.includes('login')));
  for (const u of preferidas) {
    const js = await (await fetch(BASE + u, { headers: { 'User-Agent': UA } })).text();
    for (const jwt of js.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || []) {
      try {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
        if (payload.role === 'anon') {
          setConfig('tson_anon_key', jwt);
          return (anonKey = jwt);
        }
      } catch { /* ignora */ }
    }
  }
  throw new Error('Não encontrei a anon key do TsonTips. Preencha TSON_ANON_KEY no .env');
}

let renovando = null;
async function renovar() {
  if (renovando) return renovando;
  renovando = (async () => {
    const s = sessaoAtual();
    if (!s) throw new SessaoExpirada('Nenhuma sessão do TsonTips configurada');
    const key = await descobrirAnonKey();
    const r = await fetch(`${SUPA}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new SessaoExpirada(`Não consegui renovar a sessão (${r.status}): ${txt.slice(0, 150)}`);
    }
    const j = await r.json();
    const nova = { ...s, ...j, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600) };
    setConfig('tson_session', nova);
    log('info', 'Sessão do TsonTips renovada');
    return nova;
  })();
  try { return await renovando; } finally { renovando = null; }
}

async function api(caminho, tentativa = 0) {
  let s = sessaoAtual();
  if (!s) throw new SessaoExpirada('Nenhuma sessão do TsonTips configurada. Cole o cookie em Configurações.');
  if (!s.expires_at || s.expires_at * 1000 - Date.now() < 5 * 60000) s = await renovar();

  const r = await fetch(BASE + caminho, {
    headers: {
      Cookie: montarCookie(s),
      Authorization: `Bearer ${s.access_token}`,
      'User-Agent': UA,
      Accept: 'application/json',
      Referer: `${BASE}/dashboard`,
      Origin: BASE,
    },
  });
  if (r.status === 401 || r.status === 403) {
    const corpo = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    log('erro', `TsonTips ${r.status} em ${caminho.split('?')[0]}: ${corpo}`);
    if (tentativa === 0) { await renovar(); return api(caminho, 1); }
    const bloqueio = /cloudflare|just a moment|challenge|captcha|attention required/i.test(corpo);
    throw new SessaoExpirada(
      `TsonTips recusou o acesso (${r.status})` +
      (bloqueio ? ' - bloqueio anti-robô (o site barra o IP do servidor)' : corpo ? ` - ${corpo}` : '')
    );
  }
  if (!r.ok) throw new Error(`TsonTips respondeu ${r.status} em ${caminho}`);
  return r.json();
}

function infoSessao() {
  const s = getConfig('tson_session') || null;
  if (!s) return { configurada: false };
  return {
    configurada: true,
    expiraEm: s.expires_at ? new Date(s.expires_at * 1000).toISOString() : null,
    usuario: s.user && s.user.email ? s.user.email.replace(/(.{2}).+(@.+)/, '$1***$2') : null,
  };
}

module.exports = { api, renovar, salvarSessaoDeCookie, infoSessao, SessaoExpirada };
