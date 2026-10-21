# Laboratório de Sinais · Kiron

Painel com login que coleta os jogos da Kiron (via sua conta do TsonTips), testa regras de sinal em todas as ligas e mercados, e envia os sinais aprovados no Telegram, com conferência automática de GREEN/RED e relatório diário.

## Estrutura

Todos os arquivos ficam na **mesma pasta**:

```
tson-sinais/
├── Dockerfile, package.json, .env.example, LEIA-ME.md
├── server.js      → painel web + API (login, regras, sinais, config)
├── robo.js        → coleta a cada minuto, gera sinais, confere resultados
├── tsontips.js    → conexão com o TsonTips e renovação da sessão
├── regras.js      → motor de regras (condições)
├── validador.js   → teste treino/teste, ROI, confiança
├── ia.js          → modelo de IA (regressão logística) do laboratório
├── telegram.js    → envio e comandos do bot
├── mercados.js    → ligas e mercados
├── jogos.js       → cache dos jogos em memória
├── db.js          → banco SQLite
├── descobrir.js   → descoberta automática de padrões
├── index.html, login.html, conectar.html, app.js, estilo.css → telas do painel
```

O banco fica em `/app/data` (volume da EasyPanel).

## 1. Criar o bot do Telegram

1. No Telegram, abra o **@BotFather** e mande `/newbot`.
2. Escolha um nome e um usuário (precisa terminar em `bot`).
3. Copie o **token** que ele mandar. Ele vai no `.env` (`TELEGRAM_BOT_TOKEN`), nunca em chat.

## 2. Subir na EasyPanel

1. Crie um app do tipo **App** apontando para o repositório (ou suba os arquivos) e use o **Dockerfile**.
2. Em **Environment**, preencha as variáveis do `.env.example`:
   - `ADMIN_USER` e `ADMIN_PASS` (login do painel)
   - `SESSION_SECRET` (um texto longo qualquer)
   - `TELEGRAM_BOT_TOKEN`
3. Em **Mounts/Volumes**, crie um volume em `/app/data` (é onde fica o banco; sem isso, perde tudo a cada deploy).
4. Em **Domains**, aponte a porta **3000**.
5. Faça o deploy e abra o domínio. Entre com o usuário e senha do `.env`.

## 3. Conectar o TsonTips

O login do TsonTips tem verificação anti-robô, então o sistema não entra sozinho com e-mail e senha. A conexão é feita com 1 toque:

1. No painel, vá em **Configurações → Conexão com o TsonTips**.
2. **Computador:** arraste o botão **Conectar ao Lab Sinais** para a barra de favoritos.
   **Celular:** toque em **Copiar código do favorito**, salve um favorito no Chrome com o nome `labsinais` e cole o código no endereço.
3. Faça login no TsonTips normalmente.
4. Toque no favorito. Abre uma janela do painel confirmando **Conectado!**

O TsonTips vai pedir login de novo naquele navegador: é normal, a sessão foi passada para o robô. Depois disso, a conexão se renova sozinha. Se cair, o bot avisa no Telegram e é só repetir os passos 3 e 4.

Na primeira coleta o robô puxa os últimos 5 dias (120h).

## 3.1 Descobrir padrões

Na aba **Descobrir padrões**, toque em **Analisar agora** (ou espere: roda sozinho a cada 6 horas). O sistema testa milhares de ideias em todos os mercados e ligas e mostra:
- **Lucraram no treino e no teste**: as que se sustentaram nas duas metades do histórico.
- **Melhores do treino**: o que o passado sugere, para comparar com o que aconteceu depois.

Toque em **Observar** para virar uma regra que registra sinais sem enviar, ou **Telegram** para receber os sinais.

## 4. Conectar o Telegram

1. Mande `/start` para o seu bot. Ele responde com o **ID do chat**.
2. Cole o ID em **Configurações → Telegram** e clique em **Salvar**, depois em **Enviar teste**.
3. Para usar num grupo: adicione o bot ao grupo e mande `/id` lá.

Comandos do bot: `/status` (situação do robô) e `/hoje` (relatório do dia).

## 5. Usar as regras

- **Observação**: a regra gera sinais e confere os resultados, mas não envia nada. Use para testar ideias sem risco.
- **Telegram**: envia os sinais. Com a opção "só regras aprovadas" ligada (padrão), só envia se a regra passar no teste.
- **Desligado**: não faz nada.

### Como a regra é julgada

| Status | O que significa |
|---|---|
| Aprovada | Lucrou no treino e no teste, com 100+ entradas no teste e confiança (z) ≥ 2 |
| Promissora | Lucrou nas duas metades, mas falta amostra ou confiança |
| Ilusão | Lucrou no treino e perdeu no teste (o caso mais comum) |
| Reprovada | Não supera a margem da casa |
| Amostra pequena | Menos de 30 entradas no teste |

A coluna **Ao vivo** mostra o resultado real dos sinais gerados depois que a regra foi criada. É o teste mais honesto de todos.

## Avisos importantes

- O futebol virtual é sorteado por algoritmo, e as odds já trazem margem da casa (cerca de 7% na Kiron). É esperado que quase todas as regras sejam reprovadas. O painel existe para mostrar isso com números, não para garantir lucro.
- A coleta usa a sua conta do TsonTips. As respostas deles carregam uma marca ligada à conta, e uso automatizado pode ir contra os termos do site.
- Aposte só o que pode perder. Se sentir que está perdendo o controle, procure ajuda (por exemplo, Jogadores Anônimos).
