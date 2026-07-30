import { SlashCommandBuilder, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import { montarEntrada } from '../entrada';
import { logger } from '../../logger';

/**
 * /entrada - publica no canal a mensagem com o botão que entrega o cargo.
 *
 * Admin-only igual ao /painel: quem publica a porta de entrada é quem manda no
 * servidor. Clicar no botão, esse sim, é livre pra qualquer um.
 */
export const data = new SlashCommandBuilder()
  .setName('entrada')
  .setDescription('Publica neste canal a mensagem de entrada com o botão de virar membro')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // Sem flag efêmera: a mensagem tem que FICAR no canal pra todo mundo clicar.
  await interaction.reply(montarEntrada());
  logger.info(
    { usuario: interaction.user.tag, canal: interaction.channelId },
    '[discord] Mensagem de entrada publicada.'
  );
}
