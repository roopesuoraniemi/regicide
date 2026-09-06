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

if (process.env.NODE_ENV === 'production') {
	const clientBuildPath = path.join(__dirname, '../../client/dist');
	app.use(express.static(clientBuildPath));
}

// Fetch token from developer portal and return to the embedded app
app.post('/api/token', async (req: Request, res: Response) => {
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

	const { access_token } = (await response.json()) as {
		access_token: string;
	};

	res.send({ access_token });
});

function broadcastState(roomId: string) {
	const state = rooms.get(roomId);
	if (!state) return;
	
	state.players.forEach(player => {
		io.to(player.id).emit('gameState', getMaskedState(state, player.id));
	});
	clearNewFlags(state);
}

io.on('connection', (socket) => {
	socket.on('joinRoom', (roomId, userName) => {
		socket.join(roomId);
		let state = rooms.get(roomId);
		if (!state) state = createRoom(roomId);
		
		if (state.status === 'LOBBY' && !state.players.find(p => p.id === socket.id)) {
			// Limit to 4 players max
			if (state.players.length < 4) {
				state.players.push({ id: socket.id, name: userName || 'Player', hand: [] });
			}
		}
		
		broadcastState(roomId);
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
