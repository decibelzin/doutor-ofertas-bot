import { EmbedBuilder } from 'discord.js';
import type { FunilResumo } from '../../core/funnel';

/** Embed do funil, usado pela resposta do /funil. */

const OURO = 0xe8b84b;
const VERDE = 0x25d366;

const pct = (n: number | null): string => (n === null ? '-' : `${n.toFixed(1)}%`);

export function montarEmbedFunil(f: FunilResumo): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(f.visitantes > 0 ? VERDE : OURO)
    // "hoje" seria mentira: a janela é ROLANTE (agora − dias × 24h), não o dia
    // do calendário. Às 15h, dias=1 cobre das 15h de ontem até agora.
    .setTitle(`Funil da landing - ${f.dias === 1 ? 'últimas 24h' : `últimos ${f.dias} dias`}`)
    .setURL('https://doutoroferta.com.br/perfumes')
    .setTimestamp(new Date());

  if (f.visitantes === 0 && f.cliques === 0) {
    e.setDescription(
      'Nenhuma visita registrada no período.\n' +
        '_Se você sabe que houve acesso, o log pode ter rotacionado ou o nginx ' +
        'pode não estar gravando neste arquivo._'
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
        value: f.origens.slice(0, 6)
          .map((o) => `\`${String(o.visitas).padStart(4)}\` ${o.origem}`).join('\n'),
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
      // Teto de 1024 caracteres por field: 10 dias cabe com folga.
      e.addFields({
        name: 'Por dia',
        value: f.porDia.slice(-10)
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
