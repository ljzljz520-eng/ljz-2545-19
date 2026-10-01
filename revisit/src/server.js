import { createApp } from './app.js';
import { listen } from './http.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.REVISIT_DATA_DIR || join(__dirname, '..', 'data');
const port = Number(process.env.PORT || 3000);

const { handler } = createApp({ dataDir });
const server = await listen(handler, port);
console.log(`道路回访服务已启动: http://localhost:${server.address().port}  data=${dataDir}`);
