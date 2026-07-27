/**
 * Lista o LINK DE CONVITE de cada grupo configurado - é o que vai no site
 * (botão "Entrar no grupo").
 *
 *   npm run group-links
 *
 * Requer que a conta do bot seja ADMIN do grupo (só admin pode ver/gerar o
 * convite). Grupo sem permissão aparece com o motivo.
 */
import { connectWhatsApp, whenReady } from '../whatsapp/client';
import { loadNiches } from '../core/niches';
import { logger } from '../logger';

async function main(): Promise<void> {
  const niches = loadNiches();
  if (niches.length === 0) {
    logger.error('[group-links] Nenhum nicho/grupo em config/niches.json.');
    process.exit(1);
  }

  await connectWhatsApp();
  const sock = await whenReady();

  for (const niche of niches) {
    console.log(`\n===== ${niche.name.toUpperCase()} (${niche.groups.length} grupos) =====`);
    for (const groupId of niche.groups) {
      let nome = groupId;
      try {
        nome = (await sock.groupMetadata(groupId)).subject ?? groupId;
      } catch {
        /* sem metadata - segue com o id */
      }
      try {
        const code = await sock.groupInviteCode(groupId);
        console.log(`\n  ${nome}`);
        console.log(`  https://chat.whatsapp.com/${code}`);
      } catch (err) {
        const msg = (err as Error).message;
        console.log(`\n  ${nome}`);
        console.log(`  ⚠️ não consegui o convite (${msg}) - o bot precisa ser ADMIN do grupo.`);
      }
    }
  }
  console.log('\nCole o link escolhido no href do botão em website/index.html.\n');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[group-links] Erro fatal.');
  process.exit(1);
});
