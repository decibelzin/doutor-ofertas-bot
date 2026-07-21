import { DateTime } from 'luxon';
import { config } from './config';
import { logger } from './logger';
import { store } from './core/store';
import { collectRankedDeals } from './core/selector';
import { formatDeal } from './format/whatsapp';
import { whenReady } from './whatsapp/client';
import { sendToGroup } from './whatsapp/sender';
import { sleep, randomDelay } from './util/time';
import type { Deal } from './core/deal';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function nowTz(): DateTime {
  return DateTime.now().setZone(config.timezone);
}

/** Está dentro da janela de horário configurada (ex.: 8h–22h)? */
export function isWithinWindow(): boolean {
  const h = nowTz().hour;
  return h >= config.schedule.startHour && h < config.schedule.endHour;
}

/** Algum teto anti-ban (por hora / por dia) foi atingido? */
function capReached(): boolean {
  const { maxPostsPerHour, maxPostsPerDay } = config.schedule;
  if (maxPostsPerHour && store.countSince(Date.now() - HOUR_MS) >= maxPostsPerHour) {
    logger.info({ maxPostsPerHour }, '[Scheduler] Teto por hora atingido, aguardando.');
    return true;
  }
  if (maxPostsPerDay) {
    const startOfDay = nowTz().startOf('day').toMillis();
    if (store.countSince(startOfDay) >= maxPostsPerDay) {
      logger.info({ maxPostsPerDay }, '[Scheduler] Teto diário atingido, aguardando o próximo dia.');
      return true;
    }
  }
  return false;
}

/** Melhor oferta ainda não postada dentro do cooldown (ou null). */
async function pickNextDeal(): Promise<Deal | null> {
  const cooldownMs = config.dedup.cooldownDays * DAY_MS;
  const deals = await collectRankedDeals();
  for (const deal of deals) {
    if (!store.wasPostedRecently(deal.id, cooldownMs)) return deal;
  }
  return null;
}

/**
 * Posta UMA oferta nos grupos. Respeita janela e tetos (a menos que
 * ignoreWindow=true, usado no comando de teste post-now).
 */
export async function postOneDeal({ ignoreWindow = false }: { ignoreWindow?: boolean } = {}): Promise<void> {
  if (!ignoreWindow && !isWithinWindow()) {
    logger.debug('[Scheduler] Fora da janela, ignorando.');
    return;
  }
  if (!ignoreWindow && capReached()) return;

  const groupIds = config.whatsapp.groupIds;
  if (groupIds.length === 0) {
    logger.warn('[Scheduler] WHATSAPP_GROUP_IDS vazio — nada a postar.');
    return;
  }

  const deal = await pickNextDeal();
  if (!deal) {
    logger.warn('[Scheduler] Nenhuma oferta nova encontrada nesta rodada.');
    return;
  }

  const sock = await whenReady();
  for (let i = 0; i < groupIds.length; i += 1) {
    const groupId = groupIds[i]!;
    const text = formatDeal(deal, { variant: i });
    try {
      await sendToGroup(sock, groupId, text, deal.imageUrl);
      store.markPosted(deal, groupId);
      logger.info({ groupId, id: deal.id, title: deal.title }, '[Scheduler] Oferta postada.');
    } catch (err) {
      logger.error({ err: (err as Error).message, groupId }, '[Scheduler] Falha ao postar no grupo.');
    }
    if (i < groupIds.length - 1) {
      await sleep(randomDelay(config.throttle.groupDelayMinMs, config.throttle.groupDelayMaxMs));
    }
  }
}

/** Agenda o próximo ciclo com intervalo + jitter aleatório. */
function scheduleNext(): void {
  const base = config.schedule.intervalMinutes * 60 * 1000;
  const jitter = (Math.random() * 2 - 1) * config.schedule.jitterMinutes * 60 * 1000;
  const delay = Math.max(60 * 1000, Math.round(base + jitter));
  logger.info({ proximoEmMin: Math.round(delay / 60000) }, '[Scheduler] Próxima postagem agendada.');

  setTimeout(() => {
    postOneDeal()
      .catch((err) => logger.error({ err: (err as Error).message }, '[Scheduler] Erro no ciclo.'))
      .finally(() => scheduleNext());
  }, delay);
}

/** Inicia o loop de postagens (intervalo + jitter, dentro da janela). */
export function startScheduler(): void {
  const { startHour, endHour, intervalMinutes, jitterMinutes } = config.schedule;
  logger.info(
    { janela: `${startHour}h-${endHour}h`, intervalMinutes, jitterMinutes, tz: config.timezone },
    '[Scheduler] Iniciado.'
  );
  scheduleNext();
}
