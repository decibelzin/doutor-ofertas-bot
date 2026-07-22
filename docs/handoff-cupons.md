# Handoff — Automação de Cupons do ML (Afiliado)

> Doc pra retomar do zero (pós-`/clear`). Objetivo: postar cupons do Mercado
> Livre nos grupos automaticamente, idealmente casando **perfume + cupom do
> mesmo vendedor** ("desconto duplo"), com `@all` + banner — igual os canais
> concorrentes (ex.: ZP Links "CUPOM RELÂMPAGO").

## Contexto do projeto
- Bot de afiliados em TypeScript. Fonte de ofertas = **hub de afiliado do ML** (já implementado em `src/providers/mercadolivre/hub.ts`).
- **Auth do painel de afiliado**: cookie + `x-csrf-token` em `config.mercadoLivre.affiliateCookie` / `affiliateCsrf` (vêm do `.env`; **EXPIRAM** → recapturar do painel). É a MESMA auth do `createLink` (meli.la, em `shortlink.ts`) e do hub search.
- Headers que funcionam nas chamadas do painel: `User-Agent` (Firefox), `Content-Type: application/json`, `Origin: https://www.mercadolivre.com.br`, `Referer: https://www.mercadolivre.com.br/afiliados/...`, `x-csrf-token`, `Cookie`.

## ✅ O que JÁ está descoberto e FUNCIONA
### Endpoint de cupons (listar)
- **`GET /affiliate-program/api/affiliates/coupons`**
- Requer **prefixo de cupom** na conta, senão `409 AFFILIATE_WITHOUT_PREFIX`. O usuário JÁ configurou (prefixo: **DOUTOROFF**).
- Resposta: `{ prefix, coupons: [...], page, items_per_page: 14, total_items: 7090 }`.
- **Paginação: `?page=N`** (14/página, ~506 páginas). ⚠️ `offset` / `limit` / `itemId` são **IGNORADOS** (todos devolvem a mesma página 1 / os mesmos 7090).
- Cada cupom:
  ```json
  { "in_use": false, "id": 13969808, "title": "5% OFF", "category": "PRODUCT_DISCOUNT",
    "remaining_budget": 36624.28, "expiration_date": "2026-08-01T02:59:59",
    "container_name": "", "seller": "Lojaoficialcasasbahia" }
  ```
  **Só tem o VENDEDOR — NÃO tem produto nem categoria de produto.** (`category` aqui é o TIPO do cupom, não a categoria do item.)

### Condições do cupom
- **`GET /affiliate-program/api/affiliates/coupon-terms?coupon_id=X`** → 200, texto oficial das condições (validade, compra mínima, % de desconto, "produtos selecionados", etc.). Bom pra descrição da mensagem.

### Endpoints mapeados no bundle (parcialmente testados)
Do chunk `7395.19610d49.js` (bundle do painel afiliado, em `http2.mlstatic.com/frontend-assets/affiliates-site/`). Objeto de métodos do serviço de cupom (helpers `r`=GET, `l`=POST), base = **`/affiliate-program/api/affiliates`** (NÃO é `basePath: hub`):
- `getAvailableCoupons` → GET `/coupons` ✅
- `getCouponConditions` → GET `/coupon-terms` ✅
- `getGeneratedCodes` → GET `/coupons/aliases` → **403** no teste (método/param diferente? ou precisa ter código gerado)
- `getCouponSearchUrl` → GET `/coupon-search-url` → **400** "Invalid values in query object" só com `coupon_id` (provável que precise gerar o código antes, ou outros params)
- `createCode` → **POST `/create-code`** — **ESCRITA**, gera o código compartilhável com o prefixo. Body provavelmente `{ coupon_id }`. **NÃO testado** (é escrita na conta; pedir OK do usuário).
- `createPrefix` → POST `/create-prefix`; `modifyPrefix` → POST `/modify-prefix`
- `getCampaigns` → GET `/campaigns`; `manageCampaignParticipation` → PUT `/manage-campaign-participation`
- Query params na allow-list do bundle: `env, device, itemId, status, site_id, coupon_id, filter_tag, campaign_id, filter_time_range`.

### Já construído no código (commit `8f86b8e` + mudanças novas não commitadas)
- `src/whatsapp/sender.ts`: `sendMentioningAll` (@all via `mentions` = JIDs dos participantes, obtidos por `sock.groupMetadata`) + `broadcastCoupon`.
- `src/cli/post-coupon.ts` → `npm run post-coupon -- CODIGO "descrição"`: posta cupom **manual** com @all + banner. Config: `COUPON_BANNER_PATH`, `COUPON_SEARCH_LINK` (em `config.coupon`).
- ⚠️ **@all**: o "ghost mention" (só `mentions`, sem `@numero` no texto) **NÃO notificou** no teste do usuário. Pusemos "@all" literal no texto (cosmético). Pra notificar de verdade no WhatsApp atual talvez precise dos `@<numero>` no texto — o que **não cabe** em grupo grande (limite ~4096 chars) e é sinal de spam/ban. **@all não escala pra grupo grande.**

## ❌ O NÓ — por que o "perfume + cupom" automático NÃO fecha
Precisa ligar "perfume X" ao "cupom do vendedor do X". Os 3 elos possíveis, **todos quebrados** (testados):
1. **Cupom → produto/categoria:** cupom só tem `seller`, sem produto/categoria. Impossível saber quais dos 7090 são de perfume só pela lista.
2. **Item → cupom:** `GET /coupons?itemId=<MLBxxx>` é **ignorado** (devolve os 7090 iguais pra qualquer item).
3. **Perfume → vendedor:** o hub search (`POST /affiliate-program/api/hub/search`) **NÃO devolve o seller** no polycard. `metadata` tem `id` (MLBxxx), `user_product_id` (MLBUxxx), `url` (`/up/MLBU...`), mas **sem seller/nickname**. A API pública de item (`api.mercadolibre.com/items/MLBxxx`) = **403**. A página do produto = **anti-bot** (redireciona pra `/gz/account-verification`).

Sem um desses elos, o ML **não expõe** a informação que ligaria um perfume ao seu cupom.

## 🔍 O QUE PRECISA SER DESCOBERTO (tarefas pro Fable)
1. **Como obter o VENDEDOR (seller/nickname) de um produto do hub** sem as APIs bloqueadas. Testar:
   - Outros campos/endpoints do hub afiliado (ex.: detalhe de produto do afiliado).
   - O `user_product_id` (MLBU...) resolve pra vendedor via algum endpoint do painel?
2. **`/coupons` aceita FILTRO?** Testar `filter_tag`, `status`, `site_id`, `category`, uma busca textual (`?q=`/`?search=`). Se der pra filtrar por **categoria (perfume/beleza)** ou por **seller**, resolve o nó 1/2.
3. **Endpoint "Ver produtos" de um cupom:** no painel cada cupom tem "Ver produtos". Achar no bundle qual endpoint isso chama. Se der pra **listar os produtos de um cupom**, dá pra saber se é de perfume (cruzar com nosso banco `data/perfumes.json` / matcher em `src/format/perfumes.ts`).
4. **`createCode` (POST `/create-code`):** confirmar body/resposta. Provável `{coupon_id}` → retorna código + link. **É ESCRITA — pedir autorização do usuário** antes de testar.
5. **Sistema de CAMPANHAS** (`GET /campaigns`, `PUT /manage-campaign-participation`): o cupom "geral" do concorrente (TAMOJUNTO, 15% acima de R$79, "aplicável nas ofertas") NÃO é dos `/coupons` por vendedor — parece ser de **campanha**. Investigar se há cupom geral/store-wide via campanhas.

## Caminhos (decisão do usuário)
- **A) Semi-auto por lista de vendedores:** usuário dá nicknames de vendedores de perfume confiáveis → job offline **varre os cupons** (`?page=N`, devagar, cacheado) e guarda só os desses vendedores → bot posta. Depende de: lista feita à mão + varredura de ~506 páginas (pesado/ocasional; ~7000 cupons).
- **B) Manual (JÁ pronto):** garimpa no painel ("Ver produtos"), gera código, roda `post-coupon`. Funciona hoje.
- **C) Descobrir os elos 1–3 acima** → se algum funcionar, vira automático de verdade (o objetivo).

## ⚠️ Cuidados
- Cookie/csrf **expiram** → recapturar do painel e colar no `.env`.
- Chamadas autenticadas usam a **sessão do usuário** → cuidado com volume (rate-limit/flag na conta de afiliado). Varrer 506 páginas é agressivo → devagar/ocasional/cacheado.
- `@all`: moderação (spam/ban), não escala pra grupo grande.
- `create-code` é **escrita** na conta → confirmar com o usuário.
- O classificador de segurança do Claude Code pode bloquear as chamadas autenticadas ao ML; o usuário autoriza (já autorizou nesta investigação).

## Como reproduzir uma chamada (exemplo)
```ts
import axios from 'axios';
import { config } from './src/config';
const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
  'Content-Type': 'application/json',
  Origin: 'https://www.mercadolivre.com.br',
  Referer: 'https://www.mercadolivre.com.br/afiliados/coupons?is_affiliate=true',
  'x-csrf-token': config.mercadoLivre.affiliateCsrf,
  Cookie: config.mercadoLivre.affiliateCookie,
};
const r = await axios.get('https://www.mercadolivre.com.br/affiliate-program/api/affiliates/coupons?page=1', { headers: H });
```
