/**
 * HighSeaz client runtime layer (code-first). The Babylon Editor `pack` path is
 * intentionally not used for the live world — a procedural ocean + network-
 * spawned ships do not survive the editor export step. Everything gameplay
 * lives here; `src/app` is just the React shell that mounts createGame().
 */
export { createGame } from "./core/createGame";
export type { GameHandle, GameOpts, GamePhase } from "./core/createGame";
export { OceanSystem } from "./ocean/OceanSystem";
export { WeatherSystem } from "./weather/WeatherSystem";
export { ShipManager } from "./entities/ShipManager";
export { IslandSystem } from "./world/IslandSystem";
export { CombatSystem } from "./combat/CombatSystem";
export { NetworkClient } from "./net/NetworkClient";
export { VFX } from "./vfx/VfxLibrary";
export type { VfxKey } from "./vfx/VfxLibrary";
export { Vfx } from "./vfx/VfxLibrary";
export { GameUi } from "./ui/GameUi";
export { DockingMenu } from "./ui/DockingMenu";
export { Wallet } from "./wallet/Wallet";
