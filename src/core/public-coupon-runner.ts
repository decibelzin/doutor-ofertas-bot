import type { WASocket } from '@whiskeysockets/baileys';
import { config } from '../config';
import { logger } from '../logger';
import { store } from './store';
import { couponTargetGroups } from './coupon-runner';
import { collectNicheDeals } from './selector';
import { loadNiches } from './niches';
import { sendToGroup, fetchDealImage } from '../whatsapp/sender';
import { enrichWithShortLink } from '../providers/mercadolivre/shortlink';
import { formatPublicCouponPost, formatCodeCouponPost } from '../format/coupon';
import { resolvePreset } from '../format/title';
import { isPerfumeProduct, scrapeCouponProducts } from '../providers/mercadolivre/coupons';
import {
  fetchPublicPerfumeCoupons,
  fetchSpecialCoupons,
  type PublicCoupon,
  type SpecialCoupon,
} from '../providers/mercadolivre/public-coupons';
import { sleep, randomDelay } from '../util/time';
import type { Deal } from './deal';

/**
 * Posta PERFUME + CUPOM PÚBLICO do ML (o "cupom relâmpago" que os concorrentes
 * mandam). O cupom é do próprio ML (vale pra qualquer comprador) e o cliente o
 * ATIVA no app/site — por isso a mensagem manda ativar, sem prometer preço final.
 *
 * Casamento cupom → produto:
 *  1º por ID elegível (itemIds do cupom) presente no nosso pool — casamento exato;
 *  2º senão, pelo título do perfume elegível (o card do cupom traz alt_text).
 * Sem produto casado no pool, não posta (não anuncia o que não temos link).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PublicCouponPostResult {
  coupon: PublicCoupon;
  deal: Deal;
  text: string;
  groups: string[];
  posted: number;
  dry: boolean;
}

/** Tokens significativos do título (pra casar por nome quando não há id). */
function tokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
}

/** Escolhe (cupom público, produto do pool) pra postar, ou null. */
export async function pickPublicCouponDeal(): Promise<{ coupon: PublicCoupon; deal: Deal } | null> {
  const coupons = await fetchPublicPerfumeCoupons();
  if (coupons.length === 0) return null;

  const niches = loadNiches().filter((n) => /perfum|fragr/i.test(n.name));
  const niche = niches[0] ?? loadNiches()[0];
  if (!niche) return null;

  const pool = (await collectNicheDeals(niche)).filter((d) => isPerfumeProduct(d.title));
  if (pool.length === 0) return null;

  const cooldownMs = config.dedup.cooldownDays * DAY_MS;
  const postable = (d: Deal): boolean => store.canPostNow(d.id, d.discountPercent, cooldownMs);

  for (const coupon of coupons) {
    // 1) Casamento EXATO por id elegível.
    const ids = new Set(coupon.itemIds.map((i) => `mercadolivre:${i}`));
    const byId = pool.filter((d) => ids.has(d.id) && postable(d));
    if (byId.length > 0) {
      byId.sort((a, b) => b.discountPercent - a.discountPercent);
      return { coupon, deal: byId[0]! };
    }

    // 2) Casamento por TÍTULO do perfume elegível (≥3 tokens em comum).
    for (const item of coupon.perfumeItems) {
      const want = new Set(tokens(item.altText));
      if (want.size === 0) continue;
      const matches = pool
        .filter(postable)
        .map((d) => ({ d, score: tokens(d.title).filter((t) => want.has(t)).length }))
        .filter((x) => x.score >= 3)
        .sort((a, b) => b.score - a.score || b.d.discountPercent - a.d.discountPercent);
      if (matches.length > 0) return { coupon, deal: matches[0]!.d };
    }
  }
  return null;
}

export interface CodeCouponPostResult {
  coupon: SpecialCoupon;
  deal: Deal;
  text: string;
  groups: string[];
  posted: number;
  dry: boolean;
}

/**
 * Escolhe (cupom COM CÓDIGO, perfume elegível) — o formato "cupom relâmpago"
 * dos concorrentes. Raspa a listing de elegíveis do cupom e fica com o perfume
 * de maior desconto ainda postável.
 */
export async function pickCodeCouponDeal(): Promise<{ coupon: SpecialCoupon; deal: Deal } | null> {
  const coupons = await fetchSpecialCoupons();
  if (coupons.length === 0) return null;

  const cooldownMs = config.dedup.cooldownDays * DAY_MS;
  for (const coupon of coupons) {
    if (!coupon.productsUrl) continue;
    let products: Deal[];
    try {
      products = await scrapeCouponProducts(coupon.productsUrl);
    } catch (err) {
      logger.debug({ err: (err as Error).message, cupom: coupon.code }, '[cupom-código] Falha ao raspar elegíveis.');
      continue;
    }
    const perfumes = products
      .filter((d) => isPerfumeProduct(d.title))
      .filter((d) => store.canPostNow(d.id, d.discountPercent, cooldownMs))
      .sort((a, b) => b.discountPercent - a.discountPercent);
    if (perfumes.length > 0) return { coupon, deal: perfumes[0]! };
  }
  return null;
}

/** Escolhe e posta UM perfume + cupom COM CÓDIGO. `dry` só monta o texto. */
export async function runCodeCouponPost(
  sock: WASocket | null,
  opts: { dry?: boolean } = {}
): Promise<CodeCouponPostResult | null> {
  const chosen = await pickCodeCouponDeal();
  if (!chosen) {
    logger.info('[cupom-código] Nenhum cupom com código casou com perfume elegível.');
    return null;
  }
  const { coupon, deal } = chosen;

  await enrichWithShortLink(deal);
  const text = formatCodeCouponPost(deal, coupon);
  const groups = couponTargetGroups();

  if (opts.dry) return { coupon, deal, text, groups, posted: 0, dry: true };
  if (!sock) throw new Error('runCodeCouponPost: sock ausente pra envio real');
  if (groups.length === 0) return null;

  const preset = resolvePreset(deal.title, deal.id);
  const image = await fetchDealImage(deal, preset?.imagem);
  let posted = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const groupId = groups[i]!;
    try {
      const msgId = await sendToGroup(sock, groupId, text, image);
      store.markPosted(deal, groupId, msgId);
      posted += 1;
      logger.info({ groupId, produto: deal.title, cupom: coupon.code }, '[cupom-código] Enviado.');
    } catch (err) {
      logger.error({ err: (err as Error).message, groupId }, '[cupom-código] Falha ao enviar.');
    }
    if (i < groups.length - 1) {
      await sleep(randomDelay(config.throttle.groupDelayMinMs, config.throttle.groupDelayMaxMs));
    }
  }
  return { coupon, deal, text, groups, posted, dry: false };
}

/** Escolhe e posta UM perfume + cupom público. `dry` só monta o texto. */
export async function runPublicCouponPost(
  sock: WASocket | null,
  opts: { dry?: boolean } = {}
): Promise<PublicCouponPostResult | null> {
  const chosen = await pickPublicCouponDeal();
  if (!chosen) {
    logger.info('[cupom-público] Nenhum cupom público casou com perfume do pool.');
    return null;
  }
  const { coupon, deal } = chosen;

  await enrichWithShortLink(deal);
  const text = formatPublicCouponPost(deal, coupon);
  const groups = couponTargetGroups();

  if (opts.dry) return { coupon, deal, text, groups, posted: 0, dry: true };
  if (!sock) throw new Error('runPublicCouponPost: sock ausente pra envio real');
  if (groups.length === 0) {
    logger.error('[cupom-público] Nenhum grupo configurado.');
    return null;
  }

  const preset = resolvePreset(deal.title, deal.id);
  const image = await fetchDealImage(deal, preset?.imagem);
  let posted = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const groupId = groups[i]!;
    try {
      const msgId = await sendToGroup(sock, groupId, text, image);
      store.markPosted(deal, groupId, msgId);
      posted += 1;
      logger.info({ groupId, produto: deal.title, cupom: coupon.title }, '[cupom-público] Enviado.');
    } catch (err) {
      logger.error({ err: (err as Error).message, groupId }, '[cupom-público] Falha ao enviar.');
    }
    if (i < groups.length - 1) {
      await sleep(randomDelay(config.throttle.groupDelayMinMs, config.throttle.groupDelayMaxMs));
    }
  }
  return { coupon, deal, text, groups, posted, dry: false };
}
