import * as path from 'path';
import { runTests } from '@vscode/test-electron';

runTests({
  extensionDevelopmentPath: path.resolve(__dirname, '..'),
  extensionTestsPath: path.resolve(__dirname, 'e2e'),
  launchArgs: ['--disable-extensions'],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
