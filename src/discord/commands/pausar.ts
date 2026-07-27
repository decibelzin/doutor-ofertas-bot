import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { montarPausar } from '../acoes/pausa';

/** /pausar - freio de mão da postagem. */
export const data = new SlashCommandBuilder()
  .setName('pausar')
  .setDescription('Para de postar ofertas, cupons e anúncios')
  .addIntegerOption((o) =>
    o.setName('minutos').setDescription('Retomar sozinho depois de N minutos (padrão: sem prazo)').setMinValue(1).setMaxValue(1440)
  )
  .addStringOption((o) => o.setName('motivo').setDescription('Fica registrado no status'))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply({
    embeds: [
      montarPausar(interaction.user.tag, {
        minutos: interaction.options.getInteger('minutos') ?? undefined,
        motivo: interaction.options.getString('motivo') ?? undefined,
      }),
    ],
  });
}
