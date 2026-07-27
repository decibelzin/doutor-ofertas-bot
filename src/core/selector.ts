import { config } from '../config';
import { logger } from '../logger';
import { alertAuthDegraded } from './health';
import type { Deal } from './deal';

import * as mercadolivre from '../providers/mercadolivre';
import * as shopee from '../providers/shopee';
import { fetchOfertasForCategories } from '../providers/mercadolivre/ofertas';
import { fetchHubDeals, hubEnabled } from '../providers/mercadolivre/hub';
import { fetchSearchDeals, searchEnabled } from '../providers/mercadolivre/search';
import { fetchDealsForKeywords as shopeeByKeywords } from '../providers/shopee';
import type { Niche } from './niches';

interface Provider {
  name: string;
  fetchDeals: () => Promise<Deal[]>;
}

/** Providers ativos conforme o .env. */
export function enabledProviders(): Provider[] {
  const providers: Provider[] = [];
  if (config.shopee.enabled) providers.push(shopee);
  if (config.mercadoLivre.enabled) providers.push(mercadolivre);
  return providers;
}

/**
 * Coleta ofertas de todos os providers ativos, deduplica e rankeia da melhor
 * para a pior (maior desconto; empate desempata por comissão).
 */
export async function collectRankedDeals(): Promise<Deal[]> {
  const providers = enabledProviders();
  if (providers.length === 0) {
    logger.warn('[Selector] Nenhum provider ativo - confira as credenciais no .env.');
    return [];
  }

  const all: Deal[] = [];
  for (const provider of providers) {
    try {
      all.push(...(await provider.fetchDeals()));
    } catch (err) {
      logger.error(
        { err: (err as Error).message, provider: provider.name },
        '[Selector] Erro ao buscar ofertas'
      );
    }
  }

  const seen = new Set<string>();
  const unique: Deal[] = [];
  for (const deal of all) {
    if (seen.has(deal.id)) continue;
    seen.add(deal.id);
    unique.push(deal);
  }

  unique.sort((a, b) => {
    if (b.discountPercent !== a.discountPercent) return b.discountPercent - a.discountPercent;
    return (b.commissionRate ?? 0) - (a.commissionRate ?? 0);
  });

  return unique;
}

/**
 * Coleta ofertas de UM nicho: Shopee (por palavras-chave, quando ligada) + ML
 * (por categorias). Filtra pelo desconto mínimo do nicho e rankeia.
 */
export async function collectNicheDeals(niche: Niche): Promise<Deal[]> {
  const minDiscount = niche.minDiscountPercent ?? config.mercadoLivre.minDiscountPercent;
  const minRating = niche.minRating ?? config.mercadoLivre.minRating;
  const all: Deal[] = [];

  if (config.shopee.enabled && niche.shopee?.keywords?.length) {
    try {
      all.push(...(await shopeeByKeywords(niche.shopee.keywords, minDiscount)));
    } catch (err) {
      logger.error({ err: (err as Error).message, niche: niche.name }, '[Selector] Erro Shopee');
    }
  }

  if (config.mercadoLivre.enabled) {
    try {
      // Fonte preferida: hub de afiliado por busca (catálogo inteiro, com avaliação).
      // Sem hub/searchTerms, cai na página pública de ofertas por categoria.
      const mlDeals: Deal[] = [];
      const terms = niche.ml?.searchTerms ?? [];
      const triedHub = hubEnabled() && terms.length > 0;
      if (triedHub) {
        // Hub PRIMEIRO (traz avaliação/comissão → vence na dedup do produto).
        const hub = await fetchHubDeals(terms, { pagesPerTerm: config.mercadoLivre.hubPagesPerTerm });
        mlDeals.push(...hub);
        // Hub ligado + vários termos retornando ZERO = cookie/csrf provavelmente
        // expirado (não coincidência). Alerta pra recaptura rápida.
        if (hub.length === 0) {
          alertAuthDegraded('hub-vazio', { niche: niche.name, termos: terms.length });
        }
      }
      // Busca PÚBLICA (volume): o catálogo inteiro, cacheado por TTL. Soma os
      // milhares que o hub não pega. Roda junto, não no lugar.
      if (searchEnabled() && terms.length > 0) {
        try {
          mlDeals.push(...(await fetchSearchDeals(terms)));
        } catch (err) {
          logger.error({ err: (err as Error).message, niche: niche.name }, '[Selector] Erro busca pública');
        }
      }
      // Nada das fontes acima -> fallback pra página pública de ofertas.
      if (mlDeals.length === 0) {
        mlDeals.push(...(await fetchOfertasForCategories(niche.ml?.categories ?? [])));
      }
      all.push(...mlDeals);
    } catch (err) {
      logger.error({ err: (err as Error).message, niche: niche.name }, '[Selector] Erro ML');
    }
  }

  const seen = new Set<string>();
  const deals = all.filter((d) => {
    if (seen.has(d.id) || d.discountPercent < minDiscount) return false;
    // Filtra por avaliação só quando a fonte fornece (hub tem; ofertas não).
    if (minRating > 0 && d.rating != null && d.rating < minRating) return false;
    seen.add(d.id);
    return true;
  });
  deals.sort(
    (a, b) => b.discountPercent - a.discountPercent || (b.commissionRate ?? 0) - (a.commissionRate ?? 0)
  );
  return deals;
}
