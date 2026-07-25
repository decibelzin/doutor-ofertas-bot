import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../../logger';

/**
 * CUPONS DE SITE INTEIRO do ML via AGREGADORES públicos (Pelando etc.).
 *
 * Descoberta: os códigos que os canais concorrentes postam (ALLSITE25,
 * TODOSITE25, SITEMELI25, MELIOFFHJ, LOJASOFICIAS30...) NÃO aparecem em nenhum
 * endpoint da conta de afiliado — eles são campanhas de site inteiro do ML,
 * publicadas em sites agregadores de cupom. É de lá que dá pra captá-los.
 *
 * Estes cupons valem pra QUALQUER comprador e (diferente dos de vendedor) o
 * cliente DIGITA o código no carrinho — por isso rendem o post "cupom relâmpago".
 *
 * ⚠️ Fonte de terceiro: código pode estar vencido/inválido. O post sempre traz
 * as condições e a validade é do agregador, não do ML.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export interface FeedCoupon {
  code: string;
  /** Descrição do agregador, ex.: "R$20 off em Compras Acima de 199…". */
  description: string;
  /** Desconto extraído: percentual (20 = 20%) ou null. */
  percentOff: number | null;
  /** Desconto extraído: valor em R$ ou null. */
  amountOff: number | null;
  /** Compra mínima em R$ (ou null). */
  minPurchase: number | null;
  /** Teto de desconto em R$ (ou null). */
  capAmount: number | null;
  source: string;
}

interface Feed {
  name: string;
  url: string;
  /** Seletor dos elementos que carregam o código. */
  codeSelector: string;
  /** Como extrair o código do elemento. */
  codeAttr?: string;
}

const FEEDS: Feed[] = [
  {
    name: 'pelando',
    url: 'https://www.pelando.com.br/cupons-de-descontos/mercado-livre',
    codeSelector: '[data-copy-code]',
    codeAttr: 'data-copy-code',
  },
];

const cache: { at: number; coupons: FeedCoupon[] } = { at: 0, coupons: [] };

/** "R$ 1.234,56" / "1234" → número. */
function toNum(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Extrai desconto, compra mínima e teto da descrição do agregador. */
export function parseFeedDescription(desc: string): Omit<FeedCoupon, 'code' | 'source' | 'description'> {
  const pct = desc.match(/(\d{1,2})\s*%\s*off/i);
  const amt = desc.match(/R?\$?\s*(\d{1,4}(?:[.,]\d{2})?)\s*off/i);
  const min = desc.match(/acima\s+(?:de\s+)?R?\$?\s*(\d{1,5}(?:[.,]\d{2})?)/i);
  const cap = desc.match(/limitad[oa]\s*(?:à|a|em)?\s*R?\$?\s*(\d{1,5}(?:[.,]\d{2})?)/i);
  return {
    percentOff: pct ? Number(pct[1]) : null,
    amountOff: pct ? null : toNum(amt?.[1]),
    minPurchase: toNum(min?.[1]),
    capAmount: toNum(cap?.[1]),
  };
}

async function fetchFeed(feed: Feed): Promise<FeedCoupon[]> {
  const res = await axios.get<string>(feed.url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    timeout: 25000,
    responseType: 'text',
    validateStatus: () => true,
    maxRedirects: 5,
  });
  if (res.status !== 200) {
    logger.warn({ feed: feed.name, status: res.status }, '[ML/feeds] Agregador não respondeu 200.');
    return [];
  }

  const $ = cheerio.load(res.data);
  const out: FeedCoupon[] = [];
  const seen = new Set<string>();

  $(feed.codeSelector).each((_, el) => {
    const code = (feed.codeAttr ? $(el).attr(feed.codeAttr) : $(el).text())?.trim().toUpperCase();
    // Código plausível: 4–24 chars, alfanumérico, sem espaço.
    if (!code || !/^[A-Z0-9]{4,24}$/.test(code) || seen.has(code)) return;
    // Cupom do PRÓPRIO agregador (ex.: PELANDO250) não é do ML — descarta.
    if (code.includes(feed.name.toUpperCase())) return;
    seen.add(code);

    const card = $(el).closest('article, .card, [class*="deal-card"], li');
    const description = card.find('h2,h3,[class*="title"]').first().text().trim();
    // Sem descrição de cupom do ML reconhecível, não dá pra anunciar com segurança.
    if (!/mercado\s*livre|meli/i.test(description)) return;
    out.push({ code, description, source: feed.name, ...parseFeedDescription(description) });
  });
  return out;
}

/**
 * Busca cupons de site inteiro nos agregadores. Cacheado por TTL (o conjunto
 * muda algumas vezes por dia).
 */
export async function fetchFeedCoupons({
  ttlMs = 60 * 60 * 1000,
}: { ttlMs?: number } = {}): Promise<FeedCoupon[]> {
  if (cache.at && Date.now() - cache.at < ttlMs) return cache.coupons;

  const all: FeedCoupon[] = [];
  for (const feed of FEEDS) {
    try {
      all.push(...(await fetchFeed(feed)));
    } catch (err) {
      logger.warn({ feed: feed.name, err: (err as Error).message }, '[ML/feeds] Falha no agregador.');
    }
  }

  // Dedup por código, mantendo a 1ª ocorrência (feed mais confiável primeiro).
  const byCode = new Map<string, FeedCoupon>();
  for (const c of all) if (!byCode.has(c.code)) byCode.set(c.code, c);
  const out = [...byCode.values()];

  if (out.length === 0 && cache.coupons.length > 0) return cache.coupons; // não zera cache bom
  cache.at = Date.now();
  cache.coupons = out;
  logger.info({ count: out.length, codigos: out.slice(0, 8).map((c) => c.code) }, '[ML/feeds] Cupons de site inteiro.');
  return out;
}

/** Só os cupons "de site inteiro" mais fortes: maior desconto primeiro. */
export function rankFeedCoupons(coupons: FeedCoupon[]): FeedCoupon[] {
  return [...coupons].sort((a, b) => {
    const va = a.amountOff ?? (a.percentOff ?? 0) * 2; // aproxima % vs R$ pra ordenar
    const vb = b.amountOff ?? (b.percentOff ?? 0) * 2;
    return vb - va;
  });
}
