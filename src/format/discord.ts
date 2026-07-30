import type { Deal } from '../core/deal';
import { resolvePreset, cleanTitle } from './title';
import { lookupNotas } from './perfumes';
import { formatPrice } from './whatsapp';

/**
 * A OFERTA COMO EMBED DO DISCORD.
 *
 * Função pura (não faz rede) pelo mesmo motivo do `formatDeal`: dá pra olhar o
 * resultado sem postar em canal de verdade.
 *
 * Escolhas de formato, e por que diferem do WhatsApp:
 *  - o NOME vira o título com `url`, então o card inteiro é clicável. No
 *    WhatsApp o link precisa aparecer escrito; aqui isso seria ruído.
 *  - a foto vai em `image` (grande, embaixo) e não `thumbnail`: perfume vende
 *    pelo frasco, e miniatura de 80px não mostra frasco nenhum.
 *  - o mesmo preço redondo sem ",00" do WhatsApp, pra os dois canais falarem
 *    igual.
 */

const OURO = 0xe8b84b;

export interface EmbedOferta {
  color: number;
  title: string;
  url: string;
  description: string;
  image?: { url: string };
  footer: { text: string };
  timestamp: string;
}

export function montarEmbedOferta(deal: Deal, quando = new Date()): EmbedOferta {
  const preset = resolvePreset(deal.title, deal.id);
  const nome = preset?.nome ?? cleanTitle(deal.title);
  const notas = preset?.notas?.length ? preset.notas : lookupNotas(deal.title);

  const linhas: string[] = [];

  if (preset?.descricao) linhas.push(`**${preset.descricao}**`);
  if (notas?.length) linhas.push(`🌿 ${notas.join(' · ')}`);

  if (deal.priceOriginal && deal.priceOriginal > deal.priceNow) {
    const off = deal.discountPercent ? `  ·  **${Math.round(deal.discountPercent)}% OFF**` : '';
    linhas.push(`~~R$ ${formatPrice(deal.priceOriginal)}~~  →  **R$ ${formatPrice(deal.priceNow)}**${off}`);
  } else {
    linhas.push(`**R$ ${formatPrice(deal.priceNow)}**`);
  }

  if (deal.coupon) linhas.push(`🎟️ Cupom: **${deal.coupon}**`);
  linhas.push(`[Ver no ${deal.store === 'mercadolivre' ? 'Mercado Livre' : deal.store}](${deal.affiliateUrl})`);

  return {
    color: OURO,
    title: nome.slice(0, 256), // limite do Discord
    url: deal.affiliateUrl,
    description: linhas.join('\n\n').slice(0, 4096),
    ...(deal.imageUrl ? { image: { url: deal.imageUrl } } : {}),
    footer: { text: 'Doutor Ofertas · ganhamos comissão da loja, você paga o mesmo' },
    timestamp: quando.toISOString(),
  };
}
