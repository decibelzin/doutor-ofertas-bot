import { config } from '../config';
import { logger } from '../logger';

/**
 * ALERTAS DE SAÚDE NO DISCORD, via webhook.
 *
 * Webhook e não o client do discord.js de propósito: quem dispara o alerta é o
 * processo do BOT DO WHATSAPP, que é separado do bot do Discord. Um webhook é
 * um POST HTTP sem dependência, sem token de bot e sem manter conexão — se o
 * bot do Discord estiver fora do ar, o alerta chega mesmo assim. Justamente
 * quando as coisas estão quebrando é que o canal de aviso não pode depender de
 * mais um processo estar vivo.
 *
 * Sem DISCORD_WEBHOOK_ALERTAS configurado, não faz nada (só o log de sempre).
 */

/** Não repetir o mesmo alerta a cada ciclo: 1 por motivo a cada 30 min. */
const SILENCIO_MS = 30 * 60_000;
const ultimo = new Map<string, number>();

/** O que cada `reason` do health.ts significa em português de gente. */
const EXPLICACAO: Record<string, string> = {
  'hub-vazio': 'O hub de afiliado do ML voltou vazio — normalmente é o cookie expirado.',
  'cupons-especiais-vazio': 'A API de cupons especiais respondeu sem nenhum cupom — cookie expirado.',
  'cupons-publicos-sem-sessao': 'A página de cupons não reconheceu a sessão — cookie expirado.',
  'busca-publica-muro': 'A busca pública caiu no muro de verificação do ML — precisa de cookie válido.',
  'shortlink-falhou': 'O encurtador meli.la recusou — cookie ou csrf inválido.',
};

const COR_ALERTA = 0xe5484d;

export async function enviarAlertaDiscord(motivo: string, mensagem: string, detalhe?: Record<string, unknown>): Promise<void> {
  const url = config.discord.webhookAlertas;
  if (!url) return;

  const agora = Date.now();
  const visto = ultimo.get(motivo) ?? 0;
  if (agora - visto < SILENCIO_MS) return;
  ultimo.set(motivo, agora);

  const campos = Object.entries(detalhe ?? {})
    .slice(0, 5)
    .map(([name, value]) => ({ name, value: String(value).slice(0, 200), inline: true }));

  const corpo = {
    username: 'Doutor Ofertas — Saúde',
    embeds: [
      {
        color: COR_ALERTA,
        title: `⚠️ ${motivo}`,
        description:
          (EXPLICACAO[motivo] ?? mensagem) +
          '\n\n_Quase sempre a correção é recapturar `ML_AFFILIATE_COOKIE` e `ML_AFFILIATE_CSRF` do painel de afiliado e reiniciar o serviço._',
        fields: campos.length ? campos : undefined,
        timestamp: new Date().toISOString(),
        footer: { text: 'só repito este aviso depois de 30 min' },
      },
    ],
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
    if (!res.ok) logger.warn({ status: res.status }, '[Alerta] Webhook do Discord recusou.');
  } catch (err) {
    // Falhar em avisar não pode derrubar quem estava avisando.
    logger.warn({ err: (err as Error).message }, '[Alerta] Não consegui chamar o webhook.');
  }
}
