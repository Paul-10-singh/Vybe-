/*
 * Peace✘ - Discord Bot
 * Developed by ACEtnc
 *
 * Command registration — THE only entry point for registering slash commands.
 *
 * DEFAULT MODE: guild-scope (instant, single-scope, no duplicates).
 *   - clears GLOBAL commands (so they can never shadow the guild copy)
 *   - pushes to the camp guilds + DEV_GUILD_ID (if set)
 *   - flags --guild / --guild-only force this mode (safe no-op)
 *
 * OPT-IN GLOBAL MODE (--global / --pure-global):
 *   - pushes GLOBAL commands (up to 1h to appear) and wipes guild-scoped
 *     copies across every guild the bot shares. Warning: running this while
 *     guild-scope is active will make commands appear in ALL guilds, and the
 *     camp guilds will show duplicates until the next guild-scope deploy.
 *
 * Run:  npm run deploy            (guild-scope, instant)
 *       npm run deploy:guild      (same)
 *       npm run deploy:global     (global, optional)
 */
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { loadCommands } = require('./loadCommands');

const CAMP_GUILDS = [
  { id: '1340379968571576341', name: 'TNC OFFICIAL' },
  { id: '1510358429183774910', name: 'PeaceX Hq' },
];

const IS_GLOBAL =
  process.argv.includes('--global') || process.argv.includes('--pure-global');
const IS_GUILD =
  !IS_GLOBAL || process.argv.includes('--guild') || process.argv.includes('--guild-only');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

function resolveGuilds() {
  const names = new Map(CAMP_GUILDS.map((g) => [g.id, g.name]));
  const ids = new Set(names.keys());
  const dev = (process.env.DEV_GUILD_ID || '').trim();
  if (dev) {
    ids.add(dev);
    if (!names.has(dev)) names.set(dev, 'Dev Guild');
  }
  return [...ids].map((id) => ({ id, name: names.get(id) || id }));
}

async function deployGuildScope(appId, rest, commands) {
  // Clear globals so the guild copies are the ONLY ones —
  // this is what guarantees "no duplicates".
  await rest.put(Routes.applicationCommands(appId), { body: [] });
  console.log('[deploy] ▼ Global commands cleared (single-scope, no duplicates).');

  const memberGuilds = await rest.get('/users/@me/guilds');
  const memberIds = new Set(memberGuilds.map((g) => g.id));
  let allOk = true;

  for (const g of resolveGuilds()) {
    if (!memberIds.has(g.id)) {
      console.warn(`[deploy] ⚠ Skipping "${g.name}" (${g.id}) - bot is not in this guild.`);
      continue;
    }
    const stored = await rest.put(Routes.applicationGuildCommands(appId, g.id), { body: commands });
    if (stored.length !== commands.length) allOk = false;
    console.log(`[deploy] ➜ GUILD  "${g.name}" (${g.id}) -> ${stored.length} commands (instant).`);
  }

  if (!allOk) throw new Error('Guild push count mismatch — some commands did not register.');
  console.log('[deploy] ✔ Guild-scope deploy done.');
}

async function deployGlobal(appId, rest, commands) {
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

  // Wipe any stale guild-scoped commands so globals don't get shadowed.
  const guilds = await rest.get('/users/@me/guilds');
  for (const guild of guilds) {
    const guildCommands = await rest.get(Routes.applicationGuildCommands(appId, guild.id));
    if (guildCommands.length) {
      await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: [] });
      console.warn(`[deploy] ⚠ Wiped ${guildCommands.length} stale guild-scoped command(s) in ${guild.name}.`);
    }
  }

  console.log('[deploy] ✔ Done. Global deploy — commands appear in every guild (up to 1h).');
}

async function main() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = loadCommands();
  const appId = process.env.CLIENT_ID;
  if (!appId) throw new Error('CLIENT_ID not set in .env');

  console.log(`[deploy] Loading ${commands.length} commands from src/commands/...`);

  if (commands.length > 100) {
    throw new Error(`Deploy aborted — ${commands.length} commands exceed Discord's 100 command limit.`);
  }

  if (IS_GUILD) {
    await deployGuildScope(appId, rest, commands);
  } else {
    await deployGlobal(appId, rest, commands);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[deploy] ✘ FAILED:', err.message);
  process.exit(1);
});