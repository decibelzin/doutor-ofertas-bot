import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../logger';
import { alertAuthDegraded } from '../../core/health';
import { parseOfertasHtml } from './ofertas';
import type { Deal } from '../../core/deal';

/**
 * Fonte de VOLUME: a BUSCA PÚBLICA do ML (lista.mercadolivre.com.br/<termo>).
 * O hub de afiliado é raso (~12/termo); a busca pública entrega ~48/página e é
 * paginada (o catálogo inteiro) — é o que os canais concorrentes usam pra ter
 * volume. Roda JUNTO com o hub (não no lugar); o hub continua dando avaliação/
 * comissão, a busca soma os milhares que o hub não pega. Dedup por id no selector.
 *
 * ⚠️ A listing exige o COOKIE do painel (sem ele o ML joga pro muro
 * account-verification). Logo é tráfego autenticado da sessão — por isso o
 * resultado é CACHEADO por TTL (raspa poucas vezes por hora, não a cada post).
 * O link já sai com a tag de afiliado (parseOfertasHtml → buildAffiliateUrl).
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const PAGE_SIZE = 48; // itens por página na busca pública

const cache = new Map<string, { deals: Deal[]; at: number }>();

/** Ligado quando o cookie do painel está configurado (a busca exige ele). */
export function searchEnabled(): boolean {
  return Boolean(config.mercadoLivre.affiliateCookie) && config.mercadoLivre.searchPagesPerTerm > 0;
}

/** "perfume árabe" -> "perfume-arabe" (slug de URL da busca do ML). */
function slug(term: string): string {
  return term
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function pageUrl(term: string, page: number): string {
  const base = `https://lista.mercadolivre.com.br/${slug(term)}`;
  return page <= 1 ? base : `${base}_Desde_${PAGE_SIZE * (page - 1) + 1}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * 300)));
}

async function fetchPage(term: string, page: number): Promise<Deal[]> {
  const url = pageUrl(term, page);
  const res = await axios.get<string>(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'pt-BR,pt;q=0.9',
      Cookie: config.mercadoLivre.affiliateCookie,
    },
    timeout: 25000,
    responseType: 'text',
    validateStatus: () => true,
    maxRedirects: 5,
  });
  const finalUrl: string = (res.request as { res?: { responseUrl?: string } })?.res?.responseUrl ?? url;
  if (finalUrl.includes('account-verification')) {
    alertAuthDegraded('busca-publica-muro', { term });
    return [];
  }
  if (res.status !== 200) return [];
  return parseOfertasHtml(res.data);
}

/** Roda `fn` sobre `items` com no máximo `limit` em paralelo (pacing gentil). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]!);
      await sleep(500);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Busca vários termos na busca pública (paginado), dedup por id. CACHEADO por
 * TTL — chamadas dentro do TTL reusam o último resultado (não re-raspa a cada
 * post). O selector chama isso junto com o hub.
 */
export async function fetchSearchDeals(
  terms: string[],
  {
    pagesPerTerm = config.mercadoLivre.searchPagesPerTerm,
    ttlMs = config.mercadoLivre.searchTtlMinutes * 60 * 1000,
    concurrency = 2,
  }: { pagesPerTerm?: number; ttlMs?: number; concurrency?: number } = {}
): Promise<Deal[]> {
  if (!searchEnabled() || terms.length === 0 || pagesPerTerm <= 0) return [];

  const key = `${terms.slice().sort().join('|')}#${pagesPerTerm}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < ttlMs) return cached.deals;

  const tasks: Array<{ term: string; page: number }> = [];
  for (const term of terms) for (let p = 1; p <= pagesPerTerm; p += 1) tasks.push({ term, page: p });

  const pages = await mapLimit(tasks, concurrency, ({ term, page }) =>
    fetchPage(term, page).catch((err) => {
      logger.debug({ err: (err as Error).message, term, page }, '[ML/busca] Falha numa página.');
      return [] as Deal[];
    })
  );

  const byId = new Map<string, Deal>();
  for (const arr of pages) for (const d of arr) if (!byId.has(d.id)) byId.set(d.id, d);
  const deals = [...byId.values()];

  cache.set(key, { deals, at: Date.now() });
  logger.info(
    { termos: terms.length, paginas: pagesPerTerm, count: deals.length, ttlMin: Math.round(ttlMs / 60000) },
    '[ML/busca] Ofertas da busca pública (cacheado).'
  );
  return deals;
}
