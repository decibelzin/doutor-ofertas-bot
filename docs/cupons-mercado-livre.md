# Como captar cupons do Mercado Livre

Doc pra quem vai reimplementar isso fora deste repositório (n8n, Python, o que for).
Descreve o **contrato externo**: URLs, headers, formato das respostas e as armadilhas.

O ML não tem API pública documentada pra nada disso. Tudo aqui foi obtido por engenharia
reversa do painel de afiliado e da página de cupons, e **pode quebrar quando eles mudarem o
front**. Onde uma decisão tem motivo não óbvio, o motivo está escrito.

---

## Existem TRÊS fontes de cupom, e elas não se parecem

| | **A.** Cupons públicos do ML | **B.** Cupons de vendedor | **C.** Agregadores de terceiros |
|---|---|---|---|
| Quem emite | o Mercado Livre | o lojista | o ML (campanha de site inteiro) |
| Onde se capta | API JSON do `/cupons` | painel de afiliado | Pelando e similares |
| **Precisa de login** | **sim** (cookie) | **sim** (cookie + csrf) | **não** ⭐ |
| Como usa | comprador ativa | automático no checkout | comprador **digita** no carrinho |
| Dificuldade | baixa - 1 chamada JSON | alta - 3 chamadas + raspagem | baixa - raspar 4 páginas |
| Código digitável | sim (com um truque) | não, e não precisa | **sim** |
| Escopo | categorias/lojas | produtos de 1 vendedor | **site inteiro** |

**Se for começar por um só, comece pelo C.** Não precisa de conta, não precisa de cookie, não
quebra quando a sessão expira - e é de onde saem os códigos de site inteiro (`ALLSITE25`,
`TODOSITE25`, `MELIOFFHJ`) que os canais concorrentes postam como "cupom relâmpago". Esses
códigos **não existem em nenhum endpoint da conta de afiliado**; descobrimos isso do jeito
difícil, procurando por eles na API e não achando nada.

O caminho A é o próximo em custo-benefício. O B só vale pra "desconto duplo" (produto já em
promoção + cupom da mesma loja) e custa muito mais que os outros dois somados.

---

## Autenticação: um cookie, e ele expira

> Vale só para os caminhos **A** e **B**. O caminho **C** (agregadores) é página pública - pule
> esta seção se for começar por ele.

As duas rotas do ML exigem **cookie de sessão logada**. Não existe API key.

Como pegar:

1. Logue em `mercadolivre.com.br`
2. DevTools → aba **Network**
3. Carregue `mercadolivre.com.br/cupons`
4. Ache qualquer requisição pro domínio, botão direito → **Copy → Copy as cURL**
5. Extraia o header `Cookie:` inteiro

> ⚠️ **Esse cookie expira** (dias a semanas). Quando expirar, a resposta **não dá erro** - ela
> volta `200` com lista **vazia**. Se o fluxo começar a não achar cupom nenhum, suspeite do
> cookie antes de qualquer outra coisa. Vale um alerta automático pra isso.

Para o caminho de vendedor você precisa **também** do header `x-csrf-token`, que aparece nas
requisições do painel de afiliado (`/afiliados/...`) na mesma aba Network.

---

## Caminho A - Cupons públicos do ML

### A.1. Catálogo completo, paginado

```
GET https://www.mercadolivre.com.br/cupons/api/main-data/filtered?page=1&origin=main
```

Headers obrigatórios:

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...
Accept: application/json
Accept-Language: pt-BR,pt;q=0.9
Cookie: <o cookie inteiro>
```

Paginação: `?page=N`, **30 por página**, hoje ~75 páginas. Pare quando `coupons` vier vazio.
Um teto de segurança (ex.: 90) evita laço infinito se eles mudarem o comportamento.

Resposta - os campos que importam:

```jsonc
{
  "coupons": [
    {
      "campaignId": "123456",            // identificador do cupom
      "title": "15% OFF em Perfumes",
      "code": "PERFUME15",               // ⚠️ ver A.2 - aqui costuma vir token opaco
      "amount": {
        "minAmount": "R$ 100",           // compra mínima
        "capAmount": "R$ 50"             // teto de desconto
      },
      "expirationDate": "2026-08-01T02:59:59",
      "activationType": "AUTOMATIC",
      "items": [
        {
          "altText": "Perfume Lattafa Asad Eau de Parfum 100ml",
          "domainId": "MLB-PERFUMES",    // ⭐ o classificador mais confiável
          "imageUrl": "https://..."
        }
      ]
    }
  ]
}
```

Os nomes vêm em **camelCase ou snake_case dependendo da rota** (`campaignId` vs `campaign_id`,
`minAmount` vs `min_amount`). Aceite os dois - no nosso código isso virou um helper:

```ts
/** Aceita camelCase ou snake_case: a mesma API responde dos dois jeitos. */
function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

const campaignId = String(pick(c, 'campaignId', 'campaign_id') ?? '');
const expira     = pick(c, 'expirationDate', 'expiration_date');
```

### A.2. O truque do código legível

Este é o detalhe que economiza horas:

```
GET https://www.mercadolivre.com.br/cupons/api/main-data/filtered?page=1&special_coupon=true&origin=main
```

**`special_coupon=true` é o único filtro que devolve o código digitável** (ex.: `AFILIADOPET26`)
no campo `code`. Todos os outros filtros - e o HTML da página - trazem um **token opaco de 88
caracteres**, que não serve pra postar em grupo.

Regra prática que usamos: se `code.length > 25`, não é código legível - trate como cupom de
ativação por link, não por código.

O link de ativação se monta assim:

```
https://www.mercadolivre.com.br/cupons?code=<code>
```

---

## Filtrar só o que interessa (perfumaria, no nosso caso)

Dois sinais, em ordem de confiança:

**1. `domainId`** - é taxonomia do próprio ML, então crava:

```ts
const PERFUME_DOMAIN = /^MLB-PERFUMES$|FRAGRANC|COLOGNE/i;
```

**2. Palavra-chave no título**, quando não há domínio:

```ts
const PERFUME_KEYWORD =
  /(\bperfum|\bparfum|\beau de\b|\bedt\b|\bedp\b|\bcol[oô]nia|\bfragr[aâ]ncia|\bbody spray\b|\bdeo[\s-]?col)/i;
```

**3. E uma lista de exclusão, que é o que evita vergonha.** Sem isso entra batom, shampoo, bolsa
e relógio - lojas de "beleza" vendem de tudo:

```ts
const NAO_E_PERFUME =
  /\b(batom|gloss|corretivo|r[ií]mel|delineador|sombra|blush|esmalte|shampoo|condicionador|
     sabonete|hidratante|creme|s[eé]rum|pincel|maquiagem|difusor|aromatizador|vela perfumada|
     amaciante|detergente|bolsa|mochila|carteira|mala|rel[oó]gio|[oó]culos|camiseta|cal[cç]a|
     t[eê]nis|sapato|chinelo|bon[eé]|cinto|meia|toalha)\b/i;
```

Ordem importa: **exclusão primeiro**, senão "creme perfumado" passa como perfume.

```ts
function ehPerfume(titulo: string): boolean {
  if (NAO_E_PERFUME.test(titulo)) return false;
  return PERFUME_KEYWORD.test(titulo);
}
```

> Aprendizado de um scan real: um **batom da Eudora** casou no nosso banco de perfumes porque o
> matcher casava marca + nome. Exija **também** a keyword de perfume no título do produto.

---

## Caminho B - Cupons de vendedor (só se precisar de "desconto duplo")

Base: `https://www.mercadolivre.com.br/affiliate-program/api/affiliates`

Headers: os de cima **mais** `x-csrf-token`, `Content-Type: application/json`,
`Origin: https://www.mercadolivre.com.br`, `Referer: https://www.mercadolivre.com.br/afiliados/cupons`.

São três chamadas encadeadas:

**1. Listar cupons**

```
GET /coupons?page=1
```

Devolve `{ prefix, coupons: [...], page, items_per_page: 14, total_items: ~7000 }`.

Cada cupom traz **só o vendedor** - não traz produto nem categoria:

```jsonc
{ "id": 13969808, "title": "5% OFF", "category": "PRODUCT_DISCOUNT",
  "remaining_budget": 36624.28, "expiration_date": "2026-08-01T02:59:59",
  "seller": "Lojaoficialcasasbahia" }
```

> ⚠️ `category` aqui é o **tipo do cupom**, não a categoria do produto.
> ⚠️ **Só `page` funciona.** `offset`, `limit`, `items_per_page` são aceitos pelo validador do
> front e **ignorados pelo servidor** - mandar `items_per_page=100` devolve as mesmas 14.
> ⚠️ Sem prefixo de cupom configurado na conta, dá `409 AFFILIATE_WITHOUT_PREFIX`.

**2. Descobrir os produtos do cupom**

```
GET /coupon-search-url?coupon_id=<id>
→ { "coupons_product_url": "https://lista.mercadolivre.com.br/..." }
```

**3. Raspar essa listing** (HTML, seletor `.poly-component__title`) e classificar pelos títulos.

**Não existe filtro por categoria em lugar nenhum** - pra achar cupom de perfume você varre as
~500 páginas e classifica raspando. Numa amostra de 140 cupons, **~1,4%** eram de perfumaria com
produto reconhecido, e **~8,6%** tinham alguma keyword. Dá conteúdo, mas o custo de varredura é alto.

Condições do cupom (validade, compra mínima, texto oficial):

```
GET /coupon-terms?coupon_id=<id>
```

### Armadilhas do caminho B, todas custaram tempo

| Problema | Sintoma | Solução |
|---|---|---|
| Listing sem cookie | `200` com página **vazia** - redireciona pra `/gz/account-verification` | mandar o cookie **também** na raspagem, e tratar o redirect como erro explícito |
| `?coupon_campaign_id` na URL | `404` em algumas lojas | raspar **sem** a query; o conjunto de produtos é o mesmo |
| `_Container_<label>` | parece categoria | é **texto de marketing** ("JULHO5MELIOFF"). Não classifique por ele |
| Número em `-seller-<id>` | parece id do vendedor | é id da **campanha**. O id real do vendedor só aparece nas URLs `_CustId_` |
| `/coupons/aliases` | `403` | morto, não insista |
| `/create-code` | `400` em toda chave | irrelevante: os cupons são `PRODUCT_DISCOUNT`, aplicados **automaticamente** |

---

## Caminho C - Agregadores de terceiros (o mais fácil, sem login)

Os códigos de **site inteiro** do ML não aparecem em endpoint nenhum da conta de afiliado. Eles
são campanhas que o ML distribui via sites de cupom. É de lá que dá pra captá-los - e como são
páginas públicas, **não precisa de cookie, conta nem csrf**.

### As quatro fontes

| Site | URL | Como o código está no HTML |
|---|---|---|
| Pelando | `pelando.com.br/cupons-de-descontos/mercado-livre` | atributo `data-copy-code` |
| Descontos Top | `descontostop.com/loja/cupom-desconto-mercado-livre/` | atributo `data-code` |
| Thiago Rodrigo | `thiagorodrigo.com.br/cupom-desconto-mercado-livre/` | atributo `data-full-code` |
| Melhores Cartões | `melhorescartoes.com.br` | **tabela** `REGRA \| CUPOM \| LINK` |

Três deles guardam o código num **atributo de dados** - basta um seletor CSS, não precisa parsear
texto:

```js
// Pelando: cada botão "copiar" carrega o código no próprio atributo
$('[data-copy-code]').each((_, el) => codigos.push($(el).attr('data-copy-code')));
```

O quarto é diferente e vale saber: **o Melhores Cartões publica numa página datada, que muda
todo dia**. A URL fixa é só a home; o fluxo tem que achar o link mais recente que casa um padrão
e seguir:

```js
discoverLink: /cupons?-mercado-livre[a-z0-9-]*\.html$/i
```

Em n8n isso é um HTTP Request na home → extrair `href` que casa o regex → segundo HTTP Request
na página encontrada → parsear a tabela.

### Filtrar lixo: nem todo `data-code` é cupom do ML

```js
function codigoPlausivel(code, nomeDoSite) {
  if (!/^[A-Z0-9]{4,24}$/.test(code)) return false;      // hash/token não passa
  if (code.includes(nomeDoSite.toUpperCase())) return false; // "PELANDO250" é cupom DELES
  return /[A-Z]/.test(code);                              // só número não é campanha
}
```

A segunda linha é a que importa: os agregadores publicam **cupons próprios** na mesma listagem.
Sem esse filtro você posta o cupom do Pelando achando que é do Mercado Livre.

### A ideia que faz esse caminho funcionar: confirmação cruzada

Fonte de terceiro erra - publica código vencido, inventa, deixa expirado no ar. A defesa é não
confiar em nenhuma isoladamente:

```js
// Mesmo código visto em N sites → sources = [site1, site2, ...]
// 2+ fontes independentes = confiança alta
const confiaveis = cupons.filter((c) => c.sources.length >= 2);

// Ordena por confirmação primeiro, valor depois
cupons.sort((a, b) =>
  b.sources.length - a.sources.length ||
  (b.amountOff ?? (b.percentOff ?? 0) * 2) - (a.amountOff ?? (a.percentOff ?? 0) * 2)
);
```

Junte os quatro sites, agrupe por código, e conte em quantos ele apareceu. **Poste só o que tem
2 ou mais.** Um código que só um site tem é provavelmente velho ou errado.

O `(percentOff ?? 0) * 2` é só uma heurística pra comparar "20% OFF" com "R$ 20 OFF" na mesma
escala - ajuste ao seu gosto.

### O que extrair da descrição

Os agregadores escrevem coisas como `"R$20 off em Compras Acima de 199"`. Vale parsear pra ter os
campos separados, porque a mensagem final fica muito melhor com eles: **percentual**, **valor
fixo**, **compra mínima** e **teto de desconto**.

> ⚠️ **A validade que aparece é do agregador, não do ML.** Ele pode estar desatualizado. Sempre
> poste as condições junto e não prometa prazo como se fosse oficial.

---

## Link de afiliado (sem isso não há comissão)

O ML **não tem API de geração de link**. O método é anexar sua etiqueta na URL do produto:

```ts
const url = new URL(permalink);
url.searchParams.set('matt_word', MATT_WORD);
url.searchParams.set('matt_tool', MATT_TOOL);
```

`matt_word` e `matt_tool` você pega **uma vez**: gere qualquer link na Central de Afiliados e leia
os dois parâmetros da URL resultante. Não são segredo.

Existe um encurtador oficial (`meli.la`) via endpoint interno `createLink`, com a mesma auth de
cookie + csrf. É opcional - o link longo com os parâmetros funciona e não depende de sessão.

> Sem a etiqueta, o link **funciona e não gera comissão**. Vale checar a atribuição no painel
> depois do primeiro clique real, porque falha silenciosa aqui custa dinheiro.

---

## Fluxo sugerido em n8n

### Comece por este - caminho C, sem login

```
[Schedule Trigger]  a cada 1-2h
        ↓
[HTTP Request] ×4   as quatro páginas de agregador (User-Agent de browser)
                    ⤷ melhorescartoes: 1º a home, extrai o link datado, 2º a página
        ↓
[HTML Extract]      pega os atributos: data-copy-code | data-code | data-full-code
                    (melhorescartoes: parseia a tabela REGRA | CUPOM)
        ↓
[Code]  codigoPlausivel()  - descarta hash e o cupom do próprio agregador
        ↓
[Code]  agrupa por código e conta em quantos sites apareceu → sources[]
        ↓
[Filter]  sources.length >= 2        ⭐ confirmação cruzada
        ↓
[Code]  dedup contra o que já foi postado (guarde o código + data)
        ↓
[Code]  monta a mensagem (código, desconto, mínimo, condições)
        ↓
[Discord / WhatsApp]
```

### Depois, se quiser cupom por categoria - caminho A

```
[Schedule Trigger]
        ↓
[HTTP Request]  GET .../filtered?page=1&special_coupon=true&origin=main
                headers: User-Agent, Accept, Accept-Language, Cookie
        ↓
[IF]  coupons.length == 0  →  [alerta: cookie provavelmente expirou]
        ↓
[Item Lists]  split em "coupons"
        ↓
[Code]  filtro de perfumaria (domainId + keyword − exclusão)
        ↓
[Code]  dedup por campaignId
        ↓
[Discord / WhatsApp]
```

**Guarde estado.** Sem dedup, o fluxo repõe os mesmos cupons a cada execução. Um arquivo, uma
tabela ou um nó de storage do n8n resolve - guarde o identificador (`code` ou `campaignId`) + data.

**Vá devagar nos caminhos A e B.** Toda chamada é tráfego autenticado da *sua* sessão; varredura
agressiva derruba o cookie e pode marcar a conta. No caminho C o risco é outro: os agregadores
podem bloquear por volume - mande `User-Agent` de browser e não bata de minuto em minuto.

---

## Resumo do que vale saber antes de começar

1. **Comece pelos agregadores (caminho C).** Sem login, sem cookie pra expirar, e é de onde saem
   os códigos de site inteiro que os concorrentes postam.
2. **Confirmação cruzada é o que torna terceiro confiável** - poste só código visto em 2+ sites.
3. **Filtre o cupom do próprio agregador** (`PELANDO250` e afins), senão você divulga o
   concorrente achando que é do ML.
4. **`special_coupon=true`** é o único jeito de obter código digitável na API do ML.
5. **Cookie expirado falha em silêncio** - `200` com lista vazia. Monitore isso.
6. **`domainId: MLB-PERFUMES`** é o melhor classificador; keyword é o plano B.
7. **Lista de exclusão não é opcional** - sem ela você posta batom como perfume.
8. **Só `page` funciona** na paginação do painel; o resto é ignorado pelo servidor.
9. **A raspagem do caminho B também precisa do cookie**, senão devolve página vazia com `200`.
10. **Sem `matt_word` o link não gera comissão**, e nada avisa.
