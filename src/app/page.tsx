"use client";

import { useEffect, useRef, useState } from "react";
import { createGame, type GameHandle, type GamePhase } from "@/game";
import { type PlayerPublicState } from "@shared/index";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type GameSettings } from "@/game/settings";
import { signInWithWallet } from "@/lib/supabase";
import { ShopPage } from "./menu/Shop";
import { FleetPanel } from "./menu/Fleet";
import { useGamepadNav } from "./menu/useGamepadNav";
import { HowToPanel, LandscapeGate, LoadingScreen, SettingsPanel, TitleMenu, FaucetPanel, WaitingScreen, IntroVideo } from "./menu/Menus";

type Overlay = "settings" | "howto" | "faucet" | null;

export default function Home() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const gameRef = useRef<GameHandle | null>(null);
	// Wraps the DOM menu overlays so the gamepad can move focus between their
	// controls (see useGamepadNav). display:contents keeps it layout-neutral.
	const overlayRef = useRef<HTMLDivElement>(null);

	const [phase, setPhase] = useState<GamePhase>("booting");
	const [ready, setReady] = useState(false);
	const [progress, setProgress] = useState(0);
	const [loadingDone, setLoadingDone] = useState(false);
	const [overlay, setOverlay] = useState<Overlay>(null);
	const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);
	const [wallet, setWallet] = useState<string | null>(null);
	const [gamepad, setGamepad] = useState<{ connected: boolean; id: string | null }>({ connected: false, id: null });
	// Buy-to-play entitlement, mirrored from the engine after connect / purchase.
	const [canPlay, setCanPlay] = useState<{ connected: boolean; ownsShip: boolean }>({ connected: false, ownsShip: false });
	// True while the title hands the screen to the in-world merchant overlay.
	const [shopMode, setShopMode] = useState(false);
	// True while the Fleet & Ledger holdings page is open (over the world/title/shop).
	const [fleetMode, setFleetMode] = useState(false);
	// The live off-chain ledger (purse/reputation/items) — refreshed from the engine's
	// onLedger callback. Null until the player is connected to the sea.
	const [ledger, setLedger] = useState<PlayerPublicState | null>(null);
	// Mobile landscape gate: block play until a touch device is turned sideways.
	const [portrait, setPortrait] = useState(false);
	// Cinematic intro, played only when a wallet authenticates for the FIRST TIME
	// EVER — Supabase's `players` table is the source of truth (the intro fires when
	// signInWithWallet inserts a brand-new address row, see the connect handler).
	// So a returning captain never sees it again, on any device.
	const [introOpen, setIntroOpen] = useState(false);

	// Boot the engine once. StrictMode mounts/unmounts/remounts, so the cleanup
	// must dispose synchronously or two engines + two WebSocket clients collide.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const handle = createGame(canvas, {
			onReady: () => setReady(true),
			onPhase: (p) => setPhase(p),
			onRequestOverlay: (name) => setOverlay(name),
			onGamepad: (g) => setGamepad(g),
			// Pause menu "Merchant / Shop" → the DOM Shop page over the paused world.
			// Not a buy-to-play open (they already own a hull), so no auto-return.
			onOpenShop: () => {
				buyToPlayRef.current = false;
				setShopMode(true);
			},
			// Off-chain ledger pushes (purse/reputation/fleet/items) from the server.
			onLedger: (s) => setLedger(s),
			// Wallet address changes: a silent restore on reload, a fresh connect, a
			// wallet-side switch, or a disconnect. Keeps the title/shop readout and the
			// buy-to-play entitlement in sync without re-prompting.
			onWallet: (a) => {
				setWallet(a);
				const h = gameRef.current;
				setCanPlay(a ? (h?.canPlay() ?? { connected: true, ownsShip: false }) : { connected: false, ownsShip: false });
			},
		});
		gameRef.current = handle;
		// Sync the React panel to the settings createGame already applied on boot.
		setSettings(loadSettings());
		// Seed the controller status (a pad plugged in before boot won't re-fire
		// the connect event, so read the engine's one-time poll now).
		setGamepad(handle.getGamepadStatus());

		// QA hatch (mirrors the engine's `?play`): open an overlay directly for a
		// headless screenshot without needing to click through the title.
		const menu = new URLSearchParams(window.location.search).get("menu");
		if (menu === "settings" || menu === "howto") {
			setLoadingDone(true);
			setOverlay(menu);
		}

		return () => {
			handle.dispose();
			if (gameRef.current === handle) gameRef.current = null;
		};
	}, []);

	// Re-read the buy-to-play entitlement (async on-chain count) from the engine.
	function refreshEntitlement(): void {
		const h = gameRef.current;
		if (!h) return;
		void h.refreshOwnership().then(() => setCanPlay(h.canPlay()));
	}

	// While the merchant is open over the title, poll the entitlement so we snap
	// back to "Set Sail" the moment a hull is bought — but only when the shop was
	// opened in buy-to-play mode. An already-eligible captain browsing for a second
	// hull must not have the shop yanked shut under them.
	const buyToPlayRef = useRef(false);
	useEffect(() => {
		if (!shopMode) return;
		const id = setInterval(() => {
			const h = gameRef.current;
			if (h && buyToPlayRef.current && h.canPlay().ownsShip) {
				clearInterval(id);
				setShopMode(false);
				setCanPlay(h.canPlay());
			}
		}, 1500);
		return () => clearInterval(id);
	}, [shopMode]);

	// Mobile landscape gate: track coarse-pointer + portrait, and try to lock the
	// screen orientation to landscape on the first user gesture.
	useEffect(() => {
		const isTouch =
			typeof window !== "undefined" &&
			(window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window);
		const check = () => setPortrait(isTouch && window.innerHeight > window.innerWidth);
		check();
		window.addEventListener("resize", check);
		window.addEventListener("orientationchange", check);
		return () => {
			window.removeEventListener("resize", check);
			window.removeEventListener("orientationchange", check);
		};
	}, []);

	function requestLandscape(): void {
		// screen.orientation.lock only succeeds in fullscreen; best-effort, ignored
		// on desktop/iOS where it's unsupported (the rotate overlay still nudges).
		const so = (screen as unknown as { orientation?: { lock?: (o: string) => Promise<void> } }).orientation;
		so?.lock?.("landscape").catch(() => {
			/* unsupported — rely on the rotate-your-device overlay */
		});
	}

	// Cosmetic loading bar: fill to 100%, then hold until the first frame is ready.
	useEffect(() => {
		const id = setInterval(() => {
			setProgress((p) => Math.min(100, p + 8 + Math.random() * 11));
		}, 80);
		return () => clearInterval(id);
	}, []);
	useEffect(() => {
		if (ready && progress >= 100) {
			const t = setTimeout(() => setLoadingDone(true), 350);
			return () => clearTimeout(t);
		}
	}, [ready, progress]);

	function changeSettings(next: GameSettings): void {
		setSettings(next);
		saveSettings(next);
		gameRef.current?.applySettings(next);
	}

	// Title/loading still cover the world, but the engine + DOM listeners need a
	// gesture to start the audio graph — Set Sail is that gesture.
	const play = () => gameRef.current?.startPlaying();
	const connect = () => {
		void (async () => {
			const a = await gameRef.current?.connectWallet();
			setWallet(a ?? null);
			refreshEntitlement();
			// Exchange the connected wallet for a Supabase session AND register it in
			// the `players` table (opens the signature popup). If it's a brand-new
			// address row, this is the wallet's first-ever authenticate → play the
			// intro. Non-fatal: a declined signature or Supabase error just skips it.
			if (a) {
				const res = await signInWithWallet(a);
				if (res?.isNew) setIntroOpen(true);
			}
		})();
	};
	const openShop = () => {
		requestLandscape();
		// Remember whether we're opening the shop to earn the right to play (no hull
		// yet) vs. just shopping. The auto-return-to-title only fires for the former.
		buyToPlayRef.current = !(gameRef.current?.canPlay().ownsShip ?? false);
		// The title merchant is the dedicated DOM Shop page (with artwork), not the
		// in-world Babylon dock panel; the dock stays for the E-key docking flow.
		setShopMode(true);
	};
	const closeShop = () => {
		setShopMode(false);
		refreshEntitlement();
	};

	const showLoading = !loadingDone;
	const showTitle = loadingDone && phase === "menu" && overlay === null && !shopMode;
	// Set Sail was clicked but the server hasn't welcomed us yet: show the waiting
	// screen (world hidden, render loop idle) until phase flips to "playing".
	const showWaiting = phase === "joining";

	// Any navigable DOM menu is up → let the gamepad drive focus within it. On the
	// title, B (onBack) is a no-op; it only dismisses a sub-menu or the shop. The
	// shop can be raised from the title (menu) OR the pause menu (playing).
	const menuActive = showTitle || shopMode || fleetMode || overlay !== null;
	const handleMenuBack = () => {
		if (fleetMode) setFleetMode(false);
		else if (overlay !== null) setOverlay(null);
		else if (shopMode) closeShop();
	};
	useGamepadNav({ containerRef: overlayRef, enabled: menuActive, onBack: handleMenuBack });

	return (
		<main className="relative flex h-screen w-screen flex-col items-center justify-center overflow-hidden bg-[#03070c]">
			<canvas
					ref={canvasRef}
					className="h-full w-full outline-none select-none"
					style={{ visibility: phase === "playing" ? "visible" : "hidden" }}
				/>
			{showLoading && <LoadingScreen progress={progress} />}
			{showWaiting && <WaitingScreen onCancel={() => gameRef.current?.cancelJoin()} />}
			{introOpen && <IntroVideo onClose={() => setIntroOpen(false)} />}
			{portrait && !showLoading && !showWaiting && <LandscapeGate />}
			<div ref={overlayRef} className="contents">
				{showTitle && (
					<TitleMenu
						onPlay={play}
						onSettings={() => setOverlay("settings")}
						onHowTo={() => setOverlay("howto")}
						onConnect={connect}
						onShop={openShop}
						onFleet={() => setFleetMode(true)}
						onFaucet={() => setOverlay("faucet")}
						wallet={wallet}
						canPlay={canPlay}
					/>
				)}
				{shopMode && (
					<ShopPage
						handle={gameRef.current}
						wallet={wallet}
						ledger={ledger}
						onClose={closeShop}
						onOpenFleet={() => setFleetMode(true)}
						onConnected={(addr) => {
							setWallet(addr);
							refreshEntitlement();
						}}
						onPurchased={() => {
							refreshEntitlement();
							setCanPlay(gameRef.current?.canPlay() ?? canPlay);
						}}
					/>
				)}
				{fleetMode && <FleetPanel handle={gameRef.current} ledger={ledger} wallet={wallet} onClose={() => setFleetMode(false)} />}
				{overlay === "settings" && (
					<SettingsPanel
						settings={settings}
						gamepad={gamepad}
						onChange={changeSettings}
						onClose={() => setOverlay(null)}
					/>
				)}
				{overlay === "howto" && <HowToPanel onClose={() => setOverlay(null)} />}
				{overlay === "faucet" && <FaucetPanel onClose={() => setOverlay(null)} />}
			</div>
		</main>
	);
}
