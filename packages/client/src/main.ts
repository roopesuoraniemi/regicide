import { discordSdk, isEmbedded } from './discordSdk';
import { io, Socket } from 'socket.io-client';
import './style.css';

let socket: Socket;
let roomId = 'lobby-1';
let currentRoomId: string | null = null;
let currentLobbyName = 'Lobby 1';
let currentView: 'LOADING' | 'LOBBY_SELECT' | 'ROOM' = 'LOADING';
let lobbiesSummary: any[] = [];
let myPlayerId = '';
let serverState: any = null;
let selectedCardIndices: number[] = [];
let lobbyErrorMessage: string | null = null;
let isLogCollapsed = false;

function escapeHtml(text: string): string {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

const PLAYER_LOG_COLORS = [
	'#48dbfb', // Sky blue
	'#feca57', // Warm amber / gold
	'#ff9ff3', // Pastel pink
	'#1dd1a1', // Mint emerald
	'#a29bfe', // Lavender
	'#ff6b6b', // Coral
	'#54a0ff', // Royal blue
	'#c8d6e5', // Ice blue
];

function getPlayerColor(name: string): string {
	if (serverState?.players) {
		const idx = serverState.players.findIndex((p: any) => p.name === name);
		if (idx !== -1) {
			return PLAYER_LOG_COLORS[idx % PLAYER_LOG_COLORS.length];
		}
	}
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = (hash << 5) - hash + name.charCodeAt(i);
	}
	return PLAYER_LOG_COLORS[Math.abs(hash) % PLAYER_LOG_COLORS.length];
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatLogMessage(text: string): string {
	let escaped = escapeHtml(text);

	const players: any[] = serverState?.players || [];
	const playerNames = Array.from(new Set(players.map((p: any) => p.name).filter(Boolean)))
		.sort((a, b) => b.length - a.length);

	const playerReplacements: string[] = [];
	playerNames.forEach((pName, i) => {
		const escapedName = escapeHtml(pName);
		const color = getPlayerColor(pName);
		const token = `___PL_${i}___`;
		playerReplacements.push(`<span class="log-player-name" style="color: ${color}; font-weight: 600;">${escapedName}</span>`);
		const regex = new RegExp(`(?<![\\w@])(${escapeRegex(escapedName)})(?![\\w])`, 'g');
		escaped = escaped.replace(regex, token);
	});

	// Highlight red suits (♥, ♦, Hearts, Diamonds)
	escaped = escaped.replace(/[♥♦]/g, '<span class="suit-red">$&</span>');
	escaped = escaped.replace(/\b(Hearts|Diamonds)\b/g, '<span class="suit-red">$1</span>');

	// Highlight black suits (♠, ♣, Spades, Clubs)
	escaped = escaped.replace(/[♠♣]/g, '<span class="suit-black">$&</span>');
	escaped = escaped.replace(/\b(Spades|Clubs)\b/g, '<span class="suit-black">$1</span>');

	// Restore player names
	playerReplacements.forEach((rep, i) => {
		const token = `___PL_${i}___`;
		escaped = escaped.replaceAll(token, rep);
	});

	return escaped;
}

// Fallback avatar (basic head silhouette base64 SVG data URI - immune to HTML attribute quoting issues)
const DEFAULT_AVATAR = `data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSI+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMzIiIGZpbGw9IiMyNjI2MjYiLz48Y2lyY2xlIGN4PSIzMiIgY3k9IjI0IiByPSIxMSIgZmlsbD0iIzg4ODg4OCIvPjxwYXRoIGQ9Ik0xNSA1MmMwLTkuNCA3LjYtMTcgMTctMTdzMTcgNy42IDE3IDE3IiBmaWxsPSIjODg4ODg4Ii8+PC9zdmc+`;

let storedAvatar = localStorage.getItem('regicide_player_avatar');
if (storedAvatar && (storedAvatar.includes('<svg') || storedAvatar.includes('"'))) {
	localStorage.removeItem('regicide_player_avatar');
	storedAvatar = null;
}
let playerAvatar = storedAvatar || DEFAULT_AVATAR;

// Persistent user ID and player name across refreshes
let persistentUserId = localStorage.getItem('regicide_user_id');
if (!persistentUserId) {
	persistentUserId = 'user_' + Math.random().toString(36).substring(2, 11);
	localStorage.setItem('regicide_user_id', persistentUserId);
}

let playerName = localStorage.getItem('regicide_player_name') || `Player ${Math.floor(100 + Math.random() * 900)}`;

// Check URL search parameters for custom room
const urlParams = new URLSearchParams(window.location.search);
const roomParam = urlParams.get('room');
if (roomParam) {
	roomId = roomParam;
	currentRoomId = roomParam;
}

const BASE_WIDTH = 1350;
const BASE_HEIGHT = 850;

export function updateAppScale() {
	const app = document.querySelector<HTMLDivElement>('#app');
	if (!app) return;
	const scale = Math.min(window.innerWidth / BASE_WIDTH, window.innerHeight / BASE_HEIGHT, 1);
	app.style.setProperty('--app-scale', scale.toString());
}

window.addEventListener('resize', updateAppScale);
if (window.visualViewport) {
	window.visualViewport.addEventListener('resize', updateAppScale);
}
updateAppScale();

function renderStatus(message: string, isError = false, details?: string) {
	updateAppScale();
	const app = document.querySelector<HTMLDivElement>('#app');
	if (!app) return;
	app.innerHTML = `
		<div class="menu-overlay">
			<div class="menu-content" style="max-width: 500px; text-align: center;">
				<h1 style="color: var(--red-suit); font-size: 2.5rem; margin-bottom: 15px;">REGICIDE</h1>
				<p style="color: ${isError ? '#cf6679' : 'var(--text-primary)'}; font-size: 1.1rem; margin-bottom: 15px;">
					${message}
				</p>
				${details ? `<pre style="color: #ff9e9e; background: #1a1a1a; padding: 10px; border-radius: 6px; font-size: 0.85rem; overflow-x: auto; text-align: left; word-break: break-all; white-space: pre-wrap;">${details}</pre>` : ''}
				${isError ? `<button id="btn-retry" style="margin-top: 15px; padding: 10px 20px; font-size: 1rem; border-radius: 6px; cursor: pointer;">Retry</button>` : ''}
			</div>
		</div>
	`;
	const retryBtn = document.getElementById('btn-retry');
	if (retryBtn) {
		retryBtn.addEventListener('click', () => window.location.reload());
	}
}

function renderLobbiesScreen() {
	updateAppScale();
	currentView = 'LOBBY_SELECT';
	currentRoomId = null;
	serverState = null;
	const app = document.querySelector<HTMLDivElement>('#app');
	if (!app) return;

	app.innerHTML = `
		<div class="menu-overlay">
			<div class="menu-content lobby-browser">
				<h1 style="color: var(--red-suit); font-size: 2.8rem; margin-bottom: 5px; letter-spacing: 2px;">REGICIDE</h1>
				<p style="color: #888; font-size: 0.95rem; margin-bottom: 25px;">Select a lobby to join the battle against the court</p>

				${lobbyErrorMessage ? `<div style="background: rgba(231, 76, 60, 0.2); border: 1px solid #e74c3c; color: #ff9e9e; padding: 10px 15px; border-radius: 6px; margin-bottom: 20px; font-size: 0.95rem; font-weight: 500;">⚠️ ${lobbyErrorMessage}</div>` : ''}

				<div class="player-name-box">
					<label for="player-name-input">Your Player Name:</label>
					<div class="player-name-input-row">
						<img class="player-avatar-large" src="${playerAvatar}" alt="Your Avatar" title="Player Avatar" />
						<input type="text" id="player-name-input" maxlength="20" value="${playerName}" placeholder="Enter your name..." />
					</div>
				</div>

				<div class="lobbies-grid">
					${lobbiesSummary.map(lobby => {
						const isOpen = lobby.isJoinable;
						const isPlaying = lobby.status !== 'LOBBY';
						const isFull = lobby.status === 'LOBBY' && lobby.playerCount >= 4;
						
						let badgeClass = 'badge-open';
						let badgeText = 'Open';
						let btnText = 'Join';
						let btnDisabled = false;

						if (isPlaying) {
							badgeClass = 'badge-playing';
							badgeText = 'In Game';
							btnText = 'Playing';
							btnDisabled = true;
						} else if (isFull) {
							badgeClass = 'badge-full';
							badgeText = 'Full';
							btnText = 'Full';
							btnDisabled = true;
						}

						return `
							<div class="lobby-card ${!isOpen ? 'is-unjoinable' : ''}">
								<div class="lobby-info">
									<div class="lobby-title">
										<span>${lobby.name}</span>
										<span class="badge ${badgeClass}">${badgeText}</span>
									</div>
									<div class="lobby-subtitle">${lobby.playerCount} / 4 Players</div>
									${lobby.players && lobby.players.length > 0 ? `
										<div class="lobby-players-list">
											${lobby.players.map((p: any) => `
												<span class="lobby-player-chip">
													<img class="player-avatar-small" src="${p.avatarUrl || DEFAULT_AVATAR}" alt="${p.name}" />
													<span>${p.name}</span>
												</span>
											`).join('')}
										</div>
									` : `<div class="lobby-empty-hint">Waiting for players</div>`}
								</div>
								<button class="btn-join" data-lobby-id="${lobby.id}" ${btnDisabled ? 'disabled' : ''}>
									${btnText}
								</button>
							</div>
						`;
					}).join('')}
				</div>

				<p style="font-size: 0.8rem; color: #666; margin-top: 15px;">
					Games in progress cannot be joined until the match completes or is reset.
				</p>
			</div>
		</div>
	`;

	const nameInput = document.getElementById('player-name-input') as HTMLInputElement;
	if (nameInput) {
		nameInput.addEventListener('input', (e) => {
			const target = e.target as HTMLInputElement;
			playerName = target.value.trim() || 'Player';
			localStorage.setItem('regicide_player_name', playerName);
		});
	}

	const joinButtons = document.querySelectorAll('.btn-join:not(:disabled)');
	joinButtons.forEach(btn => {
		btn.addEventListener('click', () => {
			const lobbyId = btn.getAttribute('data-lobby-id');
			if (lobbyId) {
				joinLobby(lobbyId);
			}
		});
	});
}

function joinLobby(lobbyId: string) {
	lobbyErrorMessage = null;
	currentRoomId = lobbyId;
	roomId = lobbyId;
	currentLobbyName = lobbyId === 'lobby-1' ? 'Lobby 1' : lobbyId === 'lobby-2' ? 'Lobby 2' : lobbyId === 'lobby-3' ? 'Lobby 3' : lobbyId;
	renderStatus(`Joining ${currentLobbyName}...`);
	socket.emit('joinRoom', lobbyId, playerName, persistentUserId, playerAvatar);
}

function leaveLobby() {
	if (currentRoomId) {
		socket.emit('leaveRoom', currentRoomId);
	}
	currentRoomId = null;
	serverState = null;
	renderLobbiesScreen();
	socket.emit('getLobbies');
}

function resetCurrentLobby() {
	if (currentRoomId) {
		socket.emit('resetLobby', currentRoomId);
	}
}

// --- ACTION EMITTERS ---
function toggleSelection(index: number) {
	if (selectedCardIndices.includes(index)) {
		selectedCardIndices = selectedCardIndices.filter(i => i !== index);
	} else {
		selectedCardIndices.push(index);
	}
	updateSelectionDOM();
}

function submitSelection() {
	if (selectedCardIndices.length === 0) return;
	socket.emit('playCards', roomId, selectedCardIndices);
	selectedCardIndices = [];
}

function yieldTurn() {
	socket.emit('yieldTurn', roomId);
	selectedCardIndices = [];
}

function useSoloJester() {
	socket.emit('useSoloJester', roomId);
	selectedCardIndices = [];
}

function choosePlayer(targetPlayerId: string) {
	socket.emit('chooseNextPlayer', roomId, targetPlayerId);
	selectedCardIndices = [];
}

// --- DISCORD SDK & SOCKET ---
setupDiscordSdk()
	.catch((error) => {
		console.error("SDK Error:", error);
		renderStatus('Initialization Error', true, error.message);
	});

async function setupDiscordSdk() {
	if (isEmbedded) {
		renderStatus('Connecting to Discord...');
		try {
			await discordSdk.ready();
			
			renderStatus('Authorizing with Discord...');
			const { code } = await discordSdk.commands.authorize({
				client_id: import.meta.env.VITE_CLIENT_ID,
				response_type: 'code',
				state: '',
				prompt: 'none',
				scope: ['applications.commands', 'identify', 'guilds', 'rpc.voice.read'],
			});

			renderStatus('Authenticating with game server...');
			const response = await fetch('/api/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code }),
			});

			const tokenData = await response.json().catch(() => ({}));
			if (!response.ok || !tokenData.access_token) {
				throw new Error(tokenData.error || `Failed token exchange (HTTP ${response.status})`);
			}

			const auth = await discordSdk.commands.authenticate({ access_token: tokenData.access_token });
			if (!auth) throw new Error('Discord SDK authenticate failed');
			if (auth.user) {
				if (auth.user.username) {
					playerName = auth.user.username;
					localStorage.setItem('regicide_player_name', playerName);
				}
				persistentUserId = auth.user.id;
				if (auth.user.avatar) {
					playerAvatar = `https://cdn.discordapp.com/avatars/${auth.user.id}/${auth.user.avatar}.png?size=128`;
				} else if (auth.user.id) {
					const defaultIndex = Number((BigInt(auth.user.id) >> 22n) % 6n);
					playerAvatar = `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
				}
				localStorage.setItem('regicide_player_avatar', playerAvatar);
			}
		} catch (e: any) {
			console.warn("Discord SDK authentication failed, proceeding with fallback session:", e);
			renderStatus('Discord authorization skipped. Connecting as guest...', false, e?.message);
		}
	}

	renderStatus('Connecting to Regicide server...');
	socket = io();
	
	socket.on('connect', () => {
		myPlayerId = socket.id || '';
		if (roomParam) {
			joinLobby(roomParam);
		} else {
			socket.emit('getLobbies');
		}
	});

	socket.on('lobbiesList', (lobbies) => {
		lobbiesSummary = lobbies;
		if (currentView === 'LOBBY_SELECT' || currentView === 'LOADING') {
			renderLobbiesScreen();
		}
	});

	socket.on('joinError', (errMsg) => {
		lobbyErrorMessage = errMsg;
		renderLobbiesScreen();
		socket.emit('getLobbies');
	});

	socket.on('leftRoom', () => {
		currentRoomId = null;
		serverState = null;
		renderLobbiesScreen();
		socket.emit('getLobbies');
	});

	socket.on('connect_error', (err) => {
		console.error("Socket connection error:", err);
		renderStatus('Unable to connect to game server (port 3001).', true, `Is the server running?\n${err.message}`);
	});

	socket.on('disconnect', (reason) => {
		console.warn("Socket disconnected:", reason);
		renderStatus('Disconnected from game server.', true, reason);
	});

	socket.on('gameState', (state) => {
		serverState = state;
		currentView = 'ROOM';
		currentRoomId = state.roomId;
		roomId = state.roomId;
		currentLobbyName = roomId === 'lobby-1' ? 'Lobby 1' : roomId === 'lobby-2' ? 'Lobby 2' : roomId === 'lobby-3' ? 'Lobby 3' : roomId;
		const myIndex = serverState.players.findIndex((p: any) => p.id === myPlayerId);
		if (myIndex !== serverState.activePlayerIndex) {
			selectedCardIndices = [];
		}
		triggerRender();
	});
}

// --- RENDERING ---
function triggerRender() {
	if (!serverState) return;
	if ((document as any).startViewTransition) {
		(document as any).startViewTransition(() => renderRegicideBoard());
	} else {
		renderRegicideBoard();
	}
}

function updateSelectionDOM() {
	const myIndex = serverState.players.findIndex((p: any) => p.id === myPlayerId);
	const myPlayer = serverState.players[myIndex];
	const isMyTurn = serverState.activePlayerIndex === myIndex;
	const hand = myPlayer ? myPlayer.hand : [];

	const handArea = document.getElementById('hand-area');
	if (handArea) {
		const cards = handArea.querySelectorAll('.card');
		cards.forEach((cardEl, i) => {
			if (selectedCardIndices.includes(i)) {
				cardEl.classList.add('selected');
			} else {
				cardEl.classList.remove('selected');
			}
			
			let isPlayable = true;
			if (serverState.gamePhase === 'PLAY' && selectedCardIndices.length > 0) {
				if (selectedCardIndices.includes(i)) {
					isPlayable = true;
				} else {
					const currentlySelected = selectedCardIndices.map(idx => hand[idx]);
					const newSelection = [...currentlySelected, hand[i]];
					
					const sum = newSelection.reduce((acc: number, card: any) => acc + card.value, 0);
					if (newSelection.some(card => card.rank === 'Joker')) isPlayable = false;
					else if (newSelection.length === 2 && newSelection.some(card => card.value === 1)) isPlayable = true;
					else {
						const firstVal = newSelection[0].value;
						if (!newSelection.every(card => card.value === firstVal) || sum > 10) isPlayable = false;
					}
				}
			}
			
			if (!isPlayable || !isMyTurn) {
				cardEl.classList.add('disabled');
			} else {
				cardEl.classList.remove('disabled');
			}
		});
	}
	
	updateButtons();
}

function updateButtons() {
	const btnContainer = document.getElementById('button-container');
	const promptContainer = document.getElementById('phase-prompt-container');
	if (!btnContainer) return;

	const myIndex = serverState.players.findIndex((p: any) => p.id === myPlayerId);
	const myPlayer = serverState.players[myIndex];
	const isMyTurn = serverState.activePlayerIndex === myIndex;
	const hand = myPlayer ? myPlayer.hand : [];

	const selectedCards = selectedCardIndices.map(i => hand[i]);
	let buttonHtml = '';
	let promptHtml = '';

	if (serverState.gamePhase === 'JESTER_CHOOSE_PLAYER') {
		if (isMyTurn) {
			promptHtml = `
				<div class="jester-choose-banner">
					<div style="font-weight: 700; font-size: 0.95rem; color: #f1c40f; margin-bottom: 4px;">
						★ Jester Played • Enemy Immunity Negated
					</div>
					<div style="font-size: 0.82rem; color: #ccc; margin-bottom: 10px;">
						Choose which player takes the next turn:
					</div>
					<div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
						${serverState.players.map((p: any) => `
							<button class="btn-choose-player" data-player-id="${p.id}">
								<img class="player-avatar-small" src="${p.avatarUrl || DEFAULT_AVATAR}" alt="${escapeHtml(p.name)}" />
								<span>${escapeHtml(p.name)} ${p.id === myPlayerId ? '(You)' : ''}</span>
							</button>
						`).join('')}
					</div>
				</div>
			`;
		} else {
			const activeP = serverState.players[serverState.activePlayerIndex];
			promptHtml = `
				<div class="turn-prompt-banner" style="border-color: #f1c40f;">
					<img class="player-avatar-small" src="${activeP?.avatarUrl || DEFAULT_AVATAR}" alt="${escapeHtml(activeP?.name || 'player')}" />
					<span style="color: #f1c40f;">★ Jester played • Waiting for <strong>${escapeHtml(activeP?.name || 'active player')}</strong> to choose next turn...</span>
				</div>
			`;
		}
	} else if (serverState.gamePhase === 'DISCARD') {
		const selectedSum = selectedCards.reduce((sum: number, c: any) => sum + c.value, 0);
		const disabled = (!isMyTurn || selectedSum < serverState.damageToTake) ? 'disabled' : '';
		if (isMyTurn) {
			promptHtml = `
				<div class="turn-prompt-banner discard-warning">
					Enemy attacks! Need ${serverState.damageToTake} value. (Selected: ${selectedSum}/${serverState.damageToTake})
				</div>
			`;
			buttonHtml = `
				<button class="action-btn btn-discard" id="submit-btn" ${disabled}>
					Discard Selected (${selectedSum}/${serverState.damageToTake})
				</button>
			`;
		} else {
			const activeP = serverState.players[serverState.activePlayerIndex];
			promptHtml = `
				<div class="turn-prompt-banner">
					<img class="player-avatar-small" src="${activeP?.avatarUrl || DEFAULT_AVATAR}" alt="${activeP?.name || 'player'}" />
					<span>Waiting for ${activeP?.name || 'player'} to discard...</span>
				</div>
			`;
		}
	} else {
		const sum = selectedCards.reduce((acc: number, c: any) => acc + c.value, 0);
		let isValid = true;
		if (selectedCards.length === 0) isValid = false;
		else if (selectedCards.length > 1) {
			if (selectedCards.some((c:any) => c.rank === 'Joker')) isValid = false;
			else if (selectedCards.length === 2 && selectedCards.some((c:any) => c.value === 1)) isValid = true;
			else {
				const firstVal = selectedCards[0].value;
				if (!selectedCards.every((c:any) => c.value === firstVal) || sum > 10) isValid = false;
			}
		}

		const isJoker = selectedCards.length === 1 && selectedCards[0].rank === 'Joker';
		const submitText = isJoker ? 'Play Jester (Cancel Immunity)' : 'Play Selected';
		const disabled = (!isMyTurn || !isValid) ? 'disabled' : '';

		if (isMyTurn) {
			buttonHtml = `
				<button class="action-btn btn-play" id="submit-btn" ${disabled}>${submitText}</button>
				<button class="action-btn btn-yield" id="yield-btn">Yield</button>
				${serverState.soloJestersRemaining > 0 ? `<button class="action-btn btn-solo-jester" id="jester-btn">Solo Jester (${serverState.soloJestersRemaining})</button>` : ''}
			`;
		} else {
			const activeP = serverState.players[serverState.activePlayerIndex];
			promptHtml = `
				<div class="turn-prompt-banner">
					<img class="player-avatar-small" src="${activeP?.avatarUrl || DEFAULT_AVATAR}" alt="${activeP?.name || 'player'}" />
					<span>Waiting for ${activeP?.name || 'player'}'s turn...</span>
				</div>
			`;
		}
	}

	btnContainer.innerHTML = buttonHtml;
	if (promptContainer) promptContainer.innerHTML = promptHtml;

	const spacer = document.getElementById('hand-actions-spacer');
	if (spacer) {
		spacer.style.display = buttonHtml ? 'block' : 'none';
	}

	const chooseBtns = document.querySelectorAll('.btn-choose-player');
	chooseBtns.forEach(btn => {
		btn.addEventListener('click', () => {
			const targetId = btn.getAttribute('data-player-id');
			if (targetId) choosePlayer(targetId);
		});
	});

	const submitBtn = document.getElementById('submit-btn');
	if (submitBtn && !submitBtn.hasAttribute('disabled')) {
		submitBtn.addEventListener('click', submitSelection);
	}
	const yieldBtn = document.getElementById('yield-btn');
	if (yieldBtn) yieldBtn.addEventListener('click', yieldTurn);
	const jesterBtn = document.getElementById('jester-btn');
	if (jesterBtn) jesterBtn.addEventListener('click', useSoloJester);
}

function renderRegicideBoard() {
	updateAppScale();
	const app = document.querySelector<HTMLDivElement>('#app');
	if (!app) return;

	if (serverState.status === 'LOBBY') {
		app.innerHTML = `
			<div class="menu-overlay">
				<div class="menu-content" style="max-width: 480px;">
					<h1 style="color: var(--red-suit); font-size: 2.6rem; margin-bottom: 5px;">${currentLobbyName.toUpperCase()}</h1>
					<p style="margin-bottom: 5px; font-size: 1.05rem;">${serverState.players.length} / 4 Players connected</p>
					<p style="font-size: 0.85rem; color: #888; margin-bottom: 20px;">
						Waiting in room: <span style="color: #bbb; font-family: monospace;">${roomId}</span>
					</p>
					<div style="margin-bottom: 22px; line-height: 1.8; background: #1a1a1a; padding: 14px 18px; border-radius: 8px; border: 1px solid #333; text-align: left;">
						<div style="font-size: 0.8rem; text-transform: uppercase; color: #777; margin-bottom: 10px; font-weight: bold;">Party Members</div>
						<div style="display: flex; flex-direction: column; gap: 8px;">
							${serverState.players.map((p:any) => `
								<div style="display: flex; align-items: center; gap: 10px;">
									<img class="player-avatar" src="${p.avatarUrl || DEFAULT_AVATAR}" alt="${p.name}" />
									<span style="font-weight: 500;">${p.name} ${p.id === myPlayerId ? '<span style="color: var(--accent); font-size: 0.85rem; font-weight: bold;">(You)</span>' : ''}</span>
								</div>
							`).join('')}
						</div>
					</div>
					<div style="display: flex; gap: 12px; justify-content: center;">
						<button id="btn-start" style="padding: 10px 24px; font-size: 1.05rem; cursor: pointer; border-radius: 6px; background: var(--accent); color: #121212; font-weight: bold; border: none;">Start Game</button>
						<button id="btn-leave-lobby" class="btn-secondary" style="padding: 10px 20px; font-size: 1.05rem; cursor: pointer; border-radius: 6px;">Leave Lobby</button>
					</div>
				</div>
			</div>
		`;
		
		const btnStart = document.getElementById('btn-start');
		if (btnStart) btnStart.addEventListener('click', () => socket.emit('startGame', roomId));

		const btnLeaveLobby = document.getElementById('btn-leave-lobby');
		if (btnLeaveLobby) btnLeaveLobby.addEventListener('click', () => leaveLobby());

		return;
	}

	if (serverState.status === 'GAME_OVER_WIN' || serverState.status === 'GAME_OVER_LOSS') {
		const isWin = serverState.status === 'GAME_OVER_WIN';
		app.innerHTML = `
			<div class="menu-overlay">
				<div class="menu-content" style="max-width: 500px; text-align: center;">
					<h1 style="color: ${isWin ? '#f1c40f' : '#cf6679'}; font-size: 3.5rem; margin-bottom: 10px;">
						${isWin ? '👑 VICTORY!' : '💀 DEFEAT!'}
					</h1>
					<p style="color: #bbb; font-size: 1.1rem; margin-bottom: 25px;">
						${isWin ? 'All 12 Castle Royals have been defeated! The realm is saved.' : 'The party fell before the court. Better luck next time!'}
					</p>
					<div style="display: flex; gap: 15px; justify-content: center;">
						<button id="btn-play-again" style="padding: 12px 24px; font-size: 1.05rem; cursor: pointer; border-radius: 6px; background: var(--accent); color: #121212; font-weight: bold; border: none;">
							Play Again
						</button>
						<button id="btn-return-lobbies" class="btn-secondary" style="padding: 12px 20px; font-size: 1.05rem; cursor: pointer; border-radius: 6px;">
							Back to Lobbies
						</button>
					</div>
				</div>
			</div>
		`;

		const btnPlayAgain = document.getElementById('btn-play-again');
		if (btnPlayAgain) {
			btnPlayAgain.addEventListener('click', () => resetCurrentLobby());
		}
		const btnReturn = document.getElementById('btn-return-lobbies');
		if (btnReturn) {
			btnReturn.addEventListener('click', () => leaveLobby());
		}
		return;
	}

	let immunityTag = serverState.immunityCanceled 
		? '<div class="immunity-negated-banner">Immunity Negated (★ Jester)</div>' 
		: '';

	const myIndex = serverState.players.findIndex((p: any) => p.id === myPlayerId);
	const myPlayer = serverState.players[myIndex] || { name: playerName, id: myPlayerId, hand: [] };
	const isMyTurn = serverState.activePlayerIndex === myIndex;
	const hand = myPlayer ? myPlayer.hand : [];

	app.innerHTML = `
		<div class="game-top-bar">
			<span style="font-weight: bold; color: var(--accent); font-size: 1.05rem; letter-spacing: 0.5px;">${currentLobbyName}</span>
			<button id="btn-reset-game" class="btn-small">Reset Game</button>
			<button id="btn-leave-game" class="btn-small">Leave Game</button>
			<button id="btn-toggle-log" class="btn-small ${isLogCollapsed ? '' : 'btn-active'}">Log ${(serverState.logs && serverState.logs.length > 0) ? `(${serverState.logs.length})` : ''}</button>
			${immunityTag}
		</div>
		<div class="table-area" id="table-area"></div>
		<div id="opponent-hands"></div>
		<div id="game-log-panel" class="game-log-panel ${isLogCollapsed ? 'collapsed' : ''}">
			<div class="log-header">
				<div class="log-title">
					<span>Game Log</span>
					<span class="log-count">${serverState.logs?.length || 0}</span>
				</div>
				<div class="log-actions">
					<button id="btn-minimize-log" class="btn-log-action" title="Minimize log">−</button>
				</div>
			</div>
			<div class="log-entries" id="log-entries">
				${(serverState.logs && serverState.logs.length > 0) 
					? serverState.logs.map((entry: any) => `
						<div class="log-entry">
							<div class="log-text">${formatLogMessage(entry.text)}</div>
						</div>
					`).join('')
					: `<div class="log-empty">No events yet</div>`
				}
			</div>
		</div>
		<div class="player-hand-section">
			<div id="phase-prompt-container"></div>
			<div class="self-player-bar">
				<img class="player-avatar-small" src="${myPlayer.avatarUrl || playerAvatar || DEFAULT_AVATAR}" alt="${myPlayer.name}" />
				<span class="self-name">${myPlayer.name} (You)</span>
				${isMyTurn ? '<span class="active-turn-badge">Your Turn</span>' : ''}
			</div>
			<div class="hand-wrapper">
				<div class="hand-actions-spacer" id="hand-actions-spacer"></div>
				<div class="hand-area" id="hand-area"></div>
				<div class="hand-actions" id="button-container"></div>
			</div>
		</div>
	`;

	const btnReset = document.getElementById('btn-reset-game');
	if (btnReset) {
		btnReset.addEventListener('click', () => {
			resetCurrentLobby();
		});
	}
	const btnLeave = document.getElementById('btn-leave-game');
	if (btnLeave) {
		btnLeave.addEventListener('click', () => {
			leaveLobby();
		});
	}

	const btnToggleLog = document.getElementById('btn-toggle-log');
	if (btnToggleLog) {
		btnToggleLog.addEventListener('click', () => {
			isLogCollapsed = !isLogCollapsed;
			const panel = document.getElementById('game-log-panel');
			if (panel) panel.classList.toggle('collapsed', isLogCollapsed);
			btnToggleLog.classList.toggle('btn-active', !isLogCollapsed);
		});
	}

	const btnMinimizeLog = document.getElementById('btn-minimize-log');
	if (btnMinimizeLog) {
		btnMinimizeLog.addEventListener('click', () => {
			isLogCollapsed = true;
			const panel = document.getElementById('game-log-panel');
			const toggleBtn = document.getElementById('btn-toggle-log');
			if (panel) panel.classList.add('collapsed');
			if (toggleBtn) toggleBtn.classList.remove('btn-active');
		});
	}

	const logEntries = document.getElementById('log-entries');
	if (logEntries) {
		logEntries.scrollTop = logEntries.scrollHeight;
	}

	updateButtons();
	renderTablePiles();
	renderOpponentHands(myIndex);
	renderHand(hand, isMyTurn);
}

function createCardHTML(card: any, isEnemy = false, isFaceDown = false, pileId = '', isSelected = false, isDisabled = false) {
	const transitionId = card?.id || pileId;
	const transitionStyle = transitionId ? `style="view-transition-name: ${transitionId};"` : '';

	if (isFaceDown) {
		return `<div class="card face-down" ${transitionStyle}></div>`;
	}
	if (!card) return `<div class="card face-down" style="visibility:hidden"></div>`;

	const isRed = card.suit === '♥' || card.suit === '♦';
	const colorClass = card.rank === 'Joker' ? 'jester' : isRed ? 'red' : 'black';
	const enemyClass = isEnemy ? 'enemy' : '';
	const animClass = card.isNew ? 'animate-draw' : '';
	const selectClass = isSelected ? 'selected' : '';
	const disabledClass = isDisabled ? 'disabled' : '';

	return `
		<div class="card ${colorClass} ${enemyClass} ${animClass} ${selectClass} ${disabledClass}" ${transitionStyle}>
			<div class="card-top"><span>${card.rank}</span><span>${card.suit}</span></div>
			<div class="card-center">${card.suit}</div>
			<div class="card-bottom"><span>${card.rank}</span><span>${card.suit}</span></div>
		</div>
	`;
}

function renderTablePiles() {
	const tableArea = document.getElementById('table-area');
	if (!tableArea) return;

	const tavernHtml = `
		<div class="pile-container tavern-container">
			<div class="pile-label">Tavern (${serverState.deckCount})</div>
			${serverState.deckCount > 0 
				? createCardHTML(null, false, true, 'tavern-deck') 
				: `<div class="card discard-placeholder"><span class="placeholder-icon">🍺</span></div>`
			}
		</div>
	`;

	let enemyHtml = '';
	if (serverState.currentEnemy) {
		const card = serverState.currentEnemy;
		const immunityInfo = serverState.immunityCanceled 
			? '<span style="color: #2ecc71; font-weight: bold;">Immunity Negated (★)</span>' 
			: `Immune to ${card.suit}`;
		const statsHtml = `
			<div class="enemy-stats">
				<div class="enemy-stat-row">Health: ${card.currentHp} &bull; Attack: ${card.attack}</div>
				<div class="enemy-immunity" style="color: ${serverState.immunityCanceled ? '#2ecc71' : '#888'};">
					${immunityInfo}
				</div>
			</div>
		`;
		enemyHtml = `
			<div class="pile-container enemy-container">
				<div class="pile-label">Enemy</div>
				${createCardHTML(card, true, false)}
				${statsHtml}
			</div>
		`;
	}

	const playedCards = serverState.playedCards || [];
	const playedCount = playedCards.length;
	let playedCardsInnerHtml = '';
	if (playedCount === 0) {
		playedCardsInnerHtml = `
			<div class="played-cards-placeholder">
				<span class="placeholder-icon">⚔️</span>
				<span class="placeholder-label">No cards in play</span>
			</div>
		`;
	} else {
		playedCardsInnerHtml = playedCards.map((card: any) => createCardHTML(card, false, false)).join('');
	}

	const playAreaHtml = `
		<div class="pile-container play-area-container">
			<div class="pile-label">Play Area (${playedCount})</div>
			<div class="played-cards-area">
				${playedCardsInnerHtml}
			</div>
		</div>
	`;

	const centerColumnHtml = `
		<div class="combat-center-column">
			${enemyHtml}
			${playAreaHtml}
		</div>
	`;

	const topDiscard = serverState.discard.length > 0 ? serverState.discard[serverState.discard.length - 1] : null;
	const discardHtml = `
		<div class="pile-container discard-container">
			<div class="pile-label">Discard (${serverState.discard.length})</div>
			${topDiscard 
				? createCardHTML(topDiscard, false, false) 
				: `<div class="card discard-placeholder"><span class="placeholder-icon">🗑️</span></div>`
			}
		</div>
	`;

	tableArea.innerHTML = tavernHtml + centerColumnHtml + discardHtml;
}

function renderOpponentHands(myIndex: number) {
	const container = document.getElementById('opponent-hands');
	if (!container) return;
	
	let html = '';
	const pCount = serverState.players.length;
	if (pCount <= 1) {
		container.innerHTML = '';
		return;
	}

	for (let i = 0; i < pCount; i++) {
		if (i === myIndex) continue;
		const p = serverState.players[i];
		const isTurn = serverState.activePlayerIndex === i;

		html += `
			<div class="opponent-hand ${isTurn ? 'active-turn' : ''}">
				<div class="opponent-header">
					<img class="player-avatar-small" src="${p.avatarUrl || DEFAULT_AVATAR}" alt="${escapeHtml(p.name)}" />
					<span class="opponent-name-text" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
					${isTurn ? '<span class="opponent-turn-badge">Turn</span>' : ''}
					<span class="opponent-card-count">${p.handCount}</span>
				</div>
				<div class="opponent-cards">
		`;
		for (let c = 0; c < p.handCount; c++) {
			html += createCardHTML(p.hand[c], false, true);
		}
		html += `
				</div>
			</div>
		`;
	}
	
	container.innerHTML = html;
}

function renderHand(hand: any[], isMyTurn: boolean) {
	const handArea = document.getElementById('hand-area');
	if (handArea) {
		handArea.innerHTML = '';
		hand.forEach((c, i) => {
			const isSelected = selectedCardIndices.includes(i);
			
			// Basic playable validation for UI
			let isPlayable = true;
			if (serverState.gamePhase === 'PLAY' && selectedCardIndices.length > 0) {
				if (isSelected) {
					isPlayable = true;
				} else {
					const currentlySelected = selectedCardIndices.map(idx => hand[idx]);
					const newSelection = [...currentlySelected, c];
					
					const sum = newSelection.reduce((acc: number, card: any) => acc + card.value, 0);
					if (newSelection.some(card => card.rank === 'Joker')) isPlayable = false;
					else if (newSelection.length === 2 && newSelection.some(card => card.value === 1)) isPlayable = true;
					else {
						const firstVal = newSelection[0].value;
						if (!newSelection.every(card => card.value === firstVal) || sum > 10) isPlayable = false;
					}
				}
			}

			const tempDiv = document.createElement('div');
			tempDiv.innerHTML = createCardHTML(c, false, false, '', isSelected, !isPlayable || !isMyTurn).trim();
			const cardEl = tempDiv.firstElementChild as HTMLElement;
			if (cardEl) {
				if (isPlayable && isMyTurn) {
					cardEl.addEventListener('click', () => toggleSelection(i));
				}
				handArea.appendChild(cardEl);
			}
		});
	}
}
