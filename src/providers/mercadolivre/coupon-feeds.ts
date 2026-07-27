import axios from 'axios';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { logger } from '../../logger';

/**
 * CUPONS DE SITE INTEIRO do ML via AGREGADORES públicos (Pelando etc.).
 *
 * Descoberta: os códigos que os canais concorrentes postam (ALLSITE25,
 * TODOSITE25, SITEMELI25, MELIOFFHJ, LOJASOFICIAS30...) NÃO aparecem em nenhum
 * endpoint da conta de afiliado - eles são campanhas de site inteiro do ML,
 * publicadas em sites agregadores de cupom. É de lá que dá pra captá-los.
 *
 * Estes cupons valem pra QUALQUER comprador e (diferente dos de vendedor) o
 * cliente DIGITA o código no carrinho - por isso rendem o post "cupom relâmpago".
 *
 * ⚠️ Fonte de terceiro: código pode estar vencido/inválido. O post sempre traz
 * as condições e a validade é do agregador, não do ML.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export interface FeedCoupon {
  code: string;
  /** Descrição do agregador, ex.: "R$20 off em Compras Acima de 199…". */
  description: string;
  /** Desconto extraído: percentual (20 = 20%) ou null. */
  percentOff: number | null;
  /** Desconto extraído: valor em R$ ou null. */
  amountOff: number | null;
  /** Compra mínima em R$ (ou null). */
  minPurchase: number | null;
  /** Teto de desconto em R$ (ou null). */
  capAmount: number | null;
  /** Agregadores onde o código foi visto. 2+ = confiança alta. */
  sources: string[];
}

interface Feed {
  name: string;
  url: string;
  /** 'selector' = código num atributo; 'table' = linha REGRA | CUPOM. */
  mode: 'selector' | 'table';
  /** Seletor dos elementos que carregam o código (modo selector). */
  codeSelector?: string;
  /** Atributo de onde tirar o código (modo selector). */
  codeAttr?: string;
  /**
   * Alguns sites publicam a lista numa página DATADA (muda todo dia). Quando
   * presente, buscamos `url` (um índice) e seguimos o link mais recente que
   * casa este padrão.
   */
  discoverLink?: RegExp;
}

const FEEDS: Feed[] = [
  {
    name: 'pelando',
    url: 'https://www.pelando.com.br/cupons-de-descontos/mercado-livre',
    mode: 'selector',
    codeSelector: '[data-copy-code]',
    codeAttr: 'data-copy-code',
  },
  {
    name: 'descontostop',
    url: 'https://descontostop.com/loja/cupom-desconto-mercado-livre/',
    mode: 'selector',
    codeSelector: '[data-code]',
    codeAttr: 'data-code',
  },
  {
    name: 'thiagorodrigo',
    url: 'https://thiagorodrigo.com.br/cupom-desconto-mercado-livre/',
    mode: 'selector',
    codeSelector: '[data-full-code]',
    codeAttr: 'data-full-code',
  },
  {
    // Publica numa página DATADA (muda todo dia): descobrimos o link mais
    // recente pela home. Conteúdo em TABELA (REGRA | CUPOM | LINK).
    name: 'melhorescartoes',
    url: 'https://www.melhorescartoes.com.br/',
    mode: 'table',
    discoverLink: /cupons?-mercado-livre[a-z0-9-]*\.html$/i,
  },
];

const cache: { at: number; coupons: FeedCoupon[] } = { at: 0, coupons: [] };

/** "R$ 1.234,56" / "1234" → número. */
function toNum(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Extrai desconto, compra mínima e teto da descrição do agregador. */
export function parseFeedDescription(
  desc: string
): Pick<FeedCoupon, 'percentOff' | 'amountOff' | 'minPurchase' | 'capAmount'> {
  const pct = desc.match(/(\d{1,2})\s*%\s*off/i);
  const amt = desc.match(/R?\$?\s*(\d{1,4}(?:[.,]\d{2})?)\s*off/i);
  const min = desc.match(/acima\s+(?:de\s+)?R?\$?\s*(\d{1,5}(?:[.,]\d{2})?)/i);
  const cap = desc.match(/limitad[oa]\s*(?:à|a|em)?\s*R?\$?\s*(\d{1,5}(?:[.,]\d{2})?)/i);
  return {
    percentOff: pct ? Number(pct[1]) : null,
    amountOff: pct ? null : toNum(amt?.[1]),
    minPurchase: toNum(min?.[1]),
    capAmount: toNum(cap?.[1]),
  };
}

/**
 * Acha a descrição do cupom subindo a árvore a partir do elemento do código.
 * Os agregadores variam muito de markup (às vezes o código está DENTRO do
 * título), então subimos até achar um texto que pareça regra de cupom do ML.
 */
function findDescription($: cheerio.CheerioAPI, el: AnyNode): string | null {
  const looksLikeRule = (t: string): boolean =>
    /mercado\s*livre|meli/i.test(t) && /%|R\$/i.test(t) && t.length < 220;

  let node = $(el);
  for (let up = 0; up < 5; up += 1) {
    // Texto de títulos/descrições dentro do container atual.
    const cand = node
      .find('h2,h3,h4,p,[class*="title"],[class*="desc"]')
      .map((_, e) => $(e).text().trim().replace(/\s+/g, ' '))
      .get()
      .find(looksLikeRule);
    if (cand) return cand;
    // Ou o próprio texto do nó (caso o código esteja dentro do título).
    const own = node.text().trim().replace(/\s+/g, ' ');
    if (looksLikeRule(own)) return own;
    const parent = node.parent();
    if (parent.length === 0) break;
    node = parent;
  }
  return null;
}

/** Código plausível de cupom (e não um token/hash). */
function isPlausibleCode(code: string, feedName: string): boolean {
  if (!/^[A-Z0-9]{4,24}$/.test(code)) return false;
  // Cupom do PRÓPRIO agregador (ex.: PELANDO250) não é do ML.
  if (code.includes(feedName.toUpperCase())) return false;
  // Precisa ter letra (hash puro numérico não é código de campanha).
  return /[A-Z]/.test(code);
}

async function getHtml(url: string): Promise<string | null> {
  const res = await axios.get<string>(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    timeout: 25000,
    responseType: 'text',
    validateStatus: () => true,
    maxRedirects: 5,
  });
  return res.status === 200 ? res.data : null;
}

async function fetchFeed(feed: Feed): Promise<Omit<FeedCoupon, 'sources'>[]> {
  let html = await getHtml(feed.url);
  if (!html) {
    logger.warn({ feed: feed.name }, '[ML/feeds] Agregador não respondeu 200.');
    return [];
  }

  // Página datada: segue o link mais recente do índice.
  if (feed.discoverLink) {
    const idx = cheerio.load(html);
    const links = [
      ...new Set(
        idx('a[href]')
          .map((_, a) => idx(a).attr('href') ?? '')
          .get()
          .filter((h) => feed.discoverLink!.test(h))
      ),
    ];
    if (links.length === 0) {
      logger.warn({ feed: feed.name }, '[ML/feeds] Não achei a página datada de cupons.');
      return [];
    }
    const target = new URL(links[0]!, feed.url).toString();
    html = await getHtml(target);
    if (!html) return [];
    logger.debug({ feed: feed.name, target }, '[ML/feeds] Página datada resolvida.');
  }

  const $ = cheerio.load(html);
  const out: Omit<FeedCoupon, 'sources'>[] = [];
  const seen = new Set<string>();

  if (feed.mode === 'table') {
    // Linha tipo: "20% OFF - limitado a R$100 - acima de R$29 | MELIOFFHJ | aqui"
    $('tr').each((_, tr) => {
      const cells = $(tr)
        .find('td')
        .map((__, td) => $(td).text().trim().replace(/\s+/g, ' '))
        .get();
      if (cells.length < 2) return;
      const codeCell = cells.find((c) => /^[A-Z0-9]{4,24}$/.test(c));
      if (!codeCell) return;
      const code = codeCell.toUpperCase();
      if (!isPlausibleCode(code, feed.name) || seen.has(code)) return;
      // A descrição é a célula mais longa (a "REGRA").
      const description = cells.filter((c) => c !== codeCell).sort((a, b) => b.length - a.length)[0] ?? '';
      if (!/%|R\$/i.test(description)) return; // sem regra reconhecível, pula
      seen.add(code);
      out.push({ code, description, ...parseFeedDescription(description) });
    });
    return out;
  }

  $(feed.codeSelector ?? '').each((_, el) => {
    const code = (feed.codeAttr ? $(el).attr(feed.codeAttr) : $(el).text())?.trim().toUpperCase();
    if (!code || !isPlausibleCode(code, feed.name) || seen.has(code)) return;

    const description = findDescription($, el);
    // Sem descrição de cupom do ML reconhecível, não dá pra anunciar com segurança.
    if (!description) return;
    seen.add(code);
    out.push({ code, description, ...parseFeedDescription(description) });
  });
  return out;
}

/**
 * Busca cupons de site inteiro nos agregadores. Cacheado por TTL (o conjunto
 * muda algumas vezes por dia).
 */
export async function fetchFeedCoupons({
  ttlMs = 60 * 60 * 1000,
}: { ttlMs?: number } = {}): Promise<FeedCoupon[]> {
  if (cache.at && Date.now() - cache.at < ttlMs) return cache.coupons;

  // VALIDAÇÃO CRUZADA: o mesmo código visto em N agregadores é muito mais
  // provável de estar válido (um site sozinho erra/atrasa). Guardamos em quantas
  // fontes cada código apareceu pra priorizar os confirmados.
  const byCode = new Map<string, FeedCoupon>();
  let feedsOk = 0;

  for (const feed of FEEDS) {
    let items: Omit<FeedCoupon, 'sources'>[] = [];
    try {
      items = await fetchFeed(feed);
      if (items.length > 0) feedsOk += 1;
    } catch (err) {
      logger.warn({ feed: feed.name, err: (err as Error).message }, '[ML/feeds] Falha no agregador.');
      continue;
    }
    for (const it of items) {
      const prev = byCode.get(it.code);
      if (prev) {
        if (!prev.sources.includes(feed.name)) prev.sources.push(feed.name);
        // Completa campos que a outra fonte não trouxe.
        prev.minPurchase ??= it.minPurchase;
        prev.capAmount ??= it.capAmount;
        prev.percentOff ??= it.percentOff;
        prev.amountOff ??= it.amountOff;
      } else {
        byCode.set(it.code, { ...it, sources: [feed.name] });
      }
    }
  }

  const out = [...byCode.values()];
  if (out.length === 0 && cache.coupons.length > 0) return cache.coupons; // não zera cache bom
  cache.at = Date.now();
  cache.coupons = out;

  const confirmados = out.filter((c) => c.sources.length >= 2);
  logger.info(
    {
      fontesOk: `${feedsOk}/${FEEDS.length}`,
      total: out.length,
      confirmados: confirmados.length,
      topConfirmados: confirmados.slice(0, 6).map((c) => c.code),
    },
    '[ML/feeds] Cupons de site inteiro (validação cruzada).'
  );
  return out;
}

/**
 * Ordena por CONFIANÇA e depois por valor: código visto em mais agregadores
 * primeiro (menos risco de postar cupom morto), depois maior desconto.
 */
export function rankFeedCoupons(coupons: FeedCoupon[]): FeedCoupon[] {
  const value = (c: FeedCoupon): number => c.amountOff ?? (c.percentOff ?? 0) * 2;
  return [...coupons].sort(
    (a, b) => b.sources.length - a.sources.length || value(b) - value(a)
  );
}

/** Só os cupons confirmados por 2+ agregadores (os mais seguros de postar). */
export function confirmedFeedCoupons(coupons: FeedCoupon[]): FeedCoupon[] {
  return rankFeedCoupons(coupons.filter((c) => c.sources.length >= 2));
}
