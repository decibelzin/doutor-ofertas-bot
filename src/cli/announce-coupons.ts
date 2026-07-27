/**
 * Anuncia os cupons com CÓDIGO vigentes ("CUPOM LIBERADO": banner + lista de
 * códigos + @all), no formato dos canais concorrentes.
 *
 *   npm run announce-coupons -- --dry     # prévia no console (não envia)
 *   npm run announce-coupons              # envia SE houver código novo
 *   npm run announce-coupons -- --force   # envia mesmo sem código novo
 *
 * No bot rodando (`npm run start`) isso já acontece SOZINHO quando surge um
 * código novo - este comando é pra testar ou forçar na mão.
 */
import fs from 'node:fs';
import { logger } from '../logger';
import { config } from '../config';
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
    console.log(`códigos novos: ${r.newCodes.join(', ') || '(nenhum novo - todos já anunciados)'}`);
    console.log(`grupos-alvo: ${r.groups.length}`);
    // Banner: confirma se a imagem vai junto (o anúncio fica bem melhor com ela).
    const bp = config.coupon.bannerPath;
    if (!bp) {
      console.log('banner: (COUPON_BANNER_PATH não configurado - sai só texto)');
    } else if (fs.existsSync(bp)) {
      console.log(`banner: ✅ ${bp} (${Math.round(fs.statSync(bp).size / 1024)} KB)`);
    } else {
      console.log(`banner: ❌ NÃO encontrado em ${bp} - salve a imagem aí pra sair com foto`);
    }
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
