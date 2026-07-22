/**
 * DESCOBERTA DE CUPONS DE PERFUMARIA → cache em disco.
 *
 *   npm run discover-coupons              # varre a lista toda (~507 págs) e descobre
 *   npm run discover-coupons -- 40        # varre só as primeiras 40 páginas (teste)
 *
 * Fluxo (ver docs/handoff-cupons.md):
 *   1. varre GET /coupons?page=N (barato; só `page` funciona) — RESUMÍVEL
 *   2. filtra sellers de perfumaria (nome bate watchlist)
 *   3. resolve coupon-search-url + raspa a listing SÓ dos candidatos
 *   4. classifica (produtos-perfume) e grava data/perfume-coupons.json
 *
 * Tudo autenticado na sessão do usuário → pacing conservador. O sweep é salvo
 * incrementalmente em data/coupon-sweep.json; se o cookie expirar no meio, roda
 * de novo que ele retoma de onde parou.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import {
  couponsEnabled,
  sweepCouponList,
  discoverFromCoupons,
  type SweepState,
  type PerfumeCoupon,
} from '../providers/mercadolivre/coupons';

const SWEEP_FILE = path.resolve('data/coupon-sweep.json');
const CACHE_FILE = path.resolve('data/perfume-coupons.json');
// Teto de páginas: ~507 (7088/14). 600 dá folga se o pool crescer.
const MAX_PAGES_DEFAULT = 600;
// Idade máxima do sweep salvo pra ser reaproveitado (senão recomeça do zero).
const SWEEP_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheFile {
  generatedAt: string;
  totalSwept: number;
  candidatesScraped: number;
  coupons: PerfumeCoupon[];
}

function loadSweep(): SweepState | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(SWEEP_FILE, 'utf8')) as SweepState & { savedAt?: number };
    if (raw.savedAt && Date.now() - raw.savedAt > SWEEP_TTL_MS) {
      logger.info('[discover] Sweep salvo é velho (>24h) — recomeçando a varredura.');
      return undefined;
    }
    logger.info({ paginas: raw.lastPage, cupons: raw.coupons?.length }, '[discover] Retomando sweep salvo.');
    return { totalItems: raw.totalItems ?? null, lastPage: raw.lastPage ?? 0, coupons: raw.coupons ?? [] };
  } catch {
    return undefined;
  }
}

function saveSweep(s: SweepState): void {
  fs.mkdirSync(path.dirname(SWEEP_FILE), { recursive: true });
  fs.writeFileSync(SWEEP_FILE, JSON.stringify({ ...s, savedAt: Date.now() }, null, 2));
}

async function main(): Promise<void> {
  if (!couponsEnabled()) {
    logger.error('[discover] ML_AFFILIATE_COOKIE / ML_AFFILIATE_CSRF ausentes no .env.');
    process.exit(1);
  }
  const maxPages = Number(process.argv[2] ?? MAX_PAGES_DEFAULT) || MAX_PAGES_DEFAULT;

  // 1) Varredura da lista (resumível).
  logger.info({ maxPages }, '[discover] Varrendo a lista de cupons...');
  let lastLog = 0;
  const sweep = await sweepCouponList(maxPages, {
    state: loadSweep(),
    onPage: (s) => {
      saveSweep(s);
      if (s.lastPage - lastLog >= 10) {
        lastLog = s.lastPage;
        logger.info({ pagina: s.lastPage, cupons: s.coupons.length, total: s.totalItems }, '[discover] ...varrendo');
      }
    },
  });
  logger.info(
    { paginas: sweep.lastPage, cupons: sweep.coupons.length, total: sweep.totalItems },
    '[discover] Varredura concluída.'
  );

  // 2–4) Filtra perfumaria, resolve+raspa candidatos, classifica.
  logger.info('[discover] Resolvendo + raspando candidatos de perfumaria...');
  let scraped = 0;
  const perfumeCoupons = await discoverFromCoupons(sweep.coupons, {
    onCandidate: (info) => {
      scraped += 1;
      logger.info(
        { seller: info.seller, cupom: info.couponId, perfume: info.perfumeCount, total: info.total, mantido: info.kept },
        `[discover] candidato ${scraped}`
      );
    },
  });

  const cache: CacheFile = {
    generatedAt: new Date().toISOString(),
    totalSwept: sweep.coupons.length,
    candidatesScraped: scraped,
    coupons: perfumeCoupons,
  };
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

  logger.info(
    { cuponsPerfume: perfumeCoupons.length, arquivo: CACHE_FILE },
    '[discover] Cache de cupons de perfumaria gravado.'
  );
  console.log('\n===== CUPONS DE PERFUMARIA DESCOBERTOS =====');
  for (const c of perfumeCoupons) {
    console.log(
      `${c.title.padEnd(10)} ${c.seller.padEnd(24)} perfumes=${c.perfumeCount}/${c.totalProducts} exp=${c.expiration.slice(0, 10)} (cupom ${c.couponId})`
    );
    for (const p of c.products.slice(0, 3)) console.log(`    - ${p.title.slice(0, 60)}`);
  }
  if (perfumeCoupons.length === 0) console.log('(nenhum — tente aumentar o range de páginas ou revisar a watchlist)');
  console.log(`\nBanner do post: ${config.coupon.bannerPath || '(não configurado)'}`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[discover] Erro fatal.');
  process.exit(1);
});
