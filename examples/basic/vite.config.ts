import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
import { foldkit } from '@foldkit/vite-plugin';
import foldkitRoutes from 'vite-plugin-foldkit-routes';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [foldkitRoutes(), foldkit({ devToolsMcpPort: false })],
  run: {
    tasks: {
      dev: {
        command: 'vp dev',
        dependsOn: [{ task: 'build', from: 'devDependencies' }],
        cache: false,
      },
      build: {
        command: 'vp build',
        dependsOn: [{ task: 'build', from: 'devDependencies' }],
        cache: false,
      },
    },
  },
});
