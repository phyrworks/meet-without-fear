import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Keyboard,
  Platform,
  ListRenderItem,
  ActivityIndicator,
  LayoutAnimation,
  NativeSyntheticEvent,
  NativeScrollEvent,
  LayoutChangeEvent,
  ViewToken,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageRole } from '@meet-without-fear/shared';
import { ChatBubble, ChatBubbleMessage } from './ChatBubble';
import { TypingIndicator } from './TypingIndicator';
import { ChatInput } from './ChatInput';
import { EmotionSlider } from './EmotionSlider';
import { ChatIndicator, ChatIndicatorType } from './ChatIndicator';
import { EmpathyValidationCard } from './EmpathyValidationCard';
import { assembleChatItems } from '../lib/chat/render/chatItems';
import {
  isCustomCard,
  isCustomEmptyState,
  isIndicator,
  isValidationCard,
} from '../lib/chat/render/types';
import type {
  ChatCustomCardItem,
  ChatIndicatorItem,
  ChatListItem,
  ChatMessage,
  ChatValidationCardItem,
} from '../lib/chat/render/types';
import { createStyles } from '../theme/styled';
import { designFonts, useAppAppearance } from '../theme';
import { useSpeech, useAutoSpeech } from '../hooks/useSpeech';
import { hasLinkedKeyboardController, KeyboardStickyComposer } from '../utils/keyboardController';
import {
  createLocalAnimationScope,
  getAnimationIdentity,
  getSeenAnimatedItemIds,
  isPreRegisteredAnimatedId,
} from '../lib/chat/render/animationIdentity';
import {
  isAtOrBeforeSeenBoundary as isAtOrBeforeSeenBoundaryPure,
  resolveAnimationLock,
  selectItemIdsToMarkSeen,
  selectNextAnimatableIdentity,
  shouldAnimateItem as shouldAnimateItemPure,
} from '../lib/chat/render/animationQueue';
import {
  deriveTypingIndicatorState,
  TYPING_INDICATOR_DELAY_MS,
} from '../lib/chat/render/typingIndicator';
import {
  createStickToBottomController,
  type StickToBottomController,
} from '../lib/chat/render/stickToBottom';

// ============================================================================
// Types
// ============================================================================
// Item shapes, type guards, and ordering live in ../lib/chat/render so they can
// be tested without React Native. They are re-exported here because this module
// is the public entry point every caller already imports from.

export { ChatIndicatorType } from './ChatIndicator';
export type {
  ChatCustomCardItem,
  ChatIndicatorItem,
  ChatListItem,
  ChatMessage,
  ChatValidationCardItem,
  CustomEmptyStateItem,
} from '../lib/chat/render/types';

const AUXILIARY_CONTROLS_LAYOUT_ANIMATION_MS = 110;

const auxiliaryControlsLayoutAnimation = {
  duration: AUXILIARY_CONTROLS_LAYOUT_ANIMATION_MS,
  create: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
  update: {
    type: LayoutAnimation.Types.easeInEaseOut,
  },
  delete: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
};

/** Emotion slider shown above the composer. Omit the whole object to hide it. */
export interface ChatEmotionSliderProps {
  value?: number;
  onChange: (value: number) => void;
  onHighEmotion?: (value: number) => void;
  compact?: boolean;
}

/** Older-history paging. Omit to disable paging entirely. */
export interface ChatPaginationProps {
  onLoadMore: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
}

/** Where the reader had got to, used to decide what counts as history. */
export interface ChatReadBoundaryProps {
  /** ID of the last chat item the user has seen - used to show "New messages" separator */
  lastSeenChatItemId?: string | null;
  /** Server-backed timestamp from before this screen marked the session viewed. */
  lastViewedAt?: string | null;
}

/** Inline empathy-validation cards and their two explicit responses. */
export interface ChatValidationProps {
  /** Validation cards to render inline (e.g., partner's empathy attempt for validation) */
  cards?: ChatValidationCardItem[];
  /** Callback when user taps "Yes, mostly" on a validation card */
  onValidateAccurate?: () => void;
  /** Callback when user taps "Not quite yet" on a validation card */
  onValidateNotQuite?: () => void;
}

/** Caller-supplied render slots around the transcript and composer. */
export interface ChatSlotProps {
  /** Render guided action content after the input so chat remains attached to the transcript. */
  aboveInput?: () => React.ReactNode;
  /** Render content below the input area (e.g., persistent review affordances) */
  belowInput?: () => React.ReactNode;
  /** Render content above the emotion slider / input area (e.g., inline cards) */
  belowChat?: () => React.ReactNode;
  /** Render extra content below a message bubble (e.g., draft cards in refinement chat) */
  messageExtra?: (message: ChatMessage) => React.ReactNode;
}

/** Composer affordances that are not about sending the message itself. */
export interface ChatComposerProps {
  /** Optional voice press handler -- passed through to ChatInput; renders mic button when provided */
  onVoicePress?: () => void;
  /** Content of a failed message to restore to the input field */
  failedMessage?: string | null;
  /** Pre-fill the input with provided text and focus it. */
  prefillText?: string | null;
  /** Callback invoked once a prefill has been applied. */
  onPrefillConsumed?: () => void;
}

interface ChatInterfaceProps {
  /** Session ID - used for persistent animation state tracking across remounts */
  sessionId?: string;
  messages: ChatMessage[];
  indicators?: ChatIndicatorItem[];
  onSendMessage: (content: string) => void;
  /**
   * Legacy loading prop - controls typing indicator AND disables input.
   * 
   * For Cache-First Architecture, prefer using the derived "waiting for AI" state:
   * - The typing indicator is shown when the last message is from USER (derived from messages)
   * - This prop can still be used for non-message loading states (e.g., fetching initial message)
   * 
   * @deprecated Prefer letting the component derive typing indicator from last message role
   */
  isLoading?: boolean;
  /**
   * Whether the input should be disabled (e.g., during API call).
   * This is separate from isLoading to allow showing typing indicator
   * while input is still enabled.
   */
  isInputDisabled?: boolean;
  disabled?: boolean;
  /** Hide the input area entirely (e.g., when waiting for partner) */
  hideInput?: boolean;
  emptyStateTitle?: string;
  emptyStateMessage?: string;
  /** Render card-shaped content in the chronological chat stream */
  customCards?: ChatCustomCardItem[];
  /** Callback when the latest AI message's typewriter animation completes */
  onTypewriterComplete?: () => void;
  /** Callback to report if typewriter is currently animating */
  onTypewriterStateChange?: (isAnimating: boolean) => void;
  /** Called once the first transcript layout pass has completed. */
  onInitialRenderReady?: () => void;
  /** Custom element to render when there are no messages (e.g., onboarding compact) */
  customEmptyState?: React.ReactNode;
  /** Skip marking initial messages as history - animate them instead (e.g., after compact signing + mood check) */
  skipInitialHistory?: boolean;
  /** Partner's name for personalized messages */
  partnerName?: string;
  /** Callback when "Context shared" indicator is tapped - navigates to Sharing Status
   * @param timestamp - The timestamp of the shared context (for scrolling to it)
   */
  onContextSharedPress?: (
    timestamp?: string,
    isFromMe?: boolean,
    indicatorType?: ChatIndicatorType,
  ) => void;
  /**
   * Called with every currently viewable list item (at least half on screen
   * for VIEWABILITY_MIN_MS) whenever viewability changes. The session screen
   * uses it to mark received shared frames as seen (work-2doq;
   * lib/chat/sharedFrameViews.ts de-duplicates).
   */
  onItemsViewed?: (items: ChatListItem[]) => void;
  emotionSlider?: ChatEmotionSliderProps;
  pagination?: ChatPaginationProps;
  readBoundary?: ChatReadBoundaryProps;
  validation?: ChatValidationProps;
  slots?: ChatSlotProps;
  composer?: ChatComposerProps;
}

// ============================================================================
// Component
// ============================================================================

const DEFAULT_EMPTY_TITLE = 'Start the Conversation';
const DEFAULT_EMPTY_MESSAGE =
  "Share what's on your mind. I'm here to listen and help you work through it.";

/** An item counts as viewed once at least half of it has been on screen this long. */
const VIEWABILITY_MIN_MS = 300;
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 50, minimumViewTime: VIEWABILITY_MIN_MS };

export function ChatInterface({
  sessionId,
  messages,
  indicators = [],
  onSendMessage,
  isLoading = false,
  isInputDisabled,
  disabled = false,
  hideInput = false,
  emptyStateTitle = DEFAULT_EMPTY_TITLE,
  emptyStateMessage = DEFAULT_EMPTY_MESSAGE,
  customCards,
  onTypewriterComplete,
  onTypewriterStateChange,
  onInitialRenderReady,
  customEmptyState,
  skipInitialHistory = false,
  partnerName,
  onContextSharedPress,
  onItemsViewed,
  emotionSlider,
  pagination,
  readBoundary,
  validation,
  slots,
  composer,
}: ChatInterfaceProps) {
  // Grouped props are unpacked here so the rest of the component — and every
  // hook dependency list — still reads individual values with their original
  // defaults. Passing a group is what enables the feature; the defaults inside
  // it match what the flat props used to default to.
  const { onLoadMore, hasMore = false, isLoadingMore = false } = pagination ?? {};
  const { lastSeenChatItemId, lastViewedAt } = readBoundary ?? {};
  const {
    cards: validationCards,
    onValidateAccurate,
    onValidateNotQuite,
  } = validation ?? {};
  const {
    aboveInput: renderAboveInput,
    belowInput: renderBelowInput,
    belowChat: renderBelowChat,
    messageExtra: renderMessageExtra,
  } = slots ?? {};
  const { onVoicePress, failedMessage, prefillText, onPrefillConsumed } = composer ?? {};
  const styles = useStyles();
  const safeAreaInsets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList<ChatListItem>>(null);
  const flatListContainerRef = useRef<View>(null);
  const composerContainerRef = useRef<View>(null);
  const stickToBottomRef = useRef<StickToBottomController | null>(null);
  if (stickToBottomRef.current === null) {
    stickToBottomRef.current = createStickToBottomController();
  }
  const stickToBottom = stickToBottomRef.current;
  const hasReportedInitialRenderReadyRef = useRef(false);
  const scrollRetryTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scrollRetryAnimationFrameRef = useRef<number | null>(null);
  const localAnimationScopeRef = useRef<string | null>(null);
  if (localAnimationScopeRef.current === null) {
    localAnimationScopeRef.current = createLocalAnimationScope();
  }
  const animationScope = sessionId || localAnimationScopeRef.current;
  const animationScopeRef = useRef(animationScope);
  const seenAnimatedItemIdsRef = useRef(getSeenAnimatedItemIds(animationScope));
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const [messageListBottomInset, setMessageListBottomInset] = useState(0);
  const [keyboardLift, setKeyboardLift] = useState(0);
  const [auxiliaryControlsVisible, setAuxiliaryControlsVisible] = useState(true);

  if (animationScopeRef.current !== animationScope) {
    animationScopeRef.current = animationScope;
    seenAnimatedItemIdsRef.current = getSeenAnimatedItemIds(animationScope);
  }

  const reportInitialRenderReady = useCallback(() => {
    if (hasReportedInitialRenderReadyRef.current) return;
    if (stickToBottom.getMetrics().layoutHeight <= 0) return;

    hasReportedInitialRenderReadyRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        onInitialRenderReady?.();
      });
    });
  }, [onInitialRenderReady, stickToBottom]);

  const scrollToBottom = useCallback((animated: boolean) => {
    scrollRetryTimeoutsRef.current.forEach(clearTimeout);
    scrollRetryTimeoutsRef.current = [];
    if (scrollRetryAnimationFrameRef.current !== null) {
      cancelAnimationFrame(scrollRetryAnimationFrameRef.current);
    }

    const run = () => {
      const target = stickToBottom.resolveScrollTarget();

      if (target.kind === 'offset') {
        flatListRef.current?.scrollToOffset({ offset: target.offset, animated });
        if (!animated) {
          stickToBottom.markInitialBottomScrollComplete();
          reportInitialRenderReady();
        }
        return;
      }

      flatListRef.current?.scrollToEnd({ animated });
    };

    scrollRetryAnimationFrameRef.current = requestAnimationFrame(run);
    scrollRetryTimeoutsRef.current = [
      setTimeout(run, 40),
      setTimeout(run, 120),
      setTimeout(run, 260),
      setTimeout(run, 500),
      setTimeout(run, 800),
    ];
  }, [reportInitialRenderReady, stickToBottom]);

  /** Follow the transcript only if the reader has not scrolled away from it. */
  const scrollToBottomIfAnchored = useCallback((animated: boolean) => {
    if (!stickToBottom.isAnchored()) return;
    stickToBottom.anchor();
    scrollToBottom(animated);
  }, [scrollToBottom, stickToBottom]);

  useEffect(() => {
    stickToBottom.resetForSession();
    hasReportedInitialRenderReadyRef.current = false;
  }, [sessionId, stickToBottom]);

  useEffect(() => {
    return () => {
      scrollRetryTimeoutsRef.current.forEach(clearTimeout);
      if (scrollRetryAnimationFrameRef.current !== null) {
        cancelAnimationFrame(scrollRetryAnimationFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const shownEvent = 'keyboardDidShow';
    const hiddenEvent = 'keyboardDidHide';

    const updateKeyboardLift = (event: { endCoordinates?: { height?: number } }) => {
      const nextLift = Math.max(
        0,
        Math.ceil((event.endCoordinates?.height ?? 0) - safeAreaInsets.bottom)
      );
      setKeyboardLift(nextLift);
    };

    const showSub = Keyboard.addListener(showEvent, (event) => {
      LayoutAnimation.configureNext(auxiliaryControlsLayoutAnimation);
      setAuxiliaryControlsVisible(true);
      setIsKeyboardVisible(true);
      updateKeyboardLift(event);
      // Unlike the other follow sites this one does not assert the anchor: the
      // keyboard opening should not re-attach a reader who had scrolled away.
      if (stickToBottom.isAnchored()) {
        scrollToBottom(false);
      }
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setMessageListBottomInset(0);
      setIsKeyboardVisible(false);
      setKeyboardLift(0);
    });
    const shownSub = Keyboard.addListener(shownEvent, updateKeyboardLift);
    const hiddenSub = Keyboard.addListener(hiddenEvent, () => {
      LayoutAnimation.configureNext(auxiliaryControlsLayoutAnimation);
      setAuxiliaryControlsVisible(true);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
      shownSub.remove();
      hiddenSub.remove();
    };
  }, [safeAreaInsets.bottom, scrollToBottom, stickToBottom]);

  // ---------------------------------------------------------------------------
  // Cache-First Architecture: Derive "waiting for AI" from last message role
  // ---------------------------------------------------------------------------
  // The indicator is never a flag the sender sets — it is read back out of the
  // transcript, so it survives remounts, refetches, and partner updates.
  // See lib/chat/render/typingIndicator.ts for the rules.
  const { showTypingIndicator, shouldDelay: shouldDelayTypingIndicator } = useMemo(
    () => deriveTypingIndicatorState(messages, { isLoading }),
    [messages, isLoading],
  );
  const [showDelayedTypingIndicator, setShowDelayedTypingIndicator] = useState(false);

  useEffect(() => {
    if (!showTypingIndicator) {
      setShowDelayedTypingIndicator(false);
      return;
    }

    if (!shouldDelayTypingIndicator) {
      setShowDelayedTypingIndicator(true);
      return;
    }

    const timeoutId = setTimeout(() => {
      setShowDelayedTypingIndicator(true);
    }, TYPING_INDICATOR_DELAY_MS);

    return () => clearTimeout(timeoutId);
  }, [showTypingIndicator, shouldDelayTypingIndicator]);

  useEffect(() => {
    if (showDelayedTypingIndicator) {
      scrollToBottomIfAnchored(false);
    }
  }, [showDelayedTypingIndicator, scrollToBottomIfAnchored]);

  // Track the ID of the chat item currently being animated.
  const [animatingItemId, setAnimatingItemId] = useState<string | null>(null);

  // Speech functionality
  const { isSpeaking, currentId, toggle: toggleSpeech } = useSpeech();
  const { isAutoSpeechEnabled } = useAutoSpeech();
  // Track messages that have already been auto-spoken (to avoid re-speaking)
  const spokenMessageIdsRef = useRef<Set<string>>(new Set());

  // Track items that have completed animation during this mount.
  const animatedItemIdsRef = useRef<Set<string>>(new Set());

  const markItemAnimationSeen = useCallback((itemId: string) => {
    const animationIdentity = getAnimationIdentity(itemId);
    animatedItemIdsRef.current.add(itemId);
    animatedItemIdsRef.current.add(animationIdentity);
    seenAnimatedItemIdsRef.current.add(itemId);
    seenAnimatedItemIdsRef.current.add(animationIdentity);
  }, []);

  // `lastSeenChatItemId`/`lastViewedAt` do not affect assembly, but they stay in
  // the dependency list so the read-boundary changes still yield a fresh list
  // reference for the downstream scroll and animation effects.
  const listItems = useMemo((): ChatListItem[] => assembleChatItems({
    messages,
    indicators,
    validationCards,
    customCards,
    hasCustomEmptyState: Boolean(customEmptyState),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [messages, indicators, validationCards, customCards, customEmptyState, lastSeenChatItemId, lastViewedAt]);

  useEffect(() => {
    // Skip scroll-to-bottom logic entirely while loading/restoring history
    if (stickToBottom.isLoadingHistory()) {
      return;
    }

    const newestItem = listItems[listItems.length - 1];
    if (!newestItem) return;

    const currentTimestamp = 'timestamp' in newestItem && newestItem.timestamp
      ? new Date(newestItem.timestamp).getTime()
      : 0;

    // A newer newest-item means a genuinely new turn arrived, which does follow
    // to the bottom. Streaming text into an existing turn leaves the newest
    // timestamp alone, so it never moves a reader who scrolled away.
    switch (stickToBottom.observeNewestItemTimestamp(currentTimestamp)) {
      case 'initial-jump':
        stickToBottom.anchor();
        scrollToBottom(false);
        break;
      case 'follow-new-item':
        stickToBottom.anchor();
        scrollToBottom(true);
        break;
      case 'none':
        break;
    }
  }, [listItems, scrollToBottom, stickToBottom]);

  // Snapshot boundary: captures all message IDs present on first meaningful render.
  // Messages in the snapshot render instantly. Messages not in the snapshot may animate.
  const mountSnapshotIdsRef = useRef<Set<string>>(new Set());
  const isInitialLoadRef = useRef(true);

  // Track previous value of customEmptyState to detect compact signing
  const prevCustomEmptyStateRef = useRef(customEmptyState);

  // Capture mount snapshot: all messages present on first meaningful render
  // Skip if skipInitialHistory is true AND there's only one message
  // (e.g., after compact signing + mood check with just the first AI message)
  if (isInitialLoadRef.current && messages.length > 0) {
    const shouldSkip = skipInitialHistory && messages.length === 1;
    if (!shouldSkip) {
      listItems.forEach((item) => {
        mountSnapshotIdsRef.current.add(item.id);
        seenAnimatedItemIdsRef.current.add(item.id);
      });
    }
    isInitialLoadRef.current = false;
  }

  // Add pagination messages to snapshot (they're history, not new)
  if (stickToBottom.isLoadingHistory() && messages.length > 0) {
    messages.forEach((m) => {
      mountSnapshotIdsRef.current.add(m.id);
      seenAnimatedItemIdsRef.current.add(m.id);
    });
  }

  // Detect when custom empty state is removed (e.g., compact was signed)
  useEffect(() => {
    if (prevCustomEmptyStateRef.current !== undefined && customEmptyState === undefined) {
      isInitialLoadRef.current = false;
    }
    prevCustomEmptyStateRef.current = customEmptyState;
  }, [customEmptyState]);

  const lastViewedAtTime = useMemo(() => {
    if (!lastViewedAt) return null;
    const time = new Date(lastViewedAt).getTime();
    return Number.isFinite(time) ? time : null;
  }, [lastViewedAt]);

  const lastSeenItemIndex = useMemo(() => {
    if (!lastSeenChatItemId) return -1;
    return listItems.findIndex((item) => item.id === lastSeenChatItemId);
  }, [listItems, lastSeenChatItemId]);

  const isAtOrBeforeSeenBoundary = useCallback((item: ChatListItem, index: number) => (
    isAtOrBeforeSeenBoundaryPure(item, index, { lastSeenItemIndex, lastViewedAtTime })
  ), [lastSeenItemIndex, lastViewedAtTime]);

  const shouldAnimateItem = useCallback((item: ChatListItem, index: number) => (
    shouldAnimateItemPure(item, index, {
      items: listItems,
      animatedItemIds: animatedItemIdsRef.current,
      seenAnimatedItemIds: seenAnimatedItemIdsRef.current,
      mountSnapshotIds: mountSnapshotIdsRef.current,
      lastSeenItemIndex,
      lastViewedAtTime,
      getAnimationIdentity,
      isPreRegisteredAnimatedId,
    })
  ), [lastSeenItemIndex, lastViewedAtTime, listItems]);

  // Auto-speech: speak new AI messages when enabled
  useEffect(() => {
    if (!isAutoSpeechEnabled || messages.length === 0) return;

    // Find the newest AI message that is truly NEW (not in mount snapshot)
    const newAIMessage = messages.find((m) => {
      if (m.role === MessageRole.USER) return false;
      if (m.id.startsWith('optimistic-')) return false;
      if (spokenMessageIdsRef.current.has(m.id)) return false;
      const itemIndex = listItems.findIndex((item) => item.id === m.id);
      if (itemIndex >= 0 && !shouldAnimateItem(m, itemIndex)) return false;
      return true;
    });

    if (!newAIMessage) return;

    // Mark as spoken immediately to prevent duplicate triggers
    spokenMessageIdsRef.current.add(newAIMessage.id);

    // Small delay to allow typewriter to start
    const timer = setTimeout(() => {
      toggleSpeech(newAIMessage.content, newAIMessage.id);
    }, 500);
    return () => clearTimeout(timer);
  }, [messages, listItems, isAutoSpeechEnabled, toggleSpeech, shouldAnimateItem]);

  // Handle speaker button press
  const handleSpeakerPress = useCallback(
    (text: string, id: string) => {
      toggleSpeech(text, id);
    },
    [toggleSpeech]
  );

  // Find the OLDEST non-user message that should animate
  // Sequential animation: oldest to newest (top to bottom visually)
  const nextAnimatableMessageId = useMemo(() => selectNextAnimatableIdentity(listItems, {
    animatingItemId,
    shouldAnimate: shouldAnimateItem,
    getAnimationIdentity,
  }), [listItems, animatingItemId, shouldAnimateItem]);

  // Once a non-user chat item renders in full, it should never be eligible for
  // a later typewriter pass. This prevents refetches/status changes after
  // button-only actions from replaying older visible messages one by one.
  useEffect(() => {
    const lock = resolveAnimationLock(listItems, { animatingItemId, getAnimationIdentity });
    if (lock.action !== 'keep') {
      if (lock.action === 'release-and-mark-seen' && animatingItemId !== null) {
        markItemAnimationSeen(animatingItemId);
      }
      setAnimatingItemId(null);
    }

    selectItemIdsToMarkSeen(listItems, {
      animatingItemId,
      nextAnimatableIdentity: nextAnimatableMessageId,
      shouldAnimate: shouldAnimateItem,
      getAnimationIdentity,
    }).forEach(markItemAnimationSeen);
  }, [listItems, nextAnimatableMessageId, animatingItemId, shouldAnimateItem, markItemAnimationSeen]);

  // Notify parent when typewriter state changes
  useEffect(() => {
    const isAnimating = animatingItemId !== null;
    onTypewriterStateChange?.(isAnimating);

    if (isAnimating) {
      scrollToBottomIfAnchored(false);
    }
  }, [animatingItemId, onTypewriterStateChange, scrollToBottomIfAnchored]);

  const renderItem: ListRenderItem<ChatListItem> = useCallback(({ item, index }) => {
    const nextItem = listItems[index + 1];
    const shouldPadBeforeChapter =
      nextItem !== undefined &&
      isIndicator(nextItem) &&
      nextItem.indicatorType === 'stage-chapter';
    const withChapterLeadIn = (content: React.ReactElement) => (
      shouldPadBeforeChapter
        ? <View style={styles.beforeChapterLeadIn}>{content}</View>
        : content
    );

    // 1. Render Custom Empty State (Compact)
    if (isCustomEmptyState(item)) {
      return withChapterLeadIn(
        <View style={styles.customEmptyStateItem} testID="chat-custom-empty-state-item">
          {customEmptyState}
        </View>
      );
    }

    // 2. Render Indicators
    if (isIndicator(item)) {
      const itemIndex = listItems.findIndex((listItem) => listItem.id === item.id);
      const animationIdentity = getAnimationIdentity(item.id);
      const shouldAnimateStageChapter =
        item.indicatorType === 'stage-chapter' &&
        itemIndex >= 0 &&
        !isAtOrBeforeSeenBoundary(item, itemIndex) &&
        !animatedItemIdsRef.current.has(item.id) &&
        !animatedItemIdsRef.current.has(animationIdentity) &&
        !seenAnimatedItemIdsRef.current.has(item.id) &&
        !seenAnimatedItemIdsRef.current.has(animationIdentity);

      // Shared content and share suggestion indicators are tappable to open the Activity Drawer
      const isTappableIndicator = item.indicatorType === 'context-shared'
        || item.indicatorType === 'empathy-shared';
      const onPress = isTappableIndicator && onContextSharedPress
        ? () => onContextSharedPress(item.timestamp, item.metadata?.isFromMe, item.indicatorType)
        : undefined;
      return withChapterLeadIn(
        <ChatIndicator
          type={item.indicatorType}
          timestamp={item.timestamp}
          onPress={onPress}
          metadata={item.metadata}
          animateEntrance={shouldAnimateStageChapter}
          onEntranceComplete={shouldAnimateStageChapter ? () => markItemAnimationSeen(item.id) : undefined}
        />
      );
    }

    // 3. Render Validation Cards
    if (isValidationCard(item)) {
      return withChapterLeadIn(
        <EmpathyValidationCard
          partnerName={item.partnerName}
          empathyContent={item.empathyContent}
          status={item.status}
          onValidateAccurate={onValidateAccurate || (() => {})}
          onValidateNotQuite={onValidateNotQuite || (() => {})}
          skipRevealAnimation={item.status !== 'pending'}
          testID={`validation-card-${item.id}`}
        />
      );
    }

    // 4. Render Custom Cards
    if (isCustomCard(item)) {
      const itemIndex = listItems.findIndex((listItem) => listItem.id === item.id);
      const shouldAnimate = itemIndex >= 0 ? shouldAnimateItem(item, itemIndex) : false;
      const animationIdentity = getAnimationIdentity(item.id);
      const isNextAnimatable = animationIdentity === nextAnimatableMessageId;

      return withChapterLeadIn(
        <>
          {item.render({
            skipAnimation: !shouldAnimate || !isNextAnimatable,
            onAnimationComplete: shouldAnimate && isNextAnimatable ? () => {
              markItemAnimationSeen(item.id);
              setAnimatingItemId(null);
              onTypewriterComplete?.();
            } : undefined,
          })}
        </>
      );
    }

    // 5. Render Messages
    // At this point, item must be a ChatMessage (we've already handled indicators, validation cards, custom cards, and custom empty state)
    const message = item as ChatMessage;
    const animationIdentity = getAnimationIdentity(message.id);
    
    const itemIndex = listItems.findIndex((listItem) => listItem.id === message.id);
    const isCurrentlyAnimating = animationIdentity === animatingItemId;
    const isAIMessage = message.role !== MessageRole.USER;

    const shouldAnimateTypewriter = itemIndex >= 0 ? shouldAnimateItem(message, itemIndex) : false;

    // Track animation for the next message in queue (oldest unanimatied)
    const isNextAnimatable = animationIdentity === nextAnimatableMessageId;

    const bubbleMessage: ChatBubbleMessage = {
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      senderId: message.senderId,
      status: message.status,
      skipTypewriter: !shouldAnimateTypewriter,
      sharedContentDeliveryStatus: message.sharedContentDeliveryStatus,
      sharedContentDirection: message.sharedContentDirection,
    };

    return withChapterLeadIn(
      <>
        <ChatBubble
          message={bubbleMessage}
          animationIdentity={animationIdentity}
          onAnimationStart={isNextAnimatable ? () => setAnimatingItemId(animationIdentity) : undefined}
          onAnimationProgress={() => scrollToBottomIfAnchored(false)}
          onAnimationComplete={(isNextAnimatable || isCurrentlyAnimating) ? () => {
            markItemAnimationSeen(message.id);
            setAnimatingItemId(null);
            onTypewriterComplete?.();
          } : undefined}
          isSpeaking={isSpeaking && currentId === message.id}
          onSpeakerPress={isAIMessage ? () => handleSpeakerPress(message.content, message.id) : undefined}
          partnerName={partnerName}
          onPress={
            (message.role === MessageRole.SHARED_CONTEXT || message.role === MessageRole.EMPATHY_STATEMENT) && onContextSharedPress
              ? () => onContextSharedPress(
                  message.timestamp,
                  message.sharedContentDirection === 'sent',
                  message.role === MessageRole.EMPATHY_STATEMENT ? 'empathy-shared' : 'context-shared',
                )
              : undefined
          }
        />
        {renderMessageExtra?.(message)}
      </>
    );
  }, [listItems, shouldAnimateItem, nextAnimatableMessageId, animatingItemId, onTypewriterComplete, isSpeaking, currentId, handleSpeakerPress, customEmptyState, styles, partnerName, renderMessageExtra, onContextSharedPress, onValidateAccurate, onValidateNotQuite, markItemAnimationSeen, scrollToBottomIfAnchored]);

  const keyExtractor = useCallback((item: ChatListItem) => getAnimationIdentity(item.id), []);

  // FlatList does not support changing onViewableItemsChanged after mount, so
  // the handler is stable and reads the latest prop through a ref.
  const onItemsViewedRef = useRef(onItemsViewed);
  onItemsViewedRef.current = onItemsViewed;
  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<ChatListItem>[]; changed: ViewToken<ChatListItem>[] }) => {
      onItemsViewedRef.current?.(
        viewableItems.filter((token) => token.isViewable && token.item).map((token) => token.item),
      );
    },
    [],
  );

  // Footer is visually at the bottom (Typing Indicator)
  // We always render a container with minHeight to prevent layout shift
  // when the indicator disappears and the AI message appears
  const renderHeader = useCallback(() => {
    return (
      <View
        style={styles.typingIndicatorContainer}
        onLayout={() => scrollToBottomIfAnchored(false)}
      >
        {showDelayedTypingIndicator && <TypingIndicator />}
      </View>
    );
  }, [showDelayedTypingIndicator, styles, scrollToBottomIfAnchored]);

  // Memoize the empty state element (not a callback!) to prevent remounts
  // NOTE: styles are excluded from deps because useStyles() creates new refs each render
  // but the actual style values are stable (theme-based)
  const emptyStateElement = useMemo(() => {
    if (showDelayedTypingIndicator) return null;
    // Use custom empty state if provided (e.g., onboarding compact)
    // Custom empty state starts at the top (flex-start) instead of centered
    if (customEmptyState) {
      return (
        <View style={styles.customEmptyState} testID="chat-custom-empty-state">
          {customEmptyState}
        </View>
      );
    }
    return (
      <View style={styles.emptyState} testID="chat-empty-state">
        <Text style={styles.emptyStateTitle}>{emptyStateTitle}</Text>
        {emptyStateMessage ? (
          <Text style={styles.emptyStateMessage}>{emptyStateMessage}</Text>
        ) : null}
      </View>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDelayedTypingIndicator, emptyStateTitle, emptyStateMessage, customEmptyState]);

  // Header is visually at the top (Loading Spinner)
  const renderLoadingHeader = useCallback(() => {
    if (!isLoadingMore) return null;
    return (
      <View style={styles.loadingMore}>
        <ActivityIndicator size="small" color={styles.loadingSpinner.color} />
      </View>
    );
  }, [isLoadingMore, styles]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    stickToBottom.observeScroll(event.nativeEvent);
  }, [stickToBottom]);

  const handleContentSizeChange = useCallback((_width: number, height: number) => {
    const resolution = stickToBottom.observeContentSize(height);

    if (resolution.kind === 'restore-history') {
      // History was prepended above the viewport; move down by exactly what was
      // added so the reader's anchor does not appear to shift.
      flatListRef.current?.scrollToOffset({ offset: resolution.offset, animated: false });
      return;
    }

    if (resolution.kind === 'stick-to-bottom') {
      scrollToBottom(false);
    }
  }, [scrollToBottom, stickToBottom]);

  const handleListLayout = useCallback((event: LayoutChangeEvent) => {
    stickToBottom.observeLayoutHeight(event.nativeEvent.layout.height);
    if (stickToBottom.isAnchored()) {
      scrollToBottom(false);
    }
  }, [scrollToBottom, stickToBottom]);

  const updateMessageListBottomInset = useCallback(() => {
    if (!isKeyboardVisible) {
      setMessageListBottomInset(0);
      return;
    }

    requestAnimationFrame(() => {
      flatListContainerRef.current?.measureInWindow((_listX, listY, _listWidth, listHeight) => {
        composerContainerRef.current?.measureInWindow((_composerX, composerY) => {
          const listBottom = listY + listHeight;
          const nextInset = Math.max(0, Math.ceil(listBottom - composerY));

          setMessageListBottomInset((currentInset) => (
            Math.abs(currentInset - nextInset) > 1 ? nextInset : currentInset
          ));
        });
      });
    });
  }, [isKeyboardVisible]);

  const handleComposerLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    setComposerHeight((currentHeight) => (
      Math.abs(currentHeight - nextHeight) > 1 ? nextHeight : currentHeight
    ));
  }, []);

  useEffect(() => {
    updateMessageListBottomInset();

    if (!isKeyboardVisible) {
      return;
    }

    const timeoutIds = [
      setTimeout(updateMessageListBottomInset, 80),
      setTimeout(updateMessageListBottomInset, 180),
      setTimeout(updateMessageListBottomInset, 320),
    ];

    return () => timeoutIds.forEach(clearTimeout);
  }, [
    auxiliaryControlsVisible,
    composerHeight,
    isKeyboardVisible,
    updateMessageListBottomInset,
  ]);

  useEffect(() => {
    if (isKeyboardVisible) return;

    setAuxiliaryControlsVisible(Boolean(renderAboveInput || renderBelowInput));
  }, [isKeyboardVisible, renderAboveInput, renderBelowInput]);

  const handleEndReached = useCallback(() => {
    if (!stickToBottom.canLoadMoreHistory()) {
      return;
    }

    if (hasMore && !isLoadingMore && onLoadMore) {
      // Snapshot scroll state BEFORE calling onLoadMore so no scroll effect can
      // run against stale metrics.
      stickToBottom.beginHistoryLoad();
      onLoadMore();
    }
  }, [hasMore, isLoadingMore, onLoadMore, stickToBottom]);

  const handleScrollBeginDrag = useCallback(() => {
    stickToBottom.markUserDragged();
  }, [stickToBottom]);

  // Cleanup: If loading finishes but no content was added, reset state
  useEffect(() => {
    if (!isLoadingMore && stickToBottom.isLoadingHistory()) {
      // Give handleContentSizeChange a chance to fire first
      const timeoutId = setTimeout(() => {
        if (stickToBottom.isLoadingHistory()) {
          stickToBottom.abortHistoryLoad();
        }
      }, 500);

      return () => clearTimeout(timeoutId);
    }
  }, [isLoadingMore, stickToBottom]);

  const stickyHeaderIndices = useMemo(() => {
    // VirtualizedList counts ListHeaderComponent as scroll child 0, so data
    // rows are offset by one when passed through stickyHeaderIndices.
    const listHeaderOffset = 1;
    return listItems.reduce<number[]>((indices, item, index) => {
      if (isIndicator(item) && item.indicatorType === 'stage-chapter') {
        indices.push(index + listHeaderOffset);
      }
      return indices;
    }, []);
  }, [listItems]);

  // The backend/query layer controls how many transcript rows are loaded.
  // Once a page is in memory, render it in one pass so opening a session does
  // not visibly fill the transcript row-by-row as VirtualizedList batches cells.
  const loadedTranscriptRowCount = Math.max(1, listItems.length);

  // ---------------------------------------------------------------------------
  // New Activity Pill: floating indicator for off-screen new items
  // ---------------------------------------------------------------------------

  const hasAuxiliaryControls = Boolean(renderAboveInput || renderBelowInput);
  const auxiliaryControls = hasAuxiliaryControls && auxiliaryControlsVisible ? (
    <View style={styles.auxiliaryControls}>
        {renderAboveInput?.()}
        {renderBelowInput?.()}
    </View>
  ) : null;

  const keyboardSpacerStyle = keyboardLift > 0
    ? { height: keyboardLift }
    : null;
  const keyboardOpenMessageListInset = isKeyboardVisible && messageListBottomInset > 0
    ? { paddingBottom: messageListBottomInset }
    : null;

  const composerControls = (
    <View
      ref={composerContainerRef}
      style={[styles.bottomContainer, isKeyboardVisible && styles.bottomContainerKeyboardOpen]}
      onLayout={handleComposerLayout}
    >
      {emotionSlider && (
        <EmotionSlider
          value={emotionSlider.value ?? 5}
          onChange={emotionSlider.onChange}
          onHighEmotion={emotionSlider.onHighEmotion}
          compact={emotionSlider.compact ?? false}
          testID="chat-emotion-slider"
        />
      )}
      {auxiliaryControls}
      {!hideInput && (
        <ChatInput
          onSend={onSendMessage}
          disabled={disabled || isInputDisabled || isLoading}
          inputDisabled={disabled || isLoading}
          keyboardVisible={isKeyboardVisible}
          onVoicePress={onVoicePress}
          failedMessage={failedMessage}
          prefillText={prefillText}
          onPrefillConsumed={onPrefillConsumed}
        />
      )}
    </View>
  );

  const messageList = (
    <FlatList
      ref={flatListRef}
      data={listItems}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      style={styles.flatList}
      stickyHeaderIndices={stickyHeaderIndices}
      contentContainerStyle={[
        styles.messageList,
        keyboardOpenMessageListInset,
        listItems.length === 0 && (customEmptyState ? styles.customMessageListEmpty : styles.messageListEmpty),
      ]}
      ListHeaderComponent={renderLoadingHeader}
      ListFooterComponent={
        <>
          {renderBelowChat?.()}
          {renderHeader?.()}
        </>
      }
      ListEmptyComponent={emptyStateElement}
      showsVerticalScrollIndicator={false}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      keyboardShouldPersistTaps="handled"
      testID="chat-message-list"
      onStartReached={handleEndReached}
      onStartReachedThreshold={0.2}
      initialNumToRender={loadedTranscriptRowCount}
      maxToRenderPerBatch={loadedTranscriptRowCount}
      updateCellsBatchingPeriod={0}
      removeClippedSubviews={false}
      onLayout={handleListLayout}
      onScroll={handleScroll}
      onScrollBeginDrag={handleScrollBeginDrag}
      scrollEventThrottle={16}
      onContentSizeChange={handleContentSizeChange}
      viewabilityConfig={VIEWABILITY_CONFIG}
      onViewableItemsChanged={handleViewableItemsChanged}
    />
  );

  if (Platform.OS === 'ios' && hasLinkedKeyboardController()) {
    return (
      <View style={styles.container}>
        <View ref={flatListContainerRef} style={styles.flatListContainer}>
          {messageList}
        </View>
        <KeyboardStickyComposer offset={{ opened: safeAreaInsets.bottom }}>
          {composerControls}
        </KeyboardStickyComposer>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View ref={flatListContainerRef} style={styles.flatListContainer}>
        {messageList}
      </View>
      {composerControls}
      {keyboardSpacerStyle ? <View pointerEvents="none" style={keyboardSpacerStyle} /> : null}
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const useStyles = () => {
  const { palette } = useAppAppearance();
  return createStyles((t) => ({
    container: {
      flex: 1,
      backgroundColor: palette.bg,
    },
    flatList: {
      flex: 1,
    },
    flatListContainer: {
      flex: 1,
      backgroundColor: palette.bg,
    },
    messageList: {
      paddingVertical: 18,
      flexGrow: 1,
      gap: 2,
    },
    messageListEmpty: {
      flexGrow: 1,
      justifyContent: 'center',
    },
    customMessageListEmpty: {
      flexGrow: 1,
      justifyContent: 'flex-start',
    },
    loadingMore: {
      paddingVertical: t.spacing.xl,
      alignItems: 'center',
    },
    typingIndicatorContainer: {
      // Reserve space for typing indicator to prevent layout shift
      // when it disappears and AI message appears
      // Height: padding (12*2) + dot (8) + border (2) + margin (4*2) = 42
      minHeight: 36,
    },
    customEmptyStateItem: {
      // Add padding to separate it from the input or the item above it
      paddingTop: t.spacing.md,
      paddingBottom: t.spacing.md,
    },
    beforeChapterLeadIn: {
      paddingBottom: t.spacing.xl,
    },
    loadingSpinner: {
      color: palette.textMuted,
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: t.spacing['3xl'],
      paddingVertical: t.spacing['3xl'],
    },
    customEmptyState: {
      flex: 1,
      justifyContent: 'flex-start',
    },
    emptyStateTitle: {
      fontSize: 32,
      color: palette.text,
      textAlign: 'center',
      lineHeight: 36,
      fontFamily: designFonts.serif,
    },
    emptyStateMessage: {
      fontSize: t.typography.fontSize.lg,
      lineHeight: 24,
      color: palette.textMuted,
      textAlign: 'center',
      marginTop: t.spacing.md,
      fontFamily: designFonts.sans,
    },
    bottomContainer: {
      // Container for the keyboard-sticky composer stack.
      // This ensures KeyboardAvoidingView adjusts relative to this container's bottom
      // rather than just the input field itself
      paddingBottom: t.spacing.sm,
    },
    bottomContainerKeyboardOpen: {
      paddingBottom: 0,
    },
    auxiliaryControls: {
      // overflow: 'hidden' removed — it interacted badly with
      // LayoutAnimation during keyboard transitions, permanently
      // clipping CTA panels at the bottom of the composer.
    },
  }));
};
