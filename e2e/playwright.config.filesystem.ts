import path from 'node:path';
import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

const servers = (Array.isArray(mockConfig.webServer) ? mockConfig.webServer : []).filter((server) =>
  server.command.endsWith('start-server.js'),
);
if (servers.length !== 1) throw new Error('Local files tests require E2E_REPLICAS=1.');
export default defineConfig({
  ...mockConfig,
  testDir: 'filesystem',
  outputDir: 'filesystem/.test-results',
  timeout: 120_000,
  retries: 0,
  reporter: 'line',
  webServer: servers.map((server) => ({
    ...server,
    env: {
      ...server.env,
      CONFIG_PATH: path.resolve(__dirname, 'filesystem/librechat.yaml'),
      ENDPOINTS: 'openAI,agents',
      OPENAI_MODELS: 'gpt-4o-mini',
      OPENAI_API_KEY: 'sk-e2e-local-files-placeholder',
      ASSISTANTS_API_KEY: '',
      E2E_USE_MEMORY_MONGO: 'true',
      LIBRECHAT_TEST_RUN_HOOK: path.resolve(__dirname, 'setup/local-files-model.cjs'),
    },
  })),
});
