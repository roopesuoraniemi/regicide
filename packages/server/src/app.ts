import path from 'node:path';
import dotenv from 'dotenv';
import express, {
	type Application,
	type Request,
	type Response,
} from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fetchAndRetry } from './utils';
import { rooms, createRoom, resetRoom, startGame, handlePlayCards, handleChooseNextPlayer, handleYield, handleSoloJester, getMaskedState, clearNewFlags } from './game';

dotenv.config({ path: '../../.env' });

const app: Application = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
	cors: { origin: '*' },
	path: '/socket.io/'
});

const port: number = Number(process.env.PORT) || 3001;

app.use(express.json());

// Fetch token from developer portal and return to the embedded app
app.post('/api/token', async (req: Request, res: Response) => {
	try {
		const response = await fetchAndRetry('https://discord.com/api/oauth2/token', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				client_id: String(process.env.VITE_CLIENT_ID),
				client_secret: String(process.env.CLIENT_SECRET),
				grant_type: 'authorization_code',
				code: String(req.body.code),
				redirect_uri: 'http://127.0.0.1',
			}),
		});

		const data = (await response.json()) as Record<string, any>;
		if (!response.ok || data.error) {
			console.error('Discord OAuth token exchange error:', data);
			return res.status(response.status || 400).json({
				error: data.error_description || data.error || 'Failed to exchange token with Discord',
			});
		}

		res.send({ access_token: data.access_token });
	} catch (err: any) {
		console.error('Error exchanging Discord token:', err);
		res.status(500).json({ error: err.message || 'Internal token exchange error' });
	}
});

if (process.env.NODE_ENV === 'production') {
	const clientBuildPath = path.join(__dirname, '../../client/dist');
	app.use(express.static(clientBuildPath));
	app.get('*', (req: Request, res: Response) => {
		res.sendFile(path.join(clientBuildPath, 'index.html'));
	});
}

const FIXED_LOBBIES = ['lobby-1', 'lobby-2', 'lobby-3'];
const LOBBY_NAMES: Record<string, string> = {
	'lobby-1': 'Lobby 1',
	'lobby-2': 'Lobby 2',
	'lobby-3': 'Lobby 3',
};

// Initialize fixed lobbies
FIXED_LOBBIES.forEach(id => {
	if (!rooms.has(id)) createRoom(id);
});

function getLobbiesSummary() {
	return FIXED_LOBBIES.map(id => {
		let state = rooms.get(id);
		if (!state) state = createRoom(id);
		const isPlaying = state.status === 'PLAYING';
		return {
			id,
			name: LOBBY_NAMES[id] || id,
			playerCount: state.players.length,
			maxPlayers: 4,
			status: state.status,
			isJoinable: !isPlaying && state.players.length < 4,
			players: state.players.map(p => p.name),
		};
	});
}

function broadcastLobbies() {
	io.emit('lobbiesList', getLobbiesSummary());
}

function broadcastState(roomId: string) {
	const state = rooms.get(roomId);
	if (!state) return;
	
	state.players.forEach(player => {
		io.to(player.id).emit('gameState', getMaskedState(state, player.id));
	});
	clearNewFlags(state);
	broadcastLobbies();
}

io.on('connection', (socket) => {
	// Send lobby list to newly connected clients
	socket.emit('lobbiesList', getLobbiesSummary());

	socket.on('getLobbies', () => {
		socket.emit('lobbiesList', getLobbiesSummary());
	});

	socket.on('joinRoom', (roomId, userName, userId) => {
		let state = rooms.get(roomId);
		if (!state) state = createRoom(roomId);
		
		// If the room was in game over state, reset it back to lobby
		if (state.status === 'GAME_OVER_WIN' || state.status === 'GAME_OVER_LOSS') {
			resetRoom(roomId, state.players.length > 0);
		}

		// Check for reconnection by persistent userId or socket.id
		const existingPlayer = state.players.find(p => (userId && p.userId === userId) || p.id === socket.id);

		if (existingPlayer) {
			existingPlayer.id = socket.id;
			if (userName) existingPlayer.name = userName;
		} else {
			// New player joining: enforce rules
			if (state.status === 'PLAYING') {
				socket.emit('joinError', 'This lobby is currently in an active game and cannot be joined.');
				return;
			}
			if (state.players.length >= 4) {
				socket.emit('joinError', 'This lobby is full (maximum 4 players).');
				return;
			}
			state.players.push({
				id: socket.id,
				userId: userId || socket.id,
				name: userName || 'Player',
				hand: []
			});
		}

		socket.join(roomId);
		
		// Send state to joining player
		socket.emit('gameState', getMaskedState(state, socket.id));
		// Broadcast updated state to players in this room and lobby list to everyone
		broadcastState(roomId);
	});

	socket.on('leaveRoom', (roomId) => {
		socket.leave(roomId);
		const state = rooms.get(roomId);
		if (state) {
			const index = state.players.findIndex(p => p.id === socket.id);
			if (index !== -1) {
				state.players.splice(index, 1);
			}
			if (state.players.length === 0) {
				resetRoom(roomId, false);
			} else if (state.status !== 'LOBBY') {
				// Game was disrupted by a player leaving; reset lobby to allow new connections
				resetRoom(roomId, true);
				broadcastState(roomId);
			} else {
				broadcastState(roomId);
			}
		}
		socket.emit('leftRoom');
		broadcastLobbies();
	});

	socket.on('resetLobby', (roomId) => {
		const state = rooms.get(roomId);
		if (state) {
			resetRoom(roomId, true);
			broadcastState(roomId);
		}
	});

	socket.on('disconnect', () => {
		for (const [roomId, state] of rooms.entries()) {
			const index = state.players.findIndex(p => p.id === socket.id);
			if (index !== -1) {
				if (state.status === 'LOBBY') {
					state.players.splice(index, 1);
					if (state.players.length === 0) {
						resetRoom(roomId, false);
					} else {
						broadcastState(roomId);
					}
				} else {
					// Game is active: check if any sockets remain connected in the room
					const roomSockets = io.sockets.adapter.rooms.get(roomId);
					if (!roomSockets || roomSockets.size === 0) {
						// All players left/disconnected - reset room so it can be used again
						console.log(`All players disconnected from ${roomId}. Resetting lobby.`);
						resetRoom(roomId, false);
					}
				}
			}
		}
		broadcastLobbies();
	});

	socket.on('startGame', (roomId) => {
		const state = rooms.get(roomId);
		if (state && state.status === 'LOBBY') {
			startGame(state);
			broadcastState(roomId);
		}
	});

	socket.on('playCards', (roomId, indices) => {
		const state = rooms.get(roomId);
		if (state) {
			handlePlayCards(state, socket.id, indices);
			broadcastState(roomId);
		}
	});

	socket.on('yieldTurn', (roomId) => {
		const state = rooms.get(roomId);
		if (state) {
			handleYield(state, socket.id);
			broadcastState(roomId);
		}
	});

	socket.on('chooseNextPlayer', (roomId, targetPlayerId) => {
		const state = rooms.get(roomId);
		if (state) {
			if (handleChooseNextPlayer(state, socket.id, targetPlayerId)) {
				broadcastState(roomId);
			}
		}
	});

	socket.on('useSoloJester', (roomId) => {
		const state = rooms.get(roomId);
		if (state) {
			handleSoloJester(state, socket.id);
			broadcastState(roomId);
		}
	});
});

httpServer.listen(port, () => {
	console.log(`App is listening on port ${port} !`);
});
