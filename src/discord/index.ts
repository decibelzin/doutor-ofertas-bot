import { Client, GatewayIntentBits, REST, Routes, MessageFlags, type Interaction } from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import * as funil from './commands/funil';

/**
 * BOT DO DISCORD — processo separado do bot do WhatsApp.
 *
 * Separado de propósito: a sessão do Baileys é frágil e cara de recuperar
 * (reconectar é o momento de maior risco), então um erro aqui não pode
 * derrubar aquilo. Mesmo repositório porque o pipeline de ofertas — scraping,
 * dedup, formatação, link de afiliado — vai ser compartilhado quando as
 * ofertas passarem a sair também nos canais do servidor.
 *
 * Hoje só expõe /funil. Não pede intent privilegiada nenhuma: slash command
 * não precisa ler mensagem, então o bot roda com o mínimo de permissão.
 */

const comandos = [funil];

async function registrarComandos(): Promise<void> {
  const rest = new REST().setToken(config.discord.token);
  const corpo = comandos.map((c) => c.data.toJSON());

  // Registro por GUILD, não global: aparece na hora. O global leva até 1h pra
  // propagar, o que torna qualquer iteração insuportável.
  await rest.put(
    Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
    { body: corpo }
  );
  logger.info({ comandos: comandos.map((c) => c.data.name), guild: config.discord.guildId },
    '[discord] Comandos registrados.');
}

export async function iniciarDiscord(): Promise<Client> {
  const faltando = (['token', 'clientId', 'guildId'] as const).filter((k) => !config.discord[k]);
  if (faltando.length > 0) {
    throw new Error(
      `Discord sem configuração: falta ${faltando.map((f) => `DISCORD_${f === 'clientId' ? 'CLIENT_ID' : f === 'guildId' ? 'GUILD_ID' : 'TOKEN'}`).join(', ')} no .env`
    );
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('clientReady', (c) => {
    logger.info({ usuario: c.user.tag, servidores: c.guilds.cache.size }, '[discord] Conectado.');
  });

  client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = comandos.find((c) => c.data.name === interaction.commandName);
    if (!cmd) return;

    try {
      await cmd.execute(interaction);
    } catch (err) {
      // Um comando que explode não pode derrubar o processo nem deixar o
      // usuário olhando pro "pensando..." pra sempre.
      logger.error({ err: (err as Error).message, comando: interaction.commandName },
        '[discord] Erro não tratado no comando.');
      const aviso = { content: 'Deu erro ao executar. O log do servidor tem o detalhe.', flags: MessageFlags.Ephemeral } as const;
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: aviso.content });
      else await interaction.reply(aviso);
    }
  });

  client.on('error', (err) => logger.error({ err: err.message }, '[discord] Erro do cliente.'));

  await registrarComandos();
  await client.login(config.discord.token);
  return client;
}

/** Entrypoint do serviço (`node dist/discord/index.js`). */
async function main(): Promise<void> {
  const client = await iniciarDiscord();

  for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sinal, () => {
      logger.info({ sinal }, '[discord] Encerrando.');
      void client.destroy().finally(() => process.exit(0));
    });
  }
}

// Só roda como serviço quando é o módulo principal — permite importar daqui
// sem subir o bot (ex.: em teste ou quando o scheduler for reusar o client).
if (require.main === module) {
  main().catch((err: unknown) => {
    logger.error({ err: (err as Error).message }, '[discord] Falha ao iniciar.');
    console.error(`\n✗ ${(err as Error).message}\n`);
    process.exit(1);
  });
}
