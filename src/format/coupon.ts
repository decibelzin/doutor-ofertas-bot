import { DateTime } from 'luxon';
import type { Deal } from '../core/deal';
import { config } from '../config';
import { resolvePreset, cleanTitle } from './title';
import { lookupNotas } from './perfumes';
import { formatMoney } from './whatsapp';
import type { PerfumeCoupon } from '../providers/mercadolivre/coupons';

/**
 * Legenda de PERFUME + CUPOM AUTOMÁTICO (o "desconto duplo" dos concorrentes).
 *
 * Diferente do cupom relâmpago (código digitável, @all), aqui o cupom é do tipo
 * PRODUCT_DISCOUNT: aplica sozinho no carrinho. A mensagem sai no mesmo padrão
 * premium das ofertas (foto grande + legenda), destacando o desconto do cupom e
 * o preço final estimado:
 *
 *   ✨ *Khadlaj Zayaan Gold 100ml*
 *
 *   🌿 Notas: ...
 *
 *   ~R$ 335~ | *R$ 260,39*  ·  *22% OFF*
 *
 *   🎟️ *+20% no carrinho* (cupom automático) → *R$ 208,31*
 *   _produtos selecionados · até 01/08_
 *
 *   🛒 <link>
 */

const ACCENT = ['✨', '💎', '🔥', '🌟', '🖤'];

/** Preço "premium": some com o ",00" quando é redondo. */
function price(value: number): string {
  const isRound = Number.isInteger(value);
  return Number(value).toLocaleString('pt-BR', {
    minimumFractionDigits: isRound ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** dd/MM da data de expiração (ou null se não parsear). */
function shortDate(iso: string): string | null {
  const dt = DateTime.fromISO(iso);
  return dt.isValid ? dt.toFormat('dd/MM') : null;
}

/**
 * Preço final estimado APÓS o cupom automático, respeitando compra mínima e teto
 * de desconto. Retorna null quando não dá pra estimar com segurança (ex.: cupom
 * de R$ fixo sem % , ou produto abaixo da compra mínima).
 */
export function estimateFinalPrice(deal: Deal, coupon: PerfumeCoupon): number | null {
  const min = coupon.terms?.minPurchase ?? null;
  if (min !== null && deal.priceNow < min) return null; // não atinge a compra mínima

  if (coupon.discountPercent !== null) {
    let discount = deal.priceNow * (coupon.discountPercent / 100);
    const cap = coupon.terms?.maxDiscount ?? null;
    if (cap !== null) discount = Math.min(discount, cap);
    return Math.max(0, deal.priceNow - discount);
  }
  if (coupon.discountAmount !== null) {
    return Math.max(0, deal.priceNow - coupon.discountAmount);
  }
  return null;
}

/** Texto do desconto do cupom pra headline ("20%" ou "R$ 15"). */
function couponDiscountLabel(coupon: PerfumeCoupon): string {
  if (coupon.discountPercent !== null) return `${coupon.discountPercent}%`;
  if (coupon.discountAmount !== null) return `R$ ${price(coupon.discountAmount)}`;
  return coupon.title;
}

export function formatPerfumeCoupon(
  deal: Deal,
  coupon: PerfumeCoupon,
  opts: { variant?: number } = {}
): string {
  const variant = opts.variant ?? 0;
  const preset = resolvePreset(deal.title, deal.id);
  const name = preset?.nome ?? cleanTitle(deal.title);
  const blocks: string[] = [];

  if (preset?.descricao) {
    blocks.push(`*${preset.descricao}*`, name);
  } else {
    const accent = ACCENT[variant % ACCENT.length];
    blocks.push(`${accent} *${name}*`);
  }

  const notas = preset?.notas?.length ? preset.notas : lookupNotas(deal.title);
  if (notas && notas.length > 0) {
    blocks.push(`🌿 Notas: ${notas.join(', ')}`);
  }

  // Preço do anúncio (de/por), como nas ofertas normais.
  if (deal.priceOriginal && deal.priceOriginal > deal.priceNow) {
    const off = deal.discountPercent ? `  ·  *${Math.round(deal.discountPercent)}% OFF*` : '';
    blocks.push(`~R$ ${price(deal.priceOriginal)}~ | *R$ ${price(deal.priceNow)}*${off}`);
  } else {
    blocks.push(`*R$ ${price(deal.priceNow)}*`);
  }

  // Linha do cupom automático + preço final estimado.
  const label = couponDiscountLabel(coupon);
  const final = estimateFinalPrice(deal, coupon);
  const arrow = final !== null ? ` → *R$ ${price(final)}*` : '';
  blocks.push(`🎟️ *+${label} no carrinho* (cupom automático)${arrow}`);

  // Condições em itálico (validade + compra mínima), discreto.
  const cond: string[] = ['produtos selecionados'];
  if (coupon.terms?.minPurchase && coupon.terms.minPurchase > 1) {
    cond.push(`mín. R$ ${price(coupon.terms.minPurchase)}`);
  }
  const exp = shortDate(coupon.expiration);
  if (exp) cond.push(`até ${exp}`);
  blocks.push(`_${cond.join(' · ')}_`);

  blocks.push(`🛒 ${deal.affiliateUrl}`);

  if (config.coupon.searchLink) blocks.push(`🔎 mais perfumes: ${config.coupon.searchLink}`);

  return blocks.join('\n\n');
}

// Reexport pra quem formata valores soltos (mantém formatMoney num lugar só).
export { formatMoney };
