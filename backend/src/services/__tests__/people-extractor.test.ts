/**
 * People Extractor Service Tests
 *
 * Tests for AI-powered people extraction and tracking.
 */

import { Person } from '../../generated/prisma/client';
import { prisma } from '../../lib/prisma';
import { getHaikuJson } from '../../lib/bedrock';
import { extractAndTrackPeople, mergePeople } from '../people-extractor';

// Mock dependencies
jest.mock('../../lib/prisma');
jest.mock('../../lib/bedrock');
jest.mock('../../lib/request-context', () => ({
  getCurrentUserId: jest.fn().mockReturnValue('user-123'),
}));

describe('People Extractor Service', () => {
  const mockUserId = 'user-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('extractAndTrackPeople', () => {
    it('returns empty result for short content', async () => {
      const result = await extractAndTrackPeople({
        userId: mockUserId,
        content: 'short',
        sourceType: 'INNER_THOUGHTS',
        sourceId: 'session-123',
      });

      expect(result.people).toHaveLength(0);
      expect(result.newPeople).toHaveLength(0);
      expect(getHaikuJson).not.toHaveBeenCalled();
    });

    it('extracts and creates new person when no match exists', async () => {
      // Mock no existing people
      (prisma.person.findMany as jest.Mock).mockResolvedValue([]);

      // Mock AI extraction response
      (getHaikuJson as jest.Mock).mockResolvedValue({
        names: ['Sarah'],
        matchedToExisting: {},
        newPeople: ['Sarah'],
        relationships: { Sarah: 'friend' },
        sentiment: { Sarah: 0.7 },
      });

      // Mock person creation
      const mockPerson: Partial<Person> = {
        id: 'person-new',
        userId: mockUserId,
        name: 'Sarah',
        relationship: 'friend',
      };
      (prisma.person.create as jest.Mock).mockResolvedValue(mockPerson);
      (prisma.personMention.create as jest.Mock).mockResolvedValue({});
      (prisma.person.update as jest.Mock).mockResolvedValue({});

      const result = await extractAndTrackPeople({
        userId: mockUserId,
        content: 'I talked to Sarah today about my concerns.',
        sourceType: 'INNER_THOUGHTS',
        sourceId: 'session-123',
      });

      expect(result.people).toContain('Sarah');
      expect(result.newPeople).toContain('Sarah');
      expect(prisma.person.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Sarah',
            relationship: 'friend',
          }),
        })
      );
    });

    it('matches existing person by exact name', async () => {
      const existingPerson: Partial<Person> = {
        id: 'person-existing',
        userId: mockUserId,
        name: 'Sarah',
        aliases: [],
        relationship: 'friend',
      };

      (prisma.person.findMany as jest.Mock).mockResolvedValue([existingPerson]);

      // Mock AI extraction - matches to existing person
      (getHaikuJson as jest.Mock).mockResolvedValue({
        names: ['Sarah'],
        matchedToExisting: { Sarah: 'person-existing' },
        newPeople: [],
        relationships: {},
        sentiment: { Sarah: 0.5 },
      });

      (prisma.personMention.create as jest.Mock).mockResolvedValue({});
      (prisma.person.update as jest.Mock).mockResolvedValue({});

      const result = await extractAndTrackPeople({
        userId: mockUserId,
        content: 'Sarah and I went shopping today.',
        sourceType: 'GRATITUDE',
        sourceId: 'gratitude-456',
      });

      expect(result.people).toContain('Sarah');
      expect(result.newPeople).toHaveLength(0);
      expect(prisma.person.create).not.toHaveBeenCalled();
      expect(prisma.personMention.create).toHaveBeenCalled();
    });

    it('matches existing person by alias', async () => {
      const existingPerson: Partial<Person> = {
        id: 'person-123',
        userId: mockUserId,
        name: 'Sarah Johnson',
        aliases: ['Sarah', 'SJ'],
        relationship: 'friend',
      };

      (prisma.person.findMany as jest.Mock).mockResolvedValue([existingPerson]);

      // AI returns name that's in aliases
      (getHaikuJson as jest.Mock).mockResolvedValue({
        names: ['SJ'],
        matchedToExisting: {},
        newPeople: [],
        relationships: {},
        sentiment: { SJ: 0 },
      });

      (prisma.personMention.create as jest.Mock).mockResolvedValue({});
      (prisma.person.update as jest.Mock).mockResolvedValue({});

      const result = await extractAndTrackPeople({
        userId: mockUserId,
        content: 'SJ called me yesterday.',
        sourceType: 'INNER_THOUGHTS',
        sourceId: 'session-789',
      });

      expect(result.people).toContain('Sarah Johnson');
      expect(result.newPeople).toHaveLength(0);
    });

    it('handles multiple people in one message', async () => {
      const existingPerson: Partial<Person> = {
        id: 'person-mom',
        userId: mockUserId,
        name: 'Mom',
        aliases: ['my mom'],
        relationship: 'parent',
      };

      (prisma.person.findMany as jest.Mock).mockResolvedValue([existingPerson]);

      (getHaikuJson as jest.Mock).mockResolvedValue({
        names: ['Mom', 'Tom'],
        matchedToExisting: { Mom: 'person-mom' },
        newPeople: ['Tom'],
        relationships: { Tom: 'coworker' },
        sentiment: { Mom: 0.8, Tom: -0.2 },
      });

      const mockNewPerson: Partial<Person> = {
        id: 'person-tom',
        userId: mockUserId,
        name: 'Tom',
        relationship: 'coworker',
      };
      (prisma.person.create as jest.Mock).mockResolvedValue(mockNewPerson);
      (prisma.personMention.create as jest.Mock).mockResolvedValue({});
      (prisma.person.update as jest.Mock).mockResolvedValue({});

      const result = await extractAndTrackPeople({
        userId: mockUserId,
        content: 'Mom was happy when I told her. Tom at work was being difficult again.',
        sourceType: 'INNER_THOUGHTS',
        sourceId: 'session-123',
      });

      expect(result.people).toContain('Mom');
      expect(result.people).toContain('Tom');
      expect(result.newPeople).toContain('Tom');
      expect(result.newPeople).not.toContain('Mom');
    });

    it('handles AI extraction failure gracefully', async () => {
      (prisma.person.findMany as jest.Mock).mockResolvedValue([]);
      (getHaikuJson as jest.Mock).mockRejectedValue(new Error('AI unavailable'));

      const result = await extractAndTrackPeople({
        userId: mockUserId,
        content: 'I talked to Sarah about my concerns with the project.',
        sourceType: 'INNER_THOUGHTS',
        sourceId: 'session-123',
      });

      expect(result.people).toHaveLength(0);
      expect(result.newPeople).toHaveLength(0);
    });

    it('handles AI returning null', async () => {
      (prisma.person.findMany as jest.Mock).mockResolvedValue([]);
      (getHaikuJson as jest.Mock).mockResolvedValue(null);

      const result = await extractAndTrackPeople({
        userId: mockUserId,
        content: 'Today was a good day, nothing special happened.',
        sourceType: 'GRATITUDE',
        sourceId: 'gratitude-123',
      });

      expect(result.people).toHaveLength(0);
      expect(result.newPeople).toHaveLength(0);
    });

    it('updates mention counts correctly for different source types', async () => {
      (prisma.person.findMany as jest.Mock).mockResolvedValue([]);

      (getHaikuJson as jest.Mock).mockResolvedValue({
        names: ['Alex'],
        matchedToExisting: {},
        newPeople: ['Alex'],
        relationships: {},
        sentiment: { Alex: 0 },
      });

      const mockPerson: Partial<Person> = {
        id: 'person-alex',
        userId: mockUserId,
        name: 'Alex',
      };
      (prisma.person.create as jest.Mock).mockResolvedValue(mockPerson);
      (prisma.personMention.create as jest.Mock).mockResolvedValue({});
      (prisma.person.update as jest.Mock).mockResolvedValue({});

      await extractAndTrackPeople({
        userId: mockUserId,
        content: 'Alex helped me feel better today.',
        sourceType: 'GRATITUDE',
        sourceId: 'gratitude-123',
      });

      // Check that mention count was updated for gratitude
      expect(prisma.person.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'person-alex' },
          data: { mentionCountGratitude: { increment: 1 } },
        })
      );
    });
  });

  describe('mergePeople', () => {
    it('merges two people correctly', async () => {
      const sourcePerson: Partial<Person> = {
        id: 'person-source',
        userId: mockUserId,
        name: 'Sarah W',
        aliases: ['Sarah W.'],
        relationship: 'friend',
        mentionCountInnerThoughts: 2,
        mentionCountGratitude: 1,
        mentionCountNeeds: 0,
        mentionCountConflict: 1,
        firstMentioned: new Date('2024-01-01'),
        lastMentioned: new Date('2024-01-15'),
      };

      const targetPerson: Partial<Person> = {
        id: 'person-target',
        userId: mockUserId,
        name: 'Sarah',
        aliases: [],
        relationship: 'friend',
        mentionCountInnerThoughts: 5,
        mentionCountGratitude: 3,
        mentionCountNeeds: 1,
        mentionCountConflict: 0,
        firstMentioned: new Date('2023-12-01'),
        lastMentioned: new Date('2024-01-10'),
      };

      (prisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(sourcePerson)
        .mockResolvedValueOnce(targetPerson);

      (prisma.personMention.updateMany as jest.Mock).mockResolvedValue({ count: 4 });

      const mergedPerson = {
        ...targetPerson,
        aliases: ['Sarah W', 'Sarah W.'],
        mentionCountInnerThoughts: 7,
        mentionCountGratitude: 4,
        mentionCountNeeds: 1,
        mentionCountConflict: 1,
        firstMentioned: new Date('2023-12-01'),
        lastMentioned: new Date('2024-01-15'),
      };
      (prisma.person.update as jest.Mock).mockResolvedValue(mergedPerson);
      (prisma.person.delete as jest.Mock).mockResolvedValue({});

      const result = await mergePeople('person-source', 'person-target');

      expect(prisma.personMention.updateMany).toHaveBeenCalledWith({
        where: { personId: 'person-source' },
        data: { personId: 'person-target' },
      });

      expect(prisma.person.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'person-target' },
          data: expect.objectContaining({
            aliases: expect.arrayContaining(['Sarah W', 'Sarah W.']),
            mentionCountInnerThoughts: 7,
            mentionCountGratitude: 4,
          }),
        })
      );

      expect(prisma.person.delete).toHaveBeenCalledWith({
        where: { id: 'person-source' },
      });

      expect(result.aliases).toContain('Sarah W');
    });

    it('throws error when source person not found', async () => {
      (prisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'target', userId: mockUserId });

      await expect(mergePeople('nonexistent', 'target')).rejects.toThrow('Person not found');
    });

    it('throws error when target person not found', async () => {
      (prisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce({ id: 'source', userId: mockUserId })
        .mockResolvedValueOnce(null);

      await expect(mergePeople('source', 'nonexistent')).rejects.toThrow('Person not found');
    });

    it('throws error when merging people from different users', async () => {
      (prisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce({ id: 'source', userId: 'user-1' })
        .mockResolvedValueOnce({ id: 'target', userId: 'user-2' });

      await expect(mergePeople('source', 'target')).rejects.toThrow(
        'Cannot merge people from different users'
      );
    });
  });
});
