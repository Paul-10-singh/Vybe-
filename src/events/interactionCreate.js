/*
 * Peace music - interaction router.
 *
 * Dedicated music bot: every slash command is allowed for every member and
 * the `music:` component prefix is routed to the controls engine. Stale/old
 * component messages are acknowledged so Discord never times out.
 */
const { MessageFlags } = require('discord.js');

// DiscordAPIError codes that are harmless races (expired token, already acked,
// duplicate instance, or restart). Never crash or spam logs for these.
function isTransientInteractionError(err) {
  if (typeof err?.code !== 'number') return false;
  return [10062, 10060, 40060, 10063, 50027].includes(err.code);
}

module.exports = {
  name: 'interactionCreate',
  async execute(client, interaction) {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;

      try {
        const previous = client.embedModule;
        client.embedModule = command.__folder;
        try {
          await command.execute(interaction, client);
        } finally {
          client.embedModule = previous;
        }
      } catch (err) {
        if (isTransientInteractionError(err)) return;
        console.error(`[PeaceX] [Commands] Error in /${interaction.commandName}:`, err);
        const content = { content: 'Something went wrong while running this command.', flags: MessageFlags.Ephemeral };
        const attempt =
          interaction.deferred || interaction.replied ? interaction.followUp(content) : interaction.reply(content);
        await attempt.catch(() => {});
      }
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('music:')) {
        const { handleMusicComponent } = require('../music/interactions');
        await handleMusicComponent(interaction, client);
        return;
      }
      // Acknowledge stale buttons from removed panels so Discord stops spinning.
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('music:')) {
        const { handleMusicComponent } = require('../music/interactions');
        await handleMusicComponent(interaction, client);
        return;
      }
      if (interaction.customId === 'help_menu') {
        const help = require('../commands/utility/help.js');
        const embed =
          interaction.values[0] === 'home'
            ? help.buildHomeEmbed(client, interaction.user, interaction.guild)
            : help.buildModuleEmbed(client, interaction.values[0], interaction.user, interaction.guild);
        await interaction.update({ embeds: [embed], components: [help.buildSelectMenu(client, interaction.user, interaction.guild)] });
        return;
      }
      if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate().catch(() => {});
      return;
    }
  },
};