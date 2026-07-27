import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import type { WASocket } from '@whiskeysockets/baileys';
import { config } from '../config';
import { logger } from '../logger';
import { store } from './store';
import { loadNiches } from './niches';
import { sendToGroup, fetchDealImage } from '../whatsapp/sender';
import { enrichWithShortLink } from '../providers/mercadolivre/shortlink';
import { formatPerfumeCoupon } from '../format/coupon';
import { resolvePreset } from '../format/title';
import { sleep, randomDelay } from '../util/time';
import {
  couponsEnabled,
  sweepCouponList,
  discoverFromCoupons,
  type SweepState,
  type PerfumeCoupon,
} from '../providers/mercadolivre/coupons';
import type { Deal } from './deal';

/**
 * Núcleo COMPARTILHADO da automação de cupom: descoberta (varre → cache) e
 * postagem (escolhe → posta). Usado pelos CLIs (discover-coupons,
 * post-perfume-coupon) E pelo scheduler (modo live). Sem process.exit aqui -
 * cada chamador decide o que fazer com o resultado.
 */

const SWEEP_FILE = path.resolve('data/coupon-sweep.json');
const CACHE_FILE = path.resolve('data/perfume-coupons.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_TTL_MS = 24 * 60 * 60 * 1000;
const COUPONS_PER_PAGE = 14;
export const DEFAULT_MAX_PAGES = 600;

export interface CouponCacheFile {
  generatedAt: string;
  totalSwept: number;
  candidatesScraped: number;
  coupons: PerfumeCoupon[];
}

// ---------------------------------------------------------------------------
// I/O do cache (atômico)
// ---------------------------------------------------------------------------

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Lê o cache de cupons. null = ausente ou ilegível (parcial/corrompido). */
export function loadCouponCache(): CouponCacheFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(CACHE_FILE, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as CouponCacheFile;
  } catch {
    logger.warn({ file: CACHE_FILE }, '[coupon] Cache ilegível (parcial/corrompido) - ignorando.');
    return null;
  }
}

/** Idade do cache em ms (Infinity se não existe / sem data). */
export function couponCacheAgeMs(): number {
  const cache = loadCouponCache();
  if (!cache?.generatedAt) return Infinity;
  const dt = DateTime.fromISO(cache.generatedAt);
  return dt.isValid ? Date.now() - dt.toMillis() : Infinity;
}

function loadSweep(): SweepState | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(SWEEP_FILE, 'utf8')) as SweepState & { savedAt?: number };
    if (raw.savedAt && Date.now() - raw.savedAt > SWEEP_TTL_MS) return undefined;
    return { totalItems: raw.totalItems ?? null, lastPage: raw.lastPage ?? 0, coupons: raw.coupons ?? [] };
  } catch {
    return undefined;
  }
}

function saveSweep(s: SweepState): void {
  writeAtomic(SWEEP_FILE, JSON.stringify({ ...s, savedAt: Date.now() }, null, 2));
}

function existingCacheCount(): number {
  return loadCouponCache()?.coupons?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Descoberta (varre lista → resolve/raspa candidatos → grava cache)
// ---------------------------------------------------------------------------

export interface RefreshResult {
  written: boolean;
  count: number;
  candidates: number;
  errors: number;
  authFailed: boolean;
  reason?: string;
}

export interface RefreshOptions {
  maxPages?: number;
  onPage?: (s: SweepState) => void;
  onCandidate?: (info: { seller: string; couponId: number; perfumeCount: number; total: number; kept: boolean }) => void;
}

/**
 * Atualiza o cache de cupons de perfumaria. Resumível (reaproveita o sweep de
 * <24h). Guarda contra sobrescrever cache bom com vazio quando a auth cai.
 */
export async function refreshCouponCache(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  if (!couponsEnabled()) {
    return { written: false, count: 0, candidates: 0, errors: 0, authFailed: true, reason: 'sem cookie/csrf' };
  }

  const sweep = await sweepCouponList(maxPages, {
    state: loadSweep(),
    onPage: (s) => {
      saveSweep(s);
      opts.onPage?.(s);
    },
  });

  // Só as primeiras `maxPages` páginas (escopo do teste; largo = tudo).
  const scope = sweep.coupons.slice(0, maxPages * COUPONS_PER_PAGE);
  const result = await discoverFromCoupons(scope, { onCandidate: opts.onCandidate });

  // Não zera um cache bom quando degradou (auth/erros) e achou nada.
  const prior = existingCacheCount();
  if (result.coupons.length === 0 && (result.authFailed || result.errors > 0) && prior > 0) {
    logger.warn(
      { authFailed: result.authFailed, erros: result.errors, cacheAntigo: prior },
      '[coupon] Descoberta degradou e não achou nada - PRESERVANDO cache anterior.'
    );
    return {
      written: false,
      count: 0,
      candidates: result.candidates,
      errors: result.errors,
      authFailed: result.authFailed,
      reason: 'degradado - cache preservado',
    };
  }

  const cache: CouponCacheFile = {
    generatedAt: new Date().toISOString(),
    totalSwept: scope.length,
    candidatesScraped: result.candidates,
    coupons: result.coupons,
  };
  writeAtomic(CACHE_FILE, JSON.stringify(cache, null, 2));
  return {
    written: true,
    count: result.coupons.length,
    candidates: result.candidates,
    errors: result.errors,
    authFailed: result.authFailed,
  };
}

// ---------------------------------------------------------------------------
// Postagem (escolhe cupom+produto → posta nos grupos de perfume)
// ---------------------------------------------------------------------------

/** O ML manda expiração como timestamp INGÊNUO em UTC - parseia como UTC. */
function notExpired(c: PerfumeCoupon): boolean {
  const exp = DateTime.fromISO(c.expiration, { zone: 'utc' });
  return !exp.isValid || exp > DateTime.now();
}

/** Grupos-alvo: nichos cujo nome sugere perfume; senão, todos os grupos. */
export function couponTargetGroups(): string[] {
  const niches = loadNiches();
  const perfumeNiches = niches.filter((n) => /perfum|fragr/i.test(n.name));
  const chosen = perfumeNiches.length ? perfumeNiches : niches;
  return [...new Set(chosen.flatMap((n) => n.groups))];
}

/**
 * Escolhe (cupom, produto) pra postar: entre os cupons válidos (opcionalmente
 * filtrados por `couponId`), o produto-perfume de MAIOR desconto ainda não
 * postado no cooldown. Prioriza cupom de maior % (mais grana por post).
 */
export function pickCoupon(
  cache: CouponCacheFile,
  couponId: number | null = null
): { coupon: PerfumeCoupon; deal: Deal } | null {
  const cooldownMs = config.dedup.cooldownDays * DAY_MS;
  const coupons = cache.coupons
    .filter(notExpired)
    .filter((c) => couponId === null || c.couponId === couponId)
    .sort((a, b) => (b.discountPercent ?? 0) - (a.discountPercent ?? 0));

  for (const coupon of coupons) {
    const eligible = coupon.products
      .filter((d) => store.canPostNow(d.id, d.discountPercent ?? 0, cooldownMs))
      .sort((a, b) => (b.discountPercent ?? 0) - (a.discountPercent ?? 0));
    if (eligible.length === 0) continue;
    // Novidade-first também no cupom: perfume nunca postado ganha do evergreen.
    const fresh = eligible.filter((d) => !store.hasEverPosted(d.id));
    return { coupon, deal: (fresh.length ? fresh : eligible)[0]! };
  }
  return null;
}

export interface CouponPostResult {
  coupon: PerfumeCoupon;
  deal: Deal;
  text: string;
  groups: string[];
  posted: number;
  dry: boolean;
}

/**
 * Escolhe e posta UM perfume+cupom. `dry` só monta a mensagem (não envia;
 * `sock` pode ser null). Retorna null se não há nada postável.
 */
export async function runCouponPost(
  sock: WASocket | null,
  opts: { couponId?: number | null; dry?: boolean } = {}
): Promise<CouponPostResult | null> {
  const cache = loadCouponCache();
  if (!cache) {
    logger.warn('[coupon] Sem cache de cupons - rode a descoberta antes.');
    return null;
  }
  const chosen = pickCoupon(cache, opts.couponId ?? null);
  if (!chosen) {
    logger.info('[coupon] Nada postável (cache vazio, tudo no cooldown, ou cupom expirado).');
    return null;
  }
  const { coupon, deal } = chosen;

  // Link curto oficial (meli.la); se falhar, mantém o matt que já veio no deal.
  await enrichWithShortLink(deal);
  const text = formatPerfumeCoupon(deal, coupon);
  const groups = couponTargetGroups();

  if (opts.dry) {
    return { coupon, deal, text, groups, posted: 0, dry: true };
  }
  if (!sock) throw new Error('runCouponPost: sock ausente pra envio real');
  if (groups.length === 0) {
    logger.error('[coupon] Nenhum grupo configurado (config/niches.json).');
    return null;
  }

  const preset = resolvePreset(deal.title, deal.id);
  const image = await fetchDealImage(deal, preset?.imagem);
  let posted = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const groupId = groups[i]!;
    try {
      const msgId = await sendToGroup(sock, groupId, text, image);
      store.markPosted(deal, groupId, msgId);
      posted += 1;
      logger.info({ groupId, produto: deal.title, cupom: coupon.couponId }, '[coupon] Perfume+cupom enviado.');
    } catch (err) {
      logger.error({ err: (err as Error).message, groupId }, '[coupon] Falha ao enviar.');
    }
    if (i < groups.length - 1) {
      await sleep(randomDelay(config.throttle.groupDelayMinMs, config.throttle.groupDelayMaxMs));
    }
  }
  return { coupon, deal, text, groups, posted, dry: false };
}
