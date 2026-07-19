/**
 * Conecta ao WhatsApp e mantém a sessão aberta. Rode isto UMA VEZ para
 * escanear o QR (a sessão fica salva em SESSION_DIR). Depois disso os outros
 * comandos reaproveitam a sessão sem pedir QR de novo.
 *
 *   npm run connect
 */
import { connectWhatsApp, whenReady } from '../whatsapp/client';
import { logger } from '../logger';

async function main(): Promise<void> {
  logger.info('[connect] Iniciando conexão com o WhatsApp...');
  await connectWhatsApp();
  await whenReady();
  logger.info('[connect] Pronto! Sessão salva. Pode encerrar com Ctrl+C ou deixar rodando.');
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[connect] Erro fatal.');
  process.exit(1);
});
