import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../logger';
import type { Deal } from '../../core/deal';
import { parseOfertasHtml } from './ofertas';
import { isInBank } from '../../format/perfumes';
import { norm } from '../../format/title';

/**
 * DESCOBERTA DE CUPONS DE PERFUMARIA (painel de afiliado do ML).
 *
 * Contexto (ver docs/handoff-cupons.md): os cupons dessa conta são todos do tipo
 * PRODUCT_DISCOUNT - aplicados AUTOMATICAMENTE no carrinho, sem código pra
 * digitar. A API do painel não filtra por categoria, então a descoberta é:
 *
 *   1. varrer a LISTA de cupons (GET /coupons?page=N - barato, só `page` funciona)
 *   2. filtrar sellers que "parecem" perfumaria (nome bate watchlist)
 *   3. resolver a URL de produtos (GET /coupon-search-url) SÓ dos candidatos
 *   4. raspar a listing (é o mesmo HTML de /ofertas → parseOfertasHtml)
 *   5. classificar: é cupom de perfume se a fração de produtos-perfume passa o piso
 *
 * Tudo autenticado com o MESMO cookie + x-csrf-token do hub/createLink (.env).
 * A raspagem TAMBÉM exige o cookie (sem ele o ML joga pro muro
 * account-verification), então todo o tráfego é da sessão do usuário → devagar.
 */

const API_BASE = 'https://www.mercadolivre.com.br/affiliate-program/api/affiliates';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * 250)));
}

export function couponsEnabled(): boolean {
  return Boolean(config.mercadoLivre.affiliateCookie && config.mercadoLivre.affiliateCsrf);
}

function authHeaders(): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: 'https://www.mercadolivre.com.br',
    Referer: 'https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true',
    'x-csrf-token': config.mercadoLivre.affiliateCsrf,
    Cookie: config.mercadoLivre.affiliateCookie,
  };
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Um cupom cru como vem de GET /coupons. Só tem o VENDEDOR, não o produto. */
export interface Coupon {
  id: number;
  title: string; // ex.: "20% OFF", "R$ 15 OFF"
  category: string; // "PRODUCT_DISCOUNT" (tipo do cupom, não do produto)
  seller: string;
  remaining_budget: number;
  expiration_date: string;
  in_use: boolean;
  container_name: string;
}

interface CouponsPage {
  prefix?: string;
  coupons?: Coupon[];
  page?: number;
  items_per_page?: number;
  total_items?: number;
}

/** Condições parseadas do texto oficial (coupon-terms). */
export interface CouponTerms {
  raw: string;
  minPurchase: number | null;
  maxDiscount: number | null;
  autoApply: boolean;
}

/** Cupom já classificado como de perfumaria, com seus produtos de perfume. */
export interface PerfumeCoupon {
  couponId: number;
  title: string;
  discountPercent: number | null; // % extraída do title (null se for "R$ X OFF")
  discountAmount: number | null; // R$ extraído do title (null se for "% OFF")
  seller: string;
  expiration: string;
  searchUrl: string;
  terms: CouponTerms | null;
  perfumeCount: number;
  totalProducts: number;
  products: Deal[]; // só os produtos-perfume, prontos pra postar
}

// ---------------------------------------------------------------------------
// Classificação de perfumaria
// ---------------------------------------------------------------------------

/**
 * Palavras que denunciam produto de perfumaria no título.
 * ⚠️ Os termos abertos são PREFIXOS (perfum→perfume/perfumes/perfumaria), então
 * levam `\b` só à ESQUERDA. Um `\b` à direita quebraria o match ("perfum" seguido
 * de "e" não é limite de palavra) - foi um bug real que rejeitava "Perfume ...".
 */
const PERFUME_KEYWORD =
  /(\bperfum|\bparfum|\beau de\b|\bedt\b|\bedp\b|\bcol[oô]nia|\bfragr[aâ]ncia|\bbody spray\b|\bdeo[\s-]?col)/i;

/**
 * Categorias que NÃO são perfume mas casam marca/banco de perfumaria (ex.: o
 * "Batom Eudora" casa a marca Eudora). Sem esse corte, maquiagem/cabelo/pele da
 * mesma marca entraria na fila de post rotulada como perfume (ver handoff).
 */
const NON_PERFUME_KW =
  /\b(batom|gloss|corretivo|r[ií]mel|m[aá]scara de c[ií]lios|delineador|sombra|blush|p[oó] compacto|p[oó] facial|base l[ií]quida|esmalte|shampoo|condicionador|sabonete|hidratante|creme|s[eé]rum|escova|pincel|kit maquiagem|maquiagem|difusor|aromatizador|vela perfumada|amaciante|desinfetante|detergente|bolsa|bolsas|mochila|carteira|pochete|necessaire|shoulder bag|tiracolo|mala|rel[oó]gio|[oó]culos|camiseta|camisa|blusa|cal[cç]a|bermuda|short|vestido|jaqueta|t[eê]nis|sapato|chinelo|sand[aá]lia|bon[eé]|cinto|meia|cueca|toalha)\b/i;

/**
 * Volume (ml/L) no título. Perfume é vendido POR VOLUME - praticamente todo
 * anúncio traz "100ml", "50 ml" etc. Usamos isso como corroboração quando o
 * único sinal é a MARCA (que também vende bolsa, relógio, roupa…).
 */
const HAS_VOLUME = /\b\d{1,4}\s?(ml|mls|l|litros?)\b/i;

/**
 * Marcas/casas de perfume (inclui ÁRABES - decisão do usuário: incluir mesmo
 * fora do banco Fragrantica). Usadas tanto pra reconhecer PRODUTO quanto pra
 * reconhecer SELLER de perfumaria pelo nome.
 */
const PERFUME_BRANDS = [
  'eudora', 'boticario', 'natura', 'avon', 'mahogany', 'jequiti',
  'lattafa', 'armaf', 'al haramain', 'alharamain', 'afnan', 'ajmal', 'rasasi',
  'khadlaj', 'mawwal', 'lduk', 'maison alhambra', 'alhambra', 'zimaya', 'nusuk',
  // Casas árabes/nicho que os concorrentes postam (vistas no feed do ZP Links):
  'al wataniah', 'wataniah', 'french avenue', 'paris corner', 'riiffs', 'maktub',
  'bidaya', 'bharara', 'orientica', 'swiss arabian',
  'calvin klein', 'paco rabanne', 'rabanne', 'carolina herrera', 'dior', 'versace',
  'giorgio armani', 'armani', 'hugo boss', 'dolce', 'gabbana', 'montblanc',
  'azzaro', 'jean paul gaultier', 'gaultier', 'ferrari', 'antonio banderas',
  'shakira', 'prada', 'yves saint laurent', 'bvlgari', 'givenchy', 'lancome',
];

/** Padrões de nome de SELLER que sugerem perfumaria. */
const SELLER_PATTERNS = /(perfum|fragran|essenc|arom|scent|beleza|cosmet|import|parfum)/i;

/**
 * A marca aparece como PALAVRA/FRASE inteira no texto normalizado? Boundary por
 * caractere não-alfanumérico - evita substring espúria (ex.: "avon" ⊄ "pavoni",
 * que casava a loja de autopeças "Pavoni" com a marca Avon).
 */
function brandPresent(hayNorm: string, brand: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${norm(brand)}(?:[^a-z0-9]|$)`).test(hayNorm);
}

/** O NOME do seller sugere perfumaria? (filtro barato pré-raspagem.) */
export function sellerLooksPerfumery(seller: string): boolean {
  const n = norm(seller);
  if (SELLER_PATTERNS.test(n)) return true;
  return PERFUME_BRANDS.some((b) => brandPresent(n, b));
}

/**
 * O TÍTULO do produto é de perfume?
 *  1. keyword de OUTRA categoria (batom/bolsa/difusor/relógio/roupa…) → NÃO.
 *     Veta PRIMEIRO, mesmo com palavra de perfumaria no título: "Difusor de
 *     Ambiente Fragrância" tem "fragrância" mas não é perfume;
 *  2. keyword explícita de perfume (perfume/edp/edt/…) → sim;
 *  3. casa no banco Fragrantica → sim;
 *  4. só a MARCA bate → exige VOLUME (ml) como corroboração. Marca sozinha é
 *     sinal fraco: casa de perfume também vende bolsa, relógio e roupa - foi
 *     assim que uma "Shoulder Bag Maktub" foi postada como perfume.
 */
export function isPerfumeProduct(title: string): boolean {
  if (NON_PERFUME_KW.test(title)) return false;
  if (PERFUME_KEYWORD.test(title)) return true;
  if (isInBank(title)) return true;
  const n = norm(title);
  const brandHit = PERFUME_BRANDS.some((b) => brandPresent(n, b));
  return brandHit && HAS_VOLUME.test(title);
}

/** Extrai % ou R$ do título do cupom ("20% OFF" / "R$ 15 OFF"). */
export function parseCouponAmount(title: string): { percent: number | null; amount: number | null } {
  const pct = title.match(/(\d+)\s*%/);
  if (pct) return { percent: Number(pct[1]), amount: null };
  const amt = title.match(/R\$\s*([\d.,]+)/i);
  if (amt) return { percent: null, amount: Number(amt[1]!.replace(/\./g, '').replace(',', '.')) };
  return { percent: null, amount: null };
}

// ---------------------------------------------------------------------------
// Chamadas de API
// ---------------------------------------------------------------------------

/** Uma página da lista de cupons (14/página; só `page` é honrado pelo servidor). */
export async function fetchCouponsPage(page: number): Promise<CouponsPage> {
  const { status, data } = await axios.get<CouponsPage>(`${API_BASE}/coupons?page=${page}`, {
    headers: authHeaders(),
    timeout: 20000,
    validateStatus: () => true,
  });
  if (status !== 200) {
    throw new Error(`GET /coupons?page=${page} -> ${status}`);
  }
  return data;
}

/** URL de produtos do cupom (o botão "Ver produtos" do painel). */
export async function resolveCouponSearchUrl(couponId: number): Promise<string | null> {
  const { status, data } = await axios.get<{ coupons_product_url?: string }>(
    `${API_BASE}/coupon-search-url?coupon_id=${couponId}`,
    { headers: authHeaders(), timeout: 20000, validateStatus: () => true }
  );
  if (status !== 200) return null;
  return data?.coupons_product_url ?? null;
}

/** Texto oficial das condições do cupom. */
export async function fetchCouponTerms(couponId: number): Promise<CouponTerms | null> {
  const { status, data } = await axios.get<string>(
    `${API_BASE}/coupon-terms?coupon_id=${couponId}`,
    { headers: authHeaders(), timeout: 20000, validateStatus: () => true }
  );
  if (status !== 200 || typeof data !== 'string') return null;
  return parseTerms(data);
}

/** Extrai compra mínima, teto de desconto e se é auto-aplicável do texto. */
export function parseTerms(raw: string): CouponTerms {
  const min = raw.match(/compras?\s+m[ií]nimas?[^R]*R\$\s*([\d.,]+)/i);
  // Pega as duas ordens: "máximo de desconto de R$ X" e "desconto máximo de R$ X".
  const max =
    raw.match(/m[aá]ximo de desconto de\s*R\$\s*([\d.,]+)/i) ??
    raw.match(/desconto m[aá]ximo (?:de\s*)?R\$\s*([\d.,]+)/i);
  const toNum = (s: string): number => Number(s.replace(/\./g, '').replace(',', '.'));
  return {
    raw,
    minPurchase: min ? toNum(min[1]!) : null,
    maxDiscount: max ? toNum(max[1]!) : null,
    autoApply: /automaticamente/i.test(raw),
  };
}

/** Muro de verificação de conta = cookie do painel expirado. Erro PERMANENTE (não retenta). */
export class AuthWallError extends Error {}

/**
 * Raspa os produtos de um cupom. A listing é o MESMO HTML de /ofertas, então
 * reusa parseOfertasHtml. Exige o cookie (senão o ML joga pro muro
 * account-verification) e a URL SEM o `?coupon_campaign_id` (que causa 404 em
 * alguns containers; o conjunto de produtos é o mesmo sem ele).
 *
 * Retenta erros TRANSITÓRIOS (timeout/5xx); o muro de auth é permanente e sobe
 * na hora (AuthWallError) pra o chamador abortar a rodada em vez de descartar
 * cupons bons como se não fossem de perfume.
 */
export async function scrapeCouponProducts(
  searchUrl: string,
  { retries = 1, retryDelayMs = 1500 }: { retries?: number; retryDelayMs?: number } = {}
): Promise<Deal[]> {
  const url = searchUrl.split('?')[0]!;
  let lastErr: Error = new Error('scrape falhou');
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await axios.get<string>(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', Cookie: config.mercadoLivre.affiliateCookie },
        timeout: 25000,
        responseType: 'text',
        validateStatus: () => true,
        maxRedirects: 5,
      });
      const finalUrl: string = (res.request as { res?: { responseUrl?: string } })?.res?.responseUrl ?? url;
      if (finalUrl.includes('account-verification')) {
        throw new AuthWallError('muro account-verification - cookie do painel expirado?');
      }
      if (res.status !== 200) throw new Error(`scrape ${res.status}`);
      return parseOfertasHtml(res.data);
    } catch (err) {
      if (err instanceof AuthWallError) throw err; // permanente
      lastErr = err as Error;
      if (attempt < retries) await sleep(retryDelayMs);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Varredura + descoberta
// ---------------------------------------------------------------------------

export interface SweepState {
  totalItems: number | null;
  lastPage: number;
  coupons: Coupon[];
}

/**
 * Varre a lista de cupons página a página (barato). `onPage` recebe o estado a
 * cada página pra persistir (resumível). Começa em `state.lastPage + 1`.
 */
export async function sweepCouponList(
  maxPages: number,
  {
    state,
    delayMs = 900,
    onPage,
  }: { state?: SweepState; delayMs?: number; onPage?: (s: SweepState) => void } = {}
): Promise<SweepState> {
  const s: SweepState = state ?? { totalItems: null, lastPage: 0, coupons: [] };
  const seen = new Set(s.coupons.map((c) => c.id));

  for (let page = s.lastPage + 1; page <= maxPages; page += 1) {
    let pageData: CouponsPage;
    try {
      pageData = await fetchCouponsPage(page);
    } catch (err) {
      logger.error({ err: (err as Error).message, page }, '[ML/coupons] Falha na varredura - parando (cookie expirado?).');
      break;
    }
    s.totalItems = pageData.total_items ?? s.totalItems;
    for (const c of pageData.coupons ?? []) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        s.coupons.push(c);
      }
    }
    s.lastPage = page;
    onPage?.(s);

    // Parou de vir cupom (fim real da lista) → encerra.
    if ((pageData.coupons ?? []).length === 0) break;
    // Já cobriu tudo que o servidor reporta.
    if (s.totalItems && s.coupons.length >= s.totalItems) break;
    if (page < maxPages) await sleep(delayMs);
  }
  return s;
}

export interface DiscoverOptions {
  /** Piso da fração de produtos-perfume pra classificar o cupom (0-1). */
  minPerfumeFraction?: number;
  /** OU: nº absoluto de produtos-perfume que já qualifica. */
  minPerfumeProducts?: number;
  resolveDelayMs?: number;
  scrapeDelayMs?: number;
  fetchTerms?: boolean;
  onCandidate?: (info: { seller: string; couponId: number; perfumeCount: number; total: number; kept: boolean }) => void;
}

export interface DiscoverResult {
  coupons: PerfumeCoupon[];
  candidates: number;
  scraped: number;
  errors: number;
  /** True se bateu no muro de auth (cookie expirado) - resultado NÃO é confiável. */
  authFailed: boolean;
}

/**
 * Dado o conjunto de cupons varridos, filtra sellers de perfumaria, resolve +
 * raspa SÓ os candidatos e devolve os que são de fato cupons de perfume.
 * Dedupe de raspagem por URL de loja (cupons da mesma loja → 1 raspagem).
 *
 * Se o cookie expirar no meio (muro account-verification), ABORTA e devolve
 * `authFailed: true` - pra o chamador NÃO sobrescrever um cache bom com vazio.
 */
export async function discoverFromCoupons(
  coupons: Coupon[],
  opts: DiscoverOptions = {}
): Promise<DiscoverResult> {
  const {
    minPerfumeFraction = 0.3,
    minPerfumeProducts = 8,
    resolveDelayMs = 900,
    scrapeDelayMs = 900,
    fetchTerms = true,
    onCandidate,
  } = opts;

  const candidates = coupons.filter((c) => sellerLooksPerfumery(c.seller));
  logger.info(
    { total: coupons.length, candidatos: candidates.length },
    '[ML/coupons] Sellers de perfumaria filtrados da lista.'
  );

  // Cache só de SUCESSO (Deal[]): erro transitório não fica cacheado - assim
  // outro cupom da mesma loja tenta de novo em vez de herdar a falha.
  const scrapeCache = new Map<string, Deal[]>();
  const out: PerfumeCoupon[] = [];
  let scraped = 0;
  let errors = 0;

  for (const c of candidates) {
    await sleep(resolveDelayMs);
    const searchUrl = await resolveCouponSearchUrl(c.id);
    if (!searchUrl) {
      errors += 1;
      onCandidate?.({ seller: c.seller, couponId: c.id, perfumeCount: 0, total: 0, kept: false });
      continue;
    }

    const cacheKey = searchUrl.split('?')[0]!;
    let products = scrapeCache.get(cacheKey);
    if (!products) {
      await sleep(scrapeDelayMs);
      try {
        products = await scrapeCouponProducts(searchUrl);
        scraped += 1;
        scrapeCache.set(cacheKey, products);
      } catch (err) {
        if (err instanceof AuthWallError) {
          logger.error('[ML/coupons] Muro de auth (cookie expirado) - abortando descoberta pra não gravar cache vazio.');
          return { coupons: out, candidates: candidates.length, scraped, errors, authFailed: true };
        }
        errors += 1;
        onCandidate?.({ seller: c.seller, couponId: c.id, perfumeCount: 0, total: 0, kept: false });
        continue;
      }
    }

    const perfumes = products.filter((d) => isPerfumeProduct(d.title));
    const total = products.length;
    const fraction = total > 0 ? perfumes.length / total : 0;
    const kept = perfumes.length >= minPerfumeProducts || (total > 0 && fraction >= minPerfumeFraction);
    onCandidate?.({ seller: c.seller, couponId: c.id, perfumeCount: perfumes.length, total, kept });
    if (!kept) continue;

    const { percent, amount } = parseCouponAmount(c.title);
    const terms = fetchTerms ? await fetchCouponTerms(c.id) : null;
    out.push({
      couponId: c.id,
      title: c.title,
      discountPercent: percent,
      discountAmount: amount,
      seller: c.seller,
      expiration: c.expiration_date,
      searchUrl,
      terms,
      perfumeCount: perfumes.length,
      totalProducts: total,
      products: perfumes,
    });
  }

  // Ordena: maior % primeiro, depois mais produtos de perfume.
  out.sort((a, b) => (b.discountPercent ?? 0) - (a.discountPercent ?? 0) || b.perfumeCount - a.perfumeCount);
  return { coupons: out, candidates: candidates.length, scraped, errors, authFailed: false };
}
