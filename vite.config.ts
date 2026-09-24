import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Hot reload is opt-in for this app. The radio writes its own files while
      // it is running, and a browser reload mid-show drops the live stream.
      hmr: process.env.ENABLE_HMR === 'true',
      watch: {
        // The server writes into these folders while a show is on air: a WAV
        // per turn, the rendered ad breaks, the ad log, the phone book, and
        // finally the episode itself. None of it is source, but the watcher
        // does not know that - it sees a file it cannot map to a module and
        // tells the browser to full-reload.
        //
        // That reload throws away the running show's page AND kills the
        // browser's connection to /api/generate, which aborts the server's
        // own request to the model mid-sentence. The show dies and the screen
        // goes back to the start. Observed as:
        //   [vite] (client) page reload memory/ads.json
        //   TypeError: terminated ... other side closed (port 1234)
        ignored: [
          '**/output/**',
          '**/shows/**',
          '**/memory/**',
          '**/ads/**',
          '**/commercials/**',
          '**/music/**',
          '**/dist/**',
          '**/_original_backup/**',
          '**/config.json',
        ],
      },
    },
  };
});
