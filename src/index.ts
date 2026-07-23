/**
 * Entry point do bot. Conecta no WhatsApp e inicia o agendador, que a cada
 * ~POST_INTERVAL_MINUTES (com jitter) posta a próxima oferta nos grupos,
 * dentro da janela de horário.
 */
import { connectWhatsApp, whenReady } from './whatsapp/client';
import { startScheduler } from './scheduler';
import { logger } from './logger';

// Rede de segurança do processo always-on: uma promise rejeitada solta (ex.: um
// handler de evento do Baileys) derrubaria o Node inteiro. Aqui a gente LOGA e:
//  - unhandledRejection: segue rodando (quase sempre é falha transitória de I/O);
//  - uncaughtException: estado indefinido -> sai(1) pra o supervisor reiniciar limpo
//    (use start-forever.bat / NSSM / pm2 pra reiniciar automaticamente).
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason instanceof Error ? reason.message : reason }, '[Processo] unhandledRejection — seguindo.');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, '[Processo] uncaughtException — saindo pra reiniciar limpo.');
  process.exit(1);
});

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
