import { config } from '../../config';
import { logger } from '../../logger';
import type { Deal } from '../../core/deal';
import { fetchOfertas } from './ofertas';

/**
 * Provider Mercado Livre.
 *
 * Sourcing: scraping da página pública de ofertas (ver ./ofertas.ts) - a API
 * oficial de busca foi restringida (403). Não precisa de OAuth: a página é
 * aberta e o link de afiliado é montado só com matt_word/matt_tool.
 *
 * (O fluxo OAuth em ./oauth.ts + cli/ml-auth.ts fica disponível caso o ML
 * volte a exigir token para alguma rota, mas hoje não é usado.)
 */

export const name = 'mercadolivre';

export async function fetchDeals(): Promise<Deal[]> {
  if (!config.mercadoLivre.enabled) {
    logger.warn('[ML] ML_ENABLED=false - pulando Mercado Livre.');
    return [];
  }

  const { minDiscountPercent } = config.mercadoLivre;
  const all = await fetchOfertas();
  const deals = all.filter((d) => d.discountPercent >= minDiscountPercent);

  logger.info(
    { total: all.length, acima: deals.length, minDiscountPercent },
    '[ML] Ofertas filtradas por desconto mínimo.'
  );
  return deals;
}
