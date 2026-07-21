# doutor-ofertas-bot

Bot de ofertas de afiliado — **multi-loja e multi-canal**, em TypeScript.
Hoje: busca ofertas do **Mercado Livre** e posta automaticamente em **grupos de
WhatsApp**, a cada X minutos, dentro de uma janela de horário. Arquitetado pra
crescer (novas lojas em `providers/`, novos canais em `channels/`).

## Como funciona (fluxo)

```
Mercado Livre /ofertas ──scrape──▶ Deal[] ──rank+dedup──▶ próxima oferta
                                                              │ formata
                                                              ▼
                                          WhatsApp (vários grupos, com throttle)
```

- **Sourcing:** raspa `mercadolivre.com.br/ofertas` (a API de busca do ML foi restringida). Traz preço "de/por" + desconto.
- **Link de afiliado:** anexa `matt_word`/`matt_tool` na URL do produto (sua etiqueta do painel de afiliados).
- **Dedup:** não reposta a mesma oferta dentro de N dias (`./data/posted.json`).
- **Anti-ban:** intervalo com jitter, janela de horário, tetos por hora/dia, delay entre grupos.

## Requisitos
- Node.js **≥ 20**.
- Número de WhatsApp **dedicado** ao bot.
- Conta de afiliado do Mercado Livre + seus valores `matt_word`/`matt_tool`
  (gere um link em qualquer produto no painel de afiliados e leia os parâmetros da URL).

## Setup

```bash
npm install
cp .env.example .env     # Windows: copy .env.example .env
# preencha: ML_MATT_WORD, ML_MATT_TOOL, ML_ENABLED=true, e (depois do connect) WHATSAPP_GROUP_IDS
```

### 1) Conectar o WhatsApp (escanear QR — só 1ª vez)
```bash
npm run connect
```
### 2) Descobrir os grupos e configurar
```bash
npm run list-groups      # copie os IDs @g.us para WHATSAPP_GROUP_IDS no .env
```
### 3) Ver as ofertas (sem postar) / testar um post real
```bash
npm run fetch            # imprime as ofertas reais formatadas (não posta)
npm run post-now         # posta UMA oferta real agora no(s) grupo(s) — pra testar
```
### 4) Rodar o bot (autônomo)
```bash
npm start                # conecta e posta a cada ~8min (com jitter), das 8h às 22h
# (dev: npm run dev)
```

## Scripts
| Comando | O que faz |
|---|---|
| `npm run connect` | Conecta/salva a sessão do WhatsApp (QR). |
| `npm run list-groups` | Lista grupos + IDs. |
| `npm run fetch` | Mostra as ofertas reais formatadas (não posta). |
| `npm run post-now` | Posta 1 oferta real agora (ignora a janela) — teste. |
| `npm start` | Roda o bot autônomo (agendador). |
| `npm run typecheck` | Checagem de tipos. |
| `npm run ml-auth` | (Não usado no fluxo atual) autorização OAuth do ML. |

## Estrutura
```
src/
  config.ts            configuração (env tipada)
  logger.ts
  scheduler.ts         orquestrador: janela + intervalo/jitter + tetos + dedup + post
  util/time.ts
  core/
    deal.ts            formato normalizado "Deal" (o contrato)
    store.ts           dedup + histórico (JSON)
    selector.ts        coleta dos providers + rankeia
  providers/
    mercadolivre/
      ofertas.ts       scraping da página /ofertas (cheerio)
      affiliate.ts     link matt_word/matt_tool
      oauth.ts         (não usado hoje — API de busca morreu)
      index.ts         fetchDeals (scrape + filtro de desconto)
  format/whatsapp.ts   template da mensagem
  whatsapp/
    client.ts          conexão Baileys (QR, sessão, reconexão)
    sender.ts          listGroups + sendToGroup + broadcast
  cli/                 connect · list-groups · send-test · fetch · post-now · ml-auth
  index.ts             entry: conecta + inicia o agendador
```

## Config principal (.env)
`ML_ENABLED`, `ML_MATT_WORD`, `ML_MATT_TOOL`, `ML_MIN_DISCOUNT_PERCENT`,
`WHATSAPP_GROUP_IDS`, `START_HOUR`/`END_HOUR`, `POST_INTERVAL_MINUTES`,
`POST_JITTER_MINUTES`, `MAX_POSTS_PER_HOUR`, `DEDUP_COOLDOWN_DAYS`,
`GROUP_DELAY_MIN_MS`/`MAX_MS`.

## Notas / próximos passos
- **Deploy no VPS:** validar o scraping do IP de datacenter (o ML pode desafiar/bloquear; se ocorrer, usar proxy residencial). Depois: pm2/systemd pra manter 24h.
- **Aquecer o número** de WhatsApp antes de escalar o volume (risco de ban via Baileys).
- **Próximas lojas/canais:** Shopee (API oficial), Telegram, etc. — plugáveis.
