import axios from 'axios';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { logger } from '../../logger';
import { makeDeal, type Deal } from '../../core/deal';
import { buildAffiliateUrl } from './affiliate';

/**
 * Sourcing de ofertas do Mercado Livre via SCRAPING da página pública de
 * ofertas (mercadolivre.com.br/ofertas). A API oficial de busca morreu (403),
 * então raspamos o HTML — que é renderizado no servidor e traz preço "de/por",
 * desconto, título e link direto no markup (componente "polycard" do ML).
 *
 * O link de cada produto é limpo (tira o tracking do ML) e recebe a nossa tag
 * de afiliado (matt_word/matt_tool) via buildAffiliateUrl.
 */

const OFERTAS_URL = 'https://www.mercadolivre.com.br/ofertas';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/** Extrai um número (reais.centavos) de um elemento .andes-money-amount. */
function parseMoney(el: cheerio.Cheerio<AnyNode>): number | null {
  if (!el || el.length === 0) return null;
  const fraction = el.find('.andes-money-amount__fraction').first().text().replace(/\./g, '').trim();
  const cents = el.find('.andes-money-amount__cents').first().text().trim();
  if (!fraction) return null;
  const value = Number(`${fraction}.${cents || '00'}`);
  return Number.isNaN(value) ? null : value;
}

/** Escolhe a melhor URL de imagem (evita placeholder de lazy-load). */
function pickImage(img: cheerio.Cheerio<AnyNode>): string | null {
  const src = img.attr('src') || '';
  if (/^https?:\/\/.*mlstatic/.test(src)) return src;
  const dataSrc = img.attr('data-src') || '';
  if (/^https?:/.test(dataSrc)) return dataSrc;
  return src || dataSrc || null;
}

/** Faz o parse do HTML da página de ofertas e devolve Deals normalizados. */
export function parseOfertasHtml(html: string): Deal[] {
  const $ = cheerio.load(html);
  const deals: Deal[] = [];

  $('.poly-card').each((_, el) => {
    const card = $(el);
    const linkEl = card.find('a[href*="/p/MLB"], a[href*="/MLB-"]').first();
    const href = linkEl.attr('href') || '';
    const cleanUrl = href.split('?')[0].split('#')[0];
    const idMatch = cleanUrl.match(/(MLB\d+)/);
    if (!idMatch) return;

    const title = card.find('.poly-component__title').first().text().trim() || linkEl.text().trim();
    const priceBox = card.find('.poly-component__price');

    const priceOriginal = parseMoney(priceBox.find('.andes-money-amount--previous').first());
    const priceNow = parseMoney(
      priceBox.find('.andes-money-amount').not('.andes-money-amount--previous').first()
    );

    const pillDisc = parseInt(
      priceBox.find('.polylabel-pill').first().text().replace(/\D/g, ''),
      10
    );

    const deal = makeDeal({
      id: `mercadolivre:${idMatch[1]}`,
      store: 'mercadolivre',
      title,
      priceNow,
      priceOriginal,
      discountPercent: Number.isNaN(pillDisc) ? undefined : pillDisc,
      imageUrl: pickImage(card.find('img').first()),
      affiliateUrl: buildAffiliateUrl(cleanUrl),
      productUrl: cleanUrl,
      category: 'ofertas',
    });
    if (deal) deals.push(deal);
  });

  return deals;
}

/** Baixa a página de ofertas e devolve os Deals. */
export async function fetchOfertas(): Promise<Deal[]> {
  const { data } = await axios.get<string>(OFERTAS_URL, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    timeout: 20000,
    responseType: 'text',
  });
  const deals = parseOfertasHtml(data);
  logger.info({ count: deals.length }, '[ML/ofertas] Ofertas raspadas.');
  return deals;
}
