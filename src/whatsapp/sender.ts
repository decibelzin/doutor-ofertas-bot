import axios from 'axios';
import type { WASocket } from '@whiskeysockets/baileys';
import { config } from '../config';
import { logger } from '../logger';
import { randomDelay, sleep } from '../util/time';
import type { Deal } from '../core/deal';

export interface GroupInfo {
  id: string;
  subject: string;
  size: number;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0';

/**
 * Lista todos os grupos em que a conta do bot participa (id + nome + tamanho).
 * É daqui que saem os IDs para os nichos (config/niches.json).
 */
export async function listGroups(sock: WASocket): Promise<GroupInfo[]> {
  const metadata = await sock.groupFetchAllParticipating();
  return Object.values(metadata)
    .map((g) => ({ id: g.id, subject: g.subject ?? '(sem nome)', size: g.participants?.length ?? 0 }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

/**
 * ML serve a MESMA imagem em .jpg (WhatsApp lida melhor com JPEG que WEBP) e
 * numa resolução maior (D_NQ_NP_ = pequena → D_NQ_NP2X_ = 2x). Melhor esforço:
 * se a variante maior não existir, o chamador cai na URL original.
 */
function upgradeMlImageUrl(url: string): string {
  return url
    .replace(/\.webp(\?.*)?$/i, '.jpg$1')
    // Sobe pra 2X SÓ se ainda não for — senão "D_NQ_NP_2X_" (imagem do hub) viraria
    // "D_NQ_NP2X_2X_", que o ML devolve como GIF placeholder quebrado.
    .replace(/D_NQ_NP_(?!2X_)/, 'D_NQ_NP2X_');
}

/**
 * Baixa os bytes da imagem do produto UMA vez (reusada em todos os grupos do
 * nicho). É isso que faz a mensagem sair como as das referências: FOTO GRANDE
 * em cima + legenda embaixo, com o link clicável dentro da legenda.
 *
 * Retorna null se não houver imagem ou o download falhar — aí cai no texto puro
 * (que o WhatsApp já deixa clicável por conta própria).
 */
export async function fetchDealImage(deal: Deal, imageOverride?: string | null): Promise<Buffer | null> {
  // Imagem da ficha curada tem prioridade; senão usa a do anúncio.
  if (imageOverride) return fetchImage([imageOverride]);
  if (!deal.imageUrl) return null;

  const candidates =
    deal.store === 'mercadolivre'
      ? Array.from(new Set([upgradeMlImageUrl(deal.imageUrl), deal.imageUrl]))
      : [deal.imageUrl];
  return fetchImage(candidates);
}

/** Tenta baixar a primeira URL que responder; null se todas falharem. */
async function fetchImage(candidates: string[]): Promise<Buffer | null> {
  for (const url of candidates) {
    try {
      const { data } = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: { 'User-Agent': UA },
      });
      return Buffer.from(data);
    } catch (err) {
      logger.debug({ url, err: (err as Error).message }, '[WhatsApp] Falha ao baixar imagem, tentando fallback.');
    }
  }
  return null;
}

/**
 * Envia uma oferta para UM grupo. Quando há imagem, sai como MENSAGEM DE IMAGEM
 * com legenda (foto grande + link clicável na legenda). Sem imagem, cai no
 * texto puro — a URL continua clicável.
 */
export async function sendToGroup(
  sock: WASocket,
  groupId: string,
  text: string,
  image?: Buffer | null
): Promise<string | undefined> {
  const sent = image
    ? await sock.sendMessage(groupId, { image, caption: text })
    : await sock.sendMessage(groupId, { text });
  return sent?.key?.id ?? undefined; // id da msg → liga à reação de moderação
}

/**
 * Envia pra UM grupo mencionando TODOS os participantes (o "@all"). É isso que
 * dispara notificação pra todo mundo — o texto "@all" é só cosmético; quem
 * notifica é o array `mentions` com os JIDs dos participantes. Usado no cupom.
 */
export async function sendMentioningAll(
  sock: WASocket,
  groupId: string,
  text: string,
  image?: Buffer | null
): Promise<void> {
  let mentions: string[] = [];
  try {
    const meta = await sock.groupMetadata(groupId);
    mentions = (meta.participants ?? []).map((p) => p.id);
  } catch (err) {
    logger.debug({ err: (err as Error).message, groupId }, '[WhatsApp] Sem metadata do grupo — enviando sem @all.');
  }
  const content = image ? { image, caption: text, mentions } : { text, mentions };
  await sock.sendMessage(groupId, content as never);
}

/**
 * Broadcast de CUPOM: mesma mensagem pra vários grupos, mencionando @all em cada,
 * com delay anti-ban. Use com moderação (@all frequente irrita e arrisca ban).
 */
export async function broadcastCoupon(
  sock: WASocket,
  groupIds: string[],
  text: string,
  image?: Buffer | null
): Promise<string[]> {
  const ok: string[] = [];
  for (let i = 0; i < groupIds.length; i += 1) {
    const groupId = groupIds[i]!;
    try {
      await sendMentioningAll(sock, groupId, text, image);
      ok.push(groupId);
      logger.info({ groupId }, '[WhatsApp] Cupom enviado (@all).');
    } catch (err) {
      logger.error({ err: (err as Error).message, groupId }, '[WhatsApp] Falha ao enviar cupom.');
    }
    if (i < groupIds.length - 1) {
      await sleep(randomDelay(config.throttle.groupDelayMinMs, config.throttle.groupDelayMaxMs));
    }
  }
  return ok;
}

/**
 * Envia a mesma mensagem para vários grupos, com delay aleatório entre eles
 * (anti-ban). Usado pelo comando de teste (send-test).
 * @returns a lista de grupos para os quais o envio deu certo.
 */
export async function broadcast(
  sock: WASocket,
  groupIds: string[],
  text: string,
  image?: Buffer | null
): Promise<string[]> {
  const ok: string[] = [];

  for (let i = 0; i < groupIds.length; i += 1) {
    const groupId = groupIds[i]!;
    try {
      await sendToGroup(sock, groupId, text, image);
      ok.push(groupId);
      logger.info({ groupId }, '[WhatsApp] Mensagem enviada.');
    } catch (err) {
      logger.error({ err: (err as Error).message, groupId }, '[WhatsApp] Falha ao enviar ao grupo.');
    }

    if (i < groupIds.length - 1) {
      const wait = randomDelay(config.throttle.groupDelayMinMs, config.throttle.groupDelayMaxMs);
      logger.debug({ ms: wait }, '[WhatsApp] Aguardando antes do próximo grupo...');
      await sleep(wait);
    }
  }

  return ok;
}
