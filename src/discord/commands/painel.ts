import { SlashCommandBuilder, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import { montarPainel } from '../painel';
import { logger } from '../../logger';

/** /painel — publica o painel de controle no canal. Mensagem fixa, não efêmera. */
export const data = new SlashCommandBuilder()
  .setName('painel')
  .setDescription('Publica o painel de controle com botões neste canal')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // Sem flag efêmera: o painel tem que FICAR no canal pra ser reusado.
  await interaction.reply(montarPainel());
  logger.info({ usuario: interaction.user.tag, canal: interaction.channelId }, '[discord] Painel publicado.');
}
