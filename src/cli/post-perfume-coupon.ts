/**
 * Posta PERFUME + CUPOM AUTOMÁTICO ("desconto duplo") a partir do cache gerado
 * por `discover-coupons`. Post normal (foto + legenda premium), SEM @all — igual
 * aos canais de referência.
 *
 *   npm run post-perfume-coupon                 # melhor perfume ainda não postado
 *   npm run post-perfume-coupon -- 13283171     # de um cupom específico
 *   npm run post-perfume-coupon -- --dry        # preview no console (não envia)
 *   npm run post-perfume-coupon -- 13283171 --dry
 *
 * Dedup: não reposta o mesmo produto dentro do cooldown (DEDUP_COOLDOWN_DAYS).
 * Cupom expirado é ignorado. Sem cupom postável → sai sem enviar nada.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { config } from '../config';
import { logger } from '../logger';
import { store } from '../core/store';
import { loadNiches } from '../core/niches';
import { connectWhatsApp, whenReady } from '../whatsapp/client';
import { sendToGroup, fetchDealImage } from '../whatsapp/sender';
import { enrichWithShortLink } from '../providers/mercadolivre/shortlink';
import { formatPerfumeCoupon } from '../format/coupon';
import { resolvePreset } from '../format/title';
import { sleep, randomDelay } from '../util/time';
import type { Deal } from '../core/deal';
import type { PerfumeCoupon } from '../providers/mercadolivre/coupons';

const CACHE_FILE = path.resolve('data/perfume-coupons.json');
const DAY_MS = 24 * 60 * 60 * 1000;

interface CacheFile {
  generatedAt: string;
  coupons: PerfumeCoupon[];
}

function loadCache(): CacheFile {
  let raw: string;
  try {
    raw = fs.readFileSync(CACHE_FILE, 'utf8');
  } catch {
    logger.error({ file: CACHE_FILE }, '[post-perfume] Cache não encontrado — rode `npm run discover-coupons` antes.');
    process.exit(1);
  }
  try {
    return JSON.parse(raw) as CacheFile;
  } catch {
    // Arquivo existe mas não parseia: escrita concorrente do discover ou corrupção.
    logger.error({ file: CACHE_FILE }, '[post-perfume] Cache ilegível (parcial/corrompido) — rode discover-coupons de novo.');
    process.exit(1);
  }
}

/** O ML manda expiração como timestamp INGÊNUO em UTC — parseia como UTC. */
function notExpired(c: PerfumeCoupon): boolean {
  const exp = DateTime.fromISO(c.expiration, { zone: 'utc' });
  return !exp.isValid || exp > DateTime.now();
}

/** Grupos-alvo: nichos cujo nome sugere perfume; senão, todos os grupos. */
function targetGroups(): string[] {
  const niches = loadNiches();
  const perfumeNiches = niches.filter((n) => /perfum|fragr/i.test(n.name));
  const chosen = perfumeNiches.length ? perfumeNiches : niches;
  return [...new Set(chosen.flatMap((n) => n.groups))];
}

/**
 * Escolhe (cupom, produto) pra postar: dentre os cupons válidos (opcionalmente
 * filtrados por `couponId`), o produto-perfume de maior desconto ainda não
 * postado no cooldown. Prioriza cupom de maior %.
 */
function pick(
  cache: CacheFile,
  couponId: number | null
): { coupon: PerfumeCoupon; deal: Deal } | null {
  const cooldownMs = config.dedup.cooldownDays * DAY_MS;
  const coupons = cache.coupons
    .filter(notExpired)
    .filter((c) => couponId === null || c.couponId === couponId)
    .sort((a, b) => (b.discountPercent ?? 0) - (a.discountPercent ?? 0));

  for (const coupon of coupons) {
    const products = [...coupon.products]
      .filter((d) => !store.wasPostedRecently(d.id, cooldownMs))
      .sort((a, b) => (b.discountPercent ?? 0) - (a.discountPercent ?? 0));
    if (products.length > 0) return { coupon, deal: products[0]! };
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const idArg = args.find((a) => /^\d+$/.test(a));
  const couponId = idArg ? Number(idArg) : null;

  const cache = loadCache();
  logger.info(
    { cupons: cache.coupons.length, geradoEm: cache.generatedAt },
    '[post-perfume] Cache carregado.'
  );

  const chosen = pick(cache, couponId);
  if (!chosen) {
    logger.warn('[post-perfume] Nenhum perfume postável (cache vazio, tudo no cooldown, ou cupom expirado).');
    process.exit(0);
  }
  const { coupon, deal } = chosen;

  // Link curto oficial (meli.la); se falhar, mantém o matt que já veio no deal.
  await enrichWithShortLink(deal);

  const text = formatPerfumeCoupon(deal, coupon);
  const preset = resolvePreset(deal.title, deal.id);

  if (dry) {
    console.log('----- PREVIEW (não enviado) -----');
    console.log(`cupom ${coupon.couponId} | ${coupon.seller} | ${coupon.title}`);
    console.log('---------------------------------');
    console.log(text);
    console.log('---------------------------------');
    console.log(`imagem do produto: ${deal.imageUrl ?? '(sem)'}`);
    process.exit(0);
  }

  const groups = targetGroups();
  if (groups.length === 0) {
    logger.error('[post-perfume] Nenhum grupo configurado (config/niches.json).');
    process.exit(1);
  }

  const image = await fetchDealImage(deal, preset?.imagem);
  await connectWhatsApp();
  const sock = await whenReady();

  logger.info(
    { cupom: coupon.couponId, produto: deal.title, grupos: groups.length },
    '[post-perfume] Postando perfume + cupom automático...'
  );
  let ok = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const groupId = groups[i]!;
    try {
      await sendToGroup(sock, groupId, text, image);
      store.markPosted(deal, groupId);
      ok += 1;
      logger.info({ groupId, produto: deal.title }, '[post-perfume] Enviado.');
    } catch (err) {
      logger.error({ err: (err as Error).message, groupId }, '[post-perfume] Falha ao enviar.');
    }
    if (i < groups.length - 1) {
      await sleep(randomDelay(config.throttle.groupDelayMinMs, config.throttle.groupDelayMaxMs));
    }
  }
  logger.info({ enviados: ok, total: groups.length }, '[post-perfume] Concluído.');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[post-perfume] Erro fatal.');
  process.exit(1);
});
