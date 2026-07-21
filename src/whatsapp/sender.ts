import axios from 'axios';
import type { WASocket, WAUrlInfo } from '@whiskeysockets/baileys';
import { config } from '../config';
import { logger } from '../logger';
import { formatMoney } from '../format/whatsapp';
import { randomDelay, sleep } from '../util/time';
import type { Deal } from '../core/deal';

export interface GroupInfo {
  id: string;
  subject: string;
  size: number;
}

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
 * Monta a PRÉVIA DE LINK (card clicável) a partir da oferta: título + preço na
 * descrição + imagem do produto como thumbnail. É isso que faz o link virar
 * hyperlink azul e tappável no WhatsApp (em vez de texto solto).
 *
 * O `matched-text` precisa bater com a URL que aparece no texto da mensagem.
 */
export async function buildLinkPreview(deal: Deal): Promise<WAUrlInfo> {
  const url = deal.affiliateUrl;
  const info: WAUrlInfo = {
    'canonical-url': url,
    'matched-text': url,
    title: deal.title.slice(0, 90),
    description:
      deal.priceOriginal && deal.priceOriginal > deal.priceNow
        ? `De R$ ${formatMoney(deal.priceOriginal)} por R$ ${formatMoney(deal.priceNow)} · ${deal.discountPercent}% OFF`
        : `R$ ${formatMoney(deal.priceNow)}`,
  };

  if (deal.imageUrl) {
    try {
      // ML serve .jpg na mesma URL; WhatsApp quer thumbnail JPEG.
      const jpgUrl = deal.imageUrl.replace(/\.webp(\?.*)?$/i, '.jpg');
      const { data } = await axios.get<ArrayBuffer>(jpgUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
      });
      info.jpegThumbnail = Buffer.from(data);
    } catch (err) {
      logger.debug({ err: (err as Error).message }, '[WhatsApp] Sem thumbnail no preview.');
    }
  }
  return info;
}

/**
 * Envia uma mensagem de texto para UM grupo, com prévia de link (card clicável)
 * quando fornecida.
 */
export async function sendToGroup(
  sock: WASocket,
  groupId: string,
  text: string,
  preview?: WAUrlInfo | null
): Promise<void> {
  await sock.sendMessage(groupId, { text, linkPreview: preview ?? null });
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
  preview?: WAUrlInfo | null
): Promise<string[]> {
  const ok: string[] = [];

  for (let i = 0; i < groupIds.length; i += 1) {
    const groupId = groupIds[i]!;
    try {
      await sendToGroup(sock, groupId, text, preview);
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
