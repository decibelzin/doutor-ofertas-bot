import { DateTime } from 'luxon';
import { config } from './config';
import { logger } from './logger';
import { store } from './core/store';
import { collectNicheDeals } from './core/selector';
import { loadNiches, type Niche } from './core/niches';
import { formatDeal } from './format/whatsapp';
import { resolvePreset } from './format/title';
import { whenReady, getSocket } from './whatsapp/client';
import { sendToGroup, fetchDealImage } from './whatsapp/sender';
import { setAlertSink, alertAuthDegraded } from './core/health';
import { lerPausa } from './core/pausa';
import { urlDaLanding } from './core/landing';
import { isKnownPerfume } from './core/quality';
import { enviarOfertaDiscord } from './core/oferta-discord';
import { enviarAlertaDiscord } from './core/alerta-discord';
import { enrichWithShortLink } from './providers/mercadolivre/shortlink';
import { couponsEnabled } from './providers/mercadolivre/coupons';
import { refreshCouponCache, runCouponPost, couponCacheAgeMs } from './core/coupon-runner';
import { runPublicCouponPost, runCodeCouponPost } from './core/public-coupon-runner';
import { announceNewCoupons } from './core/coupon-announcer';
import { refreshGroupStatus } from './core/group-status';
import { sleep, randomDelay } from './util/time';
import type { Deal } from './core/deal';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function nowTz(): DateTime {
  return DateTime.now().setZone(config.timezone);
}

/** Está dentro da janela de horário (ex.: 8h-22h)? */
export function isWithinWindow(): boolean {
  const h = nowTz().hour;
  return h >= config.schedule.startHour && h < config.schedule.endHour;
}

/**
 * Freio de mão acionado do Discord (data/pausa.json).
 *
 * Vale inclusive pro `ignoreWindow` do post manual: pausa é parada dura, não
 * "pare quando for conveniente". Pra postar na mão, retome antes.
 */
function pausado(contexto: string): boolean {
  const p = lerPausa();
  if (!p) return false;
  logger.info({ contexto, por: p.por, desde: p.desde, ate: p.ate }, '[Scheduler] Pausado - não vou postar.');
  return true;
}

/** Algum teto anti-ban (por hora / por dia) foi atingido? (global, entre todos os nichos) */
function capReached(): boolean {
  const { maxPostsPerHour, maxPostsPerDay } = config.schedule;
  // Conta OFERTAS distintas (não mensagens-por-grupo): 1 oferta pra 10 grupos = 1.
  if (maxPostsPerHour && store.countDealsSince(Date.now() - HOUR_MS) >= maxPostsPerHour) {
    logger.info({ maxPostsPerHour }, '[Scheduler] Teto por hora atingido, aguardando.');
    return true;
  }
  if (maxPostsPerDay) {
    const startOfDay = nowTz().startOf('day').toMillis();
    if (store.countDealsSince(startOfDay) >= maxPostsPerDay) {
      logger.info({ maxPostsPerDay }, '[Scheduler] Teto diário atingido.');
      return true;
    }
  }
  return false;
}

/**
 * Uma oferta está elegível se: passa o filtro de qualidade E (não está no
 * cooldown OU voltou MUITO melhor - re-preço). O bypass de re-preço captura o
 * cenário mais quente: um perfume postado a 30% que HOJE caiu pra 55%.
 */
function isEligible(deal: Deal, cooldownMs: number): boolean {
  if (config.filter.onlyKnownPerfumes && !isKnownPerfume(deal)) return false;
  return store.canPostNow(deal.id, deal.discountPercent, cooldownMs);
}

/**
 * Escolhe a oferta do nicho pro slot. NOVIDADE-FIRST: entre as elegíveis (já
 * ordenadas por desconto), prioriza as que NUNCA foram postadas - só re-serve
 * "evergreens" quando não há novidade. Maximiza cobertura/variedade e garante
 * que todo perfume qualificado vá ao ar ao menos 1x antes de repetir.
 */
async function pickNicheDeal(niche: Niche): Promise<Deal | null> {
  const cooldownMs = config.dedup.cooldownDays * DAY_MS;
  const deals = await collectNicheDeals(niche);
  const eligible = deals.filter((d) => isEligible(d, cooldownMs));
  if (eligible.length === 0) return null;
  const fresh = eligible.filter((d) => !store.hasEverPosted(d.id));
  return (fresh.length ? fresh : eligible)[0]!; // já vem ordenado por desconto
}

/** Rodadas já postadas nesta execução - só serve pra alternar o rodapé. */
let rodadas = 0;

/** Posta UMA oferta do nicho nos grupos dele. */
export async function postNiche(
  niche: Niche,
  { ignoreWindow = false }: { ignoreWindow?: boolean } = {}
): Promise<void> {
  if (!ignoreWindow && !isWithinWindow()) {
    logger.debug({ niche: niche.name }, '[Scheduler] Fora da janela.');
    return;
  }
  if (pausado(`oferta:${niche.name}`)) return;
  if (!ignoreWindow && capReached()) return;
  if (niche.groups.length === 0) return;

  const deal = await pickNicheDeal(niche);
  if (!deal) {
    logger.warn({ niche: niche.name }, '[Scheduler] Nenhuma oferta nova nesta rodada.');
    return;
  }

  // Troca o link do ML pelo curto (meli.la) quando disponível; senão mantém o matt.
  await enrichWithShortLink(deal);

  // Baixa a imagem uma vez - reusada em todos os grupos do nicho. Usa a imagem
  // da ficha curada (se houver) senão a do anúncio. Foto grande + legenda.
  const preset = resolvePreset(deal.title, deal.id);
  const image = await fetchDealImage(deal, preset?.imagem);

  /* Rodapé de recrutamento a cada N RODADAS - decidido aqui, fora do laço, pra
     valer igual em todos os grupos. Se fosse por grupo, o grupo 1 receberia
     sempre e o 10 quase nunca. `f=zap` marca o canal no funil: é assim que dá
     pra ver quanto tráfego o próprio encaminhamento gera. */
  rodadas += 1;
  const comRodape =
    config.schedule.footerEvery > 0 && rodadas % config.schedule.footerEvery === 0;
  const footerUrl = comRodape ? urlDaLanding(niche.name, 'zap') ?? undefined : undefined;

  const sock = await whenReady();
  for (let i = 0; i < niche.groups.length; i += 1) {
    const groupId = niche.groups[i]!;
    const text = formatDeal(deal, { variant: i, footerUrl });
    try {
      const msgId = await sendToGroup(sock, groupId, text, image);
      store.markPosted(deal, groupId, msgId);
      logger.info({ niche: niche.name, groupId, id: deal.id, title: deal.title }, '[Scheduler] Oferta postada.');
    } catch (err) {
      logger.error({ err: (err as Error).message, groupId }, '[Scheduler] Falha ao postar no grupo.');
    }
    if (i < niche.groups.length - 1) {
      await sleep(randomDelay(config.throttle.groupDelayMinMs, config.throttle.groupDelayMaxMs));
    }
  }

  /* Canal do Discord DEPOIS dos grupos, e sem await que possa quebrar a rodada:
     o WhatsApp é o canal principal e já foi servido. A função engole o próprio
     erro, então Discord fora do ar vira um post a menos, não rodada perdida. */
  await enviarOfertaDiscord(deal);
}

/** Posta uma oferta para CADA nicho (usado pelo comando post-now). */
export async function postNowAll(opts: { ignoreWindow?: boolean } = {}): Promise<void> {
  const niches = loadNiches();
  for (const niche of niches) {
    await postNiche(niche, opts);
    await sleep(randomDelay(config.throttle.groupDelayMinMs, config.throttle.groupDelayMaxMs));
  }
}

// Primeiro post logo após o arranque (não espera um intervalo inteiro) - captação
// rápida + feedback imediato. Curto + pequeno stagger aleatório entre nichos.
const KICKOFF_MIN_MS = 15 * 1000;
const KICKOFF_SPREAD_MS = 25 * 1000;

/** Loop independente de um nicho (intervalo próprio + jitter). */
function scheduleNiche(niche: Niche, opts: { immediate?: boolean } = {}): void {
  let delay: number;
  if (opts.immediate) {
    delay = KICKOFF_MIN_MS + Math.floor(Math.random() * KICKOFF_SPREAD_MS);
  } else {
    const baseMin = niche.intervalMinutes ?? config.schedule.intervalMinutes;
    const base = baseMin * 60 * 1000;
    const jitter = (Math.random() * 2 - 1) * config.schedule.jitterMinutes * 60 * 1000;
    delay = Math.max(60 * 1000, Math.round(base + jitter));
  }
  logger.info({ niche: niche.name, proximoEmMin: Math.round(delay / 60000) }, '[Scheduler] Próxima postagem agendada.');

  setTimeout(() => {
    postNiche(niche)
      .catch((err) => logger.error({ err: (err as Error).message, niche: niche.name }, '[Scheduler] Erro no ciclo.'))
      .finally(() => scheduleNiche(niche)); // próximos ciclos = intervalo normal
  }, delay);
}

// ---------------------------------------------------------------------------
// Automação de CUPOM (perfume + cupom automático) - mesmo loop live do bot.
// ---------------------------------------------------------------------------

let discovering = false;
/** Alterna cupom público ↔ cupom de vendedor entre os slots de cupom. */
let couponTurn = 0;

/** Roda UMA descoberta de cupom (atualiza o cache). Não sobrepõe execuções. */
async function runDiscoveryOnce(): Promise<void> {
  if (discovering) {
    logger.debug('[Scheduler] Descoberta de cupom já em andamento - pulando.');
    return;
  }
  discovering = true;
  try {
    logger.info('[Scheduler] Atualizando cache de cupons...');
    const r = await refreshCouponCache({ maxPages: config.coupon.maxPages });
    logger.info(r, '[Scheduler] Cache de cupons atualizado.');
    if (r.authFailed) alertAuthDegraded('cupom-muro-auth');
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[Scheduler] Erro na descoberta de cupom.');
  } finally {
    discovering = false;
  }
}

/** Loop de descoberta (a cada COUPON_DISCOVERY_INTERVAL_HOURS). */
function scheduleCouponDiscovery(): void {
  const intervalMs = Math.max(1, config.coupon.discoveryIntervalHours) * 60 * 60 * 1000;
  setTimeout(() => {
    runDiscoveryOnce().finally(() => scheduleCouponDiscovery());
  }, intervalMs);
}

/** Posta UM perfume+cupom, respeitando janela e tetos anti-ban (mesma cota das ofertas). */
async function postCouponTick(): Promise<void> {
  if (!isWithinWindow()) {
    logger.debug('[Scheduler] Cupom fora da janela.');
    return;
  }
  if (pausado('cupom')) return;
  if (capReached()) return;
  const sock = await whenReady();

  // Alterna as duas famílias de cupom pra variar o conteúdo do canal:
  //  - PÚBLICO do ML (o cliente ativa; é o "cupom relâmpago" dos concorrentes);
  //  - do VENDEDOR (auto-aplicado no carrinho).
  // Tenta a preferida da vez; se não houver nada, cai na outra.
  const publicFirst = couponTurn % 2 === 0;
  couponTurn += 1;

  const tryPublic = async (): Promise<boolean> => {
    const r = await runPublicCouponPost(sock, {});
    if (r) {
      logger.info(
        { cupom: r.coupon.title, produto: r.deal.title, grupos: r.posted },
        '[Scheduler] Perfume + cupom PÚBLICO postado.'
      );
    }
    return Boolean(r);
  };
  const trySeller = async (): Promise<boolean> => {
    const r = await runCouponPost(sock, {});
    if (r) {
      logger.info(
        { cupom: r.coupon.couponId, produto: r.deal.title, grupos: r.posted },
        '[Scheduler] Perfume + cupom automático postado.'
      );
    }
    return Boolean(r);
  };

  // Cupom COM CÓDIGO vem primeiro: é o formato mais forte (igual ao "cupom
  // relâmpago" dos concorrentes) e são poucos/rotativos - não desperdiçar.
  const tryCode = async (): Promise<boolean> => {
    const r = await runCodeCouponPost(sock, {});
    if (r) {
      logger.info(
        { cupom: r.coupon.code, produto: r.deal.title, grupos: r.posted },
        '[Scheduler] Perfume + cupom COM CÓDIGO postado.'
      );
    }
    return Boolean(r);
  };

  if (await tryCode()) return;
  const first = publicFirst ? tryPublic : trySeller;
  const second = publicFirst ? trySeller : tryPublic;
  if (!(await first())) await second();
}

/** Loop de postagem de cupom (intervalo próprio + jitter). */
function scheduleCouponPost(opts: { immediate?: boolean } = {}): void {
  let delay: number;
  if (opts.immediate) {
    // Kickoff um pouco depois das ofertas, pra não postar tudo junto no start.
    delay = 2 * 60 * 1000 + Math.floor(Math.random() * KICKOFF_SPREAD_MS);
  } else {
    const base = Math.max(1, config.coupon.postIntervalMinutes) * 60 * 1000;
    const jitter = (Math.random() * 2 - 1) * config.schedule.jitterMinutes * 60 * 1000;
    delay = Math.max(60 * 1000, Math.round(base + jitter));
  }
  setTimeout(() => {
    postCouponTick()
      .catch((err) => logger.error({ err: (err as Error).message }, '[Scheduler] Erro no post de cupom.'))
      .finally(() => scheduleCouponPost());
  }, delay);
}

/**
 * Checa se surgiram cupons com código NOVOS e dispara o anúncio "CUPOM LIBERADO"
 * (banner + lista de códigos, @all) - sozinho, sem intervenção.
 */
async function announceTick(): Promise<void> {
  if (!isWithinWindow()) return; // não acorda ninguém fora do horário
  if (pausado('anuncio-cupom')) return;
  const sock = await whenReady();
  const r = await announceNewCoupons(sock, {});
  if (r) {
    logger.info({ novos: r.newCodes, grupos: r.posted }, '[Scheduler] Anúncio de cupons novos enviado.');
  }
}

/** Loop de checagem de cupons novos pra anunciar. */
function scheduleCouponAnnounce(): void {
  const base = Math.max(5, config.coupon.announceCheckMinutes) * 60 * 1000;
  setTimeout(() => {
    announceTick()
      .catch((err) => logger.error({ err: (err as Error).message }, '[Scheduler] Erro no anúncio de cupom.'))
      .finally(() => scheduleCouponAnnounce());
  }, base);
}

/** Liga a automação de cupom se habilitada + credenciais do painel presentes. */
function startCouponAutomation(): void {
  if (!couponsEnabled()) return; // sem cookie/csrf → nada a fazer
  if (!config.coupon.auto) {
    logger.info('[Scheduler] Automação de cupom desligada (COUPON_AUTO=false).');
    return;
  }
  logger.info(
    { descobertaHoras: config.coupon.discoveryIntervalHours, postMin: config.coupon.postIntervalMinutes },
    '[Scheduler] Automação de cupom LIGADA (descoberta + post no automático).'
  );
  // Captação rápida: se o cache está velho/ausente, descobre logo no arranque
  // (após o WhatsApp assentar), senão espera o próximo ciclo.
  const staleMs = config.coupon.discoveryIntervalHours * 60 * 60 * 1000;
  if (couponCacheAgeMs() > staleMs) {
    setTimeout(() => void runDiscoveryOnce(), 30 * 1000);
  }
  scheduleCouponDiscovery();
  scheduleCouponPost({ immediate: true });

  // Anúncio "CUPOM LIBERADO" quando surgir código novo (checa periodicamente).
  if (config.coupon.announceAuto) {
    logger.info(
      { checarMin: config.coupon.announceCheckMinutes, intervaloMinH: config.coupon.announceMinGapHours },
      '[Scheduler] Anúncio automático de cupons novos LIGADO.'
    );
    scheduleCouponAnnounce();
  }
}

/**
 * Atualiza o JSON que o SITE lê (contagem de membros + link do grupo com vaga).
 * Bot e site na mesma VPS → escreve direto na pasta servida, sem deploy.
 */
function scheduleGroupStatus(): void {
  const min = config.site.refreshMinutes;
  if (min <= 0) return; // desligado
  const tick = async (): Promise<void> => {
    const sock = await whenReady();
    await refreshGroupStatus(sock);
  };
  // Primeira atualização logo após o arranque, pro site não ficar sem dado.
  setTimeout(() => {
    tick().catch((err) => logger.error({ err: (err as Error).message }, '[Scheduler] Erro no status dos grupos.'));
  }, 20 * 1000);

  setInterval(() => {
    tick().catch((err) => logger.error({ err: (err as Error).message }, '[Scheduler] Erro no status dos grupos.'));
  }, min * 60 * 1000);
  logger.info({ aCadaMin: min, arquivo: config.site.groupsFile }, '[Scheduler] Status dos grupos pro site LIGADO.');
}

/** Inicia um loop por nicho (+ automação de cupom, se ligada). */
export function startScheduler(): void {
  const niches = loadNiches();
  if (niches.length === 0) {
    logger.warn('[Scheduler] Nenhum nicho configurado - nada a agendar.');
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

  /* Alerta de saúde (cookie expirado etc.).
   *
   * O sink é ligado SEMPRE. Antes ele só era instalado quando havia grupo de
   * WhatsApp de admin configurado - e como esse campo estava vazio, todo
   * alerta de degradação morria no log sem ninguém ver. Cada destino decide
   * sozinho se está configurado. */
  setAlertSink(async (msg, reason, detail) => {
    // Discord primeiro: é webhook HTTP puro, então chega mesmo quando o que
    // quebrou foi justamente a conexão do WhatsApp.
    await enviarAlertaDiscord(reason, msg, detail);
    if (config.admin.alertGroup) {
      const s = getSocket();
      if (s) await s.sendMessage(config.admin.alertGroup, { text: msg });
    }
  });

  for (const niche of niches) scheduleNiche(niche, { immediate: true });
  startCouponAutomation();
  scheduleGroupStatus();
}
