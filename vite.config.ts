import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    ignorePatterns: ['dist/**'],
    options: { typeAware: true, typeCheck: true },
  },
  fmt: { ignorePatterns: ['dist/**'], singleQuote: true },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/setup.ts'],
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
});
