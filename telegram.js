// Bot do Telegram: envia sinais, resultados e relatórios.
const { getConfig, setConfig, log } = require('./db');

const token = () => process.env.TELEGRAM_BOT_TOKEN || '';
const chatId = () => getConfig('telegram_chat_id') || process.env.TELEGRAM_CHAT_ID || '';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Tenta de novo quando a internet falha ("fetch failed") ou o Telegram pede para esperar (429)
async function chamar(metodo, corpo, tentativas = metodo === 'getUpdates' ? 1 : 4) {
  if (!token()) throw new Error('TELEGRAM_BOT_TOKEN não configurado');
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token()}/${metodo}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(metodo === 'getUpdates' ? 45000 : 15000),
      });
      const j = await r.json();
      if (j.ok) return j.result;
      if (r.status === 429 && i < tentativas - 1) {
        await esperar(((j.parameters && j.parameters.retry_after) || 3) * 1000);
        continue;
      }
      throw Object.assign(new Error(`Telegram: ${j.description || r.status}`), { definitivo: true });
    } catch (e) {
      if (e.definitivo) throw e;
      ultimoErro = e;                          // erro de rede: tenta de novo
      if (i < tentativas - 1) await esperar([2000, 5000, 10000][i] || 10000);
    }
  }
  throw new Error(`Telegram: ${ultimoErro && ultimoErro.message}`);
}

let avisouFalta = 0;
async function enviar(texto, { para, responderA } = {}) {
  const destino = para || chatId();
  if (!token() || !destino) {
    if (Date.now() - avisouFalta > 3600e3) {
      avisouFalta = Date.now();
      log('erro', !token() ? 'Sinal não enviado: falta TELEGRAM_BOT_TOKEN nas variáveis do servidor' : 'Sinal não enviado: falta o Chat ID em Configurações');
    }
    return null;
  }
  try {
    const corpo = { chat_id: destino, text: texto, parse_mode: 'HTML', disable_web_page_preview: true };
    if (responderA) corpo.reply_parameters = { message_id: responderA, allow_sending_without_reply: true };
    const msg = await chamar('sendMessage', corpo);
    return msg.message_id;
  } catch (e) {
    log('erro', `Falha ao enviar no Telegram: ${e.message}`);
    return null;
  }
}

// Edita uma mensagem já enviada (usado para marcar GREEN/RED no próprio sinal)
async function editar(msgId, texto, para) {
  const destino = para || chatId();
  if (!token() || !destino || !msgId) return false;
  try {
    await chamar('editMessageText', { chat_id: destino, message_id: msgId, text: texto, parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (e) {
    if (!/not modified/i.test(e.message)) log('erro', `Falha ao editar no Telegram: ${e.message}`);
    return false;
  }
}

// Escuta comandos simples: /start, /id, /status, /hoje
let comandos = {};
function registrarComandos(mapa) { comandos = mapa; }

let ultimoConflito = 0;
async function escutar() {
  if (!token()) return;
  let offset = getConfig('telegram_offset', 0);
  for (;;) {
    try {
      const ups = await chamar('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const u of ups) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m || !m.text) continue;
        const cmd = m.text.trim().split(/[\s@]/)[0].toLowerCase();
        const chat = String(m.chat.id);
        if (cmd === '/start' || cmd === '/id') {
          await enviar(`👋 Olá! O ID deste chat é <code>${chat}</code>.\nCole esse número no painel, em Configurações, para receber os sinais aqui.`, { para: chat });
        } else if (comandos[cmd] && chat === String(chatId())) {
          await enviar(await comandos[cmd](), { para: chat });
        }
      }
      setConfig('telegram_offset', offset);
    } catch (e) {
      // "Conflict": outro programa está usando o mesmo bot (ou o deploy antigo ainda não desligou)
      const conflito = /conflict/i.test(e.message);
      if (!conflito || Date.now() - ultimoConflito > 3600e3) {
        log('erro', conflito
          ? 'Telegram: outro programa está usando este mesmo bot para ler mensagens. Os sinais continuam sendo enviados, mas os comandos /status e /hoje podem não responder. Se o aviso continuar, use um bot só para o Lab Sinais.'
          : `Telegram (escuta): ${e.message}`);
        if (conflito) ultimoConflito = Date.now();
      }
      await new Promise((r) => setTimeout(r, conflito ? 60000 : 15000));
    }
  }
}

module.exports = { enviar, editar, escutar, registrarComandos, chatId };
