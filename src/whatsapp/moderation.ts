import type { WASocket } from '@whiskeysockets/baileys';
import { config } from '../config';
import { logger } from '../logger';
import { store } from '../core/store';

/**
 * MODERAÇÃO POR REAÇÃO: reagir com ❌ (ou outro emoji da lista) num anúncio VETA
 * aquele produto pra sempre — ele nunca mais é postado. Bloqueia SÓ o produto
 * daquele anúncio, não a marca.
 *
 * Autorização: a reação da PRÓPRIA conta do bot (o número que roda o app) sempre
 * vale (`fromMe`). JIDs extra podem ser autorizados via MODERATION_MODERATOR_JIDS.
 *
 * ⚠️ O bot precisa estar RODANDO quando você reage (é evento ao vivo do WhatsApp).
 */

function jidMatches(reactorJid: string | undefined, allowed: string): boolean {
  if (!reactorJid) return false;
  const a = allowed.split('@')[0]!.replace(/\D/g, '');
  const r = reactorJid.split('@')[0]!.replace(/\D/g, '');
  return Boolean(a) && r.endsWith(a);
}

function isModerator(reactorJid: string | undefined, fromMe: boolean): boolean {
  if (fromMe) return true; // reação da conta do bot (número que roda o app)
  return config.moderation.moderatorJids.some((j) => jidMatches(reactorJid, j));
}

/** Registra o listener de reações no socket (chamar após conectar/reconectar). */
export function attachModeration(sock: WASocket): void {
  sock.ev.on('messages.reaction', (reactions) => {
    for (const { key, reaction } of reactions) {
      const emoji = reaction?.text ?? ''; // vazio = reação REMOVIDA → ignora
      if (!emoji || !config.moderation.blockEmojis.includes(emoji)) continue;

      const fromMe = Boolean(reaction?.key?.fromMe);
      const reactorJid = reaction?.key?.participant ?? reaction?.key?.remoteJid ?? undefined;
      if (!isModerator(reactorJid ?? undefined, fromMe)) continue;

      const msgId = key?.id ?? undefined;
      if (!msgId) continue;

      const found = store.dealByMessage(msgId);
      if (!found) {
        logger.warn(
          { msgId },
          '[Moderação] ❌ recebido, mas não achei o produto dessa mensagem (post antigo ou fora do histórico).'
        );
        continue;
      }
      store.blockProduct(found.dealId, found.title);
      logger.warn(
        { produto: found.title, id: found.dealId, totalVetados: store.blockedCount() },
        '[Moderação] Produto VETADO por reação — nunca mais será postado.'
      );
    }
  });
}
