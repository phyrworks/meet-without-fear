import { prisma } from '../lib/prisma';
import { UserMemory, MemoryStatus, MemorySource, MemoryCategory } from '../generated/prisma/client';

export const memoryService = {
  /**
   * Create a pending memory suggestion
   */
  async createPendingMemory(params: {
    userId: string;
    sessionId?: string;
    content: string;
    category: MemoryCategory;
    suggestedText?: string; // AI confidence/logic summary
  }) {
    return prisma.userMemory.create({
      data: {
        userId: params.userId,
        sessionId: params.sessionId,
        content: params.content,
        category: params.category,
        status: MemoryStatus.PENDING,
        source: MemorySource.USER_APPROVED, // Techincally pending user approval
        suggestedText: params.suggestedText,
      },
    });
  },

  /**
   * Approve a pending memory (flip to ACTIVE)
   */
  async approveMemory(id: string) {
    return prisma.userMemory.update({
      where: { id },
      data: { status: MemoryStatus.ACTIVE },
    });
  },

  /**
   * Reject a pending memory (flip to REJECTED)
   */
  async rejectMemory(id: string) {
    return prisma.userMemory.update({
      where: { id },
      data: { status: MemoryStatus.REJECTED },
    });
  },

  /**
   * Get pending memories for a user
   */
  async getPendingMemories(userId: string) {
    return prisma.userMemory.findMany({
      where: {
        userId,
        status: MemoryStatus.PENDING,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
};
