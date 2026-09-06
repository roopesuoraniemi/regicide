import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
	envDir: '../../',
	server: {
		port: 3000,
		allowedHosts: true,
		proxy: {
			'/api': {
				target: 'http://localhost:3001',
				changeOrigin: true,
				secure: false,
			},
			'/socket.io': {
				target: 'http://localhost:3001',
				ws: true,
			},
		},
		hmr: {
			clientPort: 443,
		},
	},
});
