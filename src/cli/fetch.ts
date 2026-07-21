/**
 * Teste: busca ofertas reais dos providers ativos e imprime JÁ FORMATADAS como
 * sairiam no WhatsApp — SEM conectar no WhatsApp e SEM postar nada.
 *
 *   npm run fetch        # 10 melhores
 *   npm run fetch 5      # 5 melhores
 *
 * Serve pra validar credenciais e ver a cara das mensagens (e conferir se o
 * link de afiliado saiu certo) antes de ligar o envio.
 */
import { logger } from '../logger';
import { collectRankedDeals, enabledProviders } from '../core/selector';
import { formatDeal } from '../format/whatsapp';

async function main(): Promise<void> {
  const topN = Number(process.argv[2] ?? 10);

  const providers = enabledProviders().map((p) => p.name);
  if (providers.length === 0) {
    logger.error(
      'Nenhum provider ativo. Para o Mercado Livre: ML_ENABLED=true no .env e rode "npm run ml-auth".'
    );
    process.exit(1);
  }
  logger.info({ providers }, 'Providers ativos');

  const deals = await collectRankedDeals();
  if (deals.length === 0) {
    logger.warn(
      'Nenhuma oferta acima do desconto mínimo. Tente baixar ML_MIN_DISCOUNT_PERCENT ou mudar ML_SEARCH_TERMS.'
    );
    process.exit(0);
  }

  logger.info({ total: deals.length, mostrando: Math.min(topN, deals.length) }, 'Ofertas encontradas');

  deals.slice(0, topN).forEach((deal, i) => {
    process.stdout.write(
      `\n──────── #${i + 1} · ${deal.store} · ${deal.discountPercent}% OFF ────────\n` +
        `${formatDeal(deal, { variant: i })}\n`
    );
  });
  process.stdout.write('\n');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, 'Erro no fetch de teste');
  process.exit(1);
});
