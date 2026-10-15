import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    ignorePatterns: ['**/dist/**', 'examples/*/src/**/*.gen.ts'],
    options: { typeAware: true, typeCheck: true },
  },
  fmt: { ignorePatterns: ['**/dist/**', 'examples/*/src/**/*.gen.ts'], singleQuote: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup.ts'],
  },
  pack: {
    entry: ['src/*.ts'],
    format: ['esm'],
    platform: 'node',
    root: 'src',
    outDir: 'dist',
    fixedExtension: false,
    tsconfig: 'tsconfig.build.json',
    dts: true,
    // Fingerprints read compiler/helper siblings relative to import.meta.url.
    // Preserve these modules instead of moving their code into shared chunks.
    unbundle: true,
  },
  run: {
    cache: false,
    tasks: {
      ci: {
        dependsOn: ['foldkit-routes-example#build'],
        command: ['vp check', 'vp run vite-plugin-foldkit-routes#test'],
        cache: false,
      },
    },
  },
});
