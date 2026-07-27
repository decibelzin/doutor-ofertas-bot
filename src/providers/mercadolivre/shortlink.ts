import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../logger';
import { alertAuthDegraded } from '../../core/health';
import type { Deal } from '../../core/deal';

/**
 * Gera o link curto OFICIAL do ML (meli.la) via o endpoint interno
 * `createLink` do painel de afiliado - o mesmo que o botão "Compartilhar" usa.
 *
 * Método NÃO-OFICIAL: precisa do cookie de sessão + x-csrf-token capturados do
 * navegador (painel de afiliado). Esses valores EXPIRAM - quando isso acontece,
 * a geração falha e o bot cai automaticamente no link matt (longo).
 *
 * Como o mesmo produto se repete, guardamos o resultado num cache em disco
 * (gera 1x por produto).
 */

const CREATE_LINK_URL =
  'https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink';
const CACHE_FILE = path.resolve('./data/ml_shortlinks.json');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0';

let cache: Record<string, string> | null = null;

function loadCache(): Record<string, string> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Record<string, string>;
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache(): void {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/** Ligado quando cookie + csrf estão configurados. */
export function shortLinkEnabled(): boolean {
  return Boolean(config.mercadoLivre.affiliateCookie && config.mercadoLivre.affiliateCsrf);
}

interface CreateLinkResponse {
  urls?: Array<{ short_url?: string }>;
}

/** Chama o createLink e devolve o short_url (meli.la), ou null se falhar. */
export async function generateShortLink(itemId: string, productUrl: string): Promise<string | null> {
  if (!shortLinkEnabled()) return null;

  const c = loadCache();
  if (c[itemId]) return c[itemId];

  try {
    const { data } = await axios.post<CreateLinkResponse>(
      CREATE_LINK_URL,
      {
        itemId,
        tag: config.mercadoLivre.mattWord,
        type: 'product',
        urls: [productUrl],
        extraCommission: 'false',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'User-Agent': UA,
          Origin: 'https://www.mercadolivre.com.br',
          Referer: 'https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true',
          'x-csrf-token': config.mercadoLivre.affiliateCsrf,
          Cookie: config.mercadoLivre.affiliateCookie,
        },
        timeout: 15000,
      }
    );

    const short = data?.urls?.[0]?.short_url;
    if (short) {
      c[itemId] = short;
      saveCache();
      return short;
    }
    logger.warn({ data }, '[ML/shortlink] Resposta sem short_url.');
    return null;
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    logger.warn(
      { err: (err as Error).message, status },
      '[ML/shortlink] Falha ao gerar link curto (cookie/csrf expirado?) - usando link matt.'
    );
    if (status === 401 || status === 403) alertAuthDegraded('shortlink-nao-autorizado', { status });
    return null;
  }
}

/**
 * Se o deal for do ML e o gerador estiver ligado, troca o affiliateUrl pelo
 * link curto (meli.la). Se falhar, mantém o link matt que já veio no deal.
 */
export async function enrichWithShortLink(deal: Deal): Promise<void> {
  if (deal.store !== 'mercadolivre' || !shortLinkEnabled()) return;

  const itemId = deal.id.replace(/^mercadolivre:/, '');
  const productUrl = deal.productUrl ?? deal.affiliateUrl;
  const short = await generateShortLink(itemId, productUrl);
  if (short) deal.affiliateUrl = short;
}
