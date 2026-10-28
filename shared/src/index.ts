/**
 * Meet Without Fear Shared Types
 *
 * Single source of truth for all DTOs and enums used by both backend and mobile.
 */

// Enums (mirror Prisma enums for client use)
export * from './enums';

// API response wrappers
export * from './api';

// DTOs by domain
export * from './dto/session';
export * from './dto/session-state';
export * from './dto/stage';
export * from './dto/message';
export * from './dto/consent';
export * from './dto/needs';
export * from './dto/need-edits';
export * from './dto/strategy';
export * from './dto/auth';
export * from './dto/empathy';
export * from './dto/realtime';
export * from './dto/inner-work';
export * from './dto/distillation';
export * from './dto/reconciler';
export * from './dto/memory';
export * from './dto/needs-assessment';
export * from './dto/people-tracking';
export * from './dto/knowledge-base';
export * from './dto/gratitude';
export * from './dto/meditation';
export * from './dto/cross-feature';
export * from './dto/voice';
export * from './dto/version';
export * from './dto/feature-state';

// Reference data
export * from './constants/needs';

// Validation schemas
export * from './validation';

// API contracts
export * from './contracts';

// Utilities
export * from './utils/meditation';
