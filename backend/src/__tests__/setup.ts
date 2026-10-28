// Jest setup file
// Add any global test setup here

// Store original console methods
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

// Patterns for expected console output that should be silenced
const silencedLogPatterns = [
  /^\[Realtime\]/, // Realtime service logs
  /^\[Push\]/, // Push notification logs
  /^\[sendMessage[:\]]/, // Stage1 controller debug logs (with or without request ID)
  /^\[getConversationHistory[:\]]/, // Conversation history logs
  /^\[confirmFeelHeard\]/, // Feel-heard confirmation logs
  /^\[ConversationSummarizer\]/, // Summarizer logs
  /^\[Orchestrator\]/, // Orchestrator logs
  /^\[MemoryDetector\]/, // Memory detector logs
  /^\[RetrievalPlanner\]/, // Retrieval planner logs
  /^\[notifySessionMembers\]/, // Session notification logs
  /^\[Embedding\]/, // Embedding service logs
  /^\[TokenBudget\]/, // Token budget logs
  /^\[Reconciler[:\]]/, // Reconciler logs
  /^prisma:/, // Prisma debug/info logs
];

const silencedWarnPatterns = [
  /^\[Bedrock\] AWS credentials not configured/, // Expected when testing without AWS creds
  /^\[Push\]/, // Push service warnings
  /^No JSON found in invitation text/, // Expected when testing invitation parsing
  /^\[JSON Extractor\]/, // Expected when testing invitation response extraction
  /^\[sendMessage[:\]]/, // Stage1 controller warnings (with or without request ID)
  /^\[confirmFeelHeard\]/, // Feel-heard confirmation warnings
  /^\[ConversationSummarizer\]/, // Summarizer warnings
  /^\[Embedding\]/, // Embedding service warnings (expected with mocked DB)
  /^\[notifySessionMembers\]/, // Session notification warnings
  /^prisma:/, // Prisma warnings
];

const silencedErrorPatterns = [
  /^Error recording emotion:/, // Expected in error handling tests
  /^Error getting emotions:/, // Expected in error handling tests
  /^Error completing exercise:/, // Expected in error handling tests
  /^\[AI Service\]/, // Expected in AI service error handling tests
  /^\[ConversationSummarizer\]/, // Summarizer errors (expected with mocked DB)
  /^\[confirmFeelHeard\]/, // Feel-heard confirmation errors (expected with mocked DB)
  /^\[sendMessage[:\]]/, // Stage1 controller errors (with or without request ID)
  /^\[Embedding\]/, // Embedding service errors (expected with mocked DB)
  /^\[notifySessionMembers\]/, // Session notification errors (expected with mocked DB)
  /^prisma:/, // Prisma errors (expected with mocked/disconnected DB)
];

beforeAll(() => {
  // Override console.log to silence expected patterns
  console.log = (...args) => {
    const message = args[0]?.toString() || '';
    const shouldSilence = silencedLogPatterns.some(pattern => pattern.test(message));
    if (!shouldSilence) {
      originalConsoleLog.apply(console, args);
    }
  };

  // Override console.warn to silence expected patterns
  console.warn = (...args) => {
    const message = args[0]?.toString() || '';
    const shouldSilence = silencedWarnPatterns.some(pattern => pattern.test(message));
    if (!shouldSilence) {
      originalConsoleWarn.apply(console, args);
    }
  };

  // Override console.error to silence expected patterns
  console.error = (...args) => {
    const message = args[0]?.toString() || '';
    const shouldSilence = silencedErrorPatterns.some(pattern => pattern.test(message));
    if (!shouldSilence) {
      originalConsoleError.apply(console, args);
    }
  };
});

afterAll(() => {
  // Restore original console methods
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
});
