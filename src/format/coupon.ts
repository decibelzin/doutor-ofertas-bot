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

/**
 * dd/MM da data de expiração. O ML manda a validade como timestamp INGÊNUO em
 * UTC (ex.: "2026-08-01T02:59:59" = 31/07 23:59 no Brasil); interpreta como UTC
 * e exibe no fuso configurado, senão a data sai 1 dia adiantada.
 */
function shortDate(iso: string): string | null {
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(config.timezone);
  return dt.isValid ? dt.toFormat('dd/MM') : null;
}

/**
 * Preço final estimado APÓS o cupom automático. Retorna null quando NÃO dá pra
 * estimar com segurança - de propósito, pra nunca anunciar preço enganoso:
 *  - produto abaixo da compra mínima;
 *  - cupom de % sem TETO conhecido (terms ausente) - sem o teto o desconto
 *    poderia ser bem menor que o % cheio, e mostraríamos um preço baixo demais.
 */
export function estimateFinalPrice(deal: Deal, coupon: PerfumeCoupon): number | null {
  const min = coupon.terms?.minPurchase ?? null;
  if (min !== null && deal.priceNow < min) return null;

  if (coupon.discountPercent !== null) {
    const cap = coupon.terms?.maxDiscount ?? null;
    if (cap === null) return null; // sem teto conhecido → não arrisca
    const discount = Math.min(deal.priceNow * (coupon.discountPercent / 100), cap);
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

  // Linha do cupom automático. Quando dá pra estimar o preço final, mostra o
  // desconto EFETIVO (após teto) casado com o preço final - nunca "+50%" ao lado
  // de um preço que reflete só R$ 30 de teto. Sem estimativa segura, mostra só o
  // desconto nominal do cupom, sem preço final (evita número enganoso).
  const final = estimateFinalPrice(deal, coupon);
  if (final !== null) {
    const off = deal.priceNow - final;
    const nominalOff =
      coupon.discountPercent !== null
        ? deal.priceNow * (coupon.discountPercent / 100)
        : coupon.discountAmount;
    const capped = nominalOff !== null && off < nominalOff - 0.01;
    const label =
      coupon.discountPercent !== null && !capped ? `+${coupon.discountPercent}%` : `−R$ ${price(off)}`;
    blocks.push(`🎟️ *${label} no carrinho* (cupom automático) → *R$ ${price(final)}*`);
  } else {
    blocks.push(`🎟️ *+${couponDiscountLabel(coupon)} no carrinho* (cupom automático)`);
  }

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

/**
 * Legenda de PERFUME + CUPOM PÚBLICO do ML (o "cupom relâmpago" dos concorrentes).
 * Diferente do cupom de vendedor (auto-aplicado), este o comprador ATIVA na
 * página/app do ML - por isso a mensagem manda ativar, sem prometer preço final
 * (o desconto depende da compra mínima e do teto do cupom).
 */
export function formatPublicCouponPost(
  deal: Deal,
  coupon: {
    title: string;
    minAmountText: string | null;
    capAmountText: string | null;
    expirationText: string | null;
    activationUrl?: string | null;
  },
  opts: { variant?: number } = {}
): string {
  const variant = opts.variant ?? 0;
  const preset = resolvePreset(deal.title, deal.id);
  const name = preset?.nome ?? cleanTitle(deal.title);
  const blocks: string[] = [];

  blocks.push(`⚡ *CUPOM ${coupon.title.toUpperCase()}*`);

  const accent = ACCENT[variant % ACCENT.length];
  blocks.push(`${accent} *${name}*`);

  const notas = preset?.notas?.length ? preset.notas : lookupNotas(deal.title);
  if (notas && notas.length > 0) blocks.push(`🌿 Notas: ${notas.join(', ')}`);

  if (deal.priceOriginal && deal.priceOriginal > deal.priceNow) {
    const off = deal.discountPercent ? `  ·  *${Math.round(deal.discountPercent)}% OFF*` : '';
    blocks.push(`~R$ ${price(deal.priceOriginal)}~ | *R$ ${price(deal.priceNow)}*${off}`);
  } else {
    blocks.push(`*R$ ${price(deal.priceNow)}*`);
  }

  // Condições reais do cupom (texto pronto do ML) + como ativar. Esses cupons
  // não têm código digitável (são de clicar em "Aplicar"), então mandamos o
  // LINK do cupom - é o equivalente do "código" pro cliente.
  const cond = [coupon.minAmountText, coupon.capAmountText].filter(Boolean).join(' · ');
  blocks.push(`🎟️ *Cupom ${coupon.title}*${cond ? `\n_${cond}_` : ''}`);
  if (coupon.activationUrl) {
    blocks.push(`👉 *Ative o cupom aqui (1 clique):*\n${coupon.activationUrl}`);
  } else {
    blocks.push('👉 Ative o cupom no app/site do ML antes de finalizar a compra.');
  }
  if (coupon.expirationText) blocks.push(`⏳ _${coupon.expirationText}_`);

  blocks.push(`🛒 *Compre aqui:*\n${deal.affiliateUrl}`);
  return blocks.join('\n\n');
}

/**
 * Legenda de PERFUME + CUPOM COM CÓDIGO (o "cupom relâmpago" dos concorrentes:
 * o cliente digita o código no checkout). Mostra o código em destaque.
 */
export function formatCodeCouponPost(
  deal: Deal,
  coupon: {
    code: string;
    title: string;
    minAmountText: string | null;
    capAmountText: string | null;
    expirationText: string | null;
  },
  opts: { variant?: number } = {}
): string {
  const variant = opts.variant ?? 0;
  const preset = resolvePreset(deal.title, deal.id);
  const name = preset?.nome ?? cleanTitle(deal.title);
  const blocks: string[] = [];

  const accent = ACCENT[variant % ACCENT.length];
  blocks.push(`${accent} *${name}*`);

  const notas = preset?.notas?.length ? preset.notas : lookupNotas(deal.title);
  if (notas && notas.length > 0) blocks.push(`🌿 Notas: ${notas.join(', ')}`);

  if (deal.priceOriginal && deal.priceOriginal > deal.priceNow) {
    const off = deal.discountPercent ? `  ·  *${Math.round(deal.discountPercent)}% OFF*` : '';
    blocks.push(`~R$ ${price(deal.priceOriginal)}~ | *R$ ${price(deal.priceNow)}*${off}`);
  } else {
    blocks.push(`*R$ ${price(deal.priceNow)}*`);
  }

  // O código em destaque - é o que o cliente precisa copiar.
  const cond = [coupon.minAmountText, coupon.capAmountText].filter(Boolean).join(' · ');
  blocks.push(`🎟️ *Cupom: ${coupon.code}* (${coupon.title.trim()})${cond ? `\n_${cond}_` : ''}`);
  if (coupon.expirationText) blocks.push(`⏳ _${coupon.expirationText}_`);

  blocks.push(`🛒 ${deal.affiliateUrl}`);
  return blocks.join('\n\n');
}

// Reexport pra quem formata valores soltos (mantém formatMoney num lugar só).
export { formatMoney };
