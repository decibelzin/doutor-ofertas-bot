import { config } from '../../config';
import { logger } from '../../logger';

let warnedNoTag = false;

/**
 * Monta o link de afiliado do Mercado Livre.
 *
 * O ML não tem API oficial de geração de link; o método determinístico usado
 * pela comunidade é anexar a sua "etiqueta" de afiliado na URL do produto:
 *   - modo 'matt' (padrão): ?matt_word=<tag>&matt_tool=<tool>
 *   - modo 'simple': ?forceInApp=true (fallback) + tag única
 *
 * Você pega matt_word/matt_tool UMA vez na Central de Afiliados: gere qualquer
 * link lá e leia esses dois parâmetros na URL resultante. Não são segredo.
 *
 * ATENÇÃO: se não houver tag configurada, devolve o link cru - o produto será
 * postável, mas SEM comissão. Verifique a atribuição no painel após o 1º teste.
 */
export function buildAffiliateUrl(permalink: string): string {
  const { linkMode, mattWord, mattTool, simpleTag } = config.mercadoLivre;

  let url: URL;
  try {
    url = new URL(permalink);
  } catch {
    return permalink;
  }

  if (linkMode === 'matt' && mattWord) {
    url.searchParams.set('matt_word', mattWord);
    if (mattTool) url.searchParams.set('matt_tool', mattTool);
    return url.toString();
  }

  if (simpleTag) {
    url.searchParams.set('matt_word', simpleTag);
    return url.toString();
  }

  if (!warnedNoTag) {
    warnedNoTag = true;
    logger.warn(
      '[ML] Sem tag de afiliado (ML_MATT_WORD/ML_MATT_TOOL) - links sairão SEM comissão. ' +
        'Pegue os valores na Central de Afiliados e coloque no .env.'
    );
  }
  return permalink;
}
