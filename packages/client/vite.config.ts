import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
	envDir: '../../',
	server: {
		host: '0.0.0.0',
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
				changeOrigin: true,
			},
		},
		hmr: {
			clientPort: 443,
		},
	},
});
