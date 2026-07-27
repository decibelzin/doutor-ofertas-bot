import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { lerFunil } from '../../core/funnel';
import { montarEmbedFunil } from '../embeds/funil';
import { criarPainel } from '../paineis';
import { config } from '../../config';
import { logger } from '../../logger';

/**
 * /funil — visitas, cliques e taxa de conversão da landing.
 *
 *   /funil                  -> resposta efêmera, só pra você, agora
 *   /funil canal:#metricas  -> painel fixo no canal, que se atualiza sozinho
 *
 * Só administradores: `setDefaultMemberPermissions` faz o Discord esconder o
 * comando de quem não tem a permissão — não é só uma checagem nossa.
 */
export const data = new SlashCommandBuilder()
  .setName('funil')
  .setDescription('Visitas, cliques e taxa de conversão da landing')
  .addChannelOption((o) =>
    o
      .setName('canal')
      .setDescription('Cria um painel que se atualiza sozinho neste canal')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
  )
  .addIntegerOption((o) =>
    o
      .setName('dias')
      .setDescription('Quantos dias olhar para trás (padrão: 1 = hoje)')
      .setMinValue(1)
      .setMaxValue(90)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const dias = interaction.options.getInteger('dias') ?? 1;
  const canal = interaction.options.getChannel('canal');

  // Ler e agregar o log pode passar dos 3s que o Discord dá pra responder.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!canal) {
      await interaction.editReply({ embeds: [montarEmbedFunil(lerFunil(dias))] });
      logger.info({ usuario: interaction.user.tag, dias }, '[discord] /funil consultado.');
      return;
    }

    if (!interaction.guildId) throw new Error('Este comando só funciona dentro de um servidor.');

    const { url, reaproveitado } = await criarPainel(interaction.client, {
      guildId: interaction.guildId,
      channelId: canal.id,
      dias,
      criadoPor: interaction.user.tag,
    });

    const min = config.discord.funilRefreshMinutes;
    await interaction.editReply(
      `${reaproveitado ? 'Painel atualizado' : 'Painel criado'} em <#${canal.id}> — ${url}\n` +
        (min > 0
          ? `Ele se atualiza sozinho a cada **${min} min**, e o botão **Atualizar** força na hora.`
          : 'Atualização automática está desligada; use o botão **Atualizar**.') +
        (reaproveitado ? '\n_Já existia um painel nesse canal, então reaproveitei em vez de criar outro._' : '')
    );
    logger.info(
      { usuario: interaction.user.tag, canal: canal.id, dias, reaproveitado },
      '[discord] Painel do funil configurado.'
    );
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err: msg, dias, canal: canal?.id }, '[discord] /funil falhou.');
    await interaction.editReply(
      `Não consegui: \`${msg}\`\n` +
        `Logs esperados em \`${config.site.logAcessos}\` e \`${config.site.logCliques}\`.`
    );
  }
}
