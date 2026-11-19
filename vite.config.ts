import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createStandalonePreviewController } from './nepal/scripts/standalonePreview.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serveCaptureNpStandalonePlugin = (): Plugin => {
    const controller = createStandalonePreviewController(__dirname);
    return {
        name: 'serve-capture-np-standalone',
        configureServer(server) {
            server.middlewares.use(controller.middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(controller.middleware);
        },
    };
};

export default defineConfig({
    plugins: [serveCaptureNpStandalonePlugin(), react()],
    resolve: {
        alias: {
            'capture-nepal': path.resolve(__dirname, 'src/nepal'),
        },
    },
    define: {
        'process.env.DHIS2_CACHE_VERSION': JSON.stringify(process.env.DHIS2_CACHE_VERSION || '4'),
    },
    server: {
        host: '0.0.0.0',
        port: 3000,
        allowedHosts: true,
    },
    preview: {
        host: '0.0.0.0',
        port: 3000,
    },
});
