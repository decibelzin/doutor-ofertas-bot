import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { montarStatus } from '../acoes/status';

/** /status - está tudo no ar? */
export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Estado do bot: postagem, grupos e site')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply({ embeds: [await montarStatus()] });
}
