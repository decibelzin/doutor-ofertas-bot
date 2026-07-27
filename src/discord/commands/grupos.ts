import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { montarGrupos } from '../acoes/grupos';

/** /grupos — membros, vagas e pra onde o botão do site aponta. */
export const data = new SlashCommandBuilder()
  .setName('grupos')
  .setDescription('Estado dos grupos de WhatsApp')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply({ embeds: [montarGrupos()] });
}
