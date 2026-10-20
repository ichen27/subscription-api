import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
test('pilot holds a job so a newer revision can cancel it', async () => {
  await setTimeout(180_000);
});
