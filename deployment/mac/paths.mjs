import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const deploymentHome = () => path.resolve(process.env.GOS_X_DAILY_HOME || path.join(os.homedir(), 'Documents', 'GosXDaily'));
