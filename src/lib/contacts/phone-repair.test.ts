import { describe, expect, it } from 'vitest';
import { findPhoneRepairs } from './phone-repair';

describe('findPhoneRepairs', () => {
  it('finds doubled country codes and flags collisions', () => {
    const result = findPhoneRepairs([
      { id: 'a', name: 'Ashutosh', phone: '+91919174824860' },
      { id: 'b', name: 'Gagan', phone: '+91917240882927' },
      { id: 'c', name: 'Gagan (correct)', phone: '+917240882927' },
      { id: 'd', name: 'Fine', phone: '+919876543210' },
      { id: 'e', name: null, phone: null },
    ]);
    expect(result).toEqual([
      {
        id: 'a',
        name: 'Ashutosh',
        phone: '+91919174824860',
        fixedPhone: '+919174824860',
        conflictWithId: null,
      },
      {
        id: 'b',
        name: 'Gagan',
        phone: '+91917240882927',
        fixedPhone: '+917240882927',
        conflictWithId: 'c',
      },
    ]);
  });
});
