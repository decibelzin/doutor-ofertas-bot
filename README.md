# doutor-ofertas-bot

Bot de ofertas de afiliado — **multi-loja e multi-canal**, escrito em
TypeScript. Construído por fases; começa pelo **canal WhatsApp**.

## Fase atual: **WhatsApp** (conectar + postar)

O que já funciona:
- **Conexão** com o WhatsApp via Baileys (QR na 1ª vez, sessão salva, reconexão automática).
- **Listagem de grupos** (`list-groups`) para descobrir os IDs.
- **Envio** para um ou vários grupos, com **throttle anti-ban** (delay aleatório entre grupos).

Ainda **não** faz: buscar ofertas (Shopee/ML) nem agendar postagens — próximas fases.

## Requisitos
- Node.js **≥ 20** (recomendado 20 LTS ou 22 LTS).
- Um número de WhatsApp **dedicado** ao bot (não use o seu pessoal).

## Setup

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

### 1) Conectar (escanear o QR — só na 1ª vez)
```bash
npm run connect
```
Abra o WhatsApp do número do bot → **Aparelhos conectados** → escaneie o QR.
A sessão fica salva em `SESSION_DIR` (padrão `./data/auth`).

### 2) Descobrir os IDs dos grupos
```bash
npm run list-groups
```
Copie o(s) ID(s) `...@g.us` para `WHATSAPP_GROUP_IDS` no `.env`.

### 3) Enviar uma mensagem de teste
```bash
npm run send-test                     # usa WHATSAPP_GROUP_IDS do .env
npm run send-test -- 12036...@g.us    # ou um grupo específico
```

## Scripts
| Comando | O que faz |
|---|---|
| `npm run connect` | Conecta e salva a sessão (escaneia o QR). |
| `npm run list-groups` | Lista grupos + IDs. |
| `npm run send-test` | Envia mensagem de teste (prova o envio). |
| `npm run dev` | Roda `src/index.ts` em watch (tsx). |
| `npm run typecheck` | Checagem de tipos (sem gerar arquivos). |
| `npm run build` | Compila para `dist/`. |
| `npm start` | Roda `dist/index.js` (após `build`). |

## Estrutura
```
src/
  config.ts            configuração (env tipada)
  logger.ts            pino
  util/time.ts         sleep + delay aleatório
  whatsapp/
    client.ts          conexão Baileys (QR, sessão, reconexão)
    sender.ts          listGroups + sendToGroup + broadcast (anti-ban)
  cli/
    connect.ts         escanear QR / manter sessão
    list-groups.ts     listar grupos e IDs
    send-test.ts       enviar mensagem de teste
  index.ts             entry (conecta e mantém vivo)
```

## Próximas fases
- **Ofertas:** provider Shopee (API oficial) → mensagem formatada.
- **Agendador:** postar a cada X min (com jitter) dentro de uma janela de horário.
- **Persistência:** dedup + histórico (SQLite).
- **Expansão:** Mercado Livre, Amazon, Magalu; e canais Telegram, Instagram, etc.
