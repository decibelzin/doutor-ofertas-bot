/**
 * "Deal" (oferta) é o formato NORMALIZADO que todo provider produz e todo
 * canal consome. É o contrato central: enquanto entrar/sair neste formato,
 * dá pra plugar novas lojas e novos canais sem tocar no núcleo.
 */
export interface Deal {
  /** Id único e estável. Padrão: "<store>:<idNaLoja>". */
  id: string;
  /** Loja de origem: 'mercadolivre', 'shopee', ... */
  store: string;
  title: string;
  /** Preço "de" (antes do desconto) ou null. */
  priceOriginal: number | null;
  /** Preço "por" (atual). */
  priceNow: number;
  /** Desconto em % (0–100). */
  discountPercent: number;
  coupon: string | null;
  imageUrl: string | null;
  /** Link JÁ com a tag de afiliado. */
  affiliateUrl: string;
  /** Link "cru" do produto (sem afiliação), opcional. */
  productUrl: string | null;
  /** Comissão estimada em % (usada no ranking), se disponível. */
  commissionRate: number | null;
  /** Avaliação do produto (0–5), quando a fonte fornece. Usada pra filtrar bem-avaliados. */
  rating: number | null;
  /** Termo/categoria que encontrou a oferta. */
  category: string | null;
  /** Epoch ms de quando foi coletada. */
  fetchedAt: number;
}

export interface RawDeal {
  id?: string | number;
  store?: string;
  title?: string;
  priceOriginal?: number | string | null;
  priceNow?: number | string | null;
  discountPercent?: number | string | null;
  coupon?: string | null;
  imageUrl?: string | null;
  affiliateUrl?: string | null;
  productUrl?: string | null;
  commissionRate?: number | string | null;
  rating?: number | string | null;
  category?: string | null;
  fetchedAt?: number;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/**
 * Normaliza um objeto solto num Deal válido, calculando o desconto quando não
 * vier pronto. Retorna null se faltar o essencial (id, título, preço ou link).
 */
export function makeDeal(raw: RawDeal): Deal | null {
  if (!raw) return null;

  const priceNow = toNumberOrNull(raw.priceNow);
  const priceOriginal = toNumberOrNull(raw.priceOriginal);

  let discountPercent = toNumberOrNull(raw.discountPercent);
  if (
    (discountPercent === null || discountPercent === 0) &&
    priceOriginal &&
    priceNow &&
    priceOriginal > priceNow
  ) {
    discountPercent = Math.round((1 - priceNow / priceOriginal) * 100);
  }

  const id = raw.id !== undefined && raw.id !== null ? String(raw.id) : null;
  const title = raw.title ? String(raw.title).trim() : null;
  const affiliateUrl = raw.affiliateUrl ?? raw.productUrl ?? null;

  if (!id || !title || priceNow === null || !affiliateUrl) return null;

  return {
    id,
    store: raw.store ?? 'desconhecida',
    title,
    priceOriginal,
    priceNow,
    discountPercent: discountPercent ?? 0,
    coupon: raw.coupon ?? null,
    imageUrl: raw.imageUrl ?? null,
    affiliateUrl,
    productUrl: raw.productUrl ?? null,
    commissionRate: toNumberOrNull(raw.commissionRate),
    rating: toNumberOrNull(raw.rating),
    category: raw.category ?? null,
    fetchedAt: raw.fetchedAt ?? Date.now(),
  };
}
