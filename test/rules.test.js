import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winChance, attackSucceeds } from '../shared/rules.js';

test('winChance = attacker / (attacker + defender) × 100', () => {
  assert.equal(winChance(2000, 10000), 16.67);
  assert.equal(winChance(15000, 10000), 60);
  assert.equal(winChance(10000, 10000), 50);
  assert.equal(winChance(5000, 10000), 33.33);
});

test('winChance has no 95% cap and a big advantage is never guaranteed', () => {
  assert.equal(winChance(20000, 10000), 66.67);
  assert.equal(winChance(60000, 1000), 98.36);
  assert.ok(winChance(1e9, 1) < 100);
  assert.equal(winChance(1, 10000), 0.01);
  assert.equal(winChance('abc', 100), 0);
});

test('attacker wins when roll <= chance, otherwise defender', () => {
  assert.equal(attackSucceeds(60, 60), true);
  assert.equal(attackSucceeds(60.01, 60), false);
  assert.equal(attackSucceeds(0.01, 16.67), true);
  assert.equal(attackSucceeds(100, 99.99), false);
});
