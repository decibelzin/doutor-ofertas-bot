import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { config } from '../config';
import { isInBank, lookupNotas } from '../format/perfumes';

/**
 * Diagnóstico READ-ONLY da API de cupons do painel de afiliado do ML.
 * Reconstruído a partir de docs/handoff-cupons.md (a versão da sessão 2 se
 * perdeu sem commit). Usa a MESMA auth do hub/createLink (cookie + csrf do
 * .env). Dumps completos vão pra PROBE_DUMP_DIR (ou ./data/probe-dumps).
 *
 * Subcomandos:
 *   creds                      valida cookie/csrf (200 = ok)
 *   coupons [page]             lista uma página de /coupons
 *   coupons-filters            prova que /coupons ignora filtros (só honra page)
 *   campaigns                  GET /get-campaigns
 *   aliases                    GET /coupons/aliases (403 histórico)
 *   exclusive                  GET /exclusive-offers (nunca testado)
 *   terms <couponId>           GET /coupon-terms?coupon_id=X
 *   resolve <page>             resolve coupon-search-url de todos os cupons da página
 *   scrape <url>               raspa uma listing de cupom → títulos + match no banco
 *   scan <fromPage> <toPage>   amostra: lista → resolve → raspa → % de cupons de perfume
 *   get <path>                 GET cru na base /affiliate-program/api/affiliates
 *   post <path> <json>         POST cru - ESCRITA, só rodar com OK explícito do usuário
 */

const BASE = 'https://www.mercadolivre.com.br/affiliate-program/api/affiliates';
const UA_PANEL =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0';

const DUMP_DIR = process.env.PROBE_DUMP_DIR ?? path.resolve('data/probe-dumps');

// Pacing conservador: chamadas autenticadas usam a sessão real do afiliado.
const AUTH_DELAY_MS = 1000;
const SCRAPE_DELAY_MS = 800; // raspagem agora vai com cookie => tráfego da sessão, devagar

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * 250)));
}

function dump(name: string, data: unknown): string {
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const file = path.join(DUMP_DIR, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return file;
}

function authHeaders(): Record<string, string> {
  return {
    'User-Agent': UA_PANEL,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: 'https://www.mercadolivre.com.br',
    Referer: 'https://www.mercadolivre.com.br/afiliados/cupons',
    'x-csrf-token': config.mercadoLivre.affiliateCsrf,
    Cookie: config.mercadoLivre.affiliateCookie,
  };
}

interface ApiResult {
  status: number;
  data: unknown;
}

async function apiGet(pathAndQuery: string): Promise<ApiResult> {
  const { status, data } = await axios.get(`${BASE}${pathAndQuery}`, {
    headers: authHeaders(),
    timeout: 20000,
    validateStatus: () => true,
  });
  return { status, data };
}

async function apiPost(pathOnly: string, body: unknown): Promise<ApiResult> {
  const { status, data } = await axios.post(`${BASE}${pathOnly}`, body, {
    headers: authHeaders(),
    timeout: 20000,
    validateStatus: () => true,
  });
  return { status, data };
}

interface Coupon {
  in_use: boolean;
  id: number;
  title: string;
  category: string;
  remaining_budget: number;
  expiration_date: string;
  container_name: string;
  seller: string;
}

interface CouponsPage {
  prefix?: string;
  coupons?: Coupon[];
  page?: number;
  items_per_page?: number;
  total_items?: number;
}

async function getCouponsPage(page: number): Promise<CouponsPage> {
  const { status, data } = await apiGet(`/coupons?page=${page}`);
  if (status !== 200) {
    throw new Error(`GET /coupons?page=${page} -> ${status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data as CouponsPage;
}

/** Extrai seller-id / cust-id da coupons_product_url. */
function parseSearchUrl(url: string): { sellerId: string | null; custId: string | null; kind: string } {
  const seller = url.match(/-seller-(\d+)/);
  const cust = url.match(/_CustId_(\d+)/);
  return {
    sellerId: seller?.[1] ?? null,
    custId: cust?.[1] ?? null,
    kind: url.includes('_Container_') ? 'container' : cust ? 'custid' : 'outro',
  };
}

interface ScrapedListing {
  titles: string[];
  bankMatches: string[];
  keywordMatches: string[];
}

const PERFUME_KEYWORDS = /\b(perfume|parfum|eau de|edt|edp|col[oô]nia|fragr[aâ]ncia|desodorante col)\b/i;

async function scrapeListing(rawUrl: string): Promise<ScrapedListing> {
  // A listing exige a SESSÃO LOGADA: sem cookie o ML redireciona (200) pra
  // /gz/account-verification e devolve página vazia. Descoberto em 2026-07-22.
  // O ?coupon_campaign_id precisa ser REMOVIDO: em alguns containers ele causa
  // 404 direto (ex.: Perfumes_bhz); quando funciona, o ML redireciona
  // descartando-o de qualquer jeito. O conjunto de produtos é o mesmo sem ele.
  const url = rawUrl.split('?')[0];
  const res = await axios.get<string>(url, {
    headers: {
      'User-Agent': UA_PANEL,
      'Accept-Language': 'pt-BR,pt;q=0.9',
      Cookie: config.mercadoLivre.affiliateCookie,
    },
    timeout: 25000,
    responseType: 'text',
    validateStatus: () => true,
  });
  const finalUrl: string =
    (res.request as { res?: { responseUrl?: string } })?.res?.responseUrl ?? url;
  if (finalUrl.includes('account-verification')) throw new Error('account-verification wall');
  if (res.status !== 200) throw new Error(`scrape ${res.status}`);
  const data = res.data;
  const $ = cheerio.load(data);
  const titles: string[] = [];
  $('.poly-component__title').each((_, el) => {
    const t = $(el).text().trim();
    if (t) titles.push(t);
  });
  return {
    titles,
    bankMatches: titles.filter((t) => isInBank(t)),
    keywordMatches: titles.filter((t) => PERFUME_KEYWORDS.test(t)),
  };
}

// ---------------------------------------------------------------------------
// Subcomandos
// ---------------------------------------------------------------------------

async function cmdCreds(): Promise<void> {
  const { status, data } = await apiGet('/coupons?page=1');
  const d = data as CouponsPage;
  console.log(`GET /coupons?page=1 -> ${status}`);
  if (status === 200) {
    console.log(`prefix=${d.prefix} total_items=${d.total_items} items_per_page=${d.items_per_page}`);
    console.log('Cookie/csrf VÁLIDOS.');
  } else {
    console.log(JSON.stringify(data).slice(0, 500));
    console.log('Cookie/csrf INVÁLIDOS ou expirados - recapturar do painel e colar no .env.');
  }
}

async function cmdCoupons(page: number): Promise<void> {
  const d = await getCouponsPage(page);
  console.log(`page=${d.page} total=${d.total_items} prefix=${d.prefix}`);
  for (const c of d.coupons ?? []) {
    console.log(
      `${c.id}\t${c.title}\t${c.category}\tseller=${c.seller}\tbudget=${c.remaining_budget}\texp=${c.expiration_date}`
    );
  }
  console.log(`dump: ${dump(`coupons-p${page}.json`, d)}`);
}

async function cmdCouponsFilters(): Promise<void> {
  const variants = [
    '/coupons?page=1',
    '/coupons?page=2',
    '/coupons?page=1&items_per_page=50',
    '/coupons?page=1&status=ACTIVE',
    '/coupons?page=1&filter_tag=perfume',
    '/coupons?page=1&site_id=MLB&sort_by=MOST_RECENT',
  ];
  for (const v of variants) {
    const { status, data } = await apiGet(v);
    const d = data as CouponsPage;
    const first = d.coupons?.[0]?.id;
    console.log(
      `${v} -> ${status} total=${d.total_items} n=${d.coupons?.length} firstId=${first}`
    );
    await sleep(AUTH_DELAY_MS);
  }
  console.log('(Se total/firstId não mudam fora o page, o servidor ignora o filtro.)');
}

async function cmdCampaigns(): Promise<void> {
  const { status, data } = await apiGet('/get-campaigns');
  console.log(`GET /get-campaigns -> ${status}`);
  console.log(JSON.stringify(data, null, 2).slice(0, 2000));
}

async function cmdAliases(): Promise<void> {
  const { status, data } = await apiGet('/coupons/aliases');
  console.log(`GET /coupons/aliases -> ${status}`);
  console.log(JSON.stringify(data, null, 2).slice(0, 2000));
}

async function cmdExclusive(): Promise<void> {
  const { status, data } = await apiGet('/exclusive-offers');
  console.log(`GET /exclusive-offers -> ${status}`);
  console.log(JSON.stringify(data, null, 2).slice(0, 3000));
  dump('exclusive-offers.json', data);
}

async function cmdTerms(couponId: string): Promise<void> {
  const { status, data } = await apiGet(`/coupon-terms?coupon_id=${couponId}`);
  console.log(`GET /coupon-terms?coupon_id=${couponId} -> ${status}`);
  console.log(JSON.stringify(data, null, 2).slice(0, 2000));
}

async function cmdResolve(page: number): Promise<void> {
  const d = await getCouponsPage(page);
  for (const c of d.coupons ?? []) {
    await sleep(AUTH_DELAY_MS);
    const { status, data } = await apiGet(`/coupon-search-url?coupon_id=${c.id}`);
    const url = (data as { coupons_product_url?: string })?.coupons_product_url;
    const info = url ? parseSearchUrl(url) : null;
    console.log(
      `${c.id}\t${c.seller}\t${status}\t${info?.kind ?? '-'}\tseller_id=${info?.sellerId ?? info?.custId ?? '-'}\t${url ?? ''}`
    );
  }
}

async function cmdScrape(url: string): Promise<void> {
  const r = await scrapeListing(url);
  console.log(`titulos=${r.titles.length} banco=${r.bankMatches.length} keyword=${r.keywordMatches.length}`);
  for (const t of r.titles) {
    const flag = r.bankMatches.includes(t) ? ' [BANCO]' : r.keywordMatches.includes(t) ? ' [kw]' : '';
    console.log(`- ${t}${flag}`);
  }
}

// ---------------------------------------------------------------------------
// bundle: acha o chunk do serviço de cupons no frontend e mostra como o
// createCode monta o body (pra não chutar escrita às cegas).
// ---------------------------------------------------------------------------

async function cmdBundle(): Promise<void> {
  // 1) HTML do painel (autenticado) → URLs dos assets affiliates-site.
  // A rota exata do painel de cupons varia; tenta candidatas até uma responder.
  const candidates = [
    'https://www.mercadolivre.com.br/afiliados/incentives',
    'https://www.mercadolivre.com.br/afiliados/exclusive-campaigns',
    'https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true',
  ];
  let page: { status: number; data: string } = { status: 0, data: '' };
  for (const cand of candidates) {
    page = await axios.get<string>(cand, {
      headers: {
        'User-Agent': UA_PANEL,
        'Accept-Language': 'pt-BR,pt;q=0.9',
        Cookie: config.mercadoLivre.affiliateCookie,
      },
      timeout: 25000,
      responseType: 'text',
      validateStatus: () => true,
      maxRedirects: 5,
    });
    console.log(`painel ${cand} -> ${page.status} len=${page.data.length}`);
    if (page.status === 200 && page.data.length > 1000) {
      // Links pra outras rotas de cupom que a página conheça (pra debug).
      const links = [...new Set(page.data.match(/\/afiliados\/[a-z-]*cup[a-z-]*/g) ?? [])];
      if (links.length) console.log(`  rotas de cupom vistas: ${links.join(', ')}`);
      break;
    }
    await sleep(400);
  }
  if (page.status !== 200 || page.data.length < 1000) {
    console.log('Nenhuma rota do painel respondeu com HTML útil.');
    return;
  }
  const assetUrls = [
    ...new Set(
      page.data.match(/https?:\/\/http2\.mlstatic\.com\/frontend-assets\/affiliates-site\/[^"' ]+\.js/g) ?? []
    ),
  ];
  console.log(`assets affiliates-site: ${assetUrls.length}`);
  for (const u of assetUrls) console.log(`  ${u}`);
  dump('panel-cupons.html', page.data);

  // 2) Baixa cada asset (público) e procura o que contém o serviço de cupom.
  for (const u of assetUrls) {
    const js = await axios.get<string>(u, { timeout: 25000, responseType: 'text' });
    if (!js.data.includes('create-code')) continue;
    console.log(`\n== chunk com create-code: ${u}`);
    const file = dump(u.split('/').pop() ?? 'chunk.js', js.data);
    console.log(`dump: ${file}`);
    // Mostra o trecho em volta de cada menção (pra ler assinatura/body).
    let idx = 0;
    while ((idx = js.data.indexOf('create-code', idx)) !== -1) {
      console.log(`\n--- contexto @${idx}:`);
      console.log(js.data.slice(Math.max(0, idx - 700), idx + 300));
      idx += 1;
    }
    return;
  }
  console.log('Nenhum asset direto contém create-code - procurando manifest de chunks...');
  // 3) Fallback: index com mapa de chunks lazy (id → hash).
  for (const u of assetUrls) {
    const js = await axios.get<string>(u, { timeout: 25000, responseType: 'text' });
    const map = js.data.match(/\{(\d+:"[a-f0-9]{8,}",?)+\}/g);
    if (!map) continue;
    console.log(`manifest candidato em ${u}: ${map[0]!.slice(0, 200)}...`);
    const pairs = [...map.join(',').matchAll(/(\d+):"([a-f0-9]{8,})"/g)];
    console.log(`chunks no mapa: ${pairs.length} - baixando até achar create-code`);
    for (const [, id, hash] of pairs) {
      const cu = `https://http2.mlstatic.com/frontend-assets/affiliates-site/${id}.${hash}.js`;
      try {
        const cjs = await axios.get<string>(cu, { timeout: 25000, responseType: 'text' });
        if (cjs.data.includes('create-code')) {
          console.log(`\n== chunk com create-code: ${cu}`);
          const file = dump(`${id}.${hash}.js`, cjs.data);
          console.log(`dump: ${file}`);
          let idx = 0;
          while ((idx = cjs.data.indexOf('create-code', idx)) !== -1) {
            console.log(`\n--- contexto @${idx}:`);
            console.log(cjs.data.slice(Math.max(0, idx - 700), idx + 300));
            idx += 1;
          }
          return;
        }
      } catch {
        // chunk fora do padrão de URL - segue
      }
      await sleep(150);
    }
  }
  console.log('Não achei o chunk - inspecionar panel-cupons.html manualmente.');
}

// ---------------------------------------------------------------------------
// scan: amostra de prevalência de cupons de perfume
// ---------------------------------------------------------------------------

interface ScanEntry {
  couponId: number;
  couponTitle: string;
  seller: string;
  expiration: string;
  budget: number;
  searchUrl: string | null;
  urlKind: string | null;
  sellerId: string | null;
  nTitles: number | null;
  nBank: number | null;
  nKeyword: number | null;
  bankExamples: Array<{ title: string; notas: string[] | null }>;
  error: string | null;
}

interface ScanFile {
  startedAt: string;
  pages: number[];
  totalItems: number | null;
  entries: ScanEntry[];
}

async function cmdScan(fromPage: number, toPage: number): Promise<void> {
  const outFile = path.join(DUMP_DIR, `perfume-scan-p${fromPage}-${toPage}.json`);
  fs.mkdirSync(DUMP_DIR, { recursive: true });

  // Resumível: recarrega o que já foi processado.
  let state: ScanFile = {
    startedAt: new Date().toISOString(),
    pages: [],
    totalItems: null,
    entries: [],
  };
  // URLs já resolvidas em runs anteriores (mesmo os que falharam na raspagem):
  // reusa pra não repetir chamadas autenticadas de coupon-search-url.
  const knownUrls = new Map<number, string>();
  if (fs.existsSync(outFile)) {
    state = JSON.parse(fs.readFileSync(outFile, 'utf8')) as ScanFile;
    for (const e of state.entries) if (e.searchUrl) knownUrls.set(e.couponId, e.searchUrl);
    // Re-processa o que falhou ou veio vazio (ex.: muro account-verification).
    const before = state.entries.length;
    state.entries = state.entries.filter((e) => !e.error && (e.nTitles ?? 0) > 0);
    console.log(
      `[scan] retomando: ${state.entries.length} ok mantidos, ${before - state.entries.length} a re-processar (${knownUrls.size} URLs reusáveis)`
    );
  }
  const done = new Set(state.entries.map((e) => e.couponId));
  const save = (): void => {
    fs.writeFileSync(outFile, JSON.stringify(state, null, 2));
  };

  // Cache de raspagem por conjunto de produtos (url sem query): cupons da mesma
  // loja apontam pro mesmo catálogo - raspa 1x.
  const scrapeCache = new Map<string, ScrapedListing | { error: string }>();

  for (let page = fromPage; page <= toPage; page += 1) {
    let coupons: Coupon[];
    try {
      const d = await getCouponsPage(page);
      state.totalItems = d.total_items ?? state.totalItems;
      if (!state.pages.includes(page)) state.pages.push(page);
      coupons = d.coupons ?? [];
    } catch (err) {
      console.error(`[scan] page ${page}: ${(err as Error).message}`);
      break; // provável credencial expirada / rate-limit - parar e preservar estado
    }
    console.log(`[scan] page ${page}: ${coupons.length} cupons`);

    for (const c of coupons) {
      if (done.has(c.id)) continue;
      const entry: ScanEntry = {
        couponId: c.id,
        couponTitle: c.title,
        seller: c.seller,
        expiration: c.expiration_date,
        budget: c.remaining_budget,
        searchUrl: null,
        urlKind: null,
        sellerId: null,
        nTitles: null,
        nBank: null,
        nKeyword: null,
        bankExamples: [],
        error: null,
      };

      try {
        let url = knownUrls.get(c.id) ?? null;
        if (!url) {
          await sleep(AUTH_DELAY_MS);
          const { status, data } = await apiGet(`/coupon-search-url?coupon_id=${c.id}`);
          if (status !== 200) throw new Error(`coupon-search-url ${status}`);
          url = (data as { coupons_product_url?: string })?.coupons_product_url ?? null;
        }
        entry.searchUrl = url;
        if (url) {
          const info = parseSearchUrl(url);
          entry.urlKind = info.kind;
          entry.sellerId = info.sellerId ?? info.custId;

          const cacheKey = url.split('?')[0];
          let listing = scrapeCache.get(cacheKey);
          if (!listing) {
            await sleep(SCRAPE_DELAY_MS);
            try {
              listing = await scrapeListing(url);
            } catch (err) {
              listing = { error: (err as Error).message };
            }
            scrapeCache.set(cacheKey, listing);
          }
          if ('error' in listing) {
            entry.error = `scrape: ${listing.error}`;
          } else {
            entry.nTitles = listing.titles.length;
            entry.nBank = listing.bankMatches.length;
            entry.nKeyword = listing.keywordMatches.length;
            entry.bankExamples = listing.bankMatches
              .slice(0, 5)
              .map((t) => ({ title: t, notas: lookupNotas(t) }));
          }
        }
      } catch (err) {
        entry.error = (err as Error).message;
      }

      state.entries.push(entry);
      done.add(c.id);
      save();
      const tag =
        entry.nBank && entry.nBank > 0 ? ' <-- PERFUME (banco)' : entry.nKeyword ? ' (kw)' : '';
      console.log(
        `[scan] ${c.id} ${c.seller} titles=${entry.nTitles ?? '-'} bank=${entry.nBank ?? '-'} kw=${entry.nKeyword ?? '-'}${entry.error ? ` ERRO=${entry.error}` : ''}${tag}`
      );
    }
  }

  // Resumo
  const resolved = state.entries.filter((e) => e.searchUrl);
  const scraped = state.entries.filter((e) => e.nTitles !== null);
  const perfumeBank = state.entries.filter((e) => (e.nBank ?? 0) > 0);
  const perfumeKw = state.entries.filter((e) => (e.nKeyword ?? 0) > 0);
  console.log('\n===== RESUMO DO SCAN =====');
  console.log(`cupons processados: ${state.entries.length} (de ${state.totalItems} no total)`);
  console.log(`resolvidos (search-url ok): ${resolved.length}`);
  console.log(`raspados ok: ${scraped.length} (cache dedupe por loja aplicado)`);
  console.log(`com perfume DO BANCO: ${perfumeBank.length}`);
  console.log(`com keyword de perfumaria: ${perfumeKw.length}`);
  for (const e of perfumeBank) {
    console.log(`\n  cupom ${e.couponId} "${e.couponTitle}" seller=${e.seller} (${e.nBank}/${e.nTitles} no banco)`);
    for (const ex of e.bankExamples) console.log(`    - ${ex.title}`);
  }
  console.log(`\narquivo: ${outFile}`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!config.mercadoLivre.affiliateCookie || !config.mercadoLivre.affiliateCsrf) {
    console.error('ML_AFFILIATE_COOKIE / ML_AFFILIATE_CSRF ausentes no .env');
    process.exit(1);
  }
  const [cmd, a1, a2] = process.argv.slice(2);
  switch (cmd) {
    case 'creds':
      return cmdCreds();
    case 'coupons':
      return cmdCoupons(Number(a1 ?? 1));
    case 'coupons-filters':
      return cmdCouponsFilters();
    case 'campaigns':
      return cmdCampaigns();
    case 'bundle':
      return cmdBundle();
    case 'aliases':
      return cmdAliases();
    case 'exclusive':
      return cmdExclusive();
    case 'terms':
      if (!a1) throw new Error('uso: terms <couponId>');
      return cmdTerms(a1);
    case 'resolve':
      return cmdResolve(Number(a1 ?? 1));
    case 'scrape':
      if (!a1) throw new Error('uso: scrape <url>');
      return cmdScrape(a1);
    case 'scan':
      if (!a1 || !a2) throw new Error('uso: scan <fromPage> <toPage>');
      return cmdScan(Number(a1), Number(a2));
    case 'get': {
      if (!a1) throw new Error('uso: get "/caminho?query"');
      const { status, data } = await apiGet(a1);
      console.log(`GET ${a1} -> ${status}`);
      console.log(JSON.stringify(data, null, 2).slice(0, 4000));
      return;
    }
    case 'post': {
      // ESCRITA na conta do afiliado - só rodar com OK explícito do usuário.
      if (!a1 || !a2) throw new Error('uso: post "/caminho" \'{"json":1}\'');
      const { status, data } = await apiPost(a1, JSON.parse(a2));
      console.log(`POST ${a1} -> ${status}`);
      console.log(JSON.stringify(data, null, 2).slice(0, 4000));
      return;
    }
    default:
      console.log(
        'subcomandos: creds | coupons [page] | coupons-filters | campaigns | aliases | exclusive | terms <id> | resolve <page> | scrape <url> | scan <from> <to> | get <path> | post <path> <json>'
      );
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
