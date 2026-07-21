import type { Deal } from '../core/deal';

/**
 * Formata um Deal na mensagem de WhatsApp:
 *
 *   🔥 [NOME DO PRODUTO]
 *   ❌ De R$ [VALOR_NORMAL]      (só se houver preço "de")
 *   ✅ Por R$ [VALOR_PROMOCIONAL]
 *   📉 [XX]% OFF                 (só se houver desconto)
 *   🎟️ Cupom: [CUPOM]           (só se houver cupom)
 *   ➡️ [LINK_AFILIADO]
 *
 * `variant` (índice do grupo) varia levemente o emoji entre grupos, pra não
 * mandar broadcast idêntico simultâneo (anti-ban).
 */
const HEAT = ['🔥', '⚡', '🚨', '💥', '🛒'];

export function formatMoney(value: number): string {
  return Number(value).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatDeal(deal: Deal, opts: { variant?: number } = {}): string {
  const variant = opts.variant ?? 0;
  const heat = HEAT[variant % HEAT.length];
  const lines = [`${heat} ${deal.title}`];

  if (deal.priceOriginal && deal.priceOriginal > deal.priceNow) {
    lines.push(`❌ De R$ ${formatMoney(deal.priceOriginal)}`);
  }
  lines.push(`✅ Por R$ ${formatMoney(deal.priceNow)}`);

  if (deal.discountPercent) {
    lines.push(`📉 ${Math.round(deal.discountPercent)}% OFF`);
  }
  if (deal.coupon) {
    lines.push(`🎟️ Cupom: ${deal.coupon}`);
  }
  lines.push(`➡️ ${deal.affiliateUrl}`);

  return lines.join('\n');
}
