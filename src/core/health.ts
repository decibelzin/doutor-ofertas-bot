import { logger } from '../logger';

/**
 * Alerta de SAÚDE - hoje focado na degradação de autenticação do painel do ML
 * (cookie/csrf expiram e derrubam hub + cupom + link curto em silêncio). Loga
 * ERRO alto com instrução de recuperação e, se houver um "sink" configurado
 * (ex.: mandar no WhatsApp), notifica. Throttled por motivo pra não spammar.
 */

/**
 * O sink recebe também `reason` e `detail` - sem eles o destino não consegue
 * explicar o erro nem montar um embed decente; só repassaria a frase pronta.
 */
type AlertSink = (
  message: string,
  reason: string,
  detail?: Record<string, unknown>
) => void | Promise<void>;

let sink: AlertSink | null = null;
const lastAlertAt = new Map<string, number>();
const THROTTLE_MS = 30 * 60 * 1000; // 1 alerta por motivo a cada 30 min

/** Liga um destino de alerta (ex.: enviar no WhatsApp). null desliga. */
export function setAlertSink(fn: AlertSink | null): void {
  sink = fn;
}

/** A auth do painel degradou (cookie/csrf expirado). Recapturar do painel. */
export function alertAuthDegraded(reason: string, detail?: Record<string, unknown>): void {
  const now = Date.now();
  if (now - (lastAlertAt.get(reason) ?? 0) < THROTTLE_MS) return;
  lastAlertAt.set(reason, now);

  const msg =
    `⚠️ [doutor-bot] Autenticação do ML degradada (${reason}). ` +
    `Recapture ML_AFFILIATE_COOKIE/CSRF do painel de afiliado e cole no .env - ` +
    `a captação (hub/cupom/link curto) está degradada até lá.`;
  logger.error({ reason, ...detail }, `[SAÚDE] ${msg}`);

  if (sink) {
    try {
      void Promise.resolve(sink(msg, reason, detail)).catch((err) =>
        logger.warn({ err: (err as Error).message }, '[SAÚDE] Falha ao enviar alerta.')
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[SAÚDE] Falha ao enviar alerta.');
    }
  }
}
