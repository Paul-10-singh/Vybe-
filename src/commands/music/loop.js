/*
 * Peace✘ - Discord Bot
 * Developed by ACEtnc
 *
 * /loop - cycle the repeat mode (Off -> Track -> Queue -> Off).
 */
const { SlashCommandBuilder } = require('discord.js');
const { reply } = require('../../utils/helpers');
const { successEmbed, errorEmbed } = require('../../utils/decorations');
const { QueueRepeatMode } = require('../../music/player');
const { E } = require('../../utils/emojis');

const LABELS = {
  [QueueRepeatMode.OFF]: 'Off',
  [QueueRepeatMode.TRACK]: 'Track',
  [QueueRepeatMode.QUEUE]: 'Queue',
  [QueueRepeatMode.AUTOPLAY]: 'Autoplay',
};

module.exports = {
  data: new SlashCommandBuilder().setName('loop').setDescription('Toggle repeat mode (off / track / queue)'),
  async execute(interaction, client) {
    const queue = client.music.getQueue(interaction.guild.id);
    if (!queue || !queue.currentTrack) {
      return reply(interaction, { embeds: [errorEmbed({ description: 'Nothing is playing.' })], ephemeral: true });
    }
    const mode = client.music.cycleRepeat(interaction.guild.id);
    const label = LABELS[mode] ?? 'Off';
    const icon = mode === QueueRepeatMode.TRACK ? E.loop : mode === QueueRepeatMode.QUEUE ? E.Repeat : '➡️';
    return reply(interaction, { embeds: [successEmbed({ description: `${icon} Loop set to **${label}**.` })] });
  },
};
