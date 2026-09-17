/*
 * Peace✘ - Discord Bot
 * Developed by ACEtnc
 */
const { SlashCommandBuilder } = require('discord.js');
const { reply } = require('../../utils/helpers');
const { categoryEmbed } = require('../../utils/decorations');
const vcTracker = require('../../utils/vcTracker');

function remainingText(hours) {
  const needed = vcTracker.WEEKLY_GOAL_HOURS - hours;
  if (needed <= 0) return '✅ **0 hours** (Goal Met)';
  const h = Math.floor(needed);
  const m = Math.floor((needed - h) * 60);
  return `⏳ **${h}h ${m}m needed** to become active`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vcstats')
    .setDescription('Check weekly VC time and remaining hours needed to reach the active goal.')
    .addUserOption((option) =>
      option.setName('member').setDescription('Member to check (defaults to you)').setRequired(false)
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    const member = interaction.options.getMember('member');
    const target = member || interaction.options.getUser('member') || interaction.user;
    const guildId = interaction.guild.id;

    const { startDate, endDate } = vcTracker.getWeekRange(0);
    const stats = vcTracker.getUserStats(target.id, guildId, startDate, endDate);
    const totalHours = (stats.totalSeconds + vcTracker.getLiveSeconds(target.id, guildId)) / 3600;

    const isActive = totalHours >= vcTracker.WEEKLY_GOAL_HOURS;
    const statusStr = isActive ? '🟢 **ACTIVE** (Goal Completed! 🎉)' : '🔴 **INACTIVE**';

    let breakdown = '';
    for (let i = 6; i >= 0; i--) {
      const date = vcTracker.daysAgoStr(i);
      const hrs = Math.round(((stats.dailyMap[date] || 0) / 3600) * 10) / 10;
      breakdown += `**${date}**: \`${hrs} hrs\`\n`;
    }

    const embed = categoryEmbed('utility', {
      title: `VC Stats: ${target.displayName || target.username}`,
      description: `**Period:** ${startDate} to ${endDate}`,
      fields: [
        { name: 'Current VC Time', value: `\`${totalHours.toFixed(2)} hrs\``, inline: true },
        { name: 'Target Goal', value: `\`${vcTracker.WEEKLY_GOAL_HOURS} hrs\``, inline: true },
        { name: 'Hours Needed to Complete', value: remainingText(totalHours), inline: false },
        { name: 'Current Status', value: statusStr, inline: false },
        { name: 'Daily Breakdown', value: breakdown, inline: false },
      ],
    });

    await reply(interaction, { embeds: [embed] });
  },
};
