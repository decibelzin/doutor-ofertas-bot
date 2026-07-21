/**
 * Posta UMA oferta real agora, ignorando a janela de horário — pra você ver a
 * mensagem chegando no grupo sem esperar o agendador.
 *
 *   npm run post-now
 */
import { connectWhatsApp, whenReady } from '../whatsapp/client';
import { postOneDeal } from '../scheduler';
import { logger } from '../logger';

async function main(): Promise<void> {
  await connectWhatsApp();
  await whenReady();
  logger.info('[post-now] Postando uma oferta agora...');
  await postOneDeal({ ignoreWindow: true });
  logger.info('[post-now] Concluído.');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[post-now] Erro fatal.');
  process.exit(1);
});
