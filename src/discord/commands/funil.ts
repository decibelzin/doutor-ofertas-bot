import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { lerFunil } from '../../core/funnel';
import { montarEmbedFunil } from '../embeds/funil';
import { config } from '../../config';
import { logger } from '../../logger';

/**
 * /funil - visitas, cliques e taxa de conversão da landing.
 *
 * Resposta efêmera: só quem rodou vê, e some sozinha.
 *
 * Só administradores: `setDefaultMemberPermissions` faz o Discord esconder o
 * comando de quem não tem a permissão - não é só uma checagem nossa.
 */
export const data = new SlashCommandBuilder()
  .setName('funil')
  .setDescription('Visitas, cliques e taxa de conversão da landing')
  .addIntegerOption((o) =>
    o
      .setName('dias')
      .setDescription('Janela do relatório: 1 = últimas 24h, 7 = última semana (padrão: 1)')
      .setMinValue(1)
      .setMaxValue(90)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const dias = interaction.options.getInteger('dias') ?? 1;

  // Ler e agregar o log pode passar dos 3s que o Discord dá pra responder.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await interaction.editReply({ embeds: [montarEmbedFunil(lerFunil(dias))] });
    logger.info({ usuario: interaction.user.tag, dias }, '[discord] /funil consultado.');
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err: msg, dias }, '[discord] /funil falhou.');
    await interaction.editReply(
      `Não consegui ler o funil: \`${msg}\`\n` +
        `Logs esperados em \`${config.site.logAcessos}\` e \`${config.site.logCliques}\`.`
    );
  }
}
