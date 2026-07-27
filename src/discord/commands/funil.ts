import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { lerFunil, type FunilResumo } from '../../core/funnel';
import { config } from '../../config';
import { logger } from '../../logger';

/**
 * /funil — visitas, cliques e taxa de conversão da landing.
 *
 * Só administradores: `setDefaultMemberPermissions` faz o Discord esconder o
 * comando de quem não tem a permissão, então não é só uma checagem nossa —
 * quem não é admin nem vê o comando existir.
 */
export const data = new SlashCommandBuilder()
  .setName('funil')
  .setDescription('Visitas, cliques e taxa de conversão da landing')
  .addIntegerOption((o) =>
    o
      .setName('dias')
      .setDescription('Quantos dias olhar para trás (padrão: 1 = hoje)')
      .setMinValue(1)
      .setMaxValue(90)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

const OURO = 0xe8b84b;
const VERDE = 0x25d366;

const pct = (n: number | null): string => (n === null ? '—' : `${n.toFixed(1)}%`);

function montarEmbed(f: FunilResumo): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(f.visitantes > 0 ? VERDE : OURO)
    .setTitle(`Funil da landing — ${f.dias === 1 ? 'hoje' : `últimos ${f.dias} dias`}`)
    .setURL('https://doutoroferta.com.br/perfumes')
    .setTimestamp(new Date());

  if (f.visitantes === 0 && f.cliques === 0) {
    e.setDescription(
      'Nenhuma visita registrada no período.\n' +
        'Se você sabe que houve acesso, o log pode ter rotacionado ou o nginx ' +
        'pode não estar gravando neste arquivo.'
    );
  } else {
    e.addFields(
      { name: 'Visitantes', value: `**${f.visitantes}**\n_IPs distintos_`, inline: true },
      { name: 'Cliques no CTA', value: `**${f.cliquesUnicos}**\n_${f.cliques} no total_`, inline: true },
      { name: 'Taxa de clique', value: `**${pct(f.taxaCliquePercent)}**`, inline: true }
    );

    if (f.origens.length) {
      e.addFields({
        name: 'De onde vieram',
        value: f.origens.slice(0, 6).map((o) => `\`${String(o.visitas).padStart(4)}\` ${o.origem}`).join('\n'),
      });
    }
    if (f.porNicho.length) {
      e.addFields({
        name: 'Cliques por nicho',
        value: f.porNicho.map((n) => `\`${String(n.cliques).padStart(4)}\` ${n.nicho}`).join('\n'),
        inline: true,
      });
    }
    if (f.porDia.length > 1) {
      // Últimos 10 dias: embed field tem teto de 1024 caracteres.
      e.addFields({
        name: 'Por dia',
        value: f.porDia
          .slice(-10)
          .map((d) => `\`${d.dia}\` ${String(d.visitantes).padStart(3)} visitas · ${String(d.cliques).padStart(3)} cliques`)
          .join('\n'),
      });
    }
  }

  const rodape = ['visitante = IP distinto; robôs filtrados'];
  if (f.avisos.length) rodape.push(...f.avisos);
  e.setFooter({ text: rodape.join(' · ').slice(0, 2048) });
  return e;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const dias = interaction.options.getInteger('dias') ?? 1;

  // Ler e agregar o log pode passar dos 3s que o Discord dá pra responder.
  // Efêmero: são dados de negócio e ninguém mais no canal precisa ver.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const f = lerFunil(dias);
    await interaction.editReply({ embeds: [montarEmbed(f)] });
    logger.info(
      { usuario: interaction.user.tag, dias, visitantes: f.visitantes, cliques: f.cliques },
      '[discord] /funil consultado.'
    );
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err: msg, dias }, '[discord] /funil falhou.');
    await interaction.editReply(
      `Não consegui ler o funil: \`${msg}\`\n` +
        `Logs esperados em \`${config.site.logAcessos}\` e \`${config.site.logCliques}\`.`
    );
  }
}
