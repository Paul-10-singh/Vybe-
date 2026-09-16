/*
 * Peace music - Command registration.
 *
 * THE only entry point for registering slash commands. Global (single scope)
 * by default; use --guild-only for instant push to the two camp guilds.
 *
 * Flags:
 *   --guild-only    push ONLY to camp guilds (instant but shows temporary
 *                   duplicates next to the global copy until the next deploy).
 *   --pure-global   default single-scope flow.
 *
 * Run:  npm run deploy [-- --guild-only]
 */
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { loadCommands } = require('./loadCommands');

const CAMP_GUILDS = [
  { id: '1340379968571576341', name: 'TNC OFFICIAL' },
  { id: '1510358429183774910', name: 'PeaceX Hq' },
];

const GUILD_ONLY = process.argv.includes('--guild-only');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = loadCommands();
  const appId = process.env.CLIENT_ID;
  if (!appId) throw new Error('CLIENT_ID not set in .env');

  console.log(`[deploy] Loading ${commands.length} commands from src/commands/...`);

  if (commands.length > 100) {
    throw new Error(`Deploy aborted — ${commands.length} commands exceed Discord's 100 global command limit.`);
  }

  if (GUILD_ONLY) {
    const memberGuilds = await rest.get('/users/@me/guilds');
    const memberIds = new Set(memberGuilds.map((g) => g.id));
    for (const g of CAMP_GUILDS) {
      if (!memberIds.has(g.id)) {
        console.warn(`[deploy] ⚠ Skipping "${g.name}" (${g.id}) - bot is not in this guild.`);
        continue;
      }
      const stored = await rest.put(Routes.applicationGuildCommands(appId, g.id), { body: commands });
      console.log(`[deploy] ➜ GUILD  "${g.name}" (${g.id}) -> ${stored.length} commands (instant).`);
    }
    console.log('[deploy] ✔ Guild-only deploy done.');
    process.exit(0);
  }

  const putResult = await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log(`[deploy] ➜ GLOBAL -> ${putResult.length} commands stored.`);

  const stored = await rest.get(Routes.applicationCommands(appId));
  const names = stored.map((c) => c.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);

  if (stored.length !== commands.length) {
    console.error(`[deploy] ✘ VERIFICATION FAILED: expected ${commands.length}, Discord reports ${stored.length}.`);
    process.exit(1);
  }
  if (dupes.length) {
    console.error(`[deploy] ✘ VERIFICATION FAILED: duplicates: ${dupes.join(', ')}.`);
    process.exit(1);
  }
  console.log(`[deploy] ✔ Verified: exactly ${stored.length} global commands, no duplicates.`);

  // Wipe any stale guild-scoped commands.
  const guilds = await rest.get('/users/@me/guilds');
  for (const guild of guilds) {
    const guildCommands = await rest.get(Routes.applicationGuildCommands(appId, guild.id));
    if (guildCommands.length) {
      await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: [] });
      console.warn(`[deploy] ⚠ Wiped ${guildCommands.length} stale guild-scoped command(s) in ${guild.name}.`);
    }
  }

  console.log('[deploy] ✔ Done. Single-scope global deploy — every command shows exactly ONCE.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[deploy] ✘ FAILED:', err.message);
  process.exit(1);
});