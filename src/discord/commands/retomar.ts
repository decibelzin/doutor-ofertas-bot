import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { montarRetomar } from '../acoes/pausa';

/** /retomar — desfaz a pausa. */
export const data = new SlashCommandBuilder()
  .setName('retomar')
  .setDescription('Volta a postar')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply({ embeds: [montarRetomar(interaction.user.tag)] });
}
