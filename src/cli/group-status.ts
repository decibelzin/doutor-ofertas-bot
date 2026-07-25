/**
 * Atualiza o JSON de status dos grupos que o SITE lê (contagem + link de
 * convite + qual grupo tem vaga).
 *
 *   npm run group-status
 *
 * No bot rodando (`npm run start`) isso já acontece sozinho a cada
 * SITE_REFRESH_MINUTES. Este comando é pra rodar na mão / testar.
 * Requer o bot ser ADMIN dos grupos (pra obter o link de convite).
 */
import { connectWhatsApp, whenReady } from '../whatsapp/client';
import { refreshGroupStatus } from '../core/group-status';
import { logger } from '../logger';

async function main(): Promise<void> {
  await connectWhatsApp();
  const sock = await whenReady();
  const data = await refreshGroupStatus(sock);
  if (!data) process.exit(1);

  console.log(`\n===== GRUPOS (limite operacional: ${data.limit}) =====`);
  for (const g of data.groups) {
    const status = g.full ? 'LOTADO' : `${g.vacancies} vagas`;
    console.log(`  ${g.name.padEnd(28).slice(0, 28)} ${String(g.members).padStart(5)} membros  ${status.padEnd(12)} ${g.link ?? '⚠️ sem link (bot é admin?)'}`);
  }
  console.log(`\n  total: ${data.totalMembers} membros`);
  console.log(`  botão do site aponta pra: ${data.join ?? '⚠️ NENHUM grupo com vaga+link'}`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[group-status] Erro fatal.');
  process.exit(1);
});
