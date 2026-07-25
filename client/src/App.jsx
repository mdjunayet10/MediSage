import {
  ArrowUp,
  BookOpen,
  Brain,
  FileSearch,
  FileText,
  GraduationCap,
  Info,
  Languages,
  Menu,
  MessageSquareText,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ChatMessage from "./components/ChatMessage.jsx";
import AttachmentCard from "./components/AttachmentCard.jsx";
import AccountMenu from "./components/AccountMenu.jsx";
import Logo from "./components/Logo.jsx";
import SelectMenu from "./components/SelectMenu.jsx";
import {
  isHtmlDocument,
  isValidAssistantAnswer,
  sendChat,
} from "./lib/api.js";
import {
  extractLocalAttachment,
  selectRelevantAttachmentChunks,
  sentAttachmentMetadata,
} from "./lib/localAttachments.js";
import {
  loadCloudConversations,
  saveCloudConversation,
} from "./lib/conversationStore.js";

const STORAGE_KEY = "medisage-conversations-v4";
const THEME_KEY = "medisage-theme-v1";
const MAX_SAVED_CONVERSATIONS = 15;
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const DEFAULT_MODE = "balanced";
const DEFAULT_LANGUAGE = "auto";
const AUTH_NAVIGATION_DRAFT_KEY = "medisage-auth-navigation-draft";

export const RESPONSE_MODE_OPTIONS = [
  {
    value: "balanced",
    label: "Balanced",
    description: "Clear, complete answers with moderate detail.",
  },
  {
    value: "concise",
    label: "Concise",
    description: "Essential information in a shorter answer.",
  },
  {
    value: "detailed",
    label: "Detailed",
    description: "Thorough explanation with definitions and context.",
  },
  {
    value: "simple",
    label: "Simple",
    description: "Beginner-friendly language and shorter sentences.",
  },
  {
    value: "study-notes",
    label: "Study notes",
    description: "Headings, key points, definitions and revision notes.",
  },
  {
    value: "comparison",
    label: "Comparison",
    description: "A table of similarities, differences and conclusion.",
  },
  {
    value: "qa",
    label: "Questions & answers",
    description: "The topic presented as useful questions and answers.",
  },
];

export const LANGUAGE_OPTIONS = [
  {
    value: "auto",
    label: "Auto",
    description: "Match the language and tone of your latest message.",
  },
  { value: "en", label: "English", description: "Always answer in English." },
  {
    value: "bn",
    label: "বাংলা",
    description: "সবসময় স্বাভাবিক ও পরিষ্কার বাংলায় উত্তর দিন।",
  },
];

const SUGGESTED_PROMPTS = [
  "Explain high blood pressure in simple language.",
  "Compare angina and heart attack in a table.",
  "Create short study notes on blood clotting.",
  "Explain how the immune system responds to infection.",
  "What symptoms may require urgent medical attention?",
  "Explain arteries, veins and capillaries simply.",
];
const EMPTY_ACTIONS = [
  {
    id: "topic",
    icon: Brain,
    title: "Understand a topic",
    description: "Get a clear explanation of a medical concept.",
    prompt: SUGGESTED_PROMPTS[0],
  },
  {
    id: "document",
    icon: FileSearch,
    title: "Analyze an attachment",
    description:
      "Upload a document, data file, or image for grounded analysis.",
  },
  {
    id: "notes",
    icon: GraduationCap,
    title: "Create study notes",
    description: "Turn complex material into organized revision notes.",
    prompt: SUGGESTED_PROMPTS[2],
  },
  {
    id: "compare",
    icon: BookOpen,
    title: "Compare concepts",
    description: "See differences and similarities in a clear format.",
    prompt: SUGGESTED_PROMPTS[1],
  },
];

function createConversation() {
  return {
    id: crypto.randomUUID(),
    title: "New conversation",
    createdAt: Date.now(),
    messages: [],
    attachments: [],
    responseMode: DEFAULT_MODE,
    outputLanguage: DEFAULT_LANGUAGE,
  };
}

function mergeConversationLists(local, cloud) {
  const merged = new Map(cloud.map((conversation) => [conversation.id, conversation]));
  for (const conversation of local) {
    const existing = merged.get(conversation.id);
    if (!existing) {
      merged.set(conversation.id, conversation);
      continue;
    }
    const messages = new Map((existing.messages || []).map((message) => [message.id, message]));
    for (const message of conversation.messages || []) if (!messages.has(message.id)) messages.set(message.id, message);
    const attachments = new Map(
      (existing.attachments || []).map((attachment) => [
        attachment.id,
        attachment,
      ]),
    );
    for (const attachment of conversation.attachments || [])
      attachments.set(attachment.id, attachment);
    merged.set(conversation.id, {
      ...existing,
      ...conversation,
      messages: [...messages.values()],
      attachments: [...attachments.values()],
    });
  }
  return [...merged.values()];
}

function normalizeStoredMessages(conversation) {
  const normalized = [];
  for (const message of conversation.messages || []) {
    if (message?.conversationId !== conversation.id) continue;
    if (message.role === "user" || message.localError) {
      normalized.push(message);
      continue;
    }
    if (isValidAssistantAnswer(message.content)) {
      normalized.push(message);
      continue;
    }
    if (isHtmlDocument(message.content)) {
      const previousUser = [...normalized]
        .reverse()
        .find((item) => item.role === "user");
      const requestId = message.requestId || crypto.randomUUID();
      normalized.push({
        id: message.id || crypto.randomUUID(),
        role: "assistant",
        conversationId: conversation.id,
        requestId,
        content:
          "The AI service returned an invalid response. Please retry or remove this message.",
        localError: true,
        retryable: Boolean(previousUser),
        retrying: false,
        originalRequest: previousUser
          ? {
              requestId,
              messageId: previousUser.id || crypto.randomUUID(),
              conversationId: conversation.id,
              message: previousUser.content || "",
              messages: normalized
                .filter(
                  (item) =>
                    !item.localError &&
                    ((item.role === "user" &&
                      Boolean(item.content?.trim())) ||
                      isValidAssistantAnswer(item.content)),
                )
                .slice(-19)
                .map(({ role, content }) => ({ role, content })),
              attachmentIds: [
                ...(conversation.attachments || [])
                  .filter((attachment) => attachment.active !== false)
                  .map((attachment) => attachment.id),
                ...(previousUser.attachments || []).map(
                  (attachment) => attachment.id,
                ),
              ].filter(Boolean),
              responseMode: conversation.responseMode || DEFAULT_MODE,
              outputLanguage:
                conversation.outputLanguage || DEFAULT_LANGUAGE,
            }
          : null,
      });
    }
  }
  return normalized;
}

function loadConversations(storageKey = STORAGE_KEY) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(saved) && saved.length)
      return saved.map((conversation) => ({
        ...conversation,
        responseMode: RESPONSE_MODE_OPTIONS.some(
          (option) => option.value === conversation.responseMode,
        )
          ? conversation.responseMode
          : DEFAULT_MODE,
        outputLanguage: LANGUAGE_OPTIONS.some(
          (option) => option.value === conversation.outputLanguage,
        )
          ? conversation.outputLanguage
          : DEFAULT_LANGUAGE,
        attachments: (
          conversation.attachments ||
          (conversation.document ? [{ ...conversation.document, active: true, scope: "conversation" }] : [])
        ).map(({ file: _file, blobUrl: _blobUrl, ...attachment }) => attachment),
        messages: normalizeStoredMessages(conversation),
      }));
  } catch {
    /* Invalid or legacy uncorrelated data is replaced safely. */
  }
  return [createConversation()];
}

function titleFromText(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean;
}
function attachmentDetail(file = {}) {
  if (file.pageCount) return `${file.pageCount} pages`;
  if (file.rowCount) return `${file.rowCount} rows`;
  return String(file.kind || "document").toUpperCase();
}
const SUPPORTED_FILE_PATTERN =
  /\.(pdf|docx|txt|md|csv|json|xlsx|png|jpe?g|webp)$/i;
function isSupportedAttachment(file) {
  return file && SUPPORTED_FILE_PATTERN.test(file.name);
}
function fingerprint(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function assistantMessage(data, request) {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    conversationId: request.conversationId,
    requestId: request.requestId,
    content: data.answer,
    originalAnswer: data.answer,
    translations: {},
    sources: data.sources,
    groundingType: data.groundingType,
    relatedQuestions: data.relatedQuestions,
    safety: data.safety,
  };
}

export default function App({ user = null, isGuest = false, isRegisteredUser = false, onSignOut = null, routeConversationId = null, hasPendingGuestMigration = false, onResolveGuestMigration = null }) {
  const storageKey = user?.uid
    ? `medisage-conversations-${user.uid}`
    : STORAGE_KEY;
  const [conversations, setConversations] = useState(() =>
    loadConversations(storageKey),
  );
  const [activeId, setActiveId] = useState(() =>
    conversations.some((conversation) => conversation.id === routeConversationId)
      ? routeConversationId
      : conversations[0]?.id,
  );
  const restoredComposerRef = useRef(false);
  const [composerState, setComposerState] = useState(() => ({
    ...(() => {
      try {
        const restored = JSON.parse(sessionStorage.getItem(AUTH_NAVIGATION_DRAFT_KEY) || "null");
        sessionStorage.removeItem(AUTH_NAVIGATION_DRAFT_KEY);
        if (restored) {
          restoredComposerRef.current = true;
          return restored;
        }
      } catch { sessionStorage.removeItem(AUTH_NAVIGATION_DRAFT_KEY); }
      return { text: "", responseMode: conversations[0]?.responseMode || DEFAULT_MODE, outputLanguage: conversations[0]?.outputLanguage || DEFAULT_LANGUAGE, attachments: [] };
    })(),
  }));
  const [theme, setTheme] = useState(
    () => localStorage.getItem(THEME_KEY) || "light",
  );
  const [pendingConversationIds, setPendingConversationIds] = useState([]);
  const [documentDetailsOpen, setDocumentDetailsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [conversationMenu, setConversationMenu] = useState(null);
  const [topMenuOpen, setTopMenuOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [toast, setToast] = useState("");
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const messagesEndRef = useRef(null);
  const searchRef = useRef(null);
  const requestControllers = useRef(new Map());
  const activeConversation = useMemo(
    () =>
      conversations.find((item) => item.id === activeId) || conversations[0],
    [conversations, activeId],
  );
  const filteredConversations = useMemo(
    () =>
      conversations.filter((item) =>
        item.title.toLowerCase().includes(searchQuery.toLowerCase()),
      ),
    [conversations, searchQuery],
  );
  const isSending = pendingConversationIds.includes(activeConversation?.id);
  const contextAttachments = activeConversation?.attachments || [];
  const hasSendableDraft = composerState.attachments.some((attachment) =>
    attachment.status === "ready",
  );
  const canSend =
    !isSending &&
    Boolean(composerState.text.trim() || hasSendableDraft);
  useEffect(() => {
    localStorage.setItem(
      storageKey,
      JSON.stringify(conversations.slice(0, MAX_SAVED_CONVERSATIONS)),
    );
  }, [conversations, storageKey]);
  useEffect(() => {
    if (!user?.uid || !isRegisteredUser) return undefined;
    let active = true;
    loadCloudConversations(user.uid)
      .then((cloud) => {
        if (active && cloud.length) {
          setConversations((local) => {
            const merged = mergeConversationLists(local, cloud);
            Promise.all(merged.map((conversation) => saveCloudConversation(user.uid, conversation))).catch(() => {});
            return merged;
          });
          setActiveId((current) => current || cloud[0].id);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user?.uid, isRegisteredUser]);
  useEffect(() => {
    if (!user?.uid || !isRegisteredUser || !activeConversation) return undefined;
    const timer = window.setTimeout(
      () => saveCloudConversation(user.uid, activeConversation).catch(() => {}),
      700,
    );
    return () => window.clearTimeout(timer);
  }, [user?.uid, isRegisteredUser, activeConversation]);
  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversation?.messages, isSending]);
  useEffect(() => {
    if (restoredComposerRef.current) {
      restoredComposerRef.current = false;
      return;
    }
    setComposerState({
      text: "",
      responseMode: activeConversation?.responseMode || DEFAULT_MODE,
      outputLanguage: activeConversation?.outputLanguage || DEFAULT_LANGUAGE,
      attachments: [],
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
    setDocumentDetailsOpen(false);
  }, [activeId]);
  useEffect(() => {
    if (toast) {
      const timer = window.setTimeout(() => setToast(""), 4000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [toast]);
  useEffect(() => {
    const area = textareaRef.current;
    if (area) {
      area.style.height = "auto";
      area.style.height = `${Math.min(area.scrollHeight, 160)}px`;
    }
  }, [composerState.text]);
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
  useEffect(
    () => () => {
      requestControllers.current.forEach(({ controller }) =>
        controller.abort(),
      );
    },
    [],
  );

  function updateConversation(id, updater) {
    setConversations((current) =>
      current.map((item) => (item.id === id ? updater(item) : item)),
    );
  }
  function setConversationPreference(key, value) {
    setComposerState((state) => ({ ...state, [key]: value }));
    updateConversation(activeConversation.id, (item) => ({
      ...item,
      [key]: value,
    }));
  }
  function openFilePicker() {
    fileInputRef.current?.click();
  }
  function startNewConversation() {
    const conversation = createConversation();
    setConversations((current) =>
      [conversation, ...current].slice(0, MAX_SAVED_CONVERSATIONS),
    );
    setActiveId(conversation.id);
    setSidebarOpen(false);
    setTopMenuOpen(false);
  }
  function removeConversation(id) {
    requestControllers.current.get(id)?.controller.abort();
    requestControllers.current.delete(id);
    const remaining = conversations.filter((item) => item.id !== id);
    const next = remaining.length ? remaining : [createConversation()];
    setConversations(next);
    if (id === activeId) setActiveId(next[0].id);
    setConversationMenu(null);
  }
  function clearDocument() {
    const targetId = activeConversation.id;
    updateConversation(targetId, (item) => ({ ...item, attachments: [] }));
    setDocumentDetailsOpen(false);
    setToast("Attachment context removed. General chat is ready.");
  }
  function clearMessages() {
    updateConversation(activeConversation.id, (item) => ({
      ...item,
      messages: [],
      title: item.attachments?.length ? item.title : "New conversation",
    }));
    setTopMenuOpen(false);
  }
  async function copyConversation() {
    await navigator.clipboard.writeText(
      activeConversation.messages
        .map(
          (message) =>
            `${message.role === "user" ? "You" : "MediSage"}:\n${message.content}`,
        )
        .join("\n\n"),
    );
    setToast("Conversation copied.");
    setTopMenuOpen(false);
  }
  function exportConversation() {
    const content = activeConversation.messages
      .map((message) => `${message.role === "user" ? "You" : "MediSage"}:\n${message.content || `[Attachment: ${(message.attachments || []).map((item) => item.name || item.filename).join(", ")}]`}`)
      .join("\n\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeConversation.title.replace(/[^a-z0-9-_ ]/gi, "").trim() || "medisage-conversation"}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    setTopMenuOpen(false);
  }
  function clearGuestData() {
    if (!isGuest) return;
    localStorage.removeItem(storageKey);
    const conversation = createConversation();
    setConversations([conversation]);
    setActiveId(conversation.id);
    setComposerState({ text: "", responseMode: DEFAULT_MODE, outputLanguage: DEFAULT_LANGUAGE, attachments: [] });
    setToast("Guest data on this device was cleared.");
  }
  function preserveComposerForAuth() {
    const attachments = composerState.attachments
      .filter((attachment) => attachment.id && attachment.status === "ready")
      .map(({ file: _file, ...attachment }) => attachment);
    sessionStorage.setItem(AUTH_NAVIGATION_DRAFT_KEY, JSON.stringify({ ...composerState, attachments }));
  }
  function resolveGuestMigration(choice) {
    const imported = onResolveGuestMigration?.(choice) || [];
    if (choice === "import" && imported.length) {
      setConversations((current) => mergeConversationLists(current, imported));
      setActiveId((current) => current || imported[0].id);
      setToast("Guest conversation added to your account.");
    }
  }

  function errorMessage(error, request, existingId) {
    return {
      id: existingId || crypto.randomUUID(),
      role: "assistant",
      conversationId: request.conversationId,
      requestId: request.requestId,
      content:
        error.message || "The assistant could not complete that response.",
      localError: true,
      retryable:
        error.retryable ||
        [
          "INVALID_AI_RESPONSE",
          "INVALID_API_RESPONSE",
          "INVALID_JSON_RESPONSE",
          "INVALID_RESPONSE_CONTRACT",
          "AI_SERVICE_ERROR",
          "AI_TIMEOUT",
          "REQUEST_FAILED",
          "CONVERSATION_MISMATCH",
        ].includes(error.code),
      originalRequest: request,
      retrying: false,
    };
  }

  async function executeRequest(
    request,
    { appendUser = true, replaceErrorId = null } = {},
  ) {
    requestControllers.current.get(request.conversationId)?.controller.abort();
    const controller = new AbortController();
    requestControllers.current.set(request.conversationId, {
      requestId: request.requestId,
      controller,
    });
    setPendingConversationIds((ids) => [
      ...new Set([...ids, request.conversationId]),
    ]);
    if (appendUser)
      updateConversation(request.conversationId, (item) => ({
        ...item,
        title:
          item.title === "New conversation"
            ? titleFromText(request.message)
            : item.title,
        messages: [
          ...item.messages,
          {
            id: crypto.randomUUID(),
            role: "user",
            conversationId: request.conversationId,
            requestId: request.requestId,
            content: request.message,
          },
        ],
      }));
    if (replaceErrorId)
      updateConversation(request.conversationId, (item) => ({
        ...item,
        messages: item.messages.map((message) =>
          message.id === replaceErrorId
            ? { ...message, retrying: true }
            : message,
        ),
      }));
    try {
      const data = await sendChat({ ...request, signal: controller.signal });
      if (
        requestControllers.current.get(request.conversationId)?.requestId !==
        request.requestId
      )
        return;
      const normalized = assistantMessage(data, request);
      updateConversation(request.conversationId, (item) => ({
        ...item,
        messages: replaceErrorId
          ? item.messages.map((message) =>
              message.id === replaceErrorId ? normalized : message,
            )
          : [...item.messages, normalized],
      }));
    } catch (error) {
      if (error.name === "AbortError") return;
      if (["DOCUMENT_EXPIRED", "ATTACHMENT_EXPIRED"].includes(error.code))
        updateConversation(request.conversationId, (item) => ({
          ...item,
          attachments: (item.attachments || []).map((attachment) =>
            request.attachmentIds?.includes(attachment.id)
              ? { ...attachment, active: false, status: "expired" }
              : attachment,
          ),
        }));
      const failure = errorMessage(error, request, replaceErrorId);
      updateConversation(request.conversationId, (item) => ({
        ...item,
        messages: replaceErrorId
          ? item.messages.map((message) =>
              message.id === replaceErrorId ? failure : message,
            )
          : [...item.messages, failure],
      }));
    } finally {
      if (
        requestControllers.current.get(request.conversationId)?.requestId ===
        request.requestId
      ) {
        requestControllers.current.delete(request.conversationId);
        setPendingConversationIds((ids) =>
          ids.filter((id) => id !== request.conversationId),
        );
      }
      window.setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }

  function buildRequest(text, draftAttachments = []) {
    const target = activeConversation;
    const attachmentsById = new Map();
    for (const attachment of [
      ...(target.attachments || []),
      ...draftAttachments,
    ]) {
      if (
        attachment.id &&
        attachment.active !== false &&
        attachment.status === "ready"
      )
        attachmentsById.set(attachment.id, attachment);
    }
    const selectedAttachments = [...attachmentsById.values()];
    return {
      requestId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      conversationId: target.id,
      message: text,
      attachmentIds: selectedAttachments.map((attachment) => attachment.id),
      attachmentContext: selectRelevantAttachmentChunks(
        selectedAttachments,
        text,
      ),
      responseMode: composerState.responseMode,
      outputLanguage: composerState.outputLanguage,
      messages: target.messages
        .filter(
          (message) =>
            !message.localError &&
            ((message.role === "user" &&
              Boolean(message.content?.trim())) ||
              isValidAssistantAnswer(message.content)),
        )
        .slice(-19)
        .map(({ role, content }) => ({ role, content })),
    };
  }
  function handleSend(explicitText) {
    const text = (explicitText ?? composerState.text).trim();
    const drafts = explicitText == null
      ? composerState.attachments.filter((attachment) =>
          attachment.status === "ready",
        )
      : [];
    if ((!text && !drafts.length) || isSending || !activeConversation) return;
    const request = buildRequest(text, drafts);
    const messageAttachments = drafts.map(sentAttachmentMetadata);
    const conversationAttachments = drafts.map(
      ({ file: _file, fingerprint: _fingerprint, localId: _localId, ...attachment }) => ({
        ...attachment,
        active: true,
        scope: "conversation",
      }),
    );
    updateConversation(activeConversation.id, (item) => ({
      ...item,
      title:
        item.title === "New conversation"
          ? titleFromText(text || messageAttachments[0]?.name || "Attachment")
          : item.title,
      attachments: [
        ...(item.attachments || []).filter(
          (existing) => !conversationAttachments.some((next) => next.id === existing.id),
        ),
        ...conversationAttachments,
      ],
      messages: [
        ...item.messages,
        {
          id: request.messageId,
          role: "user",
          conversationId: item.id,
          requestId: request.requestId,
          content: text,
          attachments: messageAttachments,
        },
      ],
    }));
    const sentLocalIds = new Set(drafts.map((attachment) => attachment.localId));
    setComposerState((state) => ({
      ...state,
      text: "",
      attachments: state.attachments.filter((attachment) => !sentLocalIds.has(attachment.localId)),
    }));
    if (fileInputRef.current) fileInputRef.current.value = "";
    executeRequest(request, { appendUser: false });
  }
  function handleRetry(message) {
    if (
      !message.originalRequest ||
      pendingConversationIds.includes(message.originalRequest.conversationId)
    )
      return;
    executeRequest(
      { ...message.originalRequest, requestId: crypto.randomUUID() },
      { appendUser: false, replaceErrorId: message.id },
    );
  }

  function removeMessage(message) {
    updateConversation(message.conversationId, (conversation) => ({
      ...conversation,
      messages: conversation.messages.filter((item) => item.id !== message.id),
    }));
  }

  function updateDraft(localId, patch) {
    setComposerState((state) => ({
      ...state,
      attachments: state.attachments.map((attachment) =>
        attachment.localId === localId ? { ...attachment, ...patch } : attachment,
      ),
    }));
  }

  async function processDraft(draft) {
    try {
      const result = await extractLocalAttachment(draft.file, {
        onProgress: (progress) =>
          updateDraft(draft.localId, {
            progress,
            localProgress: progress,
          }),
      });
      updateDraft(draft.localId, {
        ...result,
        file: draft.file,
        fingerprint: draft.fingerprint,
        localId: draft.localId,
        scope: "conversation",
        status: "ready",
        progress: 100,
      });
    } catch (error) {
      updateDraft(draft.localId, {
        status: "failed",
        error: error.message,
      });
      setToast(error.message);
    }
  }

  function addAttachments(fileList) {
    const target = activeConversation;
    if (!target) return;
    const available = MAX_ATTACHMENTS_PER_MESSAGE - composerState.attachments.length;
    const files = [...(fileList || [])].slice(0, Math.max(0, available));
    const known = new Set(composerState.attachments.map((item) => item.fingerprint));
    const drafts = [];
    for (const file of files) {
      if (!isSupportedAttachment(file)) {
        setToast("Select a supported PDF, document, data file, or image.");
        continue;
      }
      if (file.size > 20 * 1024 * 1024) {
        setToast(`${file.name} is larger than 20 MB.`);
        continue;
      }
      const fileFingerprint = fingerprint(file);
      if (known.has(fileFingerprint)) continue;
      known.add(fileFingerprint);
      drafts.push({
        localId: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        mimeType: file.type,
        fingerprint: fileFingerprint,
        file,
        scope: "conversation",
        status: "processing",
        progress: 0,
        localOnly: true,
      });
    }
    if (!drafts.length) return;
    setComposerState((state) => ({ ...state, attachments: [...state.attachments, ...drafts] }));
    for (const draft of drafts) processDraft(draft);
    if ([...(fileList || [])].length > available) setToast(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments can be sent at once.`);
  }

  function handleAttachmentSelection(event) {
    addAttachments(event.target.files);
    event.target.value = "";
  }

  function removeDraft(attachment) {
    setComposerState((state) => ({
      ...state,
      attachments: state.attachments.filter((item) => item.localId !== attachment.localId),
    }));
  }

  function retryDraft(attachment) {
    if (!attachment.file) return;
    updateDraft(attachment.localId, {
      status: "processing",
      progress: 0,
      error: null,
    });
    processDraft(attachment);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    addAttachments(event.dataTransfer.files);
  }
  function toggleContextAttachment(attachment) {
    updateConversation(activeConversation.id, (item) => ({
      ...item,
      attachments: (item.attachments || []).map((current) =>
        current.id === attachment.id ? { ...current, active: current.active === false } : current,
      ),
    }));
  }
  function removeContextAttachment(attachment, shouldDelete = false) {
    updateConversation(activeConversation.id, (item) => ({
      ...item,
      attachments: (item.attachments || []).filter((current) => current.id !== attachment.id),
      messages: shouldDelete
        ? item.messages.map((message) => ({
            ...message,
            attachments: (message.attachments || []).map((current) =>
              current.id === attachment.id ? { ...current, status: "deleted" } : current,
            ),
          }))
        : item.messages,
    }));
  }
  function handleEdit(text) {
    setComposerState((state) => ({ ...state, text }));
    window.setTimeout(() => textareaRef.current?.focus(), 50);
  }
  function handleKeyDown(event) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      handleSend();
    }
  }
  const sidebarWidthClass = sidebarCollapsed ? "lg:pl-[82px]" : "lg:pl-[288px]";

  return (
    <div className="app-shell">
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      {hasPendingGuestMigration && (
        <div className="guest-dialog-backdrop" role="presentation">
          <section className="guest-dialog" role="dialog" aria-modal="true" aria-labelledby="migration-dialog-title">
            <h2 id="migration-dialog-title">Add your guest conversation?</h2>
            <p>Would you like to add your current guest conversation to this account?</p>
            <div className="migration-dialog-actions">
              <button type="button" className="auth-primary" onClick={() => resolveGuestMigration("import")}>Import conversation</button>
              <button type="button" className="auth-secondary" onClick={() => resolveGuestMigration("keep")}>Continue without importing</button>
            </div>
          </section>
        </div>
      )}
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
        />
      )}
      <aside
        className={`sidebar ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${sidebarOpen ? "sidebar-mobile-open" : ""}`}
      >
        <div className="sidebar-logo-row">
          <Logo compact={sidebarCollapsed} />
          <button
            type="button"
            className="sidebar-mobile-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            <X size={19} />
          </button>
        </div>
        <div className="sidebar-primary">
          <button
            type="button"
            onClick={startNewConversation}
            className="new-conversation"
          >
            <Plus size={18} />
            <span>New conversation</span>
          </button>
        </div>
        {!sidebarCollapsed && (
          <div className="sidebar-search-wrap">
            {searchOpen ? (
              <div className="sidebar-search">
                <Search size={15} />
                <input
                  ref={searchRef}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search conversations"
                  aria-label="Search conversations"
                />
                <button
                  type="button"
                  onClick={() => {
                    setSearchOpen(false);
                    setSearchQuery("");
                  }}
                  aria-label="Close search"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="sidebar-search-trigger"
                onClick={() => setSearchOpen(true)}
              >
                <Search size={15} />
                Search conversations
              </button>
            )}
          </div>
        )}
        <div className="conversation-list">
          <p className="sidebar-label">Recent</p>
          {filteredConversations.map((conversation) => (
            <div key={conversation.id} className="conversation-item-wrap">
              <button
                type="button"
                title={conversation.title}
                onClick={() => {
                  setActiveId(conversation.id);
                  setSidebarOpen(false);
                }}
                className={`conversation-item ${conversation.id === activeConversation?.id ? "conversation-active" : ""}`}
              >
                <MessageSquareText size={16} />
                <span>{conversation.title}</span>
              </button>
              {!sidebarCollapsed && (
                <button
                  type="button"
                  onClick={() =>
                    setConversationMenu(
                      conversationMenu === conversation.id
                        ? null
                        : conversation.id,
                    )
                  }
                  className="conversation-more"
                  aria-label={`Actions for ${conversation.title}`}
                >
                  <MoreHorizontal size={15} />
                </button>
              )}
              {conversationMenu === conversation.id && (
                <div className="conversation-popover">
                  <button
                    type="button"
                    onClick={() => removeConversation(conversation.id)}
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="sidebar-footer">
          {user && <AccountMenu user={user} isGuest={isGuest} collapsed={sidebarCollapsed} onSignOut={onSignOut} onClearGuestData={clearGuestData} onBeforeAuthNavigation={preserveComposerForAuth} />}
          {!sidebarCollapsed && (
            <div className="privacy-note">
              <ShieldCheck size={17} />
              <span>
                Educational guidance with private, on-device attachment
                processing.
              </span>
            </div>
          )}
          <button
            type="button"
            className="collapse-sidebar"
            onClick={() => setSidebarCollapsed((value) => !value)}
            aria-label={
              sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
            }
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <>
                <PanelLeftClose size={18} />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
      </aside>

      <main className={`main-shell ${sidebarWidthClass}`}>
        <header className="topbar">
          <div className="topbar-title">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="mobile-menu"
              aria-label="Open sidebar"
            >
              <Menu size={20} />
            </button>
            <div>
              <h1>{activeConversation?.title}</h1>
              <p>
                {contextAttachments.length
                  ? `${contextAttachments.length} attachment${contextAttachments.length === 1 ? "" : "s"} in context`
                  : "Medical education workspace"}
              </p>
            </div>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                setSidebarCollapsed(false);
                setSearchOpen(true);
              }}
              aria-label="Search conversations"
            >
              <Search size={18} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            >
              {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            </button>
            <div className="relative">
              <button
                type="button"
                className="icon-button"
                onClick={() => setTopMenuOpen((value) => !value)}
                aria-label="Conversation actions"
              >
                <MoreHorizontal size={19} />
              </button>
              {topMenuOpen && (
                <div className="top-popover">
                  <button type="button" onClick={startNewConversation}>
                    <Plus size={15} />
                    New conversation
                  </button>
                  <button
                    type="button"
                    onClick={copyConversation}
                    disabled={!activeConversation.messages.length}
                  >
                    <BookOpen size={15} />
                    Copy conversation
                  </button>
                  <button type="button" onClick={exportConversation} disabled={!activeConversation.messages.length}>
                    <BookOpen size={15} />
                    Export conversation
                  </button>
                  <button
                    type="button"
                    onClick={clearMessages}
                    disabled={!activeConversation.messages.length}
                  >
                    <Trash2 size={15} />
                    Clear messages
                  </button>
                  {contextAttachments.length > 0 && (
                    <button type="button" onClick={clearDocument}>
                      <X size={15} />
                      Remove document
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </header>
        <div
          className="workspace"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setDragging(false);
          }}
          onDrop={handleDrop}
        >
          {dragging && (
            <div className="drop-overlay">
              <UploadCloud size={34} />
              <strong>Drop your attachment here</strong>
              <span>It will be processed in this temporary workspace</span>
            </div>
          )}
          <section className="chat-scroll">
            <div className="reading-column">
              {contextAttachments.length > 0 && (
                <div className="document-strip attachment-context-strip">
                  <div className="document-strip-icon"><FileText size={18} /></div>
                  <div>
                    <strong>Conversation attachment context</strong>
                    <span>{contextAttachments.filter((item) => item.active !== false).length} active of {contextAttachments.length}</span>
                  </div>
                  <button type="button" onClick={() => setDocumentDetailsOpen((open) => !open)} aria-label="Open attachment details"><Info size={16} /></button>
                  <button type="button" onClick={clearDocument} aria-label="Delete all attachments"><X size={16} /></button>
                </div>
              )}
              {!activeConversation?.messages.length ? (
                <div className="empty-state">
                  <div className="empty-emblem">
                    <Logo compact />
                  </div>
                  <h2>Medical knowledge, made clearer.</h2>
                  <p>
                    Ask a medical question, explore a document or create
                    structured study material.
                  </p>
                  <div className="empty-actions">
                    {EMPTY_ACTIONS.map(
                      ({ id, icon: Icon, title, description, prompt }) => (
                        <button
                          type="button"
                          key={id}
                          onClick={() =>
                            id === "document"
                              ? openFilePicker()
                              : handleSend(prompt)
                          }
                        >
                          <span>
                            <Icon size={18} />
                          </span>
                          <strong>{title}</strong>
                          <small>{description}</small>
                        </button>
                      ),
                    )}
                  </div>
                  <div className="prompt-library">
                    <span>Try asking</span>
                    <div>
                      {SUGGESTED_PROMPTS.map((prompt) => (
                        <button
                          type="button"
                          key={prompt}
                          onClick={() => handleSend(prompt)}
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="messages-list">
                  {activeConversation.messages.map((message) => (
                    <ChatMessage
                      key={message.id}
                      message={message}
                      onRetry={handleRetry}
                      onRemove={removeMessage}
                      onEdit={handleEdit}
                      onQuestion={handleSend}
                    />
                  ))}
                </div>
              )}
              {isSending && (
                <div className="loading-message">
                  <div className="assistant-avatar">
                    <Brain size={16} />
                  </div>
                  <div className="loading-skeleton">
                    <div />
                    <div />
                    <span>
                      Preparing your answer…
                    </span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </section>

          <div className={`composer-dock ${sidebarWidthClass}`}>
            <div className="composer-wrap">
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleSend();
                }}
              >
                {contextAttachments.some((item) => item.active !== false) && (
                  <div className="composer-document">
                    <FileText size={14} />
                    <button type="button" className="document-pill-name" onClick={() => setDocumentDetailsOpen((open) => !open)}>
                      Using {contextAttachments.filter((item) => item.active !== false).length} conversation attachment{contextAttachments.filter((item) => item.active !== false).length === 1 ? "" : "s"}
                    </button>
                  </div>
                )}
                {documentDetailsOpen && contextAttachments.length > 0 && (
                  <div
                    className="document-details"
                    role="region"
                    aria-label="Document details"
                  >
                    {contextAttachments.map((attachment) => (
                      <div className="attachment-context-row" key={attachment.id}>
                        <span><strong>{attachment.name || attachment.filename}</strong> · {attachmentDetail(attachment)}</span>
                        <button type="button" onClick={() => toggleContextAttachment(attachment)}>{attachment.active === false ? "Use for questions" : "Stop using"}</button>
                        <button type="button" onClick={() => removeContextAttachment(attachment)}>Remove</button>
                        <button type="button" onClick={() => removeContextAttachment(attachment, true)}>Delete</button>
                      </div>
                    ))}
                  </div>
                )}
                {composerState.attachments.length > 0 && (
                  <div className="composer-attachments">
                    {composerState.attachments.map((attachment) => (
                      <AttachmentCard
                        key={attachment.localId}
                        attachment={attachment}
                        onRemove={removeDraft}
                        onRetry={retryDraft}
                      />
                    ))}
                  </div>
                )}
                <textarea
                  ref={textareaRef}
                  value={composerState.text}
                  onChange={(event) =>
                    setComposerState((state) => ({
                      ...state,
                      text: event.target.value.slice(0, 12000),
                    }))
                  }
                  onKeyDown={handleKeyDown}
                  rows={1}
                  placeholder={
                    contextAttachments.some((item) => item.active !== false)
                      ? "Ask anything about your attachments…"
                      : "Ask a medical question…"
                  }
                  disabled={isSending}
                  aria-label="Chat message"
                />
                <div className="composer-toolbar">
                  <div className="composer-tools">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept=".pdf,.docx,.txt,.md,.csv,.json,.xlsx,.png,.jpg,.jpeg,.webp"
                      className="sr-only"
                      aria-label="Attachment file input"
                      onChange={handleAttachmentSelection}
                    />
                    <div className="attachment-menu-wrap">
                      <button
                        type="button"
                        onClick={() => setAttachmentMenuOpen((value) => !value)}
                        disabled={composerState.attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE || isSending}
                        className="tool-button"
                        aria-label="Upload attachment"
                        title="Attach a document or image"
                        aria-expanded={attachmentMenuOpen}
                      >
                        <Paperclip size={16} />
                        <span>Attach</span>
                      </button>
                      {attachmentMenuOpen && (
                        <div className="attachment-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setAttachmentMenuOpen(false);
                              openFilePicker();
                            }}
                          >
                            <FileText size={15} />
                            Upload document
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setAttachmentMenuOpen(false);
                              openFilePicker();
                            }}
                          >
                            <BookOpen size={15} />
                            Upload spreadsheet
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setAttachmentMenuOpen(false);
                              openFilePicker();
                            }}
                          >
                            <FileSearch size={15} />
                            Upload image
                          </button>
                          <small>
                            PDF, DOCX, TXT, MD · CSV, JSON, XLSX · PNG, JPG,
                            WEBP
                          </small>
                        </div>
                      )}
                    </div>
                    <SelectMenu
                      ariaLabel="Response style"
                      value={composerState.responseMode}
                      options={RESPONSE_MODE_OPTIONS}
                      onChange={(value) =>
                        setConversationPreference("responseMode", value)
                      }
                      icon={SlidersHorizontal}
                      disabled={isSending}
                    />
                    <SelectMenu
                      ariaLabel="Answer language"
                      value={composerState.outputLanguage}
                      options={LANGUAGE_OPTIONS}
                      onChange={(value) =>
                        setConversationPreference("outputLanguage", value)
                      }
                      icon={Languages}
                      disabled={isSending}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={!canSend || !activeConversation}
                    className="send-button"
                    aria-label="Send message"
                  >
                    <ArrowUp size={19} />
                  </button>
                </div>
              </form>
              <p className="composer-note">
                MediSage can make mistakes. Verify important medical information
                with a qualified professional.
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
