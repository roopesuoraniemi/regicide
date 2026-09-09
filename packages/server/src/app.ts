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
import { rooms, createRoom, startGame, handlePlayCards, handleYield, handleSoloJester, getMaskedState, clearNewFlags } from './game';

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

function broadcastState(roomId: string) {
	const state = rooms.get(roomId);
	if (!state) return;
	
	state.players.forEach(player => {
		io.to(player.id).emit('gameState', getMaskedState(state, player.id));
	});
	clearNewFlags(state);
}

io.on('connection', (socket) => {
	socket.on('joinRoom', (roomId, userName, userId) => {
		socket.join(roomId);
		let state = rooms.get(roomId);
		if (!state) state = createRoom(roomId);
		
		// Check for reconnection by persistent userId or socket.id
		const existingPlayer = state.players.find(p => (userId && p.userId === userId) || p.id === socket.id);
		if (existingPlayer) {
			existingPlayer.id = socket.id;
			if (userName) existingPlayer.name = userName;
		} else if (state.status === 'LOBBY' && state.players.length < 4) {
			state.players.push({
				id: socket.id,
				userId: userId || socket.id,
				name: userName || 'Player',
				hand: []
			});
		}
		
		// Always send current state directly to this socket so it never hangs
		socket.emit('gameState', getMaskedState(state, socket.id));
		// Broadcast updated state to all other players in the room
		broadcastState(roomId);
	});

	socket.on('disconnect', () => {
		for (const [roomId, state] of rooms.entries()) {
			if (state.status === 'LOBBY') {
				const index = state.players.findIndex(p => p.id === socket.id);
				if (index !== -1) {
					state.players.splice(index, 1);
					if (state.players.length === 0) {
						rooms.delete(roomId);
					} else {
						broadcastState(roomId);
					}
				}
			}
		}
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
