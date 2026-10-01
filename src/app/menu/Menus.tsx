"use client";

import { useCallback, useRef } from "react";
import type { ReactNode } from "react";
import type { GameSettings } from "@/game/settings";
import { asset } from "@/game/core/assets";
import { FAUCETS, openFaucetPopup } from "@/game/core/faucet";

/**
 * DOM overlay menus (title / settings / how-to / loading). These render on top
 * of the Babylon canvas + HUD rather than inside a GUI texture, because the
 * meta-menus want to fully cover the world, need keyboard/IME focus navigation,
 * and would trip the AdvancedDynamicTexture NaN-layout trap the in-world menus
 * (pause / dock) already work around with fixed pixel heights.
 *
 * The gold "selected" fill lives in globals.css (`.hs-menu-btn:focus`), not in
 * these components: it follows DOM focus so gamepad and arrow-key navigation
 * move the highlight between buttons.
 */

const GOLD = "#e6c079";

function Fullscreen({ children }: { children: ReactNode }) {
	return (
		<div className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
			{children}
		</div>
	);
}

/** Full-bleed key-art screen (the loading-screen backdrop). The title menu sits on
 *  this instead of the live ocean, so boot → title → play keeps the same art under
 *  the menu rather than revealing the 3D world behind it. */
function KeyArtScreen({ children }: { children: ReactNode }) {
	return (
		<div
			className="absolute inset-0 z-40 flex items-center justify-center bg-cover bg-center"
			style={{ backgroundImage: `url('${asset("/ui/key_art.png")}')` }}
		>
			<div className="absolute inset-0 bg-black/65" />
			<div className="relative">{children}</div>
		</div>
	);
}

function Panel({ children, wide }: { children: ReactNode; wide?: boolean }) {
	return (
		<div
			className={`relative mx-4 rounded-2xl border px-8 py-8 shadow-2xl ${wide ? "w-[560px] max-w-[92vw]" : "w-[420px] max-w-[92vw]"}`}
			style={{
				background: "linear-gradient(180deg, rgba(9,17,29,0.97), rgba(6,11,20,0.98))",
				borderColor: "rgba(150,190,225,0.28)",
				boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
			}}
		>
			{children}
		</div>
	);
}

function MenuButton({
	children,
	onClick,
	primary,
	autoFocus,
}: {
	children: ReactNode;
	onClick: () => void;
	primary?: boolean;
	autoFocus?: boolean;
}) {
	return (
		<button
			type="button"
			autoFocus={autoFocus ?? primary}
			onClick={onClick}
			className="hs-menu-btn w-full rounded-xl border px-5 py-3 text-base font-bold tracking-wide text-[#eaf3ff] transition-colors hover:bg-[rgba(40,75,110,0.95)]"
			style={{ background: "rgba(30,60,90,0.9)", borderColor: "rgba(150,190,225,0.35)" }}
		>
			{children}
		</button>
	);
}

// ---- Loading screen ------------------------------------------------------

export function LoadingScreen({ progress }: { progress: number }) {
	const pct = Math.max(0, Math.min(100, Math.round(progress)));
	return (
		<div
			className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-cover bg-center"
			style={{ backgroundImage: `url('${asset("/ui/key_art.png")}')` }}
		>
			<div className="absolute inset-0 bg-black/65" />
			<div className="relative flex flex-col items-center gap-6">
				<h1
					className="text-5xl font-black tracking-[0.2em] text-[#eaf3ff] sm:text-6xl"
					style={{ textShadow: "0 4px 24px rgba(0,0,0,0.8)" }}
				>
					HIGHSEAZ
				</h1>
				<p className="text-sm tracking-[0.3em] text-[#8aa3bd] uppercase">Charting open water…</p>
				<div className="mt-2 h-2 w-72 max-w-[80vw] overflow-hidden rounded-full bg-white/15">
					<div
						className="h-full rounded-full transition-[width] duration-150 ease-out"
						style={{ width: `${pct}%`, background: GOLD }}
					/>
				</div>
			</div>
		</div>
	);
}

// ---- Waiting (joining the live server) ----------------------------------

/**
 * The join-waiting screen. Shown from the Set Sail click until the server's
 * `welcome` hands us a ship (createGame phase `joining`). Unlike the boot
 * LoadingScreen it is deliberately INDETERMINATE — there is no known progress
 * to report, only "the sea is being prepared for you." Because the world stays
 * hidden until welcome, this same screen transparently absorbs a slow or
 * overloaded server: the player simply waits here instead of staring at a blank
 * canvas, and the ocean appears the instant the server responds.
 */
export function WaitingScreen({ onCancel }: { onCancel: () => void }) {
	return (
		<div
			className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-cover bg-center"
			style={{ backgroundImage: `url('${asset("/ui/key_art.png")}')` }}
		>
			<div className="absolute inset-0 bg-black/70" />
			<div className="relative flex flex-col items-center gap-6">
				<div
					className="h-12 w-12 animate-spin rounded-full border-4 border-white/15"
					style={{ borderTopColor: GOLD }}
				/>
				<p className="text-sm tracking-[0.3em] text-[#8aa3bd] uppercase">Raising sail…</p>
				<p className="max-w-[80vw] text-center text-xs text-[#6b83a0]">
					Finding you a place on the sea. If the waters are crowded this can take a moment.
				</p>
				<button
					type="button"
					autoFocus
					onClick={onCancel}
					className="hs-menu-btn mt-2 rounded-xl border px-5 py-2 text-sm font-bold tracking-wide text-[#eaf3ff] transition-colors hover:bg-[rgba(40,75,110,0.95)]"
					style={{ background: "rgba(30,60,90,0.9)", borderColor: "rgba(150,190,225,0.35)" }}
				>
					Back to title
				</button>
			</div>
		</div>
	);
}

// Cinematic greeting played when a brand-new wallet connects. Full-bleed video
// over everything; a Skip button is the obvious exit (and the video auto-closes
// on `ended`). Browsers can block autoplay WITH sound, so a first click on the
// frame forces play() — the connect flow is already behind a real gesture, so
// this almost always just runs.
export function IntroVideo({ onClose }: { onClose: () => void }) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const forcePlay = useCallback(() => {
		const v = videoRef.current;
		if (v && v.paused) void v.play().catch(() => {});
	}, []);
	return (
		<div
			className="absolute inset-0 z-[60] flex items-center justify-center bg-black"
			onClick={forcePlay}
		>
			<video
				ref={videoRef}
				className="h-full w-full object-contain"
				src={asset("/highseaz/Intro%20Video.mp4")}
				autoPlay
				playsInline
				onEnded={onClose}
			/>
			<button
				type="button"
				autoFocus
				onClick={(e) => {
					e.stopPropagation();
					onClose();
				}}
				className="hs-menu-btn absolute right-5 top-5 rounded-xl border px-5 py-2 text-sm font-bold tracking-wide text-[#eaf3ff] transition-colors hover:bg-[rgba(40,75,110,0.95)]"
				style={{ background: "rgba(30,60,90,0.9)", borderColor: "rgba(150,190,225,0.35)" }}
			>
				Skip
			</button>
		</div>
	);
}

// ---- Title / start menu --------------------------------------------------
export function TitleMenu({
	onPlay,
	onSettings,
	onHowTo,
	onConnect,
	onDisconnect,
	onShop,
	onFleet,
	onFaucet,
	wallet,
	canPlay,
}: {
	onPlay: () => void;
	onSettings: () => void;
	onHowTo: () => void;
	onConnect: () => void;
	onDisconnect: () => void;
	onShop: () => void;
	onFleet: () => void;
	onFaucet: () => void;
	wallet: string | null;
	canPlay: { connected: boolean; ownsShip: boolean };
}) {
	const eligible = canPlay.connected && canPlay.ownsShip;
	// Buy-to-play: the headline button adapts to how far the player has got.
	const primaryLabel = !canPlay.connected ? "Connect Wallet" : !canPlay.ownsShip ? "Buy a Hull" : "Set Sail";
	const onPrimary = !canPlay.connected ? onConnect : !canPlay.ownsShip ? onShop : onPlay;
	const hint = !canPlay.connected
		? "Connect your wallet to begin."
		: !canPlay.ownsShip
			? "You need a ship before you can set sail."
			: "Sail, trade, or sink — the sea waits.";
	return (
		<KeyArtScreen>
			<Panel>
				<h1 className="text-center text-4xl font-black tracking-[0.15em] text-[#eaf3ff]">HIGHSEAZ</h1>
				<p className="mt-1 text-center text-sm text-[#8aa3bd]">{hint}</p>
				<div className="mt-8 flex flex-col gap-3">
					<MenuButton primary autoFocus onClick={onPrimary}>
						{primaryLabel}
					</MenuButton>
					{canPlay.connected && !canPlay.ownsShip && (
						<MenuButton onClick={onPlay}>Set Sail (no hull)</MenuButton>
					)}
					{eligible && <MenuButton onClick={onShop}>Merchant</MenuButton>}
					{canPlay.connected && <MenuButton onClick={onFleet}>Fleet & Ledger</MenuButton>}
					<MenuButton onClick={onHowTo}>How to Play</MenuButton>
					<MenuButton onClick={onSettings}>Settings</MenuButton>
					<MenuButton onClick={onFaucet}>Testnet Faucet</MenuButton>
				</div>
				<div className="mt-6 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
					<div className="flex items-center justify-between text-sm">
						<span className="text-[#c9d6e6]">Wallet</span>
						<span className="font-mono text-[#8aa3bd]">
							{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Not connected"}
						</span>
					</div>
					<div className="mt-2 flex items-center justify-between text-sm">
						<span className="text-[#c9d6e6]">Hulls owned</span>
						<span className="font-mono text-[#8aa3bd]">{canPlay.ownsShip ? "Yes" : "None"}</span>
					</div>
					{!canPlay.connected ? (
						<button
							type="button"
							onClick={onConnect}
							className="mt-2 w-full rounded-lg border border-[rgba(150,190,225,0.35)] bg-[rgba(30,60,90,0.9)] px-3 py-2 text-sm font-bold text-[#eaf3ff] transition-colors hover:bg-[rgba(40,75,110,0.95)]"
						>
							Connect Wallet
						</button>
					) : (
						<button
							type="button"
							onClick={onDisconnect}
							className="mt-2 w-full rounded-lg border border-white/15 bg-transparent px-3 py-2 text-sm font-bold text-[#8aa3bd] transition-colors hover:border-[#ff9b9b]/50 hover:text-[#ff9b9b]"
						>
							Disconnect Wallet
						</button>
					)}
				</div>
			</Panel>
		</KeyArtScreen>
	);
}

// ---- Mobile landscape gate ------------------------------------------------

export function LandscapeGate({ onFullscreen }: { onFullscreen?: () => void }) {
	return (
		<Fullscreen>
			<Panel>
				<div className="mx-auto mb-4 h-16 w-28 animate-pulse rounded-lg border-2 border-[#eaf3ff]" />
				<h2 className="text-center text-xl font-black tracking-wider text-[#eaf3ff]">ROTATE YOUR DEVICE</h2>
				<p className="mt-2 text-center text-sm text-[#8aa3bd]">
					HighSeaz is sailed in landscape. Turn your phone sideways to play.
				</p>
				{onFullscreen && (
					<button
						type="button"
						onClick={onFullscreen}
						className="mt-5 w-full rounded-lg border border-[rgba(150,190,225,0.35)] bg-[rgba(30,60,90,0.9)] px-3 py-2 text-sm font-bold text-[#eaf3ff] transition-colors hover:bg-[rgba(40,75,110,0.95)]"
					>
						Go fullscreen (locks landscape)
					</button>
				)}
			</Panel>
		</Fullscreen>
	);
}

// ---- Mobile "open in a wallet app" help ----------------------------------

const WALLET_APPS = [
	{ name: "MetaMask", blurb: "Wallet → browse the dApps tab." },
	{ name: "Rabby", blurb: "Wallet → the browser (globe) tab." },
	{ name: "Trust Wallet", blurb: "Wallet → dApps tab." },
	{ name: "Coinbase Wallet", blurb: "Wallet → the Discover tab." },
];

/**
 * Shown on a phone whose plain browser has no injected wallet (so Connect can't
 * work here). HighSeaz runs on a custom testnet chain, so the reliable way to
 * play on mobile is to open this page INSIDE a wallet app's built-in browser,
 * where the wallet is already injected and the network prompt works. We hand the
 * player the current URL to open there.
 */
export function WalletHelpPanel({ onClose }: { onClose: () => void }) {
	const url = typeof window !== "undefined" ? window.location.href : "";
	const copy = () => {
		void navigator.clipboard?.writeText(url).catch(() => {
			/* clipboard blocked on some in-app browsers — the URL is shown for manual copy */
		});
	};
	return (
		<Fullscreen>
			<Panel wide>
				<h2 className="text-center text-2xl font-black tracking-[0.12em] text-[#eaf3ff]">OPEN IN A WEB3 WALLET</h2>
				<p className="mt-2 text-center text-sm text-[#8aa3bd]">
					Your browser can't connect a wallet directly. Open HighSeaz inside a wallet app to play:
				</p>
				<ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-[#c9d6e6]">
					<li>Copy the link below.</li>
					<li>Open your wallet app's built-in browser.</li>
					<li>Paste the link and visit the page — then tap Connect Wallet as usual.</li>
				</ol>
				<div className="mt-4 flex items-center gap-2">
					<input
						readOnly
						value={url}
						onFocus={(e) => e.currentTarget.select()}
						className="min-w-0 flex-1 rounded-lg border border-white/15 bg-[rgba(6,11,20,0.9)] px-3 py-2 font-mono text-xs text-[#eaf3ff]"
					/>
					<button
						type="button"
						onClick={copy}
						className="shrink-0 rounded-lg border border-[rgba(150,190,225,0.35)] bg-[rgba(30,60,90,0.9)] px-3 py-2 text-sm font-bold text-[#eaf3ff] hover:bg-[rgba(40,75,110,0.95)]"
					>
						Copy
					</button>
				</div>
				<div className="mt-4 grid grid-cols-2 gap-2">
					{WALLET_APPS.map((w) => (
						<div key={w.name} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
							<div className="text-sm font-bold text-[#eaf3ff]">{w.name}</div>
							<div className="text-[11px] text-[#8aa3bd]">{w.blurb}</div>
						</div>
					))}
				</div>
				<button
					type="button"
					onClick={onClose}
					autoFocus
					className="mt-5 w-full rounded-lg border border-white/15 bg-[rgba(30,60,90,0.9)] px-3 py-2 text-sm font-bold text-[#eaf3ff] hover:bg-[rgba(40,75,110,0.95)]"
				>
					← Back
				</button>
			</Panel>
		</Fullscreen>
	);
}


// ---- Settings ------------------------------------------------------------

function Slider({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number;
	onChange: (v: number) => void;
}) {
	return (
		<label className="block">
			<div className="mb-1 flex items-center justify-between text-sm">
				<span className="text-[#c9d6e6]">{label}</span>
				<span className="tabular-nums text-[#8aa3bd]">{Math.round(value * 100)}%</span>
			</div>
			<input
				type="range"
				min={0}
				max={100}
				value={Math.round(value * 100)}
				onChange={(e) => onChange(Number(e.target.value) / 100)}
				className="w-full accent-[#e6c079]"
			/>
		</label>
	);
}

export function SettingsPanel({
	settings,
	gamepad,
	onChange,
	onClose,
}: {
	settings: GameSettings;
	gamepad?: { connected: boolean; id: string | null };
	onChange: (next: GameSettings) => void;
	onClose: () => void;
}) {
	return (
		<Fullscreen>
			<Panel>
				<h2 className="text-2xl font-bold tracking-wide text-[#eaf3ff]">Settings</h2>
				<div className="mt-6 flex flex-col gap-5">
					<Slider label="Master Volume" value={settings.master} onChange={(v) => onChange({ ...settings, master: v })} />
					<Slider label="Combat / SFX" value={settings.sfx} onChange={(v) => onChange({ ...settings, sfx: v })} />
					<Slider label="Ocean & Ambience" value={settings.ambient} onChange={(v) => onChange({ ...settings, ambient: v })} />
					<div>
						<div className="mb-1 text-sm text-[#c9d6e6]">Quality</div>
						<div className="flex gap-2">
							{(["high", "low"] as const).map((q) => (
								<button
									key={q}
									type="button"
									onClick={() => onChange({ ...settings, quality: q })}
									className={`flex-1 rounded-lg border px-3 py-2 text-sm font-bold capitalize transition-colors ${
										settings.quality === q
											? "border-[#e6c079] bg-[#e6c079] text-[#0a1526]"
											: "border-white/15 bg-white/5 text-[#c9d6e6] hover:bg-white/10"
									}`}
								>
									{q === "high" ? "High (filmic grade)" : "Low (performance)"}
								</button>
							))}
						</div>
					</div>
					{gamepad && (
						<div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3">
							<div className="flex items-center justify-between text-sm">
								<span className="text-[#c9d6e6]">Controller</span>
								<span
									className="font-mono"
									style={{ color: gamepad.connected ? "#9be8a0" : "#8aa3bd" }}
								>
									{gamepad.connected ? "● Connected" : "○ Not detected"}
								</span>
							</div>
							<p className="mt-1 truncate text-xs text-[#8aa3bd]" title={gamepad.id ?? undefined}>
								{gamepad.connected
									? gamepad.id
									: "Press a button on your gamepad, or reconnect it. Controls: left stick sails, RT/A fires, Start pauses, X docks."}
							</p>
						</div>
					)}
				</div>
				<div className="mt-8">
					<MenuButton primary autoFocus onClick={onClose}>
						Done
					</MenuButton>
				</div>
			</Panel>
		</Fullscreen>
	);
}

// ---- How to play ---------------------------------------------------------

function Row({ k, children }: { k: string; children: ReactNode }) {
	return (
		<div className="flex items-start justify-between gap-4 border-b border-white/5 py-2 text-sm last:border-0">
			<span className="font-mono text-[#e6c079]">{k}</span>
			<span className="text-right text-[#c9d6e6]">{children}</span>
		</div>
	);
}

export function HowToPanel({ onClose }: { onClose: () => void }) {
	return (
		<Fullscreen>
			<Panel wide>
				<h2 className="text-2xl font-bold tracking-wide text-[#eaf3ff]">How to Play</h2>
				<div className="mt-5 grid gap-7 sm:grid-cols-2">
					<div>
						<h3 className="mb-1 text-xs font-bold uppercase tracking-[0.2em] text-[#8aa3bd]">Controls</h3>
						<Row k="W / S">Throttle up / down</Row>
						<Row k="A / D">Steer the rudder</Row>
						<Row k="Space">Fire a broadside</Row>
						<Row k="Click">Aim + fire at the view</Row>
						<Row k="E">Dock when in port range</Row>
						<Row k="Esc">Pause menu</Row>
					</div>
					<div>
						<h3 className="mb-1 text-xs font-bold uppercase tracking-[0.2em] text-[#8aa3bd]">The Loop</h3>
						<p className="text-sm leading-relaxed text-[#c9d6e6]">
							Buy a ship with <b className="text-[#e6c079]">USDG</b>, then hunt the open sea. Sink other
							hulls to seize their cargo; lose your own and the cargo is gone forever — though the hull
							returns to your fleet for repair. Dock at a port to sell loot, take repairs, and post
							on-chain bounties against a rival&apos;s ship. Reputation with the Pirate, Naval and
							Merchant factions shifts with who you prey upon.
						</p>
						<p className="mt-3 text-sm leading-relaxed text-[#c9d6e6]">
							Weather is a weapon: storms hide you and slow the guns. Watch the wind.
						</p>
					</div>
				</div>
				<div className="mt-8">
					<MenuButton primary autoFocus onClick={onClose}>
						Got it
					</MenuButton>
				</div>
			</Panel>
		</Fullscreen>
	);
}

// ---- Testnet faucet ------------------------------------------------------

export function FaucetPanel({ onClose }: { onClose: () => void }) {
	return (
		<Fullscreen>
			<Panel>
				<h2 className="text-2xl font-bold tracking-wide text-[#eaf3ff]">Testnet Faucet</h2>
				<p className="mt-1 text-sm text-[#8aa3bd]">
					HighSeaz runs on the Robinhood Chain testnet. Grab gas and USDG below — each opens in a popup so you
					stay in the game.
				</p>
				<div className="mt-6 flex flex-col gap-3">
					{FAUCETS.map((f, i) => (
						<button
							key={f.url}
							type="button"
							autoFocus={i === 0}
							onClick={() => openFaucetPopup(f.url)}
							className="hs-menu-btn w-full rounded-xl border px-5 py-3 text-left transition-colors hover:bg-[rgba(40,75,110,0.95)]"
							style={{ background: "rgba(30,60,90,0.9)", borderColor: "rgba(150,190,225,0.35)" }}
						>
							<span className="block text-base font-bold tracking-wide text-[#eaf3ff]">{f.label}</span>
							<span className="block text-xs text-[#8aa3bd]">{f.note}</span>
						</button>
					))}
				</div>
				<div className="mt-8">
					<MenuButton onClick={onClose}>Done</MenuButton>
				</div>
			</Panel>
		</Fullscreen>
	);
}
