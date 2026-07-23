/**
 * Posta PERFUME + CUPOM AUTOMÁTICO ("desconto duplo") a partir do cache
 * (wrapper de CLI). Post normal (foto + legenda premium), SEM @all.
 *
 *   npm run post-perfume-coupon                 # melhor perfume ainda não postado
 *   npm run post-perfume-coupon -- 13283171     # de um cupom específico
 *   npm run post-perfume-coupon -- --dry        # preview no console (não envia)
 *   npm run post-perfume-coupon -- 13283171 --dry
 *
 * Lógica em src/core/coupon-runner.ts (compartilhada com o scheduler live).
 */
import { logger } from '../logger';
import { connectWhatsApp, whenReady } from '../whatsapp/client';
import { runCouponPost } from '../core/coupon-runner';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const idArg = args.find((a) => /^\d+$/.test(a));
  const couponId = idArg ? Number(idArg) : null;

  if (dry) {
    const r = await runCouponPost(null, { couponId, dry: true });
    if (!r) {
      logger.warn('[post-perfume] Nada postável.');
      process.exit(0);
    }
    console.log('----- PREVIEW (não enviado) -----');
    console.log(`cupom ${r.coupon.couponId} | ${r.coupon.seller} | ${r.coupon.title}`);
    console.log(`grupos-alvo: ${r.groups.length}`);
    console.log('---------------------------------');
    console.log(r.text);
    console.log('---------------------------------');
    console.log(`imagem do produto: ${r.deal.imageUrl ?? '(sem)'}`);
    process.exit(0);
  }

  await connectWhatsApp();
  const sock = await whenReady();
  const r = await runCouponPost(sock, { couponId });
  if (!r) {
    logger.warn('[post-perfume] Nada postável (cache vazio, cooldown, ou expirado).');
    process.exit(0);
  }
  logger.info(
    { enviados: r.posted, total: r.groups.length, cupom: r.coupon.couponId, produto: r.deal.title },
    '[post-perfume] Concluído.'
  );
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[post-perfume] Erro fatal.');
  process.exit(1);
});
