import test from 'node:test';
test('pilot proves failing tests reach GitHub', () => {
  throw new Error('Intentional CI pilot failure; removed after verification');
});
