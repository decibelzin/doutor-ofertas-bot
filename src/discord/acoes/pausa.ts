import { EmbedBuilder } from 'discord.js';
import { lerPausa, pausar, retomar } from '../../core/pausa';
import { OURO, VERDE, minutosAtras, agora } from './comum';

/**
 * PAUSAR / RETOMAR — freio de mão da postagem.
 *
 * Escreve `data/pausa.json`, que o scheduler do bot do WhatsApp lê antes de
 * cada ciclo. Processos separados, estado em arquivo: pausa sobrevive a
 * restart, que é justamente quando você mais quer que ela valha.
 */

export function montarPausar(por: string, opts: { minutos?: number; motivo?: string } = {}): EmbedBuilder {
  const e = pausar({ por, ...opts });
  return new EmbedBuilder()
    .setColor(OURO)
    .setTitle('⏸️ Postagem pausada')
    .setDescription(
      'O bot **não vai postar** ofertas, cupons nem anúncios até retomar.\n' +
        (e.ate
          ? `Retoma sozinho ${agora(new Date(e.ate).getTime())}.`
          : 'Sem prazo — só volta no **Retomar**.')
    )
    .addFields({ name: 'Por', value: por, inline: true })
    .setFooter({ text: 'vale também pro post manual: pausa é parada dura' })
    .setTimestamp(new Date());
}

export function montarRetomar(por: string): EmbedBuilder {
  const antes = lerPausa();
  retomar(por);

  if (!antes) {
    return new EmbedBuilder()
      .setColor(VERDE)
      .setTitle('▶️ Já estava rodando')
      .setDescription('Não havia pausa ativa — nada mudou.');
  }

  return new EmbedBuilder()
    .setColor(VERDE)
    .setTitle('▶️ Postagem retomada')
    .setDescription(
      `Estava pausado desde ${minutosAtras(new Date(antes.desde).getTime())}, por \`${antes.por}\`.\n` +
        'O próximo ciclo do scheduler já volta a postar.'
    )
    .setTimestamp(new Date());
}

/** Estado atual, sem alterar nada — usado pelo painel e pelo /status. */
export function montarEstadoPausa(): EmbedBuilder {
  const p = lerPausa();
  if (!p) {
    return new EmbedBuilder()
      .setColor(VERDE)
      .setTitle('▶️ Rodando')
      .setDescription('A postagem está ativa.');
  }
  return new EmbedBuilder()
    .setColor(OURO)
    .setTitle('⏸️ Pausado')
    .setDescription(
      `Por \`${p.por}\`, desde ${minutosAtras(new Date(p.desde).getTime())}.` +
        (p.motivo ? `\nMotivo: _${p.motivo}_` : '') +
        (p.ate ? `\nRetoma ${agora(new Date(p.ate).getTime())}.` : '')
    );
}
