import { prisma } from '../../lib/prisma';
import { StateFactory, TargetStage } from '../state-factory';
import { isTargetShape } from '../golden/shape';

jest.mock('../../lib/prisma');

// The CURRENT-shape writer through a mocked Prisma. On the target shape the
// factory writes through pg (fixture-scenarios/target-shape.ts, tested in
// fixture-scenarios/__tests__/target-shape.test.ts), so this does not apply.
const describeCurrent = isTargetShape() ? describe.skip : describe;

describeCurrent('StateFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('attaches both users to fresh CREATED E2E sessions when userB is provided', async () => {
    (prisma.user.upsert as jest.Mock)
      .mockResolvedValueOnce({
        id: 'user-a',
        email: 'catherine@e2e.test',
        name: 'Catherine',
      })
      .mockResolvedValueOnce({
        id: 'user-b',
        email: 'james@e2e.test',
        name: 'James',
      });
    (prisma.relationship.create as jest.Mock).mockResolvedValue({
      id: 'relationship-1',
    });
    (prisma.session.create as jest.Mock).mockResolvedValue({
      id: 'session-1',
      status: 'CREATED',
      relationshipId: 'relationship-1',
    });
    (prisma.invitation.create as jest.Mock).mockResolvedValue({
      id: 'invitation-1',
      status: 'PENDING',
    });

    await new StateFactory('http://localhost:8082').createSessionAtStage({
      userA: { email: 'catherine@e2e.test', name: 'Catherine' },
      userB: { email: 'james@e2e.test', name: 'James' },
      targetStage: TargetStage.CREATED,
    });

    expect(prisma.relationship.create).toHaveBeenCalledWith({
      data: {
        members: {
          create: [
            { userId: 'user-a', nickname: 'James' },
            { userId: 'user-b', nickname: 'Catherine' },
          ],
        },
      },
    });
    expect(prisma.userVessel.create).toHaveBeenCalledWith({
      data: { sessionId: 'session-1', userId: 'user-a' },
    });
    expect(prisma.userVessel.create).toHaveBeenCalledWith({
      data: { sessionId: 'session-1', userId: 'user-b' },
    });
  });
});
