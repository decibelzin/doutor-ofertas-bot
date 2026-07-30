import { config } from '../config';
import { logger } from '../logger';
import { montarEmbedOferta } from '../format/discord';
import type { Deal } from './deal';

/**
 * OFERTAS NO CANAL DO DISCORD, via REST.
 *
 * Quem posta a oferta é o processo do BOT DO WHATSAPP, separado do bot do
 * Discord de propósito (a sessão do Baileys é frágil demais pra dividir
 * processo). Então ele precisa de um jeito de falar com o Discord sem virar
 * refém do outro processo estar vivo.
 *
 * `POST /channels/{id}/messages` com o próprio `DISCORD_TOKEN` resolve isso sem
 * abrir conexão de gateway, sem pedir intent e sem IPC entre os dois serviços.
 * Preferido a um webhook de canal porque:
 *   - não cria uma credencial nova pra guardar e rotacionar;
 *   - a mensagem sai com a identidade do BOT, não com um remetente paralelo;
 *   - webhook comum não aceita botão/componente, e um dia a oferta pode querer.
 *
 * Sem DISCORD_CANAL_OFERTAS (ou sem DISCORD_TOKEN), não faz nada.
 */

const API = 'https://discord.com/api/v10';

/** Erros da API que têm causa conhecida - vale dizer qual em vez de só o código. */
function explicar(status: number): string {
  if (status === 401) return 'DISCORD_TOKEN inválido ou expirado.';
  if (status === 403) return 'o bot não tem permissão de ver ou escrever neste canal.';
  if (status === 404) return 'canal não encontrado - confira DISCORD_CANAL_OFERTAS.';
  if (status === 429) return 'rate limit do Discord.';
  return `HTTP ${status}.`;
}

export async function enviarOfertaDiscord(deal: Deal): Promise<boolean> {
  const canal = config.discord.canalOfertas;
  const token = config.discord.token;
  if (!canal || !token) return false;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${API}/channels/${canal}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${token}`,
      },
      body: JSON.stringify({ embeds: [montarEmbedOferta(deal)] }),
      signal: ctrl.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      logger.warn(
        { status: res.status, causa: explicar(res.status), id: deal.id },
        '[Discord] Canal recusou a oferta.'
      );
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
