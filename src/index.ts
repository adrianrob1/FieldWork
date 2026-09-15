export type { Diagnostic, DiagnosticSeverity } from './domain/diagnostics.js';
export {
  agentBackendConfigSchema,
  backendNameSchema,
  backendsSchema,
  chatSchema,
  dateSchema,
  inlineRepositorySchema,
  linkSchema,
  openAiBackendConfigSchema,
  opencodeBackendConfigSchema,
  projectSchema,
  resourceSchema,
  stableIdSchema,
  summarySchema,
  taskSchema,
  workspaceSchema,
} from './domain/schemas.js';
export type {
  AgentBackendSettings,
  BackendConfig,
  Backends,
  OpenAiBackendSettings,
  OpencodeBackendSettings,
  Task,
  WorkspaceSettings,
} from './domain/schemas.js';
export {
  attachmentReferenceSchema,
  messageAttachmentSchema,
  messageMetadataSchema,
  messageRoles,
  toolCallSchema,
} from './domain/transcript.js';
export type {
  AttachmentReference,
  MessageAttachment,
  MessageMetadata,
  MessageRole,
  ToolCall,
} from './domain/transcript.js';
export type {
  CanonicalFileKind,
  DiscoveredWorkspaceFile,
  ParsedWorkspaceFile,
  ResolvedPath,
  WorkspaceArea,
  WorkspaceDiscoveryResult,
  WorkspaceParseResult,
} from './files/workspace.js';
export {
  discoverWorkspaceFiles,
  parseWorkspace,
  parseWorkspaceFile,
} from './files/workspace.js';
export { findWorkspaceRoot } from './files/workspaceRoot.js';
export {
  createDraft,
  deleteDraft,
  draftFilePath,
  isDraftId,
  listDrafts as listStoredDrafts,
  loadDraft,
  markDraftConsumed,
  updateDraft,
} from './files/draftStore.js';
export type {
  DraftCreateInput,
  DraftDeleteOutcome,
  DraftEntry,
  DraftListOutcome,
  DraftOutcome,
  DraftPatch,
  DraftRecord,
  DraftUpdateInput,
} from './files/draftStore.js';
export {
  parseTranscript,
  serializeChatMessage,
  serializeTranscript,
  windowMessages,
  TRANSCRIPT_WINDOW_DEFAULT_LIMIT,
  TRANSCRIPT_WINDOW_MAX_LIMIT,
} from './files/transcript.js';
export type {
  HeadingLocation,
  TranscriptMessage,
  TranscriptMessageInput,
  TranscriptParseResult,
  TranscriptWindow,
  TranscriptWindowOptions,
} from './files/transcript.js';
export { openDatabase } from './index/database.js';
export type { WorkspaceDatabase } from './index/database.js';
export {
  migrations,
  runMigrations,
  SCHEMA_VERSION,
} from './index/migrations.js';
export type { Migration, MigrationOutcome } from './index/migrations.js';
export {
  indexDirectory,
  indexPath,
  indexNewPath,
  indexOldPath,
} from './index/paths.js';
export type { IndexCounts, IndexResult } from './index/result.js';
export { rebuildIndex } from './index/build.js';
export type { RebuildOptions } from './index/build.js';
export { refreshIndex } from './index/refresh.js';
export { searchIndex } from './index/search.js';
export type { SearchHit, SearchResult, SearchScope } from './index/search.js';
export { searchRepositories } from './index/repositories.js';
export type {
  RepositoryMatch,
  RepositorySearchOptions,
  RepositorySearchResult,
} from './index/repositories.js';
export { startWorkspaceWatcher } from './watch/watcher.js';
export type {
  AwaitWriteFinishOptions,
  WatchBatchApplier,
  WatchBatchInput,
  WatchBatchPaths,
  WatchBatchResult,
  WatcherHandle,
  WatcherOptions,
  WatcherPollingOptions,
} from './watch/watcher.js';
export { attachChat } from './operations/attach.js';
export type { AttachChatInput } from './operations/attach.js';
export { detachChat } from './operations/detach.js';
export type { DetachChatInput } from './operations/detach.js';
export { promoteChat } from './operations/promote.js';
export type { PromoteChatInput } from './operations/promote.js';
export { appendChatMessage } from './operations/message.js';
export type {
  AppendChatMessage,
  AppendChatMessageInput,
  ChatMessageAppend,
} from './operations/message.js';
export { appendChatMessages } from './operations/message.js';
export type {
  AppendChatMessagesInput,
  ChatMessagesAppend,
} from './operations/message.js';
export { continueChat } from './operations/exchange.js';
export type {
  ChatExchange,
  ContinueChatHooks,
  ContinueChatInput,
} from './operations/exchange.js';
export { startChat, chatFileName, chatTitleSlug } from './operations/start.js';
export type { ChatStart, StartChatInput } from './operations/start.js';
export {
  completeTask,
  createTask,
  listTasks,
  resolveTaskAttachment,
  reopenTask,
  snoozeTask,
  taskView,
  updateTask,
} from './operations/tasks.js';
export type {
  TaskAttachmentPayload,
  TaskAttachmentResolution,
  TaskGroups,
  TaskIdInput,
  TaskListData,
  TaskQuickAddInput,
  TaskSnoozeInput,
  TaskStatusInput,
  TaskUpdateInput,
  TaskView,
} from './operations/tasks.js';
export {
  draftRoute,
  getDraft,
  listDrafts,
  stageInDraft,
  stageTaskInDraft,
  submitDraft,
} from './operations/drafts.js';
export type {
  AttachableKind,
  AttachableReference,
  DraftChatIdentity,
  DraftExchangeMessage,
  DraftSubmit,
  DraftView,
  GetDraftInput,
  StageInDraftInput,
  StageTaskInDraftInput,
  SubmitDraftInput,
} from './operations/drafts.js';
export {
  attachmentsBlock,
  messageAttachments,
  resolveAttachmentReferences,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from './operations/attachments.js';
export type {
  AttachmentResolution,
  ResolvedAttachment,
} from './operations/attachments.js';
export {
  augmentBackendMessage,
  buildAgentInstructions,
} from './operations/agentInstructions.js';
export type {
  AgentInstructionsOptions,
  BackendMessageOptions,
} from './operations/agentInstructions.js';
export { resolveBackends, findBackend } from './backends/config.js';
export type {
  AgentBackendConfig,
  BackendLookup,
  BackendsResolution,
  OpencodeBackendConfig,
  OpenAiBackendConfig,
  ResolvedBackendConfig,
} from './backends/config.js';
export { sendOpenAiExchange, createSseParser } from './backends/openai.js';
export type { OpenAiTransport, SseParser } from './backends/openai.js';
export {
  acpExchangeFromUpdates,
  buildAcpPrompt,
  childProcessAcpTransport,
  createAcpDeltaEmitter,
  sendAcpExchange,
} from './backends/acp.js';
export type {
  AcpDeltaEmitter,
  AcpSendOptions,
  AcpSession,
  AcpTransport,
} from './backends/acp.js';
export {
  buildOpencodeArgs,
  buildOpencodeMessage,
  childProcessSpawnTransport,
  createOpencodeDeltaStream,
  sendOpencodeExchange,
} from './backends/opencode.js';
export type {
  OpencodeDeltaStream,
  OpencodeSendOptions,
  SpawnCall,
  SpawnOutcome,
  SpawnTransport,
} from './backends/opencode.js';
export { createChatBackend } from './backends/create.js';
export type { ChatBackendOptions } from './backends/create.js';
export {
  buildCmdLine,
  resolveCommandFile,
  resolveSpawn,
  spawning,
} from './backends/command.js';
export type {
  CommandResolutionOptions,
  SpawnCommand,
  SpawnContext,
} from './backends/command.js';
export type {
  BackendExchange,
  BackendSendResult,
  ChatBackend,
  NormalizedExchangeMessage,
  NormalizedExchangeRequest,
} from './backends/types.js';
export {
  createProjectManifest,
  deriveRepositoryIds,
  registerProject,
} from './operations/register.js';
export type { RegisterProjectInput } from './operations/register.js';
export {
  createCanonicalFile,
  editCanonicalFile,
  hashOf,
  singleTrailingNewline,
  validateProposedDocument,
} from './operations/edit.js';
export type {
  CanonicalCreateInput,
  CanonicalEditInput,
  CanonicalWriteOutcome,
  ProposedDocument,
  WriteHooks,
} from './operations/edit.js';
export {
  applyBodyEdit,
  applyFrontmatterPatch,
  checkEditPath,
  editableFieldPolicy,
  loadEditableFile,
} from './operations/frontmatterEdit.js';
export type {
  BodyEditInput,
  EditApplyHooks,
  EditApplyOutcome,
  EditableFieldPolicy,
  EditableFileView,
  EditFileOutcome,
  EditOutcomeStatus,
  FrontmatterPatchInput,
} from './operations/frontmatterEdit.js';
export type {
  ChatAttachment,
  ChatPromotion,
  OperationResult,
  ProjectRegistration,
  RegisteredRepository,
} from './operations/result.js';
export { buildContext, MAX_CONTEXT_FILE_BYTES } from './search/context.js';
export type {
  ContextBundle,
  ContextFile,
  ContextOutcome,
  ContextScope,
  ContextScopeView,
  ContextTimings,
  ContextTrail,
  FileScore,
  LineRange,
  SelectedBranch,
} from './search/context.js';
export { lexicalSearch } from './search/lexical.js';
export type {
  LexicalScope,
  LexicalSearchData,
  LexicalSearchOutcome,
} from './search/lexical.js';
export { isOperationalFailure } from './search/outcome.js';
export {
  createWorkspaceServer,
  defaultServeHost,
  defaultServePort,
  matchRoute,
  startServer,
  stopServer,
} from './server/server.js';
export type {
  RouteMatch,
  ServerHandle,
  WorkspaceServerOptions,
} from './server/server.js';
export { renderMarkdown } from './server/render.js';
export {
  MAX_BRANCHES,
  MAX_CONTEXT_FILES,
  MIN_BRANCH_SCORE,
  scoreBranches,
  selectBranches,
} from './search/routing.js';
export type {
  BranchCandidate,
  ScoreComponents,
  ScoredBranch,
} from './search/routing.js';
