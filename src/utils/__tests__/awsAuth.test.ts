import { describe, expect, it } from 'vitest';
import { buildRoleSessionName } from '../awsAuth';

describe('the name an assumed role is given', () => {
  // The name is written into CloudTrail and into the cost report against every
  // call made with the role, so it is read by people accounting for spend long
  // after the call itself.
  it('reads as the date the role was assumed on', () => {
    expect(buildRoleSessionName(new Date('2026-07-10T12:00:00Z'))).toBe('20260710');
    expect(buildRoleSessionName(new Date('2027-01-02T12:00:00Z'))).toBe('20270102');
  });

  it('names November as November', () => {
    // Counting months from zero left this eight digits long and well formed,
    // and a month early: a name that merely looks right is worse than one that
    // obviously is not, because nobody questions the first.
    expect(buildRoleSessionName(new Date('2026-11-25T12:00:00Z'))).toBe('20261125');
    expect(buildRoleSessionName(new Date('2026-12-05T12:00:00Z'))).toBe('20261205');
  });

  it('pads a month and a day that are one digit', () => {
    // Unpadded, the parts ran together into a string that was not a date at all
    // and not even a fixed length.
    expect(buildRoleSessionName(new Date('2026-01-02T12:00:00Z'))).toBe('20260102');
    expect(buildRoleSessionName(new Date('2026-01-15T12:00:00Z'))).toBe('20260115');
  });

  it('is a name STS will take', () => {
    // `[\w+=,.@-]{2,64}`, or the request is refused before it is anything else.
    for (const date of ['2026-01-02', '2026-11-25', '2026-12-31']) {
      expect(buildRoleSessionName(new Date(`${date}T12:00:00Z`))).toMatch(/^[\w+=,.@-]{2,64}$/);
    }
  });
});
