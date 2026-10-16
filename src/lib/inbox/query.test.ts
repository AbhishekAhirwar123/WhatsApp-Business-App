import { describe, expect, it } from 'vitest';
import type { Conversation } from '@/types';
import {
  compactFilters,
  filtersToParams,
  formatCount,
  paramsToFilters,
  rowMatchesQueue,
  type InboxFilters,
} from './query';

describe('inbox filter URL state', () => {
  it('round-trips every filter through the URL', () => {
    const f: InboxFilters = {
      queue: 'awaiting',
      scope: 'mine',
      assignee: 'u-2',
      tag_ids: ['t1', 't2'],
      field_id: 'f1',
      field_value: 'Hot - 60 Days',
      date_from: '2026-10-01T00:00:00.000Z',
      date_to: '2026-10-12T00:00:00.000Z',
      search: 'garden',
    };
    const params = filtersToParams(f, { view: 'v1', sort: 'waiting_longest' });
    const back = paramsToFilters(new URLSearchParams(params.toString()));
    expect(back).toEqual({ filters: f, view: 'v1', sort: 'waiting_longest' });
  });

  it('keeps the default URL empty and ignores unknown queues', () => {
    expect(filtersToParams({ queue: 'open', scope: 'all' }).toString()).toBe('');
    expect(paramsToFilters(new URLSearchParams('q=bogus')).filters.queue).toBe('open');
  });
});

describe('compactFilters', () => {
  it('drops empty values and needs both field id and value', () => {
    expect(
      compactFilters({ queue: 'all', scope: 'all', tag_ids: [], search: '  ', field_id: 'f', field_value: '' }),
    ).toEqual({ queue: 'all', scope: 'all' });
    expect(compactFilters({ queue: 'all', scope: 'all', tag_ids: ['b', 'a'] }).tag_ids).toEqual(['a', 'b']);
  });
});

describe('rowMatchesQueue (realtime arrivals)', () => {
  const base = { id: 'c', user_id: 'u', contact_id: 'ct', status: 'open', unread_count: 0, created_at: '', updated_at: '' } as Conversation;
  it('mirrors the SQL queue semantics for row-local fields', () => {
    expect(rowMatchesQueue({ ...base, awaiting_reply_since: 'x' }, { queue: 'awaiting', scope: 'all' }, 'me')).toBe(true);
    expect(rowMatchesQueue({ ...base, status: 'closed', awaiting_reply_since: 'x' }, { queue: 'awaiting', scope: 'all' }, 'me')).toBe(false);
    expect(rowMatchesQueue({ ...base, assigned_agent_id: 'me' }, { queue: 'all', scope: 'mine' }, 'me')).toBe(true);
    expect(rowMatchesQueue(base, { queue: 'all', scope: 'mine' }, 'me')).toBe(false);
    expect(rowMatchesQueue({ ...base, my_unread_count: 2 }, { queue: 'unread', scope: 'all' }, 'me')).toBe(true);
  });
});

describe('formatCount', () => {
  it('abbreviates large counts like the reference', () => {
    expect(formatCount(1500)).toBe('1K+');
    expect(formatCount(42)).toBe('42');
    expect(formatCount(null)).toBe('…');
  });
});
