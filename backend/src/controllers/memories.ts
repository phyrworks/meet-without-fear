/**
 * Memories Controller (Things to Always Remember)
 *
 * Handles persistent memory operations:
 * - GET /memories - List all user memories grouped by global/session
 * - POST /memories - Create new memory with validation
 * - PUT /memories/:id - Update existing memory
 * - DELETE /memories/:id - Delete memory
 * - POST /memories/approve - Approve AI suggestion
 * - POST /memories/reject - Reject AI suggestion (for analytics)
 */

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { getUser } from '../middleware/auth';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errors';
import {
  ApiResponse,
  UserMemoryDTO,
  CreateMemoryRequest,
  UpdateMemoryRequest,
  ApproveMemoryRequest,
  RejectMemoryRequest,
  ListMemoriesResponse,
  MemoryCategory,
  MemorySource,
  FormatMemoryRequest,
  FormatMemoryResponse,
  UpdateMemoryAIResponse,
  ConfirmMemoryRequest,
  ConfirmMemoryUpdateRequest,
} from '@meet-without-fear/shared';
import { validateMemory } from '../services/memory-validator';
import { formatMemoryRequest, processMemoryUpdate } from '../services/memory-formatter';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map Prisma UserMemory to DTO
 */
function mapMemoryToDTO(memory: {
  id: string;
  content: string;
  category: string;
  status: string;
  source: string;
  suggestedText: string | null;
  createdAt: Date;
  updatedAt: Date;
}): UserMemoryDTO {
  return {
    id: memory.id,
    content: memory.content,
    category: memory.category as MemoryCategory,
    status: memory.status as 'ACTIVE' | 'REJECTED',
    source: memory.source as MemorySource,
    suggestedBy: memory.suggestedText || undefined,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

// ============================================================================
// GET /memories - List all user memories
// ============================================================================

export const listMemories = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Fetch all active memories for the user (only global memories)
  const memories = await prisma.userMemory.findMany({
    where: {
      userId: user.id,
      status: 'ACTIVE',
      sessionId: null, // Only return global memories
    },
    orderBy: { createdAt: 'desc' },
  });

  const memoryDTOs = memories.map(memory => mapMemoryToDTO(memory));

  const response: ApiResponse<ListMemoriesResponse> = {
    success: true,
    data: { memories: memoryDTOs },
  };

  res.json(response);
});

// ============================================================================
// POST /memories - Create new memory
// ============================================================================

export const createMemory = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const body = req.body as CreateMemoryRequest;

  // Validate request
  if (!body.content || typeof body.content !== 'string') {
    throw new ValidationError('Memory content is required');
  }
  if (!body.category) {
    throw new ValidationError('Memory category is required');
  }

  // Validate memory content
  const validationResult = await validateMemory(body.content, body.category);
  if (!validationResult.valid) {
    throw new ValidationError(validationResult.reason || 'Memory validation failed');
  }

  // Create the memory (always global)
  const memory = await prisma.userMemory.create({
    data: {
      userId: user.id,
      content: body.content.trim(),
      category: body.category,
      sessionId: null, // Memories are always global
      source: 'USER_CREATED',
      status: 'ACTIVE',
    },
  });

  const response: ApiResponse<{ memory: UserMemoryDTO }> = {
    success: true,
    data: { memory: mapMemoryToDTO(memory) },
  };

  res.status(201).json(response);
});

// ============================================================================
// PUT /memories/:id - Update memory
// ============================================================================

export const updateMemory = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const memoryId = req.params.id;
  const body = req.body as UpdateMemoryRequest;

  // Verify memory exists and belongs to user
  const existing = await prisma.userMemory.findFirst({
    where: {
      id: memoryId,
      userId: user.id,
    },
  });

  if (!existing) {
    throw new NotFoundError('Memory');
  }

  // Validate new content if provided
  if (body.content !== undefined) {
    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
      throw new ValidationError('Memory content cannot be empty');
    }

    const validationResult = await validateMemory(body.content, existing.category);
    if (!validationResult.valid) {
      throw new ValidationError(validationResult.reason || 'Memory validation failed');
    }
  }

  // Update the memory
  const memory = await prisma.userMemory.update({
    where: { id: memoryId },
    data: {
      content: body.content !== undefined ? body.content.trim() : undefined,
      status: body.status,
      updatedAt: new Date(),
    },
  });

  const response: ApiResponse<{ memory: UserMemoryDTO }> = {
    success: true,
    data: { memory: mapMemoryToDTO(memory) },
  };

  res.json(response);
});

// ============================================================================
// DELETE /memories/:id - Delete memory
// ============================================================================

export const deleteMemory = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const memoryId = req.params.id;

  // Verify memory exists and belongs to user
  const existing = await prisma.userMemory.findFirst({
    where: {
      id: memoryId,
      userId: user.id,
    },
  });

  if (!existing) {
    throw new NotFoundError('Memory');
  }

  // Delete the memory
  await prisma.userMemory.delete({
    where: { id: memoryId },
  });

  const response: ApiResponse<{ deleted: boolean }> = {
    success: true,
    data: { deleted: true },
  };

  res.json(response);
});

// ============================================================================
// POST /memories/approve - Approve AI suggestion
// ============================================================================

export const approveMemory = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const body = req.body as ApproveMemoryRequest;

  // Validate request
  if (!body.suggestedContent || typeof body.suggestedContent !== 'string') {
    throw new ValidationError('Suggested content is required');
  }
  if (!body.category) {
    throw new ValidationError('Category is required');
  }

  // Determine final content (user may have edited)
  const finalContent = body.editedContent?.trim() || body.suggestedContent.trim();
  const wasEdited = body.editedContent !== undefined && body.editedContent !== body.suggestedContent;

  // Validate the final content
  const validationResult = await validateMemory(finalContent, body.category);
  if (!validationResult.valid) {
    throw new ValidationError(validationResult.reason || 'Memory validation failed');
  }

  // Check for duplicate content (prevent approving same suggestion twice)
  const existingDuplicate = await prisma.userMemory.findFirst({
    where: {
      userId: user.id,
      content: finalContent,
      sessionId: null, // Only check global memories
      status: 'ACTIVE',
    },
  });

  if (existingDuplicate) {
    throw new ValidationError('A memory with this content already exists');
  }

  let memory;

  // If we have an ID, update the existing PENDING memory
  if (body.id) {
    // Verify the pending memory exists and belongs to the user
    const pendingMemory = await prisma.userMemory.findFirst({
      where: {
        id: body.id,
        userId: user.id,
        status: 'PENDING',
      },
    });

    if (!pendingMemory) {
      throw new NotFoundError('Pending memory not found');
    }

    // Update the pending memory to ACTIVE (always global)
    memory = await prisma.userMemory.update({
      where: { id: body.id },
      data: {
        content: finalContent,
        category: body.category,
        status: 'ACTIVE',
        source: wasEdited ? 'USER_EDITED' : 'USER_APPROVED',
        suggestedText: wasEdited ? body.suggestedContent : pendingMemory.suggestedText,
        sessionId: null, // Ensure it's global
        updatedAt: new Date(),
      },
    });
  } else {
    // No ID provided - create a new memory (backward compatibility)
    memory = await prisma.userMemory.create({
      data: {
        userId: user.id,
        content: finalContent,
        category: body.category,
        sessionId: null, // Memories are always global
        source: wasEdited ? 'USER_EDITED' : 'USER_APPROVED',
        suggestedText: wasEdited ? body.suggestedContent : null,
        status: 'ACTIVE',
      },
    });
  }

  const response: ApiResponse<{ memory: UserMemoryDTO }> = {
    success: true,
    data: { memory: mapMemoryToDTO(memory) },
  };

  res.status(201).json(response);
});

// ============================================================================
// POST /memories/reject - Reject AI suggestion (for analytics)
// ============================================================================

export const rejectMemory = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const body = req.body as RejectMemoryRequest;

  // Validate request
  if (!body.suggestedContent || typeof body.suggestedContent !== 'string') {
    throw new ValidationError('Suggested content is required');
  }
  if (!body.category) {
    throw new ValidationError('Category is required');
  }

  // If we have an ID, update the existing PENDING memory to REJECTED
  if (body.id) {
    // Verify the pending memory exists and belongs to the user
    const pendingMemory = await prisma.userMemory.findFirst({
      where: {
        id: body.id,
        userId: user.id,
        status: 'PENDING',
      },
    });

    if (pendingMemory) {
      // Update the pending memory to REJECTED
      await prisma.userMemory.update({
        where: { id: body.id },
        data: {
          status: 'REJECTED',
          updatedAt: new Date(),
        },
      });
    }
  } else {
    // No ID provided - create a rejected memory entry for analytics (backward compatibility)
    await prisma.userMemory.create({
      data: {
        userId: user.id,
        content: body.suggestedContent.trim(),
        category: body.category,
        source: 'USER_APPROVED',
        status: 'REJECTED',
      },
    });
  }

  const response: ApiResponse<{ rejected: boolean }> = {
    success: true,
    data: { rejected: true },
  };

  res.json(response);
});

// ============================================================================
// POST /memories/format - AI-assisted memory creation (preview)
// ============================================================================

export const formatMemory = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  getUser(req); // authenticated caller (throws otherwise)
  const body = req.body as FormatMemoryRequest;

  // Validate request
  if (!body.userInput || typeof body.userInput !== 'string') {
    throw new ValidationError('User input is required');
  }

  // Process through AI formatter (memories are always global)
  const result = await formatMemoryRequest(body.userInput);

  const response: ApiResponse<FormatMemoryResponse> = {
    success: true,
    data: result,
  };

  res.json(response);
});

// ============================================================================
// POST /memories/confirm - Save AI-formatted memory
// ============================================================================

export const confirmMemory = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const body = req.body as ConfirmMemoryRequest;

  // Validate request
  if (!body.content || typeof body.content !== 'string') {
    throw new ValidationError('Memory content is required');
  }
  if (!body.category) {
    throw new ValidationError('Category is required');
  }

  // Final validation (in case user manipulated the request)
  const validationResult = await validateMemory(body.content, body.category);
  if (!validationResult.valid) {
    throw new ValidationError(validationResult.reason || 'Memory validation failed');
  }

  // Check for duplicate (memories are always global)
  const existingDuplicate = await prisma.userMemory.findFirst({
    where: {
      userId: user.id,
      content: body.content.trim(),
      sessionId: null,
      status: 'ACTIVE',
    },
  });

  if (existingDuplicate) {
    throw new ValidationError('A memory with this content already exists');
  }

  // Create the memory (always global)
  const memory = await prisma.userMemory.create({
    data: {
      userId: user.id,
      content: body.content.trim(),
      category: body.category,
      sessionId: null,
      source: 'USER_CREATED',
      status: 'ACTIVE',
    },
  });

  const response: ApiResponse<{ memory: UserMemoryDTO }> = {
    success: true,
    data: { memory: mapMemoryToDTO(memory) },
  };

  res.status(201).json(response);
});

// ============================================================================
// POST /memories/:id/update - AI-assisted memory update (preview)
// ============================================================================

export const updateMemoryAI = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const memoryId = req.params.id;
  const body = req.body as { changeRequest: string };

  // Validate request
  if (!body.changeRequest || typeof body.changeRequest !== 'string') {
    throw new ValidationError('Change request is required');
  }

  // Verify memory exists and belongs to user
  const existing = await prisma.userMemory.findFirst({
    where: {
      id: memoryId,
      userId: user.id,
    },
  });

  if (!existing) {
    throw new NotFoundError('Memory');
  }

  // Process through AI formatter
  const result = await processMemoryUpdate(existing.content, existing.category as MemoryCategory, body.changeRequest);

  const response: ApiResponse<UpdateMemoryAIResponse> = {
    success: true,
    data: result,
  };

  res.json(response);
});

// ============================================================================
// POST /memories/:id/confirm-update - Save AI-updated memory
// ============================================================================

export const confirmMemoryUpdate = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const memoryId = req.params.id;
  const body = req.body as ConfirmMemoryUpdateRequest;

  // Validate request
  if (!body.content || typeof body.content !== 'string') {
    throw new ValidationError('Memory content is required');
  }
  if (!body.category) {
    throw new ValidationError('Category is required');
  }

  // Verify memory exists and belongs to user
  const existing = await prisma.userMemory.findFirst({
    where: {
      id: memoryId,
      userId: user.id,
    },
  });

  if (!existing) {
    throw new NotFoundError('Memory');
  }

  // Final validation
  const validationResult = await validateMemory(body.content, body.category);
  if (!validationResult.valid) {
    throw new ValidationError(validationResult.reason || 'Memory validation failed');
  }

  // Update the memory
  const memory = await prisma.userMemory.update({
    where: { id: memoryId },
    data: {
      content: body.content.trim(),
      category: body.category,
      source: 'USER_EDITED',
      suggestedText: existing.content, // Store original for reference
      updatedAt: new Date(),
    },
  });

  const response: ApiResponse<{ memory: UserMemoryDTO }> = {
    success: true,
    data: { memory: mapMemoryToDTO(memory) },
  };

  res.json(response);
});
