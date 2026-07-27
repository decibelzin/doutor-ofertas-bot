import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../logger';
import { makeDeal, type Deal } from '../../core/deal';
import { buildAffiliateUrl } from './affiliate';

/**
 * Sourcing via o HUB DE AFILIADO do ML (o mesmo painel que gera os links dos
 * canais concorrentes). Endpoint interno descoberto por engenharia-reversa:
 *
 *   POST /affiliate-program/api/hub/search?is_affiliate=true
 *   body: { search, offset, sort?, filters? }
 *
 * Autenticado com o MESMO cookie + x-csrf-token do createLink (shortlink.ts).
 * Retorna produtos no formato "polycard" (JSON), com preço de/por, desconto,
 * link, imagem, COMISSÃO e AVALIAÇÃO - o catálogo inteiro por busca, muito mais
 * abrangente que a página pública de /ofertas.
 */

const SEARCH_URL =
  'https://www.mercadolivre.com.br/affiliate-program/api/hub/search?is_affiliate=true';
const PAGE_SIZE = 12; // o hub devolve 12 por página
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0';

/** Ligado quando cookie + csrf do painel estão configurados. */
export function hubEnabled(): boolean {
  return Boolean(config.mercadoLivre.affiliateCookie && config.mercadoLivre.affiliateCsrf);
}

interface Polycard {
  metadata?: { id?: string; url?: string };
  pictures?: { pictures?: Array<{ id?: string }> };
  components?: Array<{ type?: string; [k: string]: unknown }>;
}

function findComponent(card: Polycard, type: string): Record<string, unknown> | undefined {
  return card.components?.find((c) => c.type === type) as Record<string, unknown> | undefined;
}

function imageFromPicture(picId?: string): string | null {
  // Formato padrão de imagem 2X do ML a partir do id da foto.
  return picId ? `https://http2.mlstatic.com/D_NQ_NP_2X_${picId}-F.webp` : null;
}

/** Converte um polycard do hub em Deal normalizado (ou null se faltar essencial). */
function polycardToDeal(card: Polycard): Deal | null {
  const md = card.metadata ?? {};
  const title = (findComponent(card, 'title')?.title as { text?: string } | undefined)?.text;

  const priceObj = findComponent(card, 'price')?.price as
    | { current_price?: { value?: number }; previous_price?: { value?: number } }
    | undefined;
  const priceNow = priceObj?.current_price?.value ?? null;
  const priceOriginal = priceObj?.previous_price?.value ?? null;

  const review = findComponent(card, 'review_compacted')?.review_compacted as
    | { values?: Array<{ key?: string; label?: { text?: string } }> }
    | undefined;
  const ratingText = review?.values?.find((v) => v.key === 'label')?.label?.text;
  const rating = ratingText ? Number(ratingText.replace(',', '.')) : null;

  const rawUrl = md.url ? (md.url.startsWith('http') ? md.url : `https://${md.url}`) : null;
  const cleanUrl = rawUrl ? rawUrl.split('?')[0].split('#')[0] : null;
  const imageUrl = imageFromPicture(card.pictures?.pictures?.[0]?.id);

  return makeDeal({
    id: md.id ? `mercadolivre:${md.id}` : undefined,
    store: 'mercadolivre',
    title,
    priceNow,
    priceOriginal,
    imageUrl,
    affiliateUrl: cleanUrl ? buildAffiliateUrl(cleanUrl) : null,
    productUrl: cleanUrl,
    rating,
    category: 'hub',
  });
}

/** Busca UMA página do hub por um termo. */
async function fetchHubPage(term: string, offset: number): Promise<Deal[]> {
  const { data } = await axios.post<{ polycard_client_model?: { polycards?: Polycard[] } }>(
    SEARCH_URL,
    { search: term, offset },
    {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Origin: 'https://www.mercadolivre.com.br',
        Referer: 'https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true',
        'x-csrf-token': config.mercadoLivre.affiliateCsrf,
        Cookie: config.mercadoLivre.affiliateCookie,
      },
      timeout: 20000,
    }
  );
  const cards = data?.polycard_client_model?.polycards ?? [];
  return cards.map(polycardToDeal).filter((d): d is Deal => d !== null);
}

/** Roda `fn` sobre `items` com no máximo `limit` em paralelo. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Busca vários termos no hub (em paralelo, concorrência limitada) e deduplica. */
export async function fetchHubDeals(
  terms: string[],
  { pagesPerTerm = 1, concurrency = 3 }: { pagesPerTerm?: number; concurrency?: number } = {}
): Promise<Deal[]> {
  if (!hubEnabled()) {
    logger.warn('[ML/hub] Cookie/csrf do painel ausentes - hub desligado.');
    return [];
  }

  const tasks: Array<{ term: string; offset: number }> = [];
  for (const term of terms) {
    for (let page = 0; page < pagesPerTerm; page += 1) tasks.push({ term, offset: page * PAGE_SIZE });
  }

  const pages = await mapLimit(tasks, concurrency, async ({ term, offset }) => {
    try {
      return await fetchHubPage(term, offset);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      logger.error({ err: (err as Error).message, status, term }, '[ML/hub] Falha na busca.');
      return [] as Deal[];
    }
  });

  const byId = new Map<string, Deal>();
  for (const deals of pages) for (const d of deals) if (!byId.has(d.id)) byId.set(d.id, d);

  const deals = [...byId.values()];
  logger.info({ termos: terms.length, count: deals.length }, '[ML/hub] Ofertas do painel de afiliado.');
  return deals;
}
