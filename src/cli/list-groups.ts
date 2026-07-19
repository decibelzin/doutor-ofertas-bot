/**
 * Lista os grupos em que o número do bot participa, com o ID de cada um.
 * Copie o(s) ID(s) que terminam em "@g.us" para WHATSAPP_GROUP_IDS no .env.
 *
 *   npm run list-groups
 */
import { connectWhatsApp, whenReady } from '../whatsapp/client';
import { listGroups } from '../whatsapp/sender';
import { logger } from '../logger';

async function main(): Promise<void> {
  await connectWhatsApp();
  const sock = await whenReady();

  const groups = await listGroups(sock);
  if (groups.length === 0) {
    logger.warn('Nenhum grupo encontrado. O número do bot precisa estar em pelo menos um grupo.');
  } else {
    process.stdout.write(`\n${groups.length} grupo(s) encontrado(s):\n\n`);
    for (const g of groups) {
      process.stdout.write(`  ${g.subject}  (${g.size} membros)\n    ${g.id}\n\n`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[list-groups] Erro fatal.');
  process.exit(1);
});
