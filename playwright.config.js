import { defineConfig } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.env.TRUSS_E2E_PORT || 4799)
const dataDir = path.join(os.tmpdir(), `truss-e2e-${port}-${process.pid}`)

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.e2e.js',
  // Suites written against the previous UI (web/app.js, web/modules/*). The current UI lives in web/app
  // and is covered by tests/app; these stay on disk as a reference until that UI is removed.
  testIgnore: [
    'ui-shell/**',
    'database/**',
    'database-relations-io/**',
    'notebooks/**',
    'sheets/**',
    'scripts-ui/**',
  ],
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, screenshot: 'only-on-failure' },
  webServer: {
    command: 'node server/main.js',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    env: { PORT: String(port), TRUSS_DATA_DIR: dataDir },
  },
})
