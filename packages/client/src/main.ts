import { discordSdk } from './discordSdk';
import { io, Socket } from 'socket.io-client';
import './style.css';

let socket: Socket;
let roomId = 'local-dev-room';
let myPlayerId = '';
let serverState: any = null;
let selectedCardIndices: number[] = [];

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

// --- DISCORD SDK & SOCKET ---
setupDiscordSdk()
	.catch((error) => {
		console.error("SDK Error:", error);
		const app = document.querySelector<HTMLDivElement>('#app');
		if (app) app.innerHTML = `<h1 style="color:red;">Error: ${error.message}</h1>`;
	});

async function setupDiscordSdk() {
	let userName = 'Player';
	
	try {
		await discordSdk.ready();
		if (discordSdk.instanceId) roomId = discordSdk.instanceId;
		
		const { code } = await discordSdk.commands.authorize({
			client_id: import.meta.env.VITE_CLIENT_ID,
			response_type: 'code',
			state: '',
			prompt: 'none',
			scope: ['applications.commands', 'identify', 'guilds', 'rpc.voice.read'],
		});
		const response = await fetch('/api/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code }),
		});
		const { access_token } = await response.json();
		const auth = await discordSdk.commands.authenticate({ access_token });
		if (!auth) throw new Error('Authenticate failed');
		userName = auth.user.username;
	} catch (e) {
		console.log("Discord SDK failed (probably running outside Discord). Using fallback room.");
	}

	socket = io();
	
	socket.on('connect', () => {
		myPlayerId = socket.id || '';
		socket.emit('joinRoom', roomId, userName);
	});

	socket.on('gameState', (state) => {
		serverState = state;
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
	if (!btnContainer) return;

	const myIndex = serverState.players.findIndex((p: any) => p.id === myPlayerId);
	const myPlayer = serverState.players[myIndex];
	const isMyTurn = serverState.activePlayerIndex === myIndex;
	const hand = myPlayer ? myPlayer.hand : [];

	const selectedCards = selectedCardIndices.map(i => hand[i]);
	let buttonHtml = '';

	if (serverState.gamePhase === 'DISCARD') {
		const selectedSum = selectedCards.reduce((sum: number, c: any) => sum + c.value, 0);
		const disabled = (!isMyTurn || selectedSum < serverState.damageToTake) ? 'disabled' : '';
		const turnText = isMyTurn ? `Need ${serverState.damageToTake} value.` : `Waiting for ${serverState.players[serverState.activePlayerIndex].name} to discard...`;
		buttonHtml = `
			<div class="discard-prompt" style="bottom: 300px;">Enemy attacks! ${turnText}</div>
			${isMyTurn ? `<button class="action-btn" id="submit-btn" ${disabled}>Discard Selected (${selectedSum}/${serverState.damageToTake})</button>` : ''}
		`;
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

		const disabled = (!isMyTurn || !isValid) ? 'disabled' : '';
		const yieldBtn = isMyTurn ? `<button class="action-btn" id="yield-btn" style="left: calc(50% + 150px); background: #333; color: white;">Yield</button>` : '';
		const jesterBtn = (isMyTurn && serverState.soloJestersRemaining > 0) ? `<button class="action-btn" id="jester-btn" style="left: calc(50% - 180px); background: #f1c40f;">Solo Jester (${serverState.soloJestersRemaining})</button>` : '';

		const turnText = isMyTurn ? '' : `<div class="discard-prompt" style="bottom: 300px; background: #333;">Waiting for ${serverState.players[serverState.activePlayerIndex].name}'s turn...</div>`;

		buttonHtml = `
			${turnText}
			${isMyTurn ? `<button class="action-btn" id="submit-btn" ${disabled}>Play Selected</button>` : ''}
			${yieldBtn}
			${jesterBtn}
		`;
	}

	btnContainer.innerHTML = buttonHtml;

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
	const app = document.querySelector<HTMLDivElement>('#app');
	if (!app) return;

	if (serverState.status === 'LOBBY') {
		app.innerHTML = `
			<div class="menu-overlay">
				<div class="menu-content">
					<h1 style="color: var(--red-suit); font-size: 3rem; margin-bottom: 20px;">REGICIDE LOBBY</h1>
					<p style="margin-bottom: 30px;">${serverState.players.length} / 4 Players connected.</p>
					${serverState.players.map((p:any) => `<div>${p.name} ${p.id === myPlayerId ? '(You)' : ''}</div>`).join('')}
					<br/>
					<button id="btn-start">Start Game</button>
				</div>
			</div>
		`;
		
		const btnStart = document.getElementById('btn-start');
		if (btnStart) btnStart.addEventListener('click', () => socket.emit('startGame', roomId));
		return;
	}

	if (serverState.status === 'GAME_OVER_WIN') {
		app.innerHTML = `<h1 style="color: gold; text-align: center; margin-top: 20vh; font-size: 4rem;">VICTORY!</h1>`;
		return;
	}
	if (serverState.status === 'GAME_OVER_LOSS') {
		app.innerHTML = `<h1 style="color: red; text-align: center; margin-top: 20vh; font-size: 4rem;">DEFEAT!</h1>`;
		return;
	}

	let immunityTag = serverState.immunityCanceled ? '<div style="position: absolute; top: 10px; color: #f1c40f; font-weight: bold; font-size: 1.5rem;">Immunity Canceled!</div>' : '';

	app.innerHTML = `
		${immunityTag}
		<div id="button-container"></div>
		<div class="table-area" id="table-area"></div>
		<div id="opponent-hands"></div>
		<div class="hand-area" id="hand-area"></div>
	`;

	const myIndex = serverState.players.findIndex((p: any) => p.id === myPlayerId);
	const myPlayer = serverState.players[myIndex];
	const isMyTurn = serverState.activePlayerIndex === myIndex;
	const hand = myPlayer ? myPlayer.hand : [];

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
	
	let extraInfo = '';
	if (isEnemy) {
		const immunityInfo = serverState.immunityCanceled ? '' : `Immune to ${card.suit}`;
		extraInfo = `<div style="position: absolute; bottom: -50px; width: 100%; text-align: center; color: white; font-size: 1.1rem; font-weight:bold;">HP: ${card.currentHp}/${card.maxHp} <br/> ATK: ${card.attack} <br/> <span style="font-size:0.9rem; color:#888;">${immunityInfo}</span></div>`;
	}

	return `
		<div class="card ${colorClass} ${enemyClass} ${animClass} ${selectClass} ${disabledClass}" ${transitionStyle}>
			<div class="card-top"><span>${card.rank}</span><span>${card.suit}</span></div>
			<div class="card-center">${card.suit}</div>
			<div class="card-bottom"><span>${card.rank}</span><span>${card.suit}</span></div>
			${extraInfo}
		</div>
	`;
}

function renderTablePiles() {
	const tableArea = document.getElementById('table-area');
	if (!tableArea) return;

	const tavernHtml = `
		<div class="pile-container">
			<div class="pile-label">Tavern (${serverState.deckCount})</div>
			${serverState.deckCount > 0 ? createCardHTML(null, false, true, 'tavern-deck') : createCardHTML(null)}
		</div>
	`;

	const enemyHtml = serverState.currentEnemy ? `
		<div class="pile-container">
			<div class="pile-label">Enemy</div>
			${createCardHTML(serverState.currentEnemy, true, false)}
		</div>
	` : '';

	const topDiscard = serverState.discard.length > 0 ? serverState.discard[serverState.discard.length - 1] : null;
	const discardHtml = `
		<div class="pile-container">
			<div class="pile-label">Discard (${serverState.discard.length})</div>
			${topDiscard ? createCardHTML(topDiscard, false, false) : createCardHTML(null, false, false, 'discard-deck')}
		</div>
	`;

	tableArea.innerHTML = tavernHtml + enemyHtml + discardHtml;
}

function renderOpponentHands(myIndex: number) {
	const container = document.getElementById('opponent-hands');
	if (!container) return;
	
	let html = '';
	const pCount = serverState.players.length;
	if (pCount <= 1) return;

	for (let i = 0; i < pCount; i++) {
		if (i === myIndex) continue;
		
		const relative = (i - myIndex + pCount) % pCount;
		let posClass = '';
		
		if (pCount === 2) posClass = 'hand-top';
		else if (pCount === 3) {
			if (relative === 1) posClass = 'hand-left';
			if (relative === 2) posClass = 'hand-right';
		} else if (pCount === 4) {
			if (relative === 1) posClass = 'hand-left';
			if (relative === 2) posClass = 'hand-top';
			if (relative === 3) posClass = 'hand-right';
		}
		
		const p = serverState.players[i];
		html += `<div class="opponent-hand ${posClass}">`;
		html += `<div class="opponent-name">${p.name}</div>`;
		html += `<div class="opponent-cards">`;
		for(let c=0; c < p.handCount; c++) {
			html += createCardHTML(p.hand[c], false, true);
		}
		html += `</div></div>`;
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
