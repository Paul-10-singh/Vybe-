/*
 * Peace music - permissions.
 *
 * Dedicated music bot: every slash command is available to every member.
 * Kept as a module so the shared /help builder (canRunAny) works unchanged.
 *
 * isBotOwner() — "me/owner" gate for owner-only actions like /24-7 end.
 * Accepts the bot's application owner, an OWNER_ID env override, or a comma /
 * space separated list of owner ids.
 */
const OWNER_IDS = (process.env.OWNER_ID || '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

const TIERS = { EVERYONE: 1 };

function hasAccess() {
  return true;
}

function canRunAny() {
  return true;
}

async function resolveOwnerId(client) {
  try {
    const app = await client.application?.fetch();
    return app?.owner?.id || (app?.owner && app.owner.ownerId) || null;
  } catch {
    return client.application?.owner?.id || null;
  }
}

/** True if the interaction user is the bot owner ("me"). Caches per process. */
async function isBotOwner(interaction, client) {
  const uid = interaction.user.id;
  if (OWNER_IDS.includes(uid)) return true;
  if (client._ownerResolved === undefined) {
    client._ownerResolved = await resolveOwnerId(client).catch(() => null);
  }
  return client._ownerResolved === uid;
}

module.exports = { TIERS, hasAccess, canRunAny, isBotOwner, resolveOwnerId };