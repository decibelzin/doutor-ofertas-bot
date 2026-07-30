import { config } from '../config';
import { logger } from '../logger';
import { montarEmbedOferta } from '../format/discord';
import type { Deal } from './deal';

/**
 * OFERTAS NO CANAL DO DISCORD, via webhook.
 *
 * Mesma escolha do alerta-discord.ts: webhook e não o client do discord.js.
 * Quem posta a oferta é o processo do BOT DO WHATSAPP, que é separado do bot do
 * Discord de propósito (a sessão do Baileys é frágil demais pra dividir
 * processo). Um POST HTTP não cria dependência entre os dois: se o bot do
 * Discord cair, a oferta continua chegando no canal.
 *
 * Sem DISCORD_WEBHOOK_OFERTAS configurado, não faz nada.
 *
 * Não tem dedup próprio: é chamado no mesmo ponto em que a oferta foi escolhida
 * e postada nos grupos, então herda o dedup do `store`. Um dedup separado aqui
 * só criaria a chance dos dois canais divergirem.
 */
export async function enviarOfertaDiscord(deal: Deal): Promise<boolean> {
  const url = config.discord.webhookOfertas;
  if (!url) return false;

  const corpo = {
    username: 'Doutor Ofertas',
    embeds: [montarEmbedOferta(deal)],
  };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: ctrl.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      logger.warn({ status: res.status, id: deal.id }, '[Discord] Webhook de ofertas recusou.');
      return false;
    }
    logger.info({ id: deal.id, title: deal.title }, '[Discord] Oferta publicada no canal.');
    return true;
  } catch (err) {
    /* Falhar aqui NÃO pode derrubar a rodada: o WhatsApp é o canal principal e
       já recebeu a oferta antes desta chamada. Discord fora do ar é um post a
       menos, não uma rodada perdida. */
    logger.warn({ err: (err as Error).message, id: deal.id }, '[Discord] Não consegui publicar a oferta.');
    return false;
  }
}
