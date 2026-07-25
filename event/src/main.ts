import * as dotenv from 'dotenv';
dotenv.config();

import { setupFastify } from './server';

(async () => {
  const server = await setupFastify();
  try {
    await server.listen({ port: 8080, host: '0.0.0.0' });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
})();
