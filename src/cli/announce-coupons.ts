/**
 * Anuncia os cupons com CÓDIGO vigentes ("CUPOM LIBERADO": banner + lista de
 * códigos + @all), no formato dos canais concorrentes.
 *
 *   npm run announce-coupons -- --dry     # prévia no console (não envia)
 *   npm run announce-coupons              # envia SE houver código novo
 *   npm run announce-coupons -- --force   # envia mesmo sem código novo
 *
 * No bot rodando (`npm run start`) isso já acontece SOZINHO quando surge um
 * código novo — este comando é pra testar ou forçar na mão.
 */
import { logger } from '../logger';
import { connectWhatsApp, whenReady } from '../whatsapp/client';
import { announceNewCoupons } from '../core/coupon-announcer';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const force = args.includes('--force');

  if (dry) {
    const r = await announceNewCoupons(null, { dry: true, force: true });
    if (!r) {
      console.log('Nenhum cupom com código vigente no momento.');
      process.exit(0);
    }
    console.log('----- PREVIEW (não enviado) -----');
    console.log(`códigos novos: ${r.newCodes.join(', ') || '(nenhum novo — todos já anunciados)'}`);
    console.log(`grupos-alvo: ${r.groups.length}`);
    console.log('---------------------------------');
    console.log(r.text);
    console.log('---------------------------------');
    process.exit(0);
  }

  await connectWhatsApp();
  const sock = await whenReady();
  const r = await announceNewCoupons(sock, { force });
  if (!r) {
    logger.info('[anúncio] Nada a anunciar (sem código novo ou dentro do intervalo mínimo). Use --force pra forçar.');
    process.exit(0);
  }
  logger.info({ novos: r.newCodes, enviados: r.posted, total: r.groups.length }, '[anúncio] Concluído.');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[anúncio] Erro fatal.');
  process.exit(1);
});
