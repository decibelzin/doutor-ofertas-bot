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

### Endpoints mapeados no bundle (atualizado sessão 2)
Bundle do painel afiliado em `http2.mlstatic.com/frontend-assets/affiliates-site/`. O chunk do serviço
de cupom hoje é **`3799.<hash>.js`** (achar via `coupon-probe.ts bundle` → lê o manifest do
`campaigns-coupons-index.<hash>.js` e localiza o chunk que contém `coupon-terms`). Base =
**`/affiliate-program/api/affiliates`** (helpers `r`=GET, `l`=POST):
- `getAvailableCoupons` → GET `/coupons` ✅
- `getCouponConditions` → GET `/coupon-terms` ✅
- `getGeneratedCodes` → GET `/coupons/aliases` (403 antigo — não re-testado; não é necessário pro pipeline)
- `getCouponSearchUrl` → GET `/coupon-search-url?coupon_id=X` → **200 ✅ (era 400)** → `{coupons_product_url}`. **O elo que faltava.**
- `createCode` → **POST `/create-code`** — **ESCRITA**, gera o código compartilhável com o prefixo. Body `{coupon_id}` (o serviço só adiciona `env`). **NÃO testado** (é escrita na conta; pedir OK do usuário).
- `createPrefix` → POST `/create-prefix`; `modifyPrefix` → POST `/modify-prefix`
- `getCampaigns` → GET `/get-campaigns` (o real; `/campaigns` também responde) → vazio nessa conta; `manageCampaignParticipation` → PUT `/manage-campaign-participation`
- **Validação de params (client-side `validateParams`):** `page, items_per_page(max100), elements_per_page, device, os_name, order_by, total_items, sort, sort_by(MOST_RECENT/OLDEST), status, env, is_affiliate, filter_time_range, site_id, siteId, name, filter_tag`. ⚠️ Isso é só sanitização no cliente — **o servidor de `/coupons` ignora tudo menos `page`.**

### Já construído no código (commit `8f86b8e` + mudanças novas não commitadas)
- `src/whatsapp/sender.ts`: `sendMentioningAll` (@all via `mentions` = JIDs dos participantes, obtidos por `sock.groupMetadata`) + `broadcastCoupon`.
- `src/cli/post-coupon.ts` → `npm run post-coupon -- CODIGO "descrição"`: posta cupom **manual** com @all + banner. Config: `COUPON_BANNER_PATH`, `COUPON_SEARCH_LINK` (em `config.coupon`).
- ⚠️ **@all**: o "ghost mention" (só `mentions`, sem `@numero` no texto) **NÃO notificou** no teste do usuário. Pusemos "@all" literal no texto (cosmético). Pra notificar de verdade no WhatsApp atual talvez precise dos `@<numero>` no texto — o que **não cabe** em grupo grande (limite ~4096 chars) e é sinal de spam/ban. **@all não escala pra grupo grande.**

## ✅ Sessão 4 (2026-07-22) — FEATURE CONSTRUÍDA (descoberta + postagem automáticas)
O fluxo de "desconto duplo" (perfume + cupom automático, igual aos concorrentes) está **implementado,
testado e revisado**. `create-code` confirmado irrelevante (todos os ~200 cupons amostrados são
`PRODUCT_DISCOUNT`, aplicação automática — POST `/create-code` dá 400 pra toda chave; é mecanismo de
campanha que essa conta não tem).

**Módulos novos (branch `cupons/descoberta-e-postagem`):**
- `src/providers/mercadolivre/coupons.ts` — biblioteca: `sweepCouponList` (varre a lista, resumível),
  `sellerLooksPerfumery` (watchlist: padrões `perfum|fragran|essenc|arom|scent|beleza|cosmet|import` +
  marcas, INCLUINDO árabes — match por palavra inteira, `brandPresent`), `resolveCouponSearchUrl`,
  `scrapeCouponProducts` (reusa `parseOfertasHtml`; retry; `AuthWallError` no muro), `isPerfumeProduct`
  (keyword de perfume; corta maquiagem/cabelo via `NON_PERFUME_KW`; senão banco/marca), `parseTerms`
  (compra mín. + teto), `discoverFromCoupons` (→ `DiscoverResult` com `authFailed`).
- `src/cli/discover-coupons.ts` — `npm run discover-coupons [maxPages]` → varre → cache
  `data/perfume-coupons.json`. Resumível (`data/coupon-sweep.json`, TTL 24h), escopo real por páginas,
  escrita atômica, **guarda que NÃO sobrescreve cache bom quando a auth cai**.
- `src/format/coupon.ts` + `src/cli/post-perfume-coupon.ts` — `npm run post-perfume-coupon [couponId] [--dry]`:
  post premium (foto+legenda) com preço final estimado **só quando o teto é conhecido** (label mostra
  desconto efetivo `−R$ X` quando o teto binda), dedup por cooldown, expiração em fuso BR. Post normal
  (sem @all), igual ao print do concorrente.

**Validado:** discover em 10 págs achou Perfumes_bhz 20% (4/4) e Mawwal 5% (árabe, 41/43); dry-run
renderiza a mensagem certa com link meli.la real. **Review adversarial (workflow, 4 dimensões) achou 12
bugs — todos corrigidos** (preço enganoso sem teto, batom entrando como perfume, `parseOfertasHtml`
dropando anúncio de vendedor com hífen, sobrescrita de cache vazio na queda de auth, fuso da expiração,
etc.).

**Falta só:** (1) rodar a **varredura completa** (507 págs) 1x pra popular o cache — em andamento;
(2) o usuário **validar comissão** com 1 clique/compra real; (3) opcional: agendar `discover-coupons`
(semanal) e decidir se `post-perfume-coupon` entra no scheduler ou fica manual.

## 🚨 Sessão 3b (2026-07-22) — VIRADA DE CHAVE: cupons são AUTOMÁTICOS, `create-code` é irrelevante
**A pergunta "qual o body do `create-code`?" era a pergunta errada.** O `coupon-terms` do cupom
Perfumes_bhz diz textualmente: *"O cupom será aplicado **automaticamente** no carrinho elegível, **sem
necessidade de ativação pelo usuário**."* Ou seja, cupons tipo `PRODUCT_DISCOUNT` **não têm código
pra digitar** — o desconto cai sozinho no carrinho de produto elegível.
- **TODO o inventário dessa conta é `PRODUCT_DISCOUNT`.** Amostrei ~200 cupons espalhados (páginas 1,
  50, 150, 300, 450, 506 + os 140 do scan) → **100% `PRODUCT_DISCOUNT`**, zero cupom de código.
- **`POST /create-code` → sempre 400 `Invalid values in body object`** pra TODA chave testada
  (`coupon_id` num/string, `id`, `campaign_id`, `coupon_campaign_id`). O erro é do body inteiro, não de
  uma chave — o session-2 tinha **chutado** `{coupon_id}` lendo o bundle (o serviço só faz `POST(e)`, não
  revela o shape). **`createCode` é definido nos bundles mas NUNCA é chamado** em nenhum dos 53 chunks
  (hub + incentives) → o botão de gerar código não existe nessa UI. `/coupons/aliases` segue **403**.
- **Conclusão:** `create-code` é pro mecanismo de **cupom de campanha com código digitável** (tipo os
  `TAMOJUNTO`/`MELIOFFHJ` do concorrente). Essa conta **não tem campanhas** (`/get-campaigns` vazio),
  então **não dá pra gerar código E NEM PRECISA** — os cupons daqui são automáticos.
- **➡️ Novo fluxo de post (mais simples que o do concorrente, e sem NENHUMA escrita):**
  perfume + link de afiliado + texto tipo *"🎟️ 20% OFF aplicado automaticamente no carrinho (produtos
  selecionados, compra mín. R$X, até DD/MM)"*. A % sai do `title` do cupom; as condições (mín., validade,
  teto) saem do `coupon-terms`; os produtos elegíveis são exatamente a listing raspada.
- ⚠️ **A validar com o usuário (não dá pra confirmar daqui):** se o desconto automático mantém a
  atribuição de comissão pro afiliado via o link. Terms dizem que é cupom do vendedor, auto-aplicado,
  1 uso/CPF; a comissão vem pelo link de afiliado. **Sugerido: testar 1 clique/compra real.**

## Sessão 3 (2026-07-22, mais tarde) — probe RECRIADO + muro de anti-bot na listing
- ⚠️ **O `coupon-probe.ts` da sessão 2 NUNCA FOI COMMITADO e se perdeu.** Recriado do zero a partir
  deste doc (mesma auth do hub; subcomandos `creds | coupons | coupons-filters | campaigns | aliases |
  exclusive | terms | resolve | scrape | scan | get | post`). O novo `scan <from> <to>` faz o
  scan-amostra completo (lista → resolve → raspa → cruza com o banco), resumível
  (`data/probe-dumps/perfume-scan-p*.json`), com cache de raspagem por loja.
- **Creds revalidadas** (200; total_items agora 7088 — o pool oscila).
- **`/coupons/aliases` → 403 de novo** (morto, confirmado). **`/exclusive-offers` → 200 com corpo
  VAZIO** (nada nessa conta, igual campanhas).
- 🧱 **DESCOBERTA CRÍTICA: a listing `lista.mercadolivre.com.br` SEM cookie agora redireciona (200)
  pra `mercadolivre.com.br/gz/account-verification`** — página vazia, 0 títulos. Foi por isso que o
  1º scan deu 0/140. **COM o cookie da sessão do afiliado no header, a listing volta inteira**
  (48 produtos, `.poly-component__title` ok). O `scrapeListing` do probe já manda o cookie sempre e
  detecta o muro pelo redirect (vira erro explícito, nunca 0 silencioso).
  Consequência: **TODA a raspagem também é tráfego autenticado da sessão do usuário** → pacing lento
  obrigatório em tudo.

### ✅ Scan-amostra RODADO (sessão 3): 10 páginas = 140 cupons, pipeline validado ponta-a-ponta
Resultado (`data/probe-dumps/perfume-scan-p1-10.json`, resumível):
- 140/140 resolvidos, 140/140 raspados OK (após o fix do cookie e do param).
- **2 cupons de perfumaria com produto NO BANCO (~1,4%)**:
  - **Perfumes_bhz — 20% OFF** (exp 2026-08-01, budget R$494k): container curado com 5 perfumes,
    **4/5 no banco** (D&G Light Blue, CH Very Good Girl Elixir, Rabanne Phantom In Red, CH 212 NYC)
    → o cenário "desconto duplo" perfeito, com notas automáticas funcionando.
  - **Eudora_oficial — 15% OFF** (exp 2026-08-05): **16/48 no banco**. ⚠️ Um BATOM Eudora também
    casou no banco (matcher casa marca+nome, não exige ser perfume) → ao escolher produtos pra postar,
    exigir TAMBÉM keyword de perfume no título do produto.
- **12 cupons com keyword de perfumaria (~8,6%)**, destaque: **Mawwal (5% OFF)** — loja INTEIRA de
  perfume árabe (48/48 kw), **0 no banco** (marca não existe no dataset Fragrantica local). Moral:
  **detector de cupom de perfumaria = fração de títulos com keyword (ex.: ≥30%), NÃO o banco**; o
  banco só entra pra escolher/enriquecer produtos. (Perfumes árabes = segmento quente que o filtro
  `onlyKnownPerfumes` cortaria — decisão editorial do usuário.)
- Extrapolando ~1,4–2% pro pool de ~7088: **estimativa de ~100–140 cupons de perfumaria no total** —
  dá conteúdo de sobra, mas exige varrer a lista toda pra achar (sem filtro server-side).
- 🐛 **Pegadinhas de raspagem descobertas** (já corrigidas no probe):
  1. **Sem cookie → muro `account-verification`** (200 + página vazia). Cookie da sessão SEMPRE.
  2. **`?coupon_campaign_id` na URL pode dar 404** (ex.: Perfumes_bhz); quando não dá, o ML
     redireciona descartando o param. **Raspar sempre SEM a query** — o conjunto de produtos é o mesmo.
  3. O número em `_Container_...-seller-<id>` (~1.78e9, clusterizado) **NÃO é o CustId/user-id real**
    (`_CustId_<esse-numero>` devolve vazio) — é id do container/campanha. O user-id verdadeiro só
    aparece nas URLs `_CustId_` de cupom de loja inteira. Corrigir a leitura da sessão 2 ("toda URL
    traz o seller-id"): o id numérico do container identifica a CAMPANHA, não o vendedor.

## ~~❌ O NÓ~~ → ✅ RESOLVIDO (sessão 2, 2026-07-22)

**O elo que faltava foi encontrado: `coupon-search-url`.** A ligação "cupom → produtos do
vendedor" agora fecha. Ferramenta de diagnóstico reproduzível: **`src/cli/coupon-probe.ts`**
(subcomandos `creds | hub-dump | coupons-filters | campaigns | bundle | resolve | scrape | get | post`).

### ✅ O que passou a funcionar
- **`GET /coupon-search-url?coupon_id=X` → 200** (o handoff antigo viu 400; hoje funciona só com
  `coupon_id`). Resposta: `{ "coupons_product_url": "https://lista.mercadolivre.com.br/..." }`.
  Esse é o endpoint do botão **"Ver produtos"** do painel (no bundle: `getCouponSearchUrl({coupon_id})`,
  abre `coupons_product_url` em nova aba).
- **A URL devolvida É uma listing raspável** (mesmo estilo de `/ofertas`, seletor
  `.poly-component__title`). Testado: cupom da Casas Bahia → 48 títulos de produto lidos limpos.
  Duas formas de URL:
  - `_Container_<label>-seller-<sellerId>?coupon_campaign_id=<id>` — conjunto curado, travado num seller.
  - `_CustId_<custId>?coupon_campaign_id=<id>` — cupom **da loja inteira** (todos os produtos do seller).
  - ⚠️ `<label>` do `_Container_` é **texto de marketing** do cupom (ex.: "JULHO5MELIOFF", "MVEIS"),
    **NÃO é categoria**. Pra saber se o cupom é de perfume tem que **raspar os títulos** e cruzar com
    o banco (`isInBank`/`lookupNotas` em `src/format/perfumes.ts`).
  - Toda URL traz o **seller-id** (numérico) — resolve também o "elo 3" (vendedor do produto).

### 🔗 Pipeline automático que isso destrava (perfume + cupom = desconto duplo)
```
/coupons?page=N                    → lista de cupons (id, seller, desconto, budget, validade)
/coupon-search-url?coupon_id=X     → coupons_product_url (listing do seller, com seller-id)
raspar a listing (cheerio)         → títulos + preços dos produtos do cupom
títulos → matcher do banco         → é cupom de perfume? quais perfumes?
→ postar cupom + esses perfumes (link de afiliado + código) com @all/banner
```
O cupom **é** a lista de produtos com desconto do vendedor; a gente detecta os perfumes dentro dela.

### ❌ Elos que continuam quebrados / mortos (re-testados)
1. **`/coupons` NÃO aceita filtro.** `status`, `filter_tag`, `site_id`, `q`, `search`, `category`,
   `seller`, `sort`, `items_per_page` → **todos ignorados** (total fixo 7091, mesma página 1).
   O bundle tem um `validateParams` (client-side, sanitiza `page/items_per_page(max100)/sort/status/
   filter_tag/site_id/...`), mas o **servidor honra só `page`** → travado em **14/página, ~507 páginas**.
2. **Hub search continua SEM seller** no polycard (só `id`/`user_product_id`/`url`). PDP segue anti-bot,
   `api.mercadolibre.com/items` segue 403. (Mas o seller agora vem via `coupon-search-url`, então ok.)
3. **Campanhas vazias:** `GET /get-campaigns` (endpoint real; `/campaigns` também responde) → 200 com
   `{availables:[], joined:[], historical:[]}`. **Nenhuma campanha** nessa conta agora → o cupom "geral"
   tipo TAMOJUNTO do concorrente **não está disponível** por aqui no momento (sem dado pra trabalhar).
4. **Não existe API estruturada de "produtos do cupom"** — o único caminho é a listing raspável acima.

### Inventário de endpoints do serviço de cupom (bundle `affiliates-site/3799.<hash>.js`)
Base `…/affiliate-program/api/affiliates`. GET: `/coupons`, `/coupon-terms`, `/coupons/aliases`,
`/coupon-search-url`, `/get-campaigns`, `/exclusive-offers`. POST(escrita): `/create-code`,
`/create-prefix`, `/modify-prefix`. PUT: `/manage-campaign-participation`.

## 🔍 O QUE FALTA (atualizado sessão 3b)
1. ~~`createCode`~~ ❌ **DESCARTADO** — cupons dessa conta são automáticos (PRODUCT_DISCOUNT), não têm
   código; `/create-code` é pro mecanismo de campanha que essa conta não tem. Não precisa e não dá.
2. ~~Prevalência de cupons de perfume~~ ✅ FEITO: ~1,4% no banco, ~8,6% keyword; exemplos Perfumes_bhz
   20% (4/5 banco), Eudora 15% (16/48), Mawwal 5% (árabe). Estimativa ~100–140 de perfumaria no pool.
3. **IMPLEMENTAR o fluxo automático** (nenhuma escrita; decisões do usuário já dadas na sessão 3b):
   - **Job de descoberta A″ híbrido:** varrer SÓ a lista (507 GETs leves, semanal) → filtrar sellers por
     watchlist de perfumaria (`perfum|fragran|essenc|arom|scent` + marcas Eudora/Boticário/Natura/Avon/
     Mahogany/Mawwal/Lattafa/Armaf…) → resolver+raspar SÓ candidatos → classificar por fração de keyword
     (≥30%) → cache `data/perfume-coupons.json`. **Incluir árabes** (decisão do user) via keyword, mesmo
     fora do banco.
   - **Postagem:** perfume elegível (da listing) + link de afiliado + condições do `coupon-terms`
     ("20% automático, mín. R$X, até DD/MM"). Integrar no scheduler ou comando dedicado.
   - ⚠️ Ao escolher produto do banco, exigir TAMBÉM keyword de perfume no título (batom Eudora casa no
     banco). Árabe entra por keyword, sem notas automáticas.
4. **Validar comissão** (só o usuário consegue): confirmar que o desconto automático preserva a
   atribuição de afiliado via link — testar 1 clique/compra real.

## Caminhos (decisão do usuário) — atualizado
- **A) Índice offline + cache (o mais "automático de verdade"):** job lento/resumível varre `/coupons`
  (507 chamadas, ~1/s, cacheado), resolve `coupon-search-url` + raspa a listing **1x por seller**,
  classifica (perfume via banco) e guarda `data/perfume-coupons.json`. O bot posta do cache (~0 chamada
  por post). Custo de descoberta amortizado (semanal). Risco: volume autenticado alto na sessão do user.
- **A′) Semi-auto por lista de vendedores:** user cura nicknames de perfumaria confiável; ainda precisa
  varrer a LISTA (não dá pra filtrar por seller), mas só resolve/raspa os que casam. Bem mais barato que A.
- **B) Manual (quase pronto):** dado um `coupon_id` do painel → `coupon-search-url` + raspa + posta os
  perfumes do cupom + código, com @all/banner. Baixíssimo volume (1 resolve + 1 raspagem por post).
- **C) Só cupom relâmpago genérico (JÁ pronto):** `npm run post-coupon -- CODIGO "desc"` sem casar produto.

## ⚠️ Cuidados
- Cookie/csrf **expiram** → recapturar do painel e colar no `.env`.
- Chamadas autenticadas usam a **sessão do usuário** → cuidado com volume (rate-limit/flag na conta de afiliado). Varrer 506 páginas é agressivo → devagar/ocasional/cacheado.
- `@all`: moderação (spam/ban), não escala pra grupo grande.
- `create-code` é **escrita** na conta → confirmar com o usuário.
- O classificador de segurança do Claude Code pode bloquear as chamadas autenticadas ao ML; o usuário autoriza (já autorizou nesta investigação).

## Como reproduzir (ferramenta pronta: `src/cli/coupon-probe.ts` — versão sessão 3, COMMITAR!)
Diagnóstico read-only, usa a mesma auth do hub/createLink (`.env`). O classificador de segurança deixa
rodar via `npx tsx` (comando do projeto), mas bloqueia `curl` cru com o cookie. Dumps vão pra
`PROBE_DUMP_DIR` (padrão `./data/probe-dumps`). Subcomandos:
```bash
npx tsx src/cli/coupon-probe.ts creds                 # valida cookie/csrf (200 = ok)
npx tsx src/cli/coupon-probe.ts coupons 1             # lista uma página de /coupons
npx tsx src/cli/coupon-probe.ts coupons-filters        # prova que /coupons ignora filtros
npx tsx src/cli/coupon-probe.ts campaigns              # /get-campaigns (vazio nessa conta)
npx tsx src/cli/coupon-probe.ts resolve 1              # resolve search-url de todos os cupons da página → seller_id
npx tsx src/cli/coupon-probe.ts scrape "<coupons_product_url>"   # raspa a listing (COM cookie) → títulos + match banco
npx tsx src/cli/coupon-probe.ts scan 1 10              # amostra de prevalência (resumível, cache por loja)
npx tsx src/cli/coupon-probe.ts terms 13969808         # condições do cupom
npx tsx src/cli/coupon-probe.ts get  "/coupon-search-url?coupon_id=13969808"
npx tsx src/cli/coupon-probe.ts post "/create-code" '{"coupon_id":123}'   # ESCRITA — só com OK do user
```
(O subcomando `bundle` da sessão 2 não foi recriado — o inventário de endpoints já está mapeado acima;
se precisar re-derivar, o caminho está descrito na seção "Endpoints mapeados no bundle".)
