import type { WASocket } from '@whiskeysockets/baileys';
import { config } from '../config';
import { logger } from '../logger';
import { randomDelay, sleep } from '../util/time';

export interface GroupInfo {
  id: string;
  subject: string;
  size: number;
}

/**
 * Lista todos os grupos em que a conta do bot participa (id + nome + tamanho).
 * É daqui que saem os IDs para preencher WHATSAPP_GROUP_IDS no .env.
 */
export async function listGroups(sock: WASocket): Promise<GroupInfo[]> {
  const metadata = await sock.groupFetchAllParticipating();
  return Object.values(metadata)
    .map((g) => ({ id: g.id, subject: g.subject ?? '(sem nome)', size: g.participants?.length ?? 0 }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

/**
 * Envia uma mensagem (texto + imagem opcional) para UM grupo.
 * Se a imagem falhar, cai para texto puro como fallback.
 */
export async function sendToGroup(
  sock: WASocket,
  groupId: string,
  text: string,
  imageUrl?: string | null
): Promise<void> {
  if (imageUrl) {
    try {
      await sock.sendMessage(groupId, { image: { url: imageUrl }, caption: text });
      return;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, imageUrl },
        '[WhatsApp] Falha ao enviar com imagem, mandando só o texto.'
      );
    }
  }
  // linkPreview: null desliga a geração de prévia (evita depender do pacote
  // opcional "link-preview-js").
  await sock.sendMessage(groupId, { text, linkPreview: null });
}

/**
 * Envia a mesma mensagem para vários grupos, com um delay ALEATÓRIO entre um
 * grupo e o próximo (anti-ban — evita padrão de broadcast simultâneo).
 *
 * @returns a lista de grupos para os quais o envio deu certo.
 */
export async function broadcast(
  sock: WASocket,
  groupIds: string[],
  text: string,
  imageUrl?: string | null
): Promise<string[]> {
  const ok: string[] = [];

  for (let i = 0; i < groupIds.length; i += 1) {
    const groupId = groupIds[i]!;
    try {
      await sendToGroup(sock, groupId, text, imageUrl);
      ok.push(groupId);
      logger.info({ groupId }, '[WhatsApp] Mensagem enviada.');
    } catch (err) {
      logger.error({ err: (err as Error).message, groupId }, '[WhatsApp] Falha ao enviar ao grupo.');
    }

    // Espera entre grupos (menos depois do último).
    if (i < groupIds.length - 1) {
      const wait = randomDelay(config.throttle.groupDelayMinMs, config.throttle.groupDelayMaxMs);
      logger.debug({ ms: wait }, '[WhatsApp] Aguardando antes do próximo grupo...');
      await sleep(wait);
    }
  }

  return ok;
}
