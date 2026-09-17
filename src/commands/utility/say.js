/*
 * Peace✘ - Discord Bot
 * Developed by ACEtnc
 */
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { reply } = require('../../utils/helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a message as the bot.')
    .addStringOption((option) =>
      option.setName('message').setDescription('The message text').setRequired(true)
    )
    .addChannelOption((option) =>
      option.setName('channel').setDescription('Channel to send to (defaults to current)').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async execute(interaction, client) {
    const text = interaction.options.getString('message');
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    if (!channel?.isTextBased?.()) {
      return reply(interaction, { content: 'That is not a text channel.' }, true);
    }
    if (!text.trim()) {
      return reply(interaction, { content: 'Message cannot be empty.' }, true);
    }

    await channel.send(text.slice(0, 2000)).catch(() => {});
    await reply(interaction, { content: `Message sent to ${channel}.` }, true);
  },
};
