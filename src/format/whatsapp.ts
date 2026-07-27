import type { Deal } from '../core/deal';
import { resolvePreset, cleanTitle } from './title';
import { lookupNotas } from './perfumes';

/**
 * Formata um Deal na legenda de WhatsApp - estilo enxuto/premium (inspirado nos
 * canais de referência), com foco no desconto e no link.
 *
 * Com FICHA curada (config/presets.json): usa a descrição chamativa como
 * headline em negrito + o nome curado:
 *
 *   *🍐 O CAPITÃO USA ESSE NA BALADA*         (descrição da ficha, negrito)
 *
 *   Afnan 9PM                                 (nome da ficha)
 *
 *   ~R$ [de]~ | *R$ [por]*  ·  *[XX]% OFF*
 *
 *   🛒 [LINK]
 *
 * Sem ficha: o título limpo (cleanTitle) vira o headline em negrito, com um
 * emoji de acento que varia por grupo (anti-ban):
 *
 *   ✨ *[NOME LIMPO]*
 *
 *   ~R$ [de]~ | *R$ [por]*  ·  *[XX]% OFF*
 *
 *   🛒 [LINK]
 */
const ACCENT = ['✨', '💎', '🔥', '🌟', '🖤'];

export function formatMoney(value: number): string {
  return Number(value).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Preço "premium": some com o ",00" quando é redondo (R$ 199 em vez de R$ 199,00). */
function formatPrice(value: number): string {
  const isRound = Number.isInteger(value);
  return Number(value).toLocaleString('pt-BR', {
    minimumFractionDigits: isRound ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function formatDeal(
  deal: Deal,
  opts: { variant?: number; footerUrl?: string } = {}
): string {
  const variant = opts.variant ?? 0;
  const preset = resolvePreset(deal.title, deal.id);
  const name = preset?.nome ?? cleanTitle(deal.title);
  const blocks: string[] = [];

  if (preset?.descricao) {
    // Ficha com descrição: headline chamativa (negrito) + nome curado.
    blocks.push(`*${preset.descricao}*`, name);
  } else {
    // Sem descrição: o nome vira o headline, com acento que varia por grupo.
    const accent = ACCENT[variant % ACCENT.length];
    blocks.push(`${accent} *${name}*`);
  }

  // Notas: da ficha (curada) OU, senão, do banco local automático (data/perfumes.json).
  const notas = preset?.notas?.length ? preset.notas : lookupNotas(deal.title);
  if (notas && notas.length > 0) {
    blocks.push(`🌿 Notas: ${notas.join(', ')}`);
  }

  if (deal.priceOriginal && deal.priceOriginal > deal.priceNow) {
    const off = deal.discountPercent ? `  ·  *${Math.round(deal.discountPercent)}% OFF*` : '';
    blocks.push(`~R$ ${formatPrice(deal.priceOriginal)}~ | *R$ ${formatPrice(deal.priceNow)}*${off}`);
  } else {
    blocks.push(`*R$ ${formatPrice(deal.priceNow)}*`);
  }

  if (deal.coupon) {
    blocks.push(`Cupom: *${deal.coupon}*`);
  }

  blocks.push(`🛒 ${deal.affiliateUrl}`);

  /* Rodapé de recrutamento (opcional - quem decide a frequência é o scheduler).
     Escrito pra quem está DE FORA: quem já está no grupo pula a linha, quem
     recebeu encaminhado descobre como entrar. Sem ele, encaminhar uma oferta -
     que é o comportamento natural em grupo de promoção - não recruta ninguém:
     o amigo recebe o perfume com desconto e nenhum caminho de volta. */
  if (opts.footerUrl) {
    blocks.push(`📲 Recebeu encaminhado? Oferta assim todo dia:\n${opts.footerUrl}`);
  }

  // Uma linha em branco entre CADA bloco (respiro/premium).
  return blocks.join('\n\n');
}
