import fs from 'node:fs';
import path from 'node:path';
import type { WASocket } from '@whiskeysockets/baileys';
import { config } from '../config';
import { logger } from '../logger';
import { loadNiches } from './niches';
import { broadcastCoupon } from '../whatsapp/sender';
import { writeFileAtomic } from '../util/atomic';
import { fetchSpecialCoupons, type SpecialCoupon } from '../providers/mercadolivre/public-coupons';
import { fetchFeedCoupons, rankFeedCoupons, confirmedFeedCoupons, type FeedCoupon } from '../providers/mercadolivre/coupon-feeds';

/**
 * ANÚNCIO AUTOMÁTICO DE CUPONS NOVOS ("CUPOM LIBERADO"): quando aparecem
 * códigos que ainda não anunciamos, dispara UMA mensagem com o banner + a lista
 * de todos os códigos vigentes (formato dos canais concorrentes).
 *
 * Cuidados:
 *  - só dispara se houver código NOVO (nunca reanuncia o mesmo);
 *  - respeita um intervalo mínimo entre anúncios (@all é sensível a spam/ban);
 *  - histórico persistido em data/announced-coupons.json.
 */

const STATE_FILE = path.resolve('data/announced-coupons.json');

interface AnnouncedState {
  /** code -> quando foi anunciado (epoch ms). */
  announced: Record<string, number>;
  lastAnnounceAt: number;
}

function loadState(): AnnouncedState {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as AnnouncedState;
    return { announced: s.announced ?? {}, lastAnnounceAt: s.lastAnnounceAt ?? 0 };
  } catch {
    return { announced: {}, lastAnnounceAt: 0 };
  }
}

function saveState(s: AnnouncedState): void {
  writeFileAtomic(STATE_FILE, JSON.stringify(s, null, 2));
}

/** Grupos-alvo do anúncio: todos os grupos de todos os nichos. */
function allGroups(): string[] {
  return [...new Set(loadNiches().flatMap((n) => n.groups))];
}

/** Linha de um cupom do agregador: "🎟️ R$20 OFF acima de R$199: *ALLSITE25*". */
function feedLine(c: FeedCoupon): string {
  const val = c.percentOff !== null ? `${c.percentOff}% OFF` : c.amountOff !== null ? `R$${c.amountOff} OFF` : 'Desconto';
  const min = c.minPurchase !== null ? ` em compras acima de R$${c.minPurchase}` : '';
  return `🎟️ ${val}${min}: *${c.code}*`;
}

/** Monta a mensagem no formato "CUPOM LIBERADO" (multi-cupom). */
export function formatCouponAnnouncement(coupons: SpecialCoupon[], feed: FeedCoupon[] = []): string {
  const blocks: string[] = ['🚨 *NOVOS CUPONS MERCADO LIVRE!*', '*Usem nos perfumes enviados anteriormente* 🔥'];

  const lines: string[] = [];
  // Cupons de site inteiro (agregador) primeiro — são os mais fortes.
  for (const c of feed) lines.push(feedLine(c));
  for (const c of coupons) {
    const cond = c.minAmountText ? ` ${c.minAmountText.toLowerCase()}` : '';
    lines.push(`🎟️ ${c.title.trim()}${cond}: *${c.code}*`);
  }
  blocks.push(lines.join('\n\n'));

  const exp = coupons.map((c) => c.expirationText).find(Boolean);
  if (exp) blocks.push(`⏳ _${exp}_`);

  blocks.push('👉 Ative em: mercadolivre.com.br/cupons');
  if (config.coupon.searchLink) blocks.push(`🛒 ${config.coupon.searchLink}`);
  return blocks.join('\n\n');
}

export interface AnnounceResult {
  newCodes: string[];
  text: string;
  groups: string[];
  posted: number;
  dry: boolean;
}

/**
 * Anuncia os cupons novos, se houver. Retorna null quando não há nada novo (ou
 * o intervalo mínimo ainda não passou).
 */
export async function announceNewCoupons(
  sock: WASocket | null,
  opts: { dry?: boolean; force?: boolean } = {}
): Promise<AnnounceResult | null> {
  const coupons = await fetchSpecialCoupons();
  // Cupons de SITE INTEIRO dos agregadores (ALLSITE25, TODOSITE25...) — os mais
  // fortes e os que os concorrentes postam. Top N pra mensagem não virar lista.
  // Prioriza os CONFIRMADOS por 2+ agregadores (menor risco de código morto);
  // se não houver confirmados suficientes, completa com os melhores restantes.
  const allFeed = await fetchFeedCoupons();
  const max = config.coupon.announceMaxFeedCoupons;
  const confirmed = confirmedFeedCoupons(allFeed);
  const feed =
    confirmed.length >= max
      ? confirmed.slice(0, max)
      : [...confirmed, ...rankFeedCoupons(allFeed).filter((c) => !confirmed.includes(c))].slice(0, max);
  if (coupons.length === 0 && feed.length === 0) return null;

  const state = loadState();
  const newOnes = [
    ...coupons.filter((c) => !state.announced[c.code]),
    ...feed.filter((c) => !state.announced[c.code]).map((c) => ({ code: c.code }) as SpecialCoupon),
  ];
  if (newOnes.length === 0 && !opts.force) {
    logger.debug('[anúncio-cupom] Nenhum código novo.');
    return null;
  }

  // Anti-spam: intervalo mínimo entre anúncios (@all incomoda e arrisca ban).
  const minGapMs = config.coupon.announceMinGapHours * 60 * 60 * 1000;
  const since = Date.now() - state.lastAnnounceAt;
  if (!opts.force && !opts.dry && state.lastAnnounceAt > 0 && since < minGapMs) {
    logger.info(
      { faltamMin: Math.round((minGapMs - since) / 60000), novos: newOnes.map((c) => c.code) },
      '[anúncio-cupom] Código novo detectado, mas dentro do intervalo mínimo — adiando.'
    );
    return null;
  }

  // Anuncia TODOS os vigentes (não só os novos) — a mensagem é uma lista.
  const text = formatCouponAnnouncement(coupons, feed);
  const groups = allGroups();

  if (opts.dry) {
    return { newCodes: newOnes.map((c) => c.code), text, groups, posted: 0, dry: true };
  }
  if (!sock) throw new Error('announceNewCoupons: sock ausente pra envio real');
  if (groups.length === 0) {
    logger.error('[anúncio-cupom] Nenhum grupo configurado.');
    return null;
  }

  // Banner fixo (opcional) — igual ao "CUPOM LIBERADO" dos concorrentes.
  let banner: Buffer | null = null;
  const bannerPath = config.coupon.bannerPath;
  if (bannerPath && fs.existsSync(bannerPath)) {
    banner = fs.readFileSync(bannerPath);
  } else if (bannerPath) {
    logger.warn({ bannerPath }, '[anúncio-cupom] Banner não encontrado — enviando só texto.');
  }

  const ok = await broadcastCoupon(sock, groups, text, banner);

  const now = Date.now();
  for (const c of coupons) state.announced[c.code] = now;
  for (const c of feed) state.announced[c.code] = now;
  state.lastAnnounceAt = now;
  saveState(state);

  logger.info(
    { novos: newOnes.map((c) => c.code), enviados: ok.length, total: groups.length },
    '[anúncio-cupom] Cupons novos anunciados.'
  );
  return { newCodes: newOnes.map((c) => c.code), text, groups, posted: ok.length, dry: false };
}
