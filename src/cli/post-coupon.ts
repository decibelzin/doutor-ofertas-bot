/**
 * Posta um CUPOM RELÂMPAGO em todos os grupos dos nichos, mencionando @all
 * (notifica todo mundo) — igual os canais concorrentes fazem pra reengajar.
 *
 * Use com MODERAÇÃO (1x por período): @all frequente irrita e arrisca ban.
 *
 *   npm run post-coupon -- TAMOJUNTO "15% OFF acima de R$ 79, teto R$ 60"
 *
 * Banner fixo opcional via COUPON_BANNER_PATH; link no rodapé via COUPON_SEARCH_LINK.
 */
import fs from 'node:fs';
import { connectWhatsApp, whenReady } from '../whatsapp/client';
import { broadcastCoupon } from '../whatsapp/sender';
import { loadNiches } from '../core/niches';
import { config } from '../config';
import { logger } from '../logger';

function formatCoupon(code: string, desc: string): string {
  const blocks = ['⚡ *CUPOM RELÂMPAGO*'];
  if (desc) blocks.push(`🎟️ ${desc}`);
  blocks.push(`Código: *${code}*`);
  blocks.push('Vale nas ofertas que já mandamos aqui!!! 🔥 @all');
  if (config.coupon.searchLink) blocks.push(`🛒 ${config.coupon.searchLink}`);
  return blocks.join('\n\n');
}

async function main(): Promise<void> {
  const code = process.argv[2];
  const desc = process.argv[3] ?? '';
  if (!code) {
    logger.error('Uso: npm run post-coupon -- CODIGO "descrição opcional"');
    process.exit(1);
  }

  const groups = [...new Set(loadNiches().flatMap((n) => n.groups))];
  if (groups.length === 0) {
    logger.error('Nenhum grupo configurado (config/niches.json).');
    process.exit(1);
  }

  let banner: Buffer | null = null;
  if (config.coupon.bannerPath && fs.existsSync(config.coupon.bannerPath)) {
    banner = fs.readFileSync(config.coupon.bannerPath);
  } else if (config.coupon.bannerPath) {
    logger.warn({ path: config.coupon.bannerPath }, '[post-coupon] Banner não encontrado — enviando só texto.');
  }

  await connectWhatsApp();
  const sock = await whenReady();
  const text = formatCoupon(code, desc);
  logger.info({ code, grupos: groups.length, banner: Boolean(banner) }, '[post-coupon] Enviando cupom com @all...');
  const ok = await broadcastCoupon(sock, groups, text, banner);
  logger.info({ enviados: ok.length, total: groups.length }, '[post-coupon] Concluído.');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[post-coupon] Erro fatal.');
  process.exit(1);
});
