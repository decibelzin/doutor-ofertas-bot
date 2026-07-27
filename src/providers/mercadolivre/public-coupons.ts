import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../logger';
import { alertAuthDegraded } from '../../core/health';
import { isPerfumeProduct } from './coupons';

/**
 * CUPONS PÚBLICOS DO ML (mercadolivre.com.br/cupons) - os mesmos que os canais
 * concorrentes postam ("CUPOM RELÂMPAGO"). Diferente dos cupons de VENDEDOR
 * (coupons.ts, auto-aplicados), estes são cupons do próprio ML, que o comprador
 * ativa/usa, e valem pra QUALQUER pessoa (não são da nossa conta de afiliado).
 *
 * A página não expõe API limpa: os cupons vêm num JSON EMBUTIDO no HTML. A gente
 * extrai os objetos `{"campaign_id": ...}` balanceando chaves, e fica com os que
 * têm produto de PERFUMARIA (domain_id MLB-PERFUMES ou título de perfume).
 *
 * ⚠️ A página exige sessão (cookie do painel) - senão cai no muro/login.
 */

const URL = 'https://www.mercadolivre.com.br/cupons';
/**
 * API JSON dos cupons. O filtro `special_coupon=true` é o ÚNICO que devolve o
 * CÓDIGO LEGÍVEL (ex.: "AFILIADOPET26") no campo `code`/`inputCode`; todos os
 * outros filtros - e o HTML da página - só trazem um token opaco de 88 chars.
 * Descoberto por engenharia reversa do bundle smart-coupons-frontend.
 */
const SPECIAL_API =
  'https://www.mercadolivre.com.br/cupons/api/main-data/filtered?page=1&special_coupon=true&origin=main';
/** API paginada do catálogo INTEIRO de cupons (~75 páginas x 30). */
const ALL_API = 'https://www.mercadolivre.com.br/cupons/api/main-data/filtered';
/** Teto de páginas por varredura (75 cobre o catálogo hoje; folga pra crescer). */
const MAX_PAGES = 90;
/** Acima disso o `code` é token opaco, não código digitável. */
const MAX_READABLE_CODE_LEN = 25;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export interface PublicCouponItem {
  altText: string;
  domainId: string;
  imageUrl: string | null;
}

export interface PublicCoupon {
  campaignId: string;
  title: string;
  /** IDs (MLB…) dos produtos elegíveis - vêm de um objeto irmão no mesmo HTML. */
  itemIds: string[];
  /** Ex.: "Compra mínima R$ 150" (texto pronto do ML). */
  minAmountText: string | null;
  /** Ex.: "Limite de R$ 20". */
  capAmountText: string | null;
  /** Ex.: "Vence em sexta-feira" / "Está esgotando!". */
  expirationText: string | null;
  /** EU_QUERO = o comprador ativa o cupom na página/app. */
  activationType: string | null;
  /**
   * Link direto pro cupom na página do ML (abre já apontando pra ele). Esses
   * cupons NÃO têm código digitável - são de ativar por clique ("Aplicar"), e o
   * `code` é um token opaco. Este link é o equivalente ao "código" pro cliente.
   */
  activationUrl: string | null;
  /** Produtos de perfumaria elegíveis (amostra que o ML mostra no card). */
  perfumeItems: PublicCouponItem[];
  /** Todos os produtos-amostra do card. */
  items: PublicCouponItem[];
}

const cache: { at: number; coupons: PublicCoupon[] } = { at: 0, coupons: [] };
const specialCache: { at: number; coupons: SpecialCoupon[] } = { at: 0, coupons: [] };

/** Cupom com CÓDIGO DIGITÁVEL (o "cupom relâmpago" que os concorrentes postam). */
export interface SpecialCoupon {
  campaignId: string;
  /** Código legível pro cliente digitar. Ex.: "AFILIADOPET26". */
  code: string;
  title: string;
  minAmountText: string | null;
  capAmountText: string | null;
  expirationText: string | null;
  /** Listing dos produtos elegíveis (lista.mercadolivre.com.br/...). */
  productsUrl: string | null;
}

export function publicCouponsEnabled(): boolean {
  return Boolean(config.mercadoLivre.affiliateCookie);
}

/** Texto pode vir string ou {text}. Normaliza. */
function asText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'text' in (v as Record<string, unknown>)) {
    const t = (v as { text?: unknown }).text;
    return typeof t === 'string' ? t : null;
  }
  return null;
}

const PERFUME_DOMAIN = /^MLB-PERFUMES$|FRAGRANC|COLOGNE/i;
const PERFUME_TEXT = /\b(perfum|parfum|eau de|\bedt\b|\bedp\b)\b/i;

/**
 * É item de perfumaria? Domínio MLB-PERFUMES crava; senão exige que o título
 * passe no mesmo crivo das ofertas (`isPerfumeProduct`), que corta difusor de
 * ambiente, sabonete, kit banho e afins - falsos-positivos de "fragrância".
 */
function isPerfumeItem(i: PublicCouponItem): boolean {
  if (PERFUME_DOMAIN.test(i.domainId)) return true;
  return isPerfumeProduct(i.altText);
}

/**
 * Extrai os objetos de cupom do JSON embutido no HTML (balanceando chaves a
 * partir de cada `{"campaign_id":"`).
 */
export function parsePublicCouponsHtml(html: string): PublicCoupon[] {
  const raw: Record<string, unknown>[] = [];
  const re = /\{"campaign_id":"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const start = m.index;
    let depth = 0;
    let end = -1;
    for (let j = start; j < html.length && j < start + 9000; j += 1) {
      if (html[j] === '{') depth += 1;
      else if (html[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end < 0) continue;
    try {
      raw.push(JSON.parse(html.slice(start, end)) as Record<string, unknown>);
    } catch {
      /* fragmento inválido - ignora */
    }
  }

  // Os IDs dos produtos elegíveis vêm num objeto IRMÃO (mesmo campaign_id) que
  // carrega `item_ids` - o card visual só traz imagem/alt_text/domain_id.
  const idsByCampaign = new Map<string, string[]>();
  for (const c of raw) {
    const id = String(c.campaign_id ?? '');
    if (id && Array.isArray(c.item_ids) && c.item_ids.length && !idsByCampaign.has(id)) {
      idsByCampaign.set(id, (c.item_ids as unknown[]).map(String));
    }
  }

  const byCampaign = new Map<string, PublicCoupon>();
  for (const c of raw) {
    const items: PublicCouponItem[] = Array.isArray(c.items)
      ? (c.items as Record<string, unknown>[]).map((i) => ({
          altText: String(i.alt_text ?? ''),
          domainId: String(i.domain_id ?? ''),
          imageUrl: typeof i.image_url === 'string' ? i.image_url : null,
        }))
      : [];
    const perfumeItems = items.filter(isPerfumeItem);
    if (perfumeItems.length === 0) continue; // só interessa cupom com perfume

    const amount = (c.amount ?? {}) as Record<string, unknown>;
    const campaignId = String(c.campaign_id ?? '');
    if (!campaignId || byCampaign.has(campaignId)) continue;

    byCampaign.set(campaignId, {
      campaignId,
      itemIds: idsByCampaign.get(campaignId) ?? [],
      title: asText(c.title) ?? '(sem título)',
      minAmountText: asText(amount.min_amount) ?? asText(c.min_amount),
      capAmountText: asText(amount.cap_amount) ?? asText(c.cap_amount),
      expirationText: asText(c.expiration_date),
      activationType: typeof c.activation_type === 'string' ? c.activation_type : null,
      activationUrl:
        typeof c.code === 'string' && c.code.length > 0
          ? `${URL}?code=${encodeURIComponent(c.code)}`
          : null,
      perfumeItems,
      items,
    });
  }
  return [...byCampaign.values()];
}

/**
 * Cupons com CÓDIGO DIGITÁVEL vigentes (filtro `special_coupon`). São poucos
 * (3-5) e rotativos - vários vencem no mesmo dia -, então vale consultar de
 * hora em hora pra pegar os novos cedo. É o equivalente ao "CUPOM RELÂMPAGO"
 * dos concorrentes.
 */
export async function fetchSpecialCoupons({
  ttlMs = 60 * 60 * 1000,
}: { ttlMs?: number } = {}): Promise<SpecialCoupon[]> {
  if (!publicCouponsEnabled()) return [];
  if (specialCache.at && Date.now() - specialCache.at < ttlMs) return specialCache.coupons;

  const res = await axios.get<{ coupons?: Record<string, unknown>[] }>(SPECIAL_API, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      Cookie: config.mercadoLivre.affiliateCookie,
    },
    timeout: 20000,
    validateStatus: () => true,
  });
  if (res.status !== 200) return specialCache.coupons;

  const list = Array.isArray(res.data?.coupons) ? res.data.coupons : [];
  // Sem sessão o endpoint responde 200 com lista VAZIA (falha silenciosa).
  if (list.length === 0 && specialCache.coupons.length > 0) {
    alertAuthDegraded('cupons-especiais-vazio');
    return specialCache.coupons;
  }

  const out: SpecialCoupon[] = [];
  for (const c of list) {
    const code = String(c.code ?? c.inputCode ?? '');
    // Só o código LEGÍVEL interessa; token opaco (88 chars) não serve pra postar.
    if (!code || code.length > MAX_READABLE_CODE_LEN) continue;
    const amount = (c.amount ?? {}) as Record<string, unknown>;
    const action = (c.action ?? {}) as Record<string, unknown>;
    out.push({
      campaignId: String(c.campaign_id ?? c.campaignId ?? ''),
      code,
      title: (asText(c.title) ?? '').trim() || '(sem título)',
      minAmountText: asText(amount.min_amount),
      capAmountText: asText(amount.cap_amount),
      expirationText: asText(c.expiration_date) ?? asText(c.expirationDate),
      productsUrl: typeof action.value === 'string' ? action.value : null,
    });
  }

  specialCache.at = Date.now();
  specialCache.coupons = out;
  logger.info(
    { count: out.length, codigos: out.map((c) => c.code) },
    '[ML/cupons-especiais] Cupons com código digitável.'
  );
  return out;
}

/** Texto pode vir em snake_case (HTML) ou camelCase (API). */
function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

/** Converte um cupom da API (camelCase) no nosso PublicCoupon, ou null se não tem perfume. */
function apiCouponToPublic(c: Record<string, unknown>): PublicCoupon | null {
  const rawItems = (pick(c, 'items') as Record<string, unknown>[] | undefined) ?? [];
  const items: PublicCouponItem[] = rawItems.map((i) => ({
    altText: String(pick(i, 'altText', 'alt_text') ?? ''),
    domainId: String(pick(i, 'domainId', 'domain_id') ?? ''),
    imageUrl: (pick(i, 'imageUrl', 'image_url') as string | undefined) ?? null,
  }));
  const title = asText(pick(c, 'title')) ?? '(sem título)';
  const perfumeItems = items.filter(isPerfumeItem);
  // Aceita também quando o TÍTULO do cupom é de perfumaria ("15% OFF em Perfumes").
  if (perfumeItems.length === 0 && !PERFUME_TEXT.test(title)) return null;

  const amount = (pick(c, 'amount') as Record<string, unknown> | undefined) ?? {};
  const campaignId = String(pick(c, 'campaignId', 'campaign_id') ?? '');
  if (!campaignId) return null;
  const code = String(pick(c, 'code') ?? '');

  return {
    campaignId,
    itemIds: [],
    title,
    minAmountText: asText(pick(amount, 'minAmount', 'min_amount')),
    capAmountText: asText(pick(amount, 'capAmount', 'cap_amount')),
    expirationText: asText(pick(c, 'expirationDate', 'expiration_date')),
    activationType: (pick(c, 'activationType', 'activation_type') as string | undefined) ?? null,
    activationUrl: code ? `${URL}?code=${encodeURIComponent(code)}` : null,
    perfumeItems,
    items,
  };
}

/**
 * Busca TODOS os cupons públicos de perfumaria, varrendo a API paginada
 * (~75 páginas). Muito superior a raspar o HTML da página, que só expõe as
 * primeiras dezenas - a varredura completa acha ~50 cupons de perfumaria contra
 * ~2 do HTML. Cacheado por TTL (o conjunto muda devagar).
 */
export async function fetchPublicPerfumeCoupons({
  ttlMs = config.mercadoLivre.publicCouponsTtlMinutes * 60 * 1000,
  maxPages = MAX_PAGES,
  delayMs = 350,
}: { ttlMs?: number; maxPages?: number; delayMs?: number } = {}): Promise<PublicCoupon[]> {
  if (!publicCouponsEnabled()) return [];
  if (cache.at && Date.now() - cache.at < ttlMs) return cache.coupons;

  const out: PublicCoupon[] = [];
  const seen = new Set<string>();
  let pages = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    let list: Record<string, unknown>[];
    try {
      const res = await axios.get<{ coupons?: Record<string, unknown>[] }>(
        `${ALL_API}?page=${page}&all_coupons=true&origin=main`,
        {
          headers: {
            'User-Agent': UA,
            Accept: 'application/json',
            'Accept-Language': 'pt-BR,pt;q=0.9',
            Cookie: config.mercadoLivre.affiliateCookie,
          },
          timeout: 20000,
          validateStatus: () => true,
        }
      );
      if (res.status !== 200) break;
      list = Array.isArray(res.data?.coupons) ? res.data.coupons : [];
    } catch {
      break;
    }
    if (list.length === 0) break; // fim do catálogo
    pages += 1;

    for (const c of list) {
      const id = String(pick(c, 'campaignId', 'campaign_id') ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const parsed = apiCouponToPublic(c);
      if (parsed) out.push(parsed);
    }
    if (page < maxPages) await new Promise((r) => setTimeout(r, delayMs));
  }

  // Varredura sem resultado com cache cheio = sessão caiu (falha silenciosa).
  if (pages === 0 && cache.coupons.length > 0) {
    alertAuthDegraded('cupons-publicos-sem-sessao');
    return cache.coupons;
  }

  cache.at = Date.now();
  cache.coupons = out;
  logger.info(
    { paginas: pages, varridos: seen.size, perfumaria: out.length },
    '[ML/cupons-públicos] Catálogo varrido - cupons de perfumaria.'
  );
  return out;
}
