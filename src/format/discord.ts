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
 *  - a compra sai num BOTÃO de link, não num link escrito no meio do texto.
 *    Botão é alvo grande, aparece separado do conteúdo e não compete com o
 *    preço pela atenção. Só é possível porque a mensagem vai por REST com o
 *    token do bot - webhook comum não aceita componente.
 *  - o NOME vira o título com `url`, então o card inteiro também é clicável.
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

/**
 * Corpo COMPLETO da mensagem: embed + botão de compra.
 *
 * Os números crus (`type: 1` linha, `type: 2` botão, `style: 5` link) são o
 * formato da API. Não uso os builders do discord.js aqui de propósito: este
 * módulo é chamado pelo processo do WhatsApp, que envia por `fetch` e não
 * carrega o client - importar builder só pra serializar JSON traria a
 * biblioteca inteira pra dentro do processo que precisa ficar leve.
 *
 * Botão de link não leva `custom_id` e não gera interação: o Discord abre a URL
 * direto. Ou seja, não depende do bot estar vivo pra funcionar - o post de hoje
 * continua comprável daqui a um ano.
 */
export function montarMensagemOferta(deal: Deal, quando = new Date()): {
  embeds: EmbedOferta[];
  components: unknown[];
} {
  return {
    embeds: [montarEmbedOferta(deal, quando)],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: 'Comprar', emoji: { name: '🛒' }, url: deal.affiliateUrl },
        ],
      },
    ],
  };
}
