/**
 * DESCOBERTA DE CUPONS DE PERFUMARIA → cache em disco (wrapper de CLI).
 *
 *   npm run discover-coupons              # varre a lista toda (~507 págs) e descobre
 *   npm run discover-coupons -- 40        # varre só as primeiras 40 páginas (teste)
 *
 * Lógica em src/core/coupon-runner.ts (compartilhada com o scheduler live).
 */
import { logger } from '../logger';
import { couponsEnabled } from '../providers/mercadolivre/coupons';
import { refreshCouponCache, loadCouponCache, DEFAULT_MAX_PAGES } from '../core/coupon-runner';

async function main(): Promise<void> {
  if (!couponsEnabled()) {
    logger.error('[discover] ML_AFFILIATE_COOKIE / ML_AFFILIATE_CSRF ausentes no .env.');
    process.exit(1);
  }
  const maxPages = Number(process.argv[2] ?? DEFAULT_MAX_PAGES) || DEFAULT_MAX_PAGES;

  logger.info({ maxPages }, '[discover] Varrendo a lista de cupons...');
  let lastLog = 0;
  let logged = 0;
  const result = await refreshCouponCache({
    maxPages,
    onPage: (s) => {
      if (s.lastPage - lastLog >= 10) {
        lastLog = s.lastPage;
        logger.info({ pagina: s.lastPage, cupons: s.coupons.length, total: s.totalItems }, '[discover] ...varrendo');
      }
    },
    onCandidate: (info) => {
      logged += 1;
      logger.info(
        { seller: info.seller, cupom: info.couponId, perfume: info.perfumeCount, total: info.total, mantido: info.kept },
        `[discover] candidato ${logged}`
      );
    },
  });

  if (!result.written) {
    logger.error({ ...result }, '[discover] Cache NÃO gravado (degradado/auth) - cache anterior preservado.');
    process.exit(1);
  }
  logger.info(
    { cuponsPerfume: result.count, candidatos: result.candidates, erros: result.errors },
    '[discover] Cache de cupons de perfumaria gravado.'
  );

  const cache = loadCouponCache();
  console.log('\n===== CUPONS DE PERFUMARIA DESCOBERTOS =====');
  for (const c of cache?.coupons ?? []) {
    console.log(
      `${c.title.padEnd(10)} ${c.seller.padEnd(24)} perfumes=${c.perfumeCount}/${c.totalProducts} exp=${c.expiration.slice(0, 10)} (cupom ${c.couponId})`
    );
    for (const p of c.products.slice(0, 3)) console.log(`    - ${p.title.slice(0, 60)}`);
  }
  if ((cache?.coupons?.length ?? 0) === 0) console.log('(nenhum - tente aumentar o range de páginas ou revisar a watchlist)');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[discover] Erro fatal.');
  process.exit(1);
});
