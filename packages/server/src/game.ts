export type Suit = '♥' | '♦' | '♣' | '♠' | '★';
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'Joker';

export interface Card {
	rank: Rank;
	suit: Suit;
	value: number;
	id: string;
	isNew?: boolean;
}

export interface Enemy extends Card {
	maxHp: number;
	currentHp: number;
	attack: number;
	originalAttack: number;
}

export interface Player {
	id: string; // Socket ID
	userId?: string; // Persistent user ID
	name: string; // Discord username or fallback
	hand: Card[];
}

export interface GameState {
	roomId: string;
	status: 'LOBBY' | 'PLAYING' | 'GAME_OVER_WIN' | 'GAME_OVER_LOSS';
	players: Player[];
	activePlayerIndex: number;
	deck: Card[];
	discard: Card[];
	enemies: Enemy[];
	currentEnemy: Enemy | null;
	gamePhase: 'PLAY' | 'DISCARD';
	damageToTake: number;
	currentShield: number;
	immunityCanceled: boolean;
	maxHandSize: number;
	soloJestersRemaining: number;
}

export const rooms = new Map<string, GameState>();

const suits: Suit[] = ['♥', '♦', '♣', '♠'];
const ranks: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

export function createRoom(roomId: string): GameState {
	const state: GameState = {
		roomId,
		status: 'LOBBY',
		players: [],
		activePlayerIndex: 0,
		deck: [],
		discard: [],
		enemies: [],
		currentEnemy: null,
		gamePhase: 'PLAY',
		damageToTake: 0,
		currentShield: 0,
		immunityCanceled: false,
		maxHandSize: 8,
		soloJestersRemaining: 0,
	};
	rooms.set(roomId, state);
	return state;
}

function shuffle<T>(array: T[]): T[] {
	const newArr = [...array];
	for (let i = newArr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[newArr[i], newArr[j]] = [newArr[j], newArr[i]];
	}
	return newArr;
}

export function startGame(state: GameState) {
	if (state.players.length === 0 || state.players.length > 4) return;
	
	const count = state.players.length;
	if (count === 1) { state.maxHandSize = 8; state.soloJestersRemaining = 2; }
	if (count === 2) { state.maxHandSize = 7; state.soloJestersRemaining = 0; }
	if (count === 3) { state.maxHandSize = 6; state.soloJestersRemaining = 0; }
	if (count === 4) { state.maxHandSize = 5; state.soloJestersRemaining = 0; }

	state.deck = [];
	for (const suit of suits) {
		for (let i = 0; i < ranks.length; i++) {
			const suitName = suit === '♥' ? 'hearts' : suit === '♦' ? 'diamonds' : suit === '♣' ? 'clubs' : 'spades';
			state.deck.push({ rank: ranks[i], suit, value: i + 1, id: `card-${ranks[i]}-${suitName}` });
		}
	}
	
	if (count === 3) state.deck.push({ rank: 'Joker', suit: '★', value: 0, id: 'joker-1' });
	if (count === 4) {
		state.deck.push({ rank: 'Joker', suit: '★', value: 0, id: 'joker-1' });
		state.deck.push({ rank: 'Joker', suit: '★', value: 0, id: 'joker-2' });
	}

	state.deck = shuffle(state.deck);

	const buildEnemy = (rank: Rank, val: number, hp: number, atk: number) => 
		suits.map(suit => {
			const suitName = suit === '♥' ? 'hearts' : suit === '♦' ? 'diamonds' : suit === '♣' ? 'clubs' : 'spades';
			return { rank, suit, value: val, maxHp: hp, currentHp: hp, attack: atk, originalAttack: atk, id: `enemy-${rank}-${suitName}` };
		});

	const jacks = shuffle(buildEnemy('J', 10, 20, 10));
	const queens = shuffle(buildEnemy('Q', 15, 30, 15));
	const kings = shuffle(buildEnemy('K', 20, 40, 20));
	
	state.enemies = [...kings, ...queens, ...jacks];
	
	state.discard = [];
	state.activePlayerIndex = 0;
	state.gamePhase = 'PLAY';
	state.status = 'PLAYING';
	
	state.players.forEach(p => p.hand = []);
	
	spawnNextEnemy(state);
	dealCards(state);
}

function spawnNextEnemy(state: GameState) {
	state.currentEnemy = state.enemies.pop() || null;
	state.currentShield = 0;
	state.immunityCanceled = false;
	if (!state.currentEnemy) {
		state.status = 'GAME_OVER_WIN';
	}
}

function dealCards(state: GameState) {
	// Deals to everyone in clockwise order starting from active player
	// Simple implementation: just fill everyone up
	state.players.forEach(p => {
		while (p.hand.length < state.maxHandSize && state.deck.length > 0) {
			const card = state.deck.pop()!;
			card.isNew = true;
			p.hand.push(card);
		}
	});
}

function drawCardsForCurrent(state: GameState, amount: number) {
	// Draws cards one by one clockwise, actually Regicide says start with current player
	let drawn = 0;
	let currentIdx = state.activePlayerIndex;
	while (drawn < amount && state.deck.length > 0) {
		const p = state.players[currentIdx];
		if (p.hand.length < state.maxHandSize) {
			const card = state.deck.pop()!;
			card.isNew = true;
			p.hand.push(card);
			drawn++;
		}
		currentIdx = (currentIdx + 1) % state.players.length;
		// Break if everyone is full
		if (state.players.every(pl => pl.hand.length >= state.maxHandSize)) break;
	}
}

function isValidCombo(cards: Card[]): boolean {
	if (cards.length === 0) return false;
	if (cards.length === 1) return true;
	if (cards.some(c => c.rank === 'Joker')) return false;

	const sum = cards.reduce((acc, c) => acc + c.value, 0);
	if (cards.length === 2 && cards.some(c => c.value === 1)) return true;

	const firstValue = cards[0].value;
	const allSameValue = cards.every(c => c.value === firstValue);
	
	if (allSameValue && sum <= 10) return true;
	return false;
}

export function handleYield(state: GameState, playerId: string) {
	if (state.status !== 'PLAYING' || state.gamePhase !== 'PLAY') return;
	const pIdx = state.players.findIndex(p => p.id === playerId);
	if (pIdx !== state.activePlayerIndex) return;

	if (state.currentEnemy && state.currentEnemy.attack > 0) {
		state.damageToTake = state.currentEnemy.attack;
		state.gamePhase = 'DISCARD';
		
		const p = state.players[pIdx];
		const maxPossibleDiscard = p.hand.reduce((sum, c) => sum + c.value, 0);
		if (maxPossibleDiscard < state.damageToTake) {
			state.status = 'GAME_OVER_LOSS';
		}
	} else {
		nextPlayer(state);
	}
}

export function handleSoloJester(state: GameState, playerId: string) {
	if (state.status !== 'PLAYING' || state.players.length !== 1) return;
	const pIdx = state.players.findIndex(p => p.id === playerId);
	if (pIdx !== state.activePlayerIndex) return;

	if (state.soloJestersRemaining <= 0) return;
	state.soloJestersRemaining--;
	
	const p = state.players[pIdx];
	while(p.hand.length > 0) state.discard.push(p.hand.pop()!);
	dealCards(state);
}

function nextPlayer(state: GameState) {
	state.activePlayerIndex = (state.activePlayerIndex + 1) % state.players.length;
	state.gamePhase = 'PLAY';
}

export function handlePlayCards(state: GameState, playerId: string, cardIndices: number[]) {
	if (state.status !== 'PLAYING') return;
	const pIdx = state.players.findIndex(p => p.id === playerId);
	if (pIdx !== state.activePlayerIndex) return;
	
	const p = state.players[pIdx];
	if (cardIndices.length === 0 || !state.currentEnemy) return;

	cardIndices.sort((a, b) => b - a);
	const selectedCards = cardIndices.map(i => p.hand[i]);

	if (state.gamePhase === 'DISCARD') {
		const discardSum = selectedCards.reduce((acc, c) => acc + c.value, 0);
		if (discardSum < state.damageToTake) return;

		state.damageToTake = 0;
		cardIndices.forEach(index => {
			state.discard.push(p.hand[index]);
			p.hand.splice(index, 1);
		});
		
		nextPlayer(state);
		return;
	}

	// --- PLAY PHASE ---
	if (!isValidCombo(selectedCards)) return;

	cardIndices.forEach(index => {
		state.discard.push(p.hand[index]);
		p.hand.splice(index, 1);
	});

	if (selectedCards.length === 1 && selectedCards[0].rank === 'Joker') {
		state.immunityCanceled = true;
		return; 
	}

	let baseDamage = selectedCards.reduce((acc, c) => acc + c.value, 0);
	let finalDamage = baseDamage;
	
	const uniqueSuits = new Set(selectedCards.map(c => c.suit));

	if (uniqueSuits.has('♣') && (state.immunityCanceled || state.currentEnemy.suit !== '♣')) finalDamage = baseDamage * 2; 
	if (uniqueSuits.has('♥') && (state.immunityCanceled || state.currentEnemy.suit !== '♥')) {
		for(let i=0; i < baseDamage && state.discard.length > 0; i++) {
			state.deck.unshift(state.discard.shift()!);
		}
	}
	if (uniqueSuits.has('♦') && (state.immunityCanceled || state.currentEnemy.suit !== '♦')) {
		drawCardsForCurrent(state, baseDamage);
	}
	if (uniqueSuits.has('♠') && (state.immunityCanceled || state.currentEnemy.suit !== '♠')) {
		state.currentShield += baseDamage;
		state.currentEnemy.attack = Math.max(0, state.currentEnemy.originalAttack - state.currentShield);
	}
	
	const exactKill = state.currentEnemy.currentHp === finalDamage;
	state.currentEnemy.currentHp -= finalDamage;

	if (state.currentEnemy.currentHp <= 0) {
		const defeatedEnemyCard = { rank: state.currentEnemy.rank, suit: state.currentEnemy.suit, value: state.currentEnemy.value, id: state.currentEnemy.id };
		if (exactKill) {
			state.deck.push(defeatedEnemyCard);
		} else {
			state.discard.push(defeatedEnemyCard);
		}
		spawnNextEnemy(state);
		// Player who gets the kill takes another turn
	} else {
		if (state.currentEnemy.attack > 0) {
			state.damageToTake = state.currentEnemy.attack;
			state.gamePhase = 'DISCARD';
			
			const maxPossibleDiscard = p.hand.reduce((sum, c) => sum + c.value, 0);
			if (maxPossibleDiscard < state.damageToTake) {
				state.status = 'GAME_OVER_LOSS';
			}
		} else {
			nextPlayer(state);
		}
	}
}

// Generate a sanitized view for a specific player (hiding other hands)
export function getMaskedState(state: GameState, playerId: string) {
	return {
		...state,
		deckCount: state.deck.length, // Don't send whole deck
		deck: [], 
		players: state.players.map(p => {
			if (p.id === playerId) {
				return p; // My hand is visible
			}
			return {
				id: p.id,
				name: p.name,
				handCount: p.hand.length,
				hand: p.hand.map((_, i) => ({ id: `hidden-${p.id}-${i}` })) // Masked hand
			};
		})
	};
}

export function clearNewFlags(state: GameState) {
	state.players.forEach(p => p.hand.forEach(c => { c.isNew = false; }));
}
