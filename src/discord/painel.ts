import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
} from 'discord.js';
import { montarStatus } from './acoes/status';
import { montarGrupos } from './acoes/grupos';
import { montarPausar, montarRetomar } from './acoes/pausa';
import { montarEmbedFunil } from './embeds/funil';
import { lerFunil } from '../core/funnel';
import { OURO } from './acoes/comum';
import { logger } from '../logger';

/**
 * PAINEL DE CONTROLE — uma mensagem fixa com botões.
 *
 * A mensagem é ESTÁTICA: os botões respondem em efêmero e ninguém reescreve o
 * painel. Uma versão anterior tentava manter o próprio painel auto-atualizando
 * e era frágil — dependia de guardar o id da mensagem, sobreviver a restart e
 * reeditar em laço. Estático não tem nenhum desses modos de falha, e a
 * informação chega igual de fresca porque é lida na hora do clique.
 *
 * Toda ação existe TAMBÉM como slash command. O painel é conveniência, não a
 * única porta.
 */

export const BOTOES = {
  status: 'painel:status',
  funil: 'painel:funil',
  grupos: 'painel:grupos',
  pausar: 'painel:pausar',
  retomar: 'painel:retomar',
} as const;

export function montarPainel(): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder()
    .setColor(OURO)
    .setTitle('🎛️ Painel de Controle — Doutor Ofertas')
    .setDescription(
      'Use os botões abaixo. Só você vê as respostas.\n\n' +
        '**📊 Status** — está tudo no ar? última postagem, tetos, site\n' +
        '**📈 Funil** — visitas, cliques e conversão da landing\n' +
        '**👥 Grupos** — membros, vagas e pra onde o botão do site aponta\n' +
        '**⏸️ Pausar** — freia a postagem na hora\n' +
        '**▶️ Retomar** — volta a postar'
    )
    .setFooter({ text: 'cada botão também existe como comando: /status /funil /grupos /pausar /retomar' });

  const linha1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(BOTOES.status).setLabel('Status').setEmoji('📊').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(BOTOES.funil).setLabel('Funil').setEmoji('📈').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(BOTOES.grupos).setLabel('Grupos').setEmoji('👥').setStyle(ButtonStyle.Secondary)
  );

  const linha2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(BOTOES.pausar).setLabel('Pausar').setEmoji('⏸️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(BOTOES.retomar).setLabel('Retomar').setEmoji('▶️').setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [linha1, linha2] };
}

/** Roteia o clique. Devolve false quando o botão não é deste painel. */
export async function tratarBotaoPainel(interaction: ButtonInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith('painel:')) return false;

  // Pausar/Retomar mudam estado: só admin. Os de leitura ficam livres — quem
  // enxerga o painel já pode rodar os slash commands equivalentes.
  const mudaEstado = id === BOTOES.pausar || id === BOTOES.retomar;
  if (mudaEstado && !interaction.memberPermissions?.has('Administrator')) {
    await interaction.reply({
      content: 'Só administradores podem pausar ou retomar.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  // Ler log/arquivo e sondar o site passa dos 3s que o Discord dá pra responder.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const quem = interaction.user.tag;

  try {
    switch (id) {
      case BOTOES.status:
        await interaction.editReply({ embeds: [await montarStatus()] });
        break;
      case BOTOES.funil:
        await interaction.editReply({ embeds: [montarEmbedFunil(lerFunil(1))] });
        break;
      case BOTOES.grupos:
        await interaction.editReply({ embeds: [montarGrupos()] });
        break;
      case BOTOES.pausar:
        await interaction.editReply({ embeds: [montarPausar(quem, { motivo: 'pelo painel' })] });
        break;
      case BOTOES.retomar:
        await interaction.editReply({ embeds: [montarRetomar(quem)] });
        break;
      default:
        await interaction.editReply('Botão desconhecido.');
    }
    logger.info({ usuario: quem, botao: id }, '[discord] Botão do painel.');
  } catch (err) {
    logger.error({ err: (err as Error).message, botao: id }, '[discord] Falha no botão do painel.');
    await interaction.editReply(`Deu erro: \`${(err as Error).message}\``);
  }
  return true;
}
