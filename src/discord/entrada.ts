import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  type ButtonInteraction,
} from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import { OURO, VERDE } from './acoes/comum';

/**
 * PORTA DE ENTRADA - mensagem fixa com um botão que entrega o cargo de membro.
 *
 * Mesmo desenho do painel: mensagem ESTÁTICA, resposta em efêmero. O botão é
 * roteado por `customId`, não por coletor, então ele continua funcionando
 * depois de reiniciar o bot - o que importa muito aqui, porque esta mensagem
 * fica pregada num canal por meses.
 *
 * O cargo é procurado por NOME (`DISCORD_CARGO_ENTRADA`, padrão "membro").
 *
 * ⚠️ Dois requisitos no servidor, e os dois falham silenciosamente sem
 * tratamento — por isso cada erro abaixo tem mensagem própria:
 *   1. o bot precisa da permissão "Gerenciar Cargos";
 *   2. o cargo mais alto do BOT precisa estar ACIMA do cargo entregue, na
 *      ordem da tela de cargos. O Discord recusa entregar cargo igual ou
 *      acima do próprio, e essa é a causa nº 1 de "não funciona".
 */

export const BOTAO_ENTRAR = 'entrada:entrar';

export function montarEntrada(): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setColor(OURO)
    .setTitle('👋 Bem-vindo ao Doutor Ofertas')
    .setDescription(
      'Pra liberar o servidor e ver os canais de ofertas, clique no botão abaixo.\n\n' +
        'Você recebe o cargo de membro na hora e os canais aparecem sozinhos. ' +
        'É de graça e leva um segundo.'
    )
    .setFooter({ text: 'Só você vê a confirmação do clique.' });

  const linha = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(BOTAO_ENTRAR)
      .setLabel('Entrar')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [linha] };
}

/** Roteia o clique. Devolve false quando o botão não é desta mensagem. */
export async function tratarBotaoEntrada(interaction: ButtonInteraction): Promise<boolean> {
  if (interaction.customId !== BOTAO_ENTRAR) return false;

  const responder = (content: string): Promise<unknown> =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });

  if (!interaction.guild) {
    await responder('Este botão só funciona dentro do servidor.');
    return true;
  }

  const nome = config.discord.cargoEntrada;

  // `fetch()` e não `cache`: o bot roda só com a intent Guilds, e depender do
  // cache de cargos aqui daria "cargo não encontrado" intermitente.
  const cargos = await interaction.guild.roles.fetch();
  const cargo = cargos.find((c) => c.name.toLowerCase() === nome.toLowerCase());

  if (!cargo) {
    logger.error({ cargo: nome, guild: interaction.guild.id }, '[discord] Cargo de entrada não existe.');
    await responder(
      `Não achei o cargo **${nome}** neste servidor. Avise um administrador — ` +
        'o cargo precisa existir com esse nome exato.'
    );
    return true;
  }

  const membro =
    interaction.member instanceof GuildMember
      ? interaction.member
      : await interaction.guild.members.fetch(interaction.user.id);

  if (membro.roles.cache.has(cargo.id)) {
    await responder(`Você já tem o cargo **${cargo.name}** — está tudo liberado.`);
    return true;
  }

  try {
    await membro.roles.add(cargo, 'Clicou no botão de entrada');
  } catch (err) {
    // 50013 = Missing Permissions. Quase sempre hierarquia, não a permissão em
    // si: o Discord devolve o mesmo código pros dois casos, então a mensagem
    // cobre os dois em vez de chutar um.
    const hierarquia = err instanceof DiscordAPIError && err.code === 50013;
    logger.error(
      { err: (err as Error).message, cargo: cargo.name, usuario: interaction.user.tag },
      '[discord] Falha ao entregar o cargo de entrada.'
    );
    await responder(
      hierarquia
        ? `Não consegui te dar o cargo **${cargo.name}**. Um administrador precisa ` +
            'dar a permissão "Gerenciar Cargos" ao bot e arrastar o cargo do bot ' +
            `para ACIMA de **${cargo.name}** na lista de cargos.`
        : 'Deu erro ao liberar seu acesso. Avise um administrador.'
    );
    return true;
  }

  logger.info(
    { usuario: interaction.user.tag, cargo: cargo.name },
    '[discord] Cargo de entrada entregue.'
  );

  const ok = new EmbedBuilder()
    .setColor(VERDE)
    .setDescription(`✅ Pronto! Você recebeu o cargo **${cargo.name}**. Os canais já estão liberados.`);
  await interaction.reply({ embeds: [ok], flags: MessageFlags.Ephemeral });
  return true;
}
