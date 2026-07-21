import { DateTime } from 'luxon';
import { config } from './config';
import { logger } from './logger';
import { store } from './core/store';
import { collectNicheDeals } from './core/selector';
import { loadNiches, type Niche } from './core/niches';
import { formatDeal } from './format/whatsapp';
import { whenReady } from './whatsapp/client';
import { sendToGroup, buildLinkPreview } from './whatsapp/sender';
import { enrichWithShortLink } from './providers/mercadolivre/shortlink';
import { sleep, randomDelay } from './util/time';
import type { Deal } from './core/deal';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function nowTz(): DateTime {
  return DateTime.now().setZone(config.timezone);
}

/** Está dentro da janela de horário (ex.: 8h–22h)? */
export function isWithinWindow(): boolean {
  const h = nowTz().hour;
  return h >= config.schedule.startHour && h < config.schedule.endHour;
}

/** Algum teto anti-ban (por hora / por dia) foi atingido? (global, entre todos os nichos) */
function capReached(): boolean {
  const { maxPostsPerHour, maxPostsPerDay } = config.schedule;
  if (maxPostsPerHour && store.countSince(Date.now() - HOUR_MS) >= maxPostsPerHour) {
    logger.info({ maxPostsPerHour }, '[Scheduler] Teto por hora atingido, aguardando.');
    return true;
  }
  if (maxPostsPerDay) {
    const startOfDay = nowTz().startOf('day').toMillis();
    if (store.countSince(startOfDay) >= maxPostsPerDay) {
      logger.info({ maxPostsPerDay }, '[Scheduler] Teto diário atingido.');
      return true;
    }
  }
  return false;
}

/** Melhor oferta do nicho ainda não postada dentro do cooldown (ou null). */
async function pickNicheDeal(niche: Niche): Promise<Deal | null> {
  const cooldownMs = config.dedup.cooldownDays * DAY_MS;
  const deals = await collectNicheDeals(niche);
  for (const deal of deals) {
    if (!store.wasPostedRecently(deal.id, cooldownMs)) return deal;
  }
  return null;
}

/** Posta UMA oferta do nicho nos grupos dele. */
export async function postNiche(
  niche: Niche,
  { ignoreWindow = false }: { ignoreWindow?: boolean } = {}
): Promise<void> {
  if (!ignoreWindow && !isWithinWindow()) {
    logger.debug({ niche: niche.name }, '[Scheduler] Fora da janela.');
    return;
  }
  if (!ignoreWindow && capReached()) return;
  if (niche.groups.length === 0) return;

  const deal = await pickNicheDeal(niche);
  if (!deal) {
    logger.warn({ niche: niche.name }, '[Scheduler] Nenhuma oferta nova nesta rodada.');
    return;
  }

  // Troca o link do ML pelo curto (meli.la) quando disponível; senão mantém o matt.
  await enrichWithShortLink(deal);

  // Monta a prévia de link (card clicável) uma vez — mesma pra todos os grupos.
  const preview = await buildLinkPreview(deal);

  const sock = await whenReady();
  for (let i = 0; i < niche.groups.length; i += 1) {
    const groupId = niche.groups[i]!;
    const text = formatDeal(deal, { variant: i });
    try {
      await sendToGroup(sock, groupId, text, preview);
      store.markPosted(deal, groupId);
      logger.info({ niche: niche.name, groupId, id: deal.id, title: deal.title }, '[Scheduler] Oferta postada.');
    } catch (err) {
      logger.error({ err: (err as Error).message, groupId }, '[Scheduler] Falha ao postar no grupo.');
    }
    if (i < niche.groups.length - 1) {
      await sleep(randomDelay(config.throttle.groupDelayMinMs, config.throttle.groupDelayMaxMs));
    }
  }
}

/** Posta uma oferta para CADA nicho (usado pelo comando post-now). */
export async function postNowAll(opts: { ignoreWindow?: boolean } = {}): Promise<void> {
  const niches = loadNiches();
  for (const niche of niches) {
    await postNiche(niche, opts);
    await sleep(randomDelay(config.throttle.groupDelayMinMs, config.throttle.groupDelayMaxMs));
  }
}

/** Loop independente de um nicho (intervalo próprio + jitter). */
function scheduleNiche(niche: Niche): void {
  const baseMin = niche.intervalMinutes ?? config.schedule.intervalMinutes;
  const base = baseMin * 60 * 1000;
  const jitter = (Math.random() * 2 - 1) * config.schedule.jitterMinutes * 60 * 1000;
  const delay = Math.max(60 * 1000, Math.round(base + jitter));
  logger.info({ niche: niche.name, proximoEmMin: Math.round(delay / 60000) }, '[Scheduler] Próxima postagem agendada.');

  setTimeout(() => {
    postNiche(niche)
      .catch((err) => logger.error({ err: (err as Error).message, niche: niche.name }, '[Scheduler] Erro no ciclo.'))
      .finally(() => scheduleNiche(niche));
  }, delay);
}

/** Inicia um loop por nicho. */
export function startScheduler(): void {
  const niches = loadNiches();
  if (niches.length === 0) {
    logger.warn('[Scheduler] Nenhum nicho configurado — nada a agendar.');
    return;
  }
  logger.info(
    {
      janela: `${config.schedule.startHour}h-${config.schedule.endHour}h`,
      nichos: niches.map((n) => n.name),
      tz: config.timezone,
    },
    '[Scheduler] Iniciado.'
  );
  for (const niche of niches) scheduleNiche(niche);
}
