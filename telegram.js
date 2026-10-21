// Bot do Telegram: envia sinais, resultados e relatórios.
const { getConfig, setConfig, log } = require('./db');

const token = () => process.env.TELEGRAM_BOT_TOKEN || '';
const chatId = () => getConfig('telegram_chat_id') || process.env.TELEGRAM_CHAT_ID || '';

async function chamar(metodo, corpo) {
  if (!token()) throw new Error('TELEGRAM_BOT_TOKEN não configurado');
  const r = await fetch(`https://api.telegram.org/bot${token()}/${metodo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram: ${j.description || r.status}`);
  return j.result;
}

async function enviar(texto, { para, responderA } = {}) {
  const destino = para || chatId();
  if (!token() || !destino) return null;
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

// Escuta comandos simples: /start, /id, /status, /hoje
let comandos = {};
function registrarComandos(mapa) { comandos = mapa; }

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
      log('erro', `Telegram (escuta): ${e.message}`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

module.exports = { enviar, escutar, registrarComandos, chatId };
