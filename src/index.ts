/**
 * Entry point do bot. Conecta no WhatsApp e inicia o agendador, que a cada
 * ~POST_INTERVAL_MINUTES (com jitter) posta a próxima oferta nos grupos,
 * dentro da janela de horário.
 */
import { connectWhatsApp, whenReady } from './whatsapp/client';
import { startScheduler } from './scheduler';
import { logger } from './logger';

async function main(): Promise<void> {
  logger.info('Iniciando doutor-ofertas-bot...');
  await connectWhatsApp();
  await whenReady();
  logger.info('WhatsApp conectado. Iniciando agendador de ofertas.');
  startScheduler();
  logger.info('Bot em execução. Ctrl+C para encerrar.');
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, 'Erro fatal ao iniciar o bot.');
  process.exit(1);
});
