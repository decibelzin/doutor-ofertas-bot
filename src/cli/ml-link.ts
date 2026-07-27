/**
 * Testa a geração do link curto (meli.la) do Mercado Livre - isolado, sem
 * WhatsApp. Prova que seu cookie/csrf estão válidos e o endpoint responde.
 *
 *   npm run ml-link -- https://www.mercadolivre.com.br/.../p/MLB123456
 */
import { generateShortLink, shortLinkEnabled } from '../providers/mercadolivre/shortlink';
import { logger } from '../logger';

async function main(): Promise<void> {
  if (!shortLinkEnabled()) {
    logger.error('Faltam ML_AFFILIATE_COOKIE e/ou ML_AFFILIATE_CSRF no .env.');
    process.exit(1);
  }

  const url = process.argv[2];
  if (!url) {
    logger.error('Uso: npm run ml-link -- <url-do-produto-do-ML>');
    process.exit(1);
  }

  const match = url.match(/(MLB\d+)/);
  if (!match) {
    logger.error('Não achei o ID (MLBxxxx) na URL. Cole a URL /p/MLB... do produto.');
    process.exit(1);
  }
  const itemId = match[1]!;

  logger.info({ itemId }, 'Gerando link curto...');
  const short = await generateShortLink(itemId, url);
  if (short) {
    logger.info({ short }, '✅ Link curto gerado com sucesso!');
    process.exit(0);
  } else {
    logger.error('❌ Não gerou (cookie/csrf expirado ou erro). Veja o aviso acima.');
    process.exit(1);
  }
}

main();
