import createApp from '../index';
import { afterEach, describe, expect, it } from 'vitest';

const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      await app.close();
    }),
  );
});

describe('readiness checks', () => {
  it('returns 200 while the gateway is running', async () => {
    const app = createApp(undefined, {
      getStatus: () => 'running',
    });

    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/checks/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'running',
    });
  });

  it('returns 503 while the gateway is draining', async () => {
    const app = createApp(undefined, {
      getStatus: () => 'terminating',
    });

    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/checks/ready',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'terminating',
    });
  });
});
