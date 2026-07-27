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
 *   /funil                  -> painel fixo NESTE canal, que se atualiza sozinho
 *   /funil canal:#metricas  -> painel fixo em outro canal
 *   /funil efemero:true     -> retrato privado, só pra você, sem criar painel
 *
 * O painel é o padrão de propósito: é o que se usa no dia a dia. Antes era o
 * contrário e a pessoa rodava /funil esperando o painel, recebia uma mensagem
 * efêmera que sumia, e tinha que rodar de novo.
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
      .setDescription('Onde criar o painel (padrão: o canal atual)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
  )
  .addBooleanOption((o) =>
    o
      .setName('efemero')
      .setDescription('Só mostrar pra mim agora, sem criar painel fixo')
  )
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
  const efemero = interaction.options.getBoolean('efemero') ?? false;
  // Sem `canal`, o painel nasce onde o comando foi dado — é o que a pessoa
  // espera ao digitar /funil num canal.
  const canalId = interaction.options.getChannel('canal')?.id ?? interaction.channelId;

  // Ler e agregar o log pode passar dos 3s que o Discord dá pra responder.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (efemero) {
      await interaction.editReply({ embeds: [montarEmbedFunil(lerFunil(dias))] });
      logger.info({ usuario: interaction.user.tag, dias }, '[discord] /funil efêmero.');
      return;
    }

    if (!interaction.guildId) throw new Error('Este comando só funciona dentro de um servidor.');

    const { url, reaproveitado } = await criarPainel(interaction.client, {
      guildId: interaction.guildId,
      channelId: canalId,
      dias,
      criadoPor: interaction.user.tag,
    });

    const min = config.discord.funilRefreshMinutes;
    await interaction.editReply(
      `${reaproveitado ? 'Painel atualizado' : 'Painel criado'} em <#${canalId}> — ${url}\n` +
        (min > 0
          ? `Ele se atualiza sozinho a cada **${min} min**, e o botão **Atualizar** força na hora.`
          : 'Atualização automática está desligada; use o botão **Atualizar**.') +
        (reaproveitado ? '\n_Já existia um painel nesse canal, então reaproveitei em vez de criar outro._' : '')
    );
    logger.info(
      { usuario: interaction.user.tag, canal: canalId, dias, reaproveitado },
      '[discord] Painel do funil configurado.'
    );
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err: msg, dias, canal: canalId }, '[discord] /funil falhou.');
    await interaction.editReply(
      `Não consegui: \`${msg}\`\n` +
        `Logs esperados em \`${config.site.logAcessos}\` e \`${config.site.logCliques}\`.`
    );
  }
}
