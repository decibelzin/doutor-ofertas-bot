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

## Nichos (grupos por segmento)

Em vez de mandar tudo pra todos os grupos, você define **nichos** — cada um com
seus grupos, suas fontes e sua cadência. Ex.: grupos só de perfume recebem só
oferta de perfume.

1. Copie o template e edite:
   ```bash
   cp config/niches.example.json config/niches.json   # Windows: copy ...
   ```
2. Preencha cada nicho com seus grupos (`@g.us`) e as categorias do ML.

Cada nicho puxa ofertas da(s) **categoria(s) do ML** que você listar
(`/ofertas?category=<ID>`), e da **Shopee** por palavra-chave (quando a API
liberar). Sem `config/niches.json`, o bot usa um nicho "geral" com
`WHATSAPP_GROUP_IDS`.

**Categorias do ML verificadas** (volume aproximado de ofertas):

| Nicho | Categoria ID | Ofertas |
|---|---|---|
| Perfumes | `MLB6284` | ~23 |
| Suplementos (creatina/whey) | `MLB264586` | ~39 |
| Esportes e Fitness | `MLB1276` | ~26 |
| Beleza (geral) | `MLB1246` | ~47 |
| Eletrônicos / TV | `MLB1000` | ~42 |
| Celulares | `MLB1051` | ~40 |
| Farmácia | `MLB431646` | ~1 (magro) |

> Nichos com pouco volume no ML (ex.: farmácia/saúde) vão render bem melhor
> quando a **Shopee** entrar (busca por palavra-chave).

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

## Site (landings por nicho)

Uma página estática **por nicho**, servida em `/<slug>`:

```
website/
  styles.css            compartilhado por todas as landings
  assets/               logo (webp + jpg de reserva), favicon
  index.html            raiz -> encaminha pro nicho padrão
  perfumes/
    index.html          GERADO — não edite à mão
    og.png              GERADO — card 1200x630 deste nicho
    groups.json         escrito pelo BOT (fora do git)
```

Por que uma página por nicho e não uma só com seletor: o crawler do WhatsApp
não executa JS, então o `og:image` é fixo no HTML. Página única significaria o
mesmo card genérico pra todo mundo — e é no card que o clique é ganho.

```bash
npm run build-site     # gera as páginas + os og.png a partir da config
npm run group-status   # força uma atualização dos groups.json (o bot já faz sozinho)
```

- **Conteúdo:** `config/landings.json` (versionado — é copy, não segredo).
  Veja `config/landings.example.json` pro formato com dois nichos.
- **Estrutura/HTML:** `src/site/landing.template.html`.
- **Grupos:** continuam em `config/niches.json` (fora do git). O campo `niche`
  da landing casa com o `name` do nicho.

Depois de publicar ou trocar o `og.png`, force o recache do card em
<https://developers.facebook.com/tools/debug/> — o WhatsApp usa o mesmo
scraper e guarda a resposta antiga por dias.

Contagem de cliques sem pixel de terceiro: o CTA dispara `sendBeacon` pra
`/e?c=cta&n=<slug>`. Basta o nginx responder 204 nessa rota que o access.log
vira o contador, já separado por nicho.

## Produção (VPS)

`root@168.231.89.180` — Ubuntu 25.04. **A máquina não é dedicada:** também roda
`dashrp.com.br`. Qualquer mexida em nginx pede `nginx -t` antes do reload.

| o quê | onde |
|---|---|
| Repo | `/srv/doutor-ofertas-bot` (não em `/root`: modo 700 impede o nginx de atravessar) |
| Site servido | `/srv/doutor-ofertas-bot/website` — o nginx aponta pra dentro do repo |
| Serviço | `systemd: doutor-ofertas` |
| Logs | `journalctl -u doutor-ofertas -f` |
| Cliques do CTA | `/var/log/nginx/doutoroferta-cliques.log` |

### Fluxo de trabalho

Tudo é editado **na máquina local**. A VPS só recebe `git pull`:

```bash
npm run build-site     # gera as páginas e os og.png (local!)
git add -A && git commit && git push
npm run deploy         # ssh na VPS: git pull + build/restart só se precisar
```

O `build-site` roda **local de propósito**: a arte do `og.png` pede as fontes
Impact/Arial, que não existem num Ubuntu limpo — gerar na VPS sairia diferente
do que foi validado. As páginas geradas são commitadas justamente pra isso.

O `deploy-vps.sh` só recompila e reinicia o bot quando `src/` mudou. Mudança só
de landing não derruba a conexão do WhatsApp (reconectar é o momento de risco).

### Fora do git (vai à mão, uma vez)

`.env`, `config/niches.json`, `config/presets.json` e `data/` (sessão do
Baileys + estado). O `.env` da VPS tem uma linha que o local não tem:
`SITE_DIR=/srv/doutor-ofertas-bot/website`.

⚠️ A sessão do Baileys **não roda em dois lugares**. Com o bot ativo na VPS, não
suba o bot local — e os CLIs que falam com o WhatsApp precisam rodar lá:
`ssh root@168.231.89.180 "cd /srv/doutor-ofertas-bot && npm run group-status"`.

## Config principal (.env)
`ML_ENABLED`, `ML_MATT_WORD`, `ML_MATT_TOOL`, `ML_MIN_DISCOUNT_PERCENT`,
`WHATSAPP_GROUP_IDS`, `START_HOUR`/`END_HOUR`, `POST_INTERVAL_MINUTES`,
`POST_JITTER_MINUTES`, `MAX_POSTS_PER_HOUR`, `DEDUP_COOLDOWN_DAYS`,
`GROUP_DELAY_MIN_MS`/`MAX_MS`.

## Notas / próximos passos
- **Deploy no VPS:** validar o scraping do IP de datacenter (o ML pode desafiar/bloquear; se ocorrer, usar proxy residencial). Depois: pm2/systemd pra manter 24h.
- **Aquecer o número** de WhatsApp antes de escalar o volume (risco de ban via Baileys).
- **Próximas lojas/canais:** Shopee (API oficial), Telegram, etc. — plugáveis.
