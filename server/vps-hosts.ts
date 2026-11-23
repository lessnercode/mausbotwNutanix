// Which VPS host a bot's computer lives on: the app-wide SSH alias, or the bot's own.
import { isValidSshAlias, vpsSshAlias, type AppConfig } from "./config.ts";

/** Set while a Nutanix desktop server is ready: every bot's desktop runs there, whatever its own alias says. */
export const sharedVpsHost: { alias: string | null } = { alias: null };

/** The shared host wins, then a bot's own SSH alias, then the default; each is validated the same way. */
export function vpsSshAliasForBot(cfg: AppConfig, bot: { vpsAlias?: string } | null | undefined): string | null {
  if (isValidSshAlias(sharedVpsHost.alias)) return sharedVpsHost.alias;
  return isValidSshAlias(bot?.vpsAlias) ? bot.vpsAlias : vpsSshAlias(cfg);
}

/** A config scoped to one bot's VPS alias, shaped for the vps-computer calls. */
export function vpsConfigForBot(cfg: AppConfig, bot: { vpsAlias?: string } | null | undefined): AppConfig {
  const sshAlias = vpsSshAliasForBot(cfg, bot);
  return sshAlias ? { vps: { sshAlias } } : {};
}

/** Every alias this installation can hold VPS computers on: the shared host and default first, then each bot's own. */
export function vpsAliasesInPlay(cfg: AppConfig, bots: ReadonlyArray<{ vpsAlias?: string }>): string[] {
  const aliases = new Set<string>();
  if (isValidSshAlias(sharedVpsHost.alias)) aliases.add(sharedVpsHost.alias);
  const primary = vpsSshAlias(cfg);
  if (primary) aliases.add(primary);
  for (const bot of bots) {
    if (isValidSshAlias(bot.vpsAlias)) aliases.add(bot.vpsAlias);
  }
  return [...aliases];
}
