/**
 * Envia uma mensagem de teste para o(s) grupo(s), pra provar que o envio
 * funciona (com o throttle anti-ban entre grupos).
 *
 *   npm run send-test                    # usa WHATSAPP_GROUP_IDS do .env
 *   npm run send-test -- 12036...@g.us   # envia para um grupo específico
 */
import { connectWhatsApp, whenReady } from '../whatsapp/client';
import { broadcast } from '../whatsapp/sender';
import { config } from '../config';
import { logger } from '../logger';

const SAMPLE = [
  '🔥 TESTE — Fone Bluetooth JBL Tune 510BT',
  '❌ De R$ 299,90',
  '✅ Por R$ 179,90',
  '📉 40% OFF',
  '➡️ https://exemplo.com/oferta-teste',
  '',
  '_(mensagem de teste do doutor-ofertas-bot)_',
].join('\n');

async function main(): Promise<void> {
  const argGroup = process.argv[2];
  const groupIds = argGroup ? [argGroup] : config.whatsapp.groupIds;

  if (groupIds.length === 0) {
    logger.error(
      'Nenhum grupo definido. Passe um ID como argumento ou preencha WHATSAPP_GROUP_IDS no .env ' +
        '(use "npm run list-groups" para descobrir os IDs).'
    );
    process.exit(1);
  }

  await connectWhatsApp();
  const sock = await whenReady();

  logger.info({ groupIds }, '[send-test] Enviando mensagem de teste...');
  const ok = await broadcast(sock, groupIds, SAMPLE);
  logger.info({ enviados: ok.length, total: groupIds.length }, '[send-test] Concluído.');

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[send-test] Erro fatal.');
  process.exit(1);
});
