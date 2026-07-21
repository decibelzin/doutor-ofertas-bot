import { config } from '../config';
import { logger } from '../logger';
import type { Deal } from './deal';

import * as mercadolivre from '../providers/mercadolivre';
import * as shopee from '../providers/shopee';

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
    logger.warn('[Selector] Nenhum provider ativo — confira as credenciais no .env.');
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
