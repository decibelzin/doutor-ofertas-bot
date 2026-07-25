/**
 * Lista os CUPONS PÚBLICOS do ML que incluem PERFUME (os mesmos que os canais
 * concorrentes postam como "CUPOM RELÂMPAGO").
 *
 *   npm run public-coupons          # lista os cupons de perfumaria vigentes
 *
 * São cupons do próprio Mercado Livre (não da nossa conta de afiliado): valem
 * pra qualquer comprador, ativados na página/app do ML. Descoberta automática —
 * sem código fixo no bot.
 */
import { logger } from '../logger';
import {
  fetchPublicPerfumeCoupons,
  fetchSpecialCoupons,
  publicCouponsEnabled,
} from '../providers/mercadolivre/public-coupons';

async function main(): Promise<void> {
  if (!publicCouponsEnabled()) {
    logger.error('[cupons-públicos] ML_AFFILIATE_COOKIE ausente no .env (a página exige sessão).');
    process.exit(1);
  }

  // 1) Cupons com CÓDIGO DIGITÁVEL (o "cupom relâmpago" dos concorrentes).
  const special = await fetchSpecialCoupons({ ttlMs: 0 });
  console.log(`\n===== CUPONS COM CÓDIGO (${special.length}) =====`);
  for (const c of special) {
    console.log(`\n🎟️  *${c.code}*  — ${c.title}`);
    const cond = [c.minAmountText, c.capAmountText].filter(Boolean).join(' · ');
    if (cond) console.log(`    ${cond}`);
    if (c.expirationText) console.log(`    ⏳ ${c.expirationText}`);
    if (c.productsUrl) console.log(`    produtos: ${c.productsUrl.slice(0, 80)}`);
  }
  if (special.length === 0) console.log('(nenhum no momento)');

  // 2) Cupons de ativar por clique que incluem perfume.
  const coupons = await fetchPublicPerfumeCoupons({ ttlMs: 0 }); // sempre fresco no CLI
  if (coupons.length === 0) {
    console.log('\nNenhum cupom público (de ativar) com perfume no momento.');
    process.exit(0);
  }

  console.log(`\n===== CUPONS PÚBLICOS COM PERFUME (${coupons.length}) =====`);
  for (const c of coupons) {
    console.log(`\n🎟️  ${c.title}`);
    const cond = [c.minAmountText, c.capAmountText].filter(Boolean).join(' · ');
    if (cond) console.log(`    ${cond}`);
    if (c.expirationText) console.log(`    ⏳ ${c.expirationText}`);
    console.log(`    ativação: ${c.activationType ?? '-'} | campanha ${c.campaignId}`);
    console.log(`    perfumes elegíveis (${c.perfumeItems.length}):`);
    for (const i of c.perfumeItems.slice(0, 5)) console.log(`      - ${i.altText.slice(0, 60)}`);
  }
  console.log(
    '\nDica: pra anunciar, use `npm run post-coupon -- "<código/nome>" "<descrição>"` ' +
      '(o código o cliente pega ao ativar o cupom na página do ML).'
  );
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[cupons-públicos] Erro fatal.');
  process.exit(1);
});
