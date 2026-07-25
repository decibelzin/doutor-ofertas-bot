import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../logger';
import { alertAuthDegraded } from '../../core/health';

/**
 * CUPONS PÚBLICOS DO ML (mercadolivre.com.br/cupons) — os mesmos que os canais
 * concorrentes postam ("CUPOM RELÂMPAGO"). Diferente dos cupons de VENDEDOR
 * (coupons.ts, auto-aplicados), estes são cupons do próprio ML, que o comprador
 * ativa/usa, e valem pra QUALQUER pessoa (não são da nossa conta de afiliado).
 *
 * A página não expõe API limpa: os cupons vêm num JSON EMBUTIDO no HTML. A gente
 * extrai os objetos `{"campaign_id": ...}` balanceando chaves, e fica com os que
 * têm produto de PERFUMARIA (domain_id MLB-PERFUMES ou título de perfume).
 *
 * ⚠️ A página exige sessão (cookie do painel) — senão cai no muro/login.
 */

const URL = 'https://www.mercadolivre.com.br/cupons';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export interface PublicCouponItem {
  altText: string;
  domainId: string;
  imageUrl: string | null;
}

export interface PublicCoupon {
  campaignId: string;
  title: string;
  /** Ex.: "Compra mínima R$ 150" (texto pronto do ML). */
  minAmountText: string | null;
  /** Ex.: "Limite de R$ 20". */
  capAmountText: string | null;
  /** Ex.: "Vence em sexta-feira" / "Está esgotando!". */
  expirationText: string | null;
  /** EU_QUERO = o comprador ativa o cupom na página/app. */
  activationType: string | null;
  /** Produtos de perfumaria elegíveis (amostra que o ML mostra no card). */
  perfumeItems: PublicCouponItem[];
  /** Todos os produtos-amostra do card. */
  items: PublicCouponItem[];
}

const cache: { at: number; coupons: PublicCoupon[] } = { at: 0, coupons: [] };

export function publicCouponsEnabled(): boolean {
  return Boolean(config.mercadoLivre.affiliateCookie);
}

/** Texto pode vir string ou {text}. Normaliza. */
function asText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'text' in (v as Record<string, unknown>)) {
    const t = (v as { text?: unknown }).text;
    return typeof t === 'string' ? t : null;
  }
  return null;
}

const PERFUME_DOMAIN = /PERFUME|FRAGRANC|COLOGNE/i;
const PERFUME_TEXT = /\b(perfum|parfum|eau de|\bedt\b|\bedp\b|col[oô]nia|fragr[aâ]ncia)\b/i;

function isPerfumeItem(i: PublicCouponItem): boolean {
  return PERFUME_DOMAIN.test(i.domainId) || PERFUME_TEXT.test(i.altText);
}

/**
 * Extrai os objetos de cupom do JSON embutido no HTML (balanceando chaves a
 * partir de cada `{"campaign_id":"`).
 */
export function parsePublicCouponsHtml(html: string): PublicCoupon[] {
  const raw: Record<string, unknown>[] = [];
  const re = /\{"campaign_id":"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const start = m.index;
    let depth = 0;
    let end = -1;
    for (let j = start; j < html.length && j < start + 9000; j += 1) {
      if (html[j] === '{') depth += 1;
      else if (html[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end < 0) continue;
    try {
      raw.push(JSON.parse(html.slice(start, end)) as Record<string, unknown>);
    } catch {
      /* fragmento inválido — ignora */
    }
  }

  const byCampaign = new Map<string, PublicCoupon>();
  for (const c of raw) {
    const items: PublicCouponItem[] = Array.isArray(c.items)
      ? (c.items as Record<string, unknown>[]).map((i) => ({
          altText: String(i.alt_text ?? ''),
          domainId: String(i.domain_id ?? ''),
          imageUrl: typeof i.image_url === 'string' ? i.image_url : null,
        }))
      : [];
    const perfumeItems = items.filter(isPerfumeItem);
    if (perfumeItems.length === 0) continue; // só interessa cupom com perfume

    const amount = (c.amount ?? {}) as Record<string, unknown>;
    const campaignId = String(c.campaign_id ?? '');
    if (!campaignId || byCampaign.has(campaignId)) continue;

    byCampaign.set(campaignId, {
      campaignId,
      title: asText(c.title) ?? '(sem título)',
      minAmountText: asText(amount.min_amount) ?? asText(c.min_amount),
      capAmountText: asText(amount.cap_amount) ?? asText(c.cap_amount),
      expirationText: asText(c.expiration_date),
      activationType: typeof c.activation_type === 'string' ? c.activation_type : null,
      perfumeItems,
      items,
    });
  }
  return [...byCampaign.values()];
}

/**
 * Busca os cupons públicos vigentes que incluem PERFUME. Cacheado por TTL (a
 * página é pesada e o conjunto muda devagar).
 */
export async function fetchPublicPerfumeCoupons({
  ttlMs = config.mercadoLivre.publicCouponsTtlMinutes * 60 * 1000,
}: { ttlMs?: number } = {}): Promise<PublicCoupon[]> {
  if (!publicCouponsEnabled()) return [];
  if (cache.at && Date.now() - cache.at < ttlMs) return cache.coupons;

  const res = await axios.get<string>(URL, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'pt-BR,pt;q=0.9',
      Cookie: config.mercadoLivre.affiliateCookie,
    },
    timeout: 30000,
    responseType: 'text',
    validateStatus: () => true,
    maxRedirects: 5,
  });
  const finalUrl: string = (res.request as { res?: { responseUrl?: string } })?.res?.responseUrl ?? URL;
  if (finalUrl.includes('account-verification') || finalUrl.includes('/login')) {
    alertAuthDegraded('cupons-publicos-sem-sessao');
    return cache.coupons; // devolve o último bom em vez de vazio
  }
  if (res.status !== 200) return cache.coupons;

  const coupons = parsePublicCouponsHtml(res.data);
  cache.at = Date.now();
  cache.coupons = coupons;
  logger.info({ count: coupons.length }, '[ML/cupons-públicos] Cupons de perfumaria encontrados.');
  return coupons;
}
