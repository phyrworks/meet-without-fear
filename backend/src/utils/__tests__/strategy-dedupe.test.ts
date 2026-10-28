import { filterNewStrategiesAgainstExisting, isSupersededStrategy } from '../strategy-dedupe';

describe('strategy dedupe', () => {
  it('marks shorter earlier proposal drafts as superseded by refined versions', () => {
    expect(
      isSupersededStrategy(
        'Monthly low-stakes exploration plan where we pick one new experience together',
        'Monthly low-stakes exploration plan where we pick one new experience together and Adam can say what feels exciting and what feels scary',
      ),
    ).toBe(true);
  });

  it('keeps distinct proposals while returning superseded ids for replacements', () => {
    const result = filterNewStrategiesAgainstExisting(
      [
        {
          id: 'old-monthly',
          description: 'Monthly low-stakes exploration plan where we pick one new experience together',
        },
        {
          id: 'old-pause',
          description: 'Use pause phrase when fear comes up during conversations about wanting or change',
        },
      ],
      [
        'Monthly low-stakes exploration plan where we pick one new experience together and Adam can say what feels exciting and what feels scary',
        'Check in after one month',
      ],
    );

    expect(result.supersededIds).toEqual(['old-monthly']);
    expect(result.newStrategies).toHaveLength(2);
  });

  it('drops exact duplicates', () => {
    const result = filterNewStrategiesAgainstExisting(
      [{ id: 'existing', description: 'Check in after one month' }],
      ['Check in after one month'],
    );

    expect(result.supersededIds).toEqual([]);
    expect(result.newStrategies).toEqual([]);
  });

  it('does not let a broader later draft replace a more specific existing strategy', () => {
    expect(
      isSupersededStrategy(
        'Sunday morning walk, 45 minutes, once a week for four weeks, no relationship agenda',
        'Sunday morning walk once a week',
      ),
    ).toBe(false);
  });
});
