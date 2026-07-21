import crypto from 'node:crypto';
import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../logger';
import { makeDeal, type Deal } from '../../core/deal';

/**
 * Provider Shopee — Shopee Affiliate Open API (GraphQL). Credenciais em
 * https://affiliate.shopee.com.br -> "Open API" (App ID + App Secret).
 *
 * Vantagem sobre o ML: a query `productOfferV2` já devolve o `offerLink` — o
 * link de afiliado PRONTO com a sua tag — junto com preço, desconto e comissão.
 * Zero scraping, atribuição garantida pela própria Shopee.
 *
 * Autenticação (esquema da Shopee):
 *   Authorization: SHA256 Credential={AppId}, Timestamp={ts}, Signature={sig}
 *   Signature = SHA256(AppId + Timestamp + Payload + AppSecret)
 */

interface OfferNode {
  itemId: number | string;
  productName: string;
  priceMin: string | number;
  priceMax: string | number;
  priceDiscountRate: string | number;
  commissionRate: string | number;
  imageUrl: string;
  offerLink: string;
  productLink: string;
  shopName: string;
}

interface ProductOfferData {
  productOfferV2?: { nodes?: OfferNode[]; pageInfo?: { hasNextPage?: boolean } };
}

function sign(payload: string): { timestamp: number; signature: string } {
  const { appId, appSecret } = config.shopee;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHash('sha256')
    .update(`${appId}${timestamp}${payload}${appSecret}`)
    .digest('hex');
  return { timestamp, signature };
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const { appId, graphqlEndpoint } = config.shopee;
  const body = JSON.stringify({ query, variables });
  const { timestamp, signature } = sign(body);

  const { data } = await axios.post<{ data: T; errors?: unknown }>(graphqlEndpoint, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
    },
    timeout: 15000,
  });
  if (data.errors) throw new Error(`Shopee GraphQL error: ${JSON.stringify(data.errors)}`);
  return data.data;
}

const PRODUCT_OFFER_QUERY = `
  query ProductOffer($keyword: String, $sortType: Int, $page: Int, $limit: Int) {
    productOfferV2(keyword: $keyword, sortType: $sortType, page: $page, limit: $limit) {
      nodes {
        itemId
        productName
        priceMin
        priceMax
        priceDiscountRate
        commissionRate
        imageUrl
        offerLink
        productLink
        shopName
      }
      pageInfo { hasNextPage }
    }
  }
`;

async function searchTerm(term: string): Promise<OfferNode[]> {
  try {
    const data = await graphql<ProductOfferData>(PRODUCT_OFFER_QUERY, {
      keyword: term,
      sortType: config.shopee.sortType,
      page: 1,
      limit: config.shopee.limitPerTerm,
    });
    return data.productOfferV2?.nodes ?? [];
  } catch (err) {
    logger.error({ err: (err as Error).message, term }, '[Shopee] Falha ao buscar termo');
    return [];
  }
}

/** Calcula o preço "de" a partir do preço atual e da % de desconto. */
function computeOriginalPrice(priceNow: number, discountRate: number): number | null {
  if (!discountRate) return null;
  return Math.round((priceNow / (1 - discountRate / 100)) * 100) / 100;
}

export const name = 'shopee';

export async function fetchDeals(): Promise<Deal[]> {
  if (!config.shopee.enabled) {
    logger.warn('[Shopee] SHOPEE_APP_ID/SHOPEE_APP_SECRET ausentes — pulando Shopee.');
    return [];
  }

  const { searchTerms, minDiscountPercent, fallbackCoupon } = config.shopee;
  const byItem = new Map<string, OfferNode>();

  for (const term of searchTerms) {
    for (const node of await searchTerm(term)) {
      const key = String(node.itemId);
      if (!byItem.has(key)) byItem.set(key, node);
    }
  }

  const deals: Deal[] = [];
  for (const node of byItem.values()) {
    const discount = Number(node.priceDiscountRate || 0);
    if (discount < minDiscountPercent) continue;

    const priceNow = Number(node.priceMin);
    const commission = Number(node.commissionRate || 0);
    const deal = makeDeal({
      id: `shopee:${node.itemId}`,
      store: 'shopee',
      title: node.productName,
      priceNow,
      priceOriginal: computeOriginalPrice(priceNow, discount),
      discountPercent: discount,
      // commissionRate pode vir como fração (0-1) ou %; normaliza pra %.
      commissionRate: commission > 0 && commission <= 1 ? commission * 100 : commission || null,
      coupon: fallbackCoupon || null,
      imageUrl: node.imageUrl || null,
      affiliateUrl: node.offerLink || node.productLink,
      productUrl: node.productLink || null,
      category: null,
    });
    if (deal) deals.push(deal);
  }

  logger.info({ count: deals.length }, '[Shopee] Ofertas coletadas.');
  return deals;
}
