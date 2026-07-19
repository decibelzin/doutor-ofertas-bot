/**
 * Entry point. Fase 1 (só WhatsApp): conecta e mantém a sessão viva.
 * O agendamento de ofertas e os providers entram nas próximas fases.
 */
import { connectWhatsApp, whenReady } from './whatsapp/client';
import { logger } from './logger';

async function main(): Promise<void> {
  logger.info('Iniciando doutor-ofertas-bot (Fase 1: WhatsApp)...');
  await connectWhatsApp();
  await whenReady();
  logger.info('Bot conectado e em execução. (Agendador de ofertas: próxima fase.)');
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, 'Erro fatal ao iniciar o bot.');
  process.exit(1);
});
