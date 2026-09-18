/**
 * PROTOTYPE — planning evidence for issue 19, not migration implementation.
 *
 * This artifact fixes the shape of the portable core interface while leaving
 * D1 SQL mechanics (#20), qualified numeric limits (#29), and pruning (#30)
 * to their dedicated decisions.
 */

export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type ProgrammeId = Brand<number, "ProgrammeId">;
export type EpisodeId = Brand<number, "EpisodeId">;
export type MediaId = Brand<number, "MediaId">;
export type RequestId = Brand<string, "RequestId">;
export type JobId = Brand<string, "JobId">;
export type RootId = Brand<string, "RootId">;
export type ReceiptId = Brand<string, "ReceiptId">;
export type OutboxId = Brand<string, "OutboxId">;
export type GenerationId = Brand<string, "GenerationId">;
export type LeaseToken = Brand<string, "LeaseToken">;
export type Revision = Brand<string, "Revision">;
export type Fingerprint = Brand<string, "Fingerprint">;
export type IsoInstant = Brand<string, "IsoInstant">;
export type Cursor = Brand<string, "Cursor">;

export type ByteStream = ReadableStream<Uint8Array>;

export type Result<Value, Error = RuntimeFailure> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Error };

export type LifecycleState =
  | "standby"
  | "active"
  | "quiescing"
  | "halted";

export type ProgrammeType =
  | "Balado"
  | "EmissionPremiere"
  | "GrandeSerie"
  | "Audiobook";

export type ProgrammeStatus = "Ok" | "Failed";

// ---------------------------------------------------------------------------
// Closed failure model
// ---------------------------------------------------------------------------

export type FailureSource =
  | "core"
  | "radio-canada"
  | "persistence"
  | "archive"
  | "publisher"
  | "configuration";

export type FailureStage =
  | "configuration"
  | "admission"
  | "lookup"
  | "lease"
  | "fetch-headers"
  | "fetch-body"
  | "graphql"
  | "decode"
  | "schema"
  | "traversal"
  | "media-discovery"
  | "media-resolution"
  | "object-read"
  | "object-write"
  | "object-scan"
  | "commit"
  | "publication"
  | "recovery"
  | "execution";

export interface FailureContext {
  readonly message: string; // bounded, human-safe
  readonly occurredAt: IsoInstant;
  readonly jobId?: JobId;
  readonly rootId?: RootId;
  readonly programmeId?: ProgrammeId;
  readonly episodeId?: EpisodeId;
  readonly mediaId?: MediaId;
  readonly attempt?: number;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly payloadFingerprint?: Fingerprint;
  readonly jsonPath?: string;
}

interface FailureBase<
  Class extends string,
  Code extends string,
  Retryable extends boolean,
> {
  readonly class: Class;
  readonly code: Code;
  readonly source: FailureSource;
  readonly stage: FailureStage;
  readonly retryable: Retryable;
  readonly context: FailureContext;
}

export type BenignCondition = FailureBase<
  "benign",
  | "duplicate-receipt"
  | "completed-receipt"
  | "revision-zero-already-present"
  | "expected-missing-object"
  | "suppressed-programme"
  | "acknowledged-no-op"
  | "live-lease"
  | "unmet-dependency"
  | "non-head-lane"
  | "not-yet-due",
  false
> & { readonly programmeImpact: "never" };

export type TransientDependencyFailure = FailureBase<
  "transient-dependency",
  | "upstream-retryable-status"
  | "upstream-transport"
  | "upstream-deadline"
  | "upstream-body-interrupted"
  | "upstream-malformed-json"
  | "graphql-transient"
  | "d1-transient"
  | "r2-transient"
  | "queue-transient"
  | "ambiguous-platform-outcome",
  true
> & {
  readonly programmeImpact: "programme-page-after-exhaustion" | "never";
  readonly retryAfter?: IsoInstant;
};

export type PermanentUpstreamContentFailure = FailureBase<
  "permanent-upstream-content",
  | "upstream-permanent-status"
  | "graphql-permanent"
  | "incompatible-schema"
  | "unknown-upstream-type"
  | "invalid-upstream-identifier"
  | "pagination-cycle"
  | "pagination-no-progress"
  | "invalid-traversal",
  false
> & {
  readonly programmeImpact: "programme-page-immediate" | "never";
};

export type PermanentOperationalFailure = FailureBase<
  "permanent-operational-contract",
  | "invalid-configuration"
  | "invalid-binding"
  | "invalid-envelope"
  | "unsupported-envelope-version"
  | "unsupported-job-kind"
  | "unsupported-job-version"
  | "unknown-job"
  | "invalid-request-construction"
  | "corrupt-persisted-state"
  | "invariant-violation"
  | "unsupported-operation"
  | "capacity-or-quota"
  | "lifecycle-closed"
  | "idempotency-key-reused",
  false
> & { readonly programmeImpact: "never" };

export type UnexpectedInternalFailure = FailureBase<
  "unexpected-internal",
  "unclassified-exception",
  false
> & { readonly programmeImpact: "never" };

export type ClassifiedCondition =
  | BenignCondition
  | TransientDependencyFailure
  | PermanentUpstreamContentFailure
  | PermanentOperationalFailure
  | UnexpectedInternalFailure;

export type RuntimeFailure = Exclude<ClassifiedCondition, BenignCondition>;

// ---------------------------------------------------------------------------
// One deep inbound interface: seven route/event-shaped operations
// ---------------------------------------------------------------------------

export interface Ohdieux {
  readonly feeds: Feeds;
  readonly media: Media;
  readonly administration: Administration;
  readonly schedule: Schedule;
  readonly jobs: Jobs;
}

export interface FeedOptions {
  readonly reverse: boolean;
  readonly tagSegments: boolean;
  readonly limitEpisodes: boolean;
  readonly excludeReplays: boolean;
  readonly favorAac: boolean;
}

export interface Feeds {
  read(input: {
    readonly requestId: RequestId;
    readonly programmeId: ProgrammeId;
    readonly options: FeedOptions;
  }): Promise<FeedOutcome>;
}

export type FeedOutcome =
  | { readonly kind: "found"; readonly xml: string }
  | {
      readonly kind: "missing";
      readonly discovery:
        | { readonly kind: "disabled" }
        | { readonly kind: "admitted"; readonly rootId: RootId }
        | { readonly kind: "duplicate"; readonly rootId: RootId }
        | {
            readonly kind: "admission-failed";
            readonly failure: RuntimeFailure;
          };
    }
  | { readonly kind: "fault"; readonly failure: RuntimeFailure };

export interface Media {
  readImage(input: {
    readonly programmeId: ProgrammeId;
  }): Promise<ImageOutcome>;

  readAudio(input: {
    /** Raw terminal path segment; core owns legacy `.m4a` parsing. */
    readonly fileName: string;
    /** Raw Range header; core owns validation and multi-range collapse. */
    readonly rangeHeader?: string;
  }): Promise<AudioOutcome>;
}

export type ImageOutcome =
  | {
      readonly kind: "found";
      readonly size: number;
      readonly body: ByteStream;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "fault"; readonly failure: RuntimeFailure };

export interface SatisfiedByteRange {
  readonly start: number;
  readonly endInclusive: number;
  readonly totalSize: number;
}

export type AudioOutcome =
  | {
      readonly kind: "full";
      readonly mediaId: MediaId;
      readonly fileName: `${number}.m4a`;
      readonly totalSize: number;
      readonly body: ByteStream;
    }
  | {
      readonly kind: "partial";
      readonly mediaId: MediaId;
      readonly fileName: `${number}.m4a`;
      readonly range: SatisfiedByteRange;
      readonly body: ByteStream;
    }
  | { readonly kind: "missing"; readonly mediaId: MediaId }
  | { readonly kind: "invalid-name"; readonly fileName: string }
  | { readonly kind: "unsatisfiable-range"; readonly totalSize: number }
  | { readonly kind: "fault"; readonly failure: RuntimeFailure };

export interface Administration {
  readDashboard(): Promise<DashboardOutcome>;

  refresh(input: {
    readonly requestId: RequestId;
    readonly programmeId: ProgrammeId;
    readonly mode: "incremental" | "full";
  }): Promise<AdminOutcome>;

  rescanArchive(input: {
    readonly requestId: RequestId;
    readonly programmeId: ProgrammeId;
  }): Promise<AdminOutcome>;

  recomputeArchiveStatistics(input: {
    readonly requestId: RequestId;
  }): Promise<AdminOutcome>;

  setProgrammeStatus(input: {
    readonly requestId: RequestId;
    readonly programmeId: ProgrammeId;
    /** Raw compatibility value; core accepts only exact `Ok` or `Failed`. */
    readonly status: string;
    readonly message?: string;
  }): Promise<AdminOutcome>;
}

export type DashboardOutcome =
  | { readonly kind: "found"; readonly html: string }
  | { readonly kind: "fault"; readonly failure: RuntimeFailure };

export type AdminOutcome =
  | { readonly kind: "accepted"; readonly rootId?: RootId }
  | { readonly kind: "duplicate"; readonly rootId?: RootId }
  | { readonly kind: "joined"; readonly rootId: RootId }
  | { readonly kind: "no-op"; readonly reason: "audio-archive-disabled" }
  | { readonly kind: "invalid-status" }
  | {
      readonly kind: "rejected";
      readonly reason: "lifecycle";
      readonly lifecycle: LifecycleState;
    }
  | { readonly kind: "fault"; readonly failure: RuntimeFailure };

export interface Schedule {
  hourly(input: {
    /** Cron scheduled time, not Worker receipt time. */
    readonly scheduledAt: IsoInstant;
  }): Promise<ScheduleOutcome>;
}

export type ScheduleOutcome =
  | { readonly kind: "admitted"; readonly sweepId: RootId }
  | { readonly kind: "duplicate"; readonly sweepId: RootId }
  | {
      readonly kind: "no-op";
      readonly reason: "disabled" | "standby" | "quiescing" | "halted";
    }
  | { readonly kind: "fault"; readonly failure: RuntimeFailure };

export interface QueueEnvelopeV1 {
  readonly version: 1;
  readonly jobId: JobId;
}

export interface Jobs {
  /** `unknown` keeps envelope validation inside the core. */
  consume(envelope: unknown): Promise<JobDisposition>;
}

export type JobDisposition =
  | {
      readonly kind: "ack";
      readonly reason:
        | "completed"
        | "duplicate"
        | "benign"
        | "deferred"
        | "retry-scheduled"
        | "terminal"
        | "publication-pending";
    }
  | {
      /** Required durable disposition could not be persisted. */
      readonly kind: "retry";
      readonly failure: RuntimeFailure;
      readonly delaySeconds?: number;
    }
  | {
      readonly kind: "discard";
      readonly reason:
        | "invalid-envelope"
        | "unsupported-version"
        | "unknown-job"
        | "unsupported-kind";
      readonly diagnostic: ClassifiedCondition;
    };

// ---------------------------------------------------------------------------
// Domain records and read-only repository seams
// ---------------------------------------------------------------------------

export interface ReadToken {
  readonly record: RecordRef;
  readonly revision: Revision;
}

export interface Observed<Value> {
  readonly value: Value;
  readonly token: ReadToken;
}

export interface Page<Value> {
  readonly items: readonly Value[];
  readonly nextCursor?: Cursor;
}

export interface Programme {
  readonly id: ProgrammeId;
  readonly type: ProgrammeType;
  readonly title: string;
  readonly description: string;
  readonly author: string;
  readonly canonicalUrl: string;
  readonly imageUrl: string;
  readonly advertisedEpisodes: number;
  readonly lastChecked: string;
  readonly status: ProgrammeStatus;
  readonly statusMessage: string;
  readonly statusDate: string;
}

export interface Episode {
  readonly id: EpisodeId;
  readonly programmeId: ProgrammeId;
  readonly title: string;
  readonly description: string;
  readonly date: string;
  readonly duration: number;
  readonly isBroadcastReplay: number;
}

export interface MediaRecord {
  readonly id: MediaId;
  readonly episodeId: EpisodeId;
  readonly episodeIndex: number;
  readonly length: number;
  readonly upstreamUrl: string;
}

export interface ManifestProjection {
  readonly programme: Programme;
  readonly episodes: readonly {
    readonly episode: Episode;
    readonly media: readonly MediaRecord[];
  }[];
}

export interface ProgrammeRepository {
  getById(id: ProgrammeId): Promise<Result<Observed<Programme> | null>>;
  pageEligibleForHourlySweep(input: {
    readonly after?: Cursor;
    readonly limit: number;
  }): Promise<Result<Page<ProgrammeId>>>;
}

export interface EpisodeRepository {
  getById(id: EpisodeId): Promise<Result<Observed<Episode> | null>>;
  countByProgrammeId(programmeId: ProgrammeId): Promise<Result<number>>;
  pageByProgrammeId(input: {
    readonly programmeId: ProgrammeId;
    readonly after?: Cursor;
    readonly limit: number;
  }): Promise<Result<Page<Observed<Episode>>>>;
}

export interface MediaRepository {
  getById(id: MediaId): Promise<Result<Observed<MediaRecord> | null>>;
  pageByEpisodeId(input: {
    readonly episodeId: EpisodeId;
    readonly after?: Cursor;
    readonly limit: number;
  }): Promise<Result<Page<Observed<MediaRecord>>>>;
  resolveProgrammeOwners(
    mediaIds: readonly MediaId[],
  ): Promise<
    Result<
      readonly {
        readonly mediaId: MediaId;
        readonly programmeId: ProgrammeId | null;
      }[]
    >
  >;
}

export interface ManifestRepository {
  getByProgrammeId(
    programmeId: ProgrammeId,
  ): Promise<Result<ManifestProjection | null>>;
}

export interface StatisticsRepository {
  readDashboard(): Promise<Result<DashboardProjection>>;
  getVisibleGeneration(): Promise<
    Result<Observed<{ readonly generationId?: GenerationId }>>
  >;
}

export interface DashboardProjection {
  readonly programmes: readonly {
    readonly programmeId: ProgrammeId;
    readonly title: string;
    readonly advertisedEpisodes: number;
    readonly knownEpisodes: number;
    /** Compatibility name; counts archived media segments. */
    readonly archivedEpisodes: number;
  }[];
  readonly failures: readonly {
    readonly programmeId: ProgrammeId;
    readonly status: "Failed";
    readonly message: string;
    readonly date: string;
  }[];
}

// ---------------------------------------------------------------------------
// Closed, versioned job catalog and operational reads
// ---------------------------------------------------------------------------

export interface JobVersion<Version extends number, Payload> {
  readonly version: Version;
  readonly payload: Payload;
}

export type BuiltInJobCatalog = {
  readonly "hourly-sweep": JobVersion<
    1,
    { readonly cursor: Cursor | null }
  >;
  readonly "programme-page": JobVersion<
    1,
    {
      readonly programmeId: ProgrammeId;
      readonly mode: "incremental" | "full" | "auto-add";
      readonly programmeType: ProgrammeType | null;
      readonly cursor: Cursor | null;
      readonly direction: "unknown" | "normal" | "reversed";
      readonly depth: number;
    }
  >;
  readonly "episode-media": JobVersion<
    1,
    {
      readonly programmeId: ProgrammeId;
      readonly episodeId: EpisodeId;
      readonly source: EpisodeMediaSource;
      readonly discoveredMediaIds: readonly MediaId[] | null;
      readonly offset: number;
    }
  >;
  readonly "image-archive": JobVersion<
    1,
    {
      readonly programmeId: ProgrammeId;
      readonly sourceUrl: string;
    }
  >;
  readonly "archive-stat-scan": JobVersion<
    1,
    {
      readonly generationId: GenerationId;
      readonly cursor: Cursor | null;
    }
  >;
  readonly "archive-stat-publish": JobVersion<
    1,
    { readonly generationId: GenerationId }
  >;
  readonly "activation-probe": JobVersion<
    1,
    {
      readonly activationAttemptId: string;
      readonly acceptanceDigest: string;
    }
  >;
};

export type ExpandJob<Kind extends string, Specification> =
  Specification extends JobVersion<infer Version, infer Payload>
    ? {
        readonly type: `${Kind}@${Version}`;
        readonly kind: Kind;
        readonly version: Version;
        readonly payload: Payload;
      }
    : never;

export type JobDefinition<Catalog> = {
  [Kind in keyof Catalog & string]: ExpandJob<Kind, Catalog[Kind]>;
}[keyof Catalog & string];

export type BuiltInJobDefinition = JobDefinition<BuiltInJobCatalog>;

export type JobState =
  | "blocked"
  | "ready"
  | "leased"
  | "retry-wait"
  | "succeeded"
  | "failed"
  | "suppressed";

export interface StoredJob {
  readonly id: JobId;
  readonly rootId: RootId;
  readonly programmeId?: ProgrammeId;
  /** Untrusted until decoded against BuiltInJobCatalog. */
  readonly version: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly state: JobState;
  readonly attempt: number;
  readonly dueAt: IsoInstant;
  readonly dependencies: readonly JobId[];
  readonly lease?: {
    readonly token: LeaseToken;
    readonly expiresAt: IsoInstant;
  };
}

export interface Receipt {
  readonly id: ReceiptId;
  readonly fingerprint: Fingerprint;
  readonly subject: {
    readonly kind: "request" | "job" | "activation";
    readonly id: string;
  };
  readonly completedAt: IsoInstant;
  readonly outcomeDigest: string;
}

declare const durableOutboxBrand: unique symbol;

export interface DurableOutboxMessage {
  readonly [durableOutboxBrand]: true;
  readonly outboxId: OutboxId;
  readonly envelope: QueueEnvelopeV1;
  readonly createdAt: IsoInstant;
  readonly lastPromptAt?: IsoInstant;
}

export interface JobRepository {
  getLifecycle(): Promise<Result<Observed<LifecycleState>>>;
  getJob(jobId: JobId): Promise<Result<Observed<StoredJob> | null>>;
  getReceipt(receiptId: ReceiptId): Promise<Result<Receipt | null>>;
  pagePendingOutbox(input: {
    readonly after?: Cursor;
    readonly limit: number;
  }): Promise<Result<Page<DurableOutboxMessage>>>;
  pageRecoverableJobs(input: {
    readonly at: IsoInstant;
    readonly after?: Cursor;
    readonly limit: number;
  }): Promise<Result<Page<JobId>>>;
}

// ---------------------------------------------------------------------------
// Atomic unit-of-work seam
// ---------------------------------------------------------------------------

export type RecordRef =
  | { readonly kind: "programme"; readonly id: ProgrammeId }
  | { readonly kind: "episode"; readonly id: EpisodeId }
  | { readonly kind: "media"; readonly id: MediaId }
  | { readonly kind: "job"; readonly id: JobId }
  | { readonly kind: "root"; readonly id: RootId }
  | { readonly kind: "receipt"; readonly id: ReceiptId }
  | { readonly kind: "outbox"; readonly id: OutboxId }
  | { readonly kind: "schedule-watermark" }
  | { readonly kind: "lifecycle" }
  | { readonly kind: "statistics-generation"; readonly id: GenerationId };

export type CommitPrecondition =
  | { readonly kind: "read-unchanged"; readonly token: ReadToken }
  | {
      readonly kind: "lifecycle-allows";
      readonly operation:
        | "http-admission"
        | "cron-admission"
        | "job-execution"
        | "image-write";
      readonly allowed: readonly LifecycleState[];
    }
  | {
      readonly kind: "job-state";
      readonly jobId: JobId;
      readonly expected: readonly JobState[];
      readonly leaseToken?: LeaseToken;
    }
  | {
      readonly kind: "programme-lane-head";
      readonly programmeId: ProgrammeId;
      readonly rootId: RootId;
    }
  | {
      readonly kind: "dependencies-terminal";
      readonly jobId: JobId;
      readonly requireSuccess: boolean;
    }
  | { readonly kind: "root-graph-terminal"; readonly rootId: RootId }
  | {
      readonly kind: "schedule-watermark";
      readonly expected?: IsoInstant;
    }
  | {
      readonly kind: "statistics-generation-active";
      readonly generationId: GenerationId;
    };

export type DomainMutation =
  | { readonly kind: "upsert-programme"; readonly value: Programme }
  | { readonly kind: "upsert-episode"; readonly value: Episode }
  | { readonly kind: "upsert-media"; readonly value: MediaRecord }
  | {
      readonly kind: "set-programme-status";
      readonly programmeId: ProgrammeId;
      readonly status: ProgrammeStatus;
      readonly message: string;
      readonly at: IsoInstant;
    }
  | {
      readonly kind: "stage-archive-stat";
      readonly generationId: GenerationId;
      readonly programmeId: ProgrammeId;
      readonly delta: number;
      readonly shardId: string;
    }
  | {
      readonly kind: "publish-archive-stats";
      readonly generationId: GenerationId;
    };

export type OperationalMutation =
  | {
      readonly kind: "admit-job";
      readonly jobId: JobId;
      readonly rootId: RootId;
      readonly programmeId?: ProgrammeId;
      readonly definition: BuiltInJobDefinition;
      readonly dependencies: readonly JobId[];
      readonly dueAt: IsoInstant;
    }
  | {
      readonly kind: "transition-job";
      readonly jobId: JobId;
      readonly from: readonly JobState[];
      readonly to: JobState;
      readonly attempt?: number;
      readonly dueAt?: IsoInstant;
      readonly lease?: {
        readonly token: LeaseToken;
        readonly expiresAt: IsoInstant;
      };
      readonly failure?: RuntimeFailure;
    }
  | {
      readonly kind: "record-attempt-failure";
      readonly jobId: JobId;
      readonly attempt: number;
      readonly occurredAt: IsoInstant;
      readonly nextDueAt?: IsoInstant;
      readonly failure: RuntimeFailure;
    }
  | {
      readonly kind: "set-programme-lane";
      readonly programmeId: ProgrammeId;
      readonly rootId?: RootId;
    }
  | {
      readonly kind: "set-root-outcome";
      readonly rootId: RootId;
      readonly outcome: "succeeded" | "failed" | "suppressed";
    }
  | { readonly kind: "set-schedule-watermark"; readonly at: IsoInstant }
  | {
      readonly kind: "mark-outbox-prompted";
      readonly outboxId: OutboxId;
      readonly at: IsoInstant;
    }
  | {
      readonly kind: "set-lifecycle";
      readonly from: readonly LifecycleState[];
      readonly to: LifecycleState;
      readonly activationAttemptId?: string;
      readonly acceptanceDigest?: string;
    };

export interface ReceiptDraft extends Omit<Receipt, "completedAt"> {
  readonly completedAt: IsoInstant;
}

export interface OutboxDraft {
  readonly outboxId: OutboxId;
  readonly envelope: QueueEnvelopeV1;
  readonly createdAt: IsoInstant;
}

export type ChangeSet =
  | {
      readonly kind: "effect";
      readonly commitId: string;
      readonly fingerprint: Fingerprint;
      readonly preconditions: readonly CommitPrecondition[];
      readonly domain: readonly DomainMutation[];
      readonly operations: readonly OperationalMutation[];
      readonly receipt: ReceiptDraft;
      readonly outbox: readonly OutboxDraft[];
    }
  | {
      /** Lease acquisition and coordination with no domain effect. */
      readonly kind: "coordination";
      readonly commitId: string;
      readonly fingerprint: Fingerprint;
      readonly preconditions: readonly CommitPrecondition[];
      readonly operations: readonly OperationalMutation[];
    };

export type CommitConflict =
  | {
      readonly kind: "preconditions-failed";
      /** Ordered by their position in ChangeSet.preconditions. */
      readonly failed: readonly CommitPrecondition[];
    }
  | {
      readonly kind: "receipt-fingerprint-mismatch";
      readonly receiptId: ReceiptId;
    };

export type CommitOutcome =
  | {
      readonly kind: "applied";
      readonly receipt?: Receipt;
      readonly durableOutbox: readonly DurableOutboxMessage[];
    }
  | {
      readonly kind: "duplicate";
      readonly receipt: Receipt;
      readonly durableOutbox: readonly DurableOutboxMessage[];
    }
  | { readonly kind: "conflict"; readonly conflict: CommitConflict };

export interface UnitOfWorkRepository {
  commit(changeSet: ChangeSet): Promise<Result<CommitOutcome>>;
}

// ---------------------------------------------------------------------------
// Semantic external-effect ports
// ---------------------------------------------------------------------------

export interface EpisodeMediaSource {
  readonly directMediaId?: string;
  readonly playbackListId: string;
  readonly contentTypeId: number;
}

export interface NormalizedProgrammePage {
  readonly programme: Omit<
    Programme,
    "status" | "statusMessage" | "statusDate"
  >;
  readonly episodes: readonly {
    readonly episode: Episode;
    readonly mediaSource: EpisodeMediaSource;
  }[];
  readonly nextCursor: Cursor | null;
}

export interface RadioCanadaGateway {
  probeProgramme(input: {
    readonly programmeId: ProgrammeId;
  }): Promise<
    Result<
      | {
          readonly kind: "found";
          readonly programmeType: ProgrammeType;
          readonly firstPage: NormalizedProgrammePage;
        }
      | { readonly kind: "not-found" },
      TransientDependencyFailure | PermanentUpstreamContentFailure
    >
  >;

  readProgrammePage(input: {
    readonly programmeId: ProgrammeId;
    readonly programmeType: ProgrammeType;
    readonly cursor: Cursor;
  }): Promise<
    Result<
      NormalizedProgrammePage,
      TransientDependencyFailure | PermanentUpstreamContentFailure
    >
  >;

  discoverMediaIds(input: {
    readonly source: EpisodeMediaSource;
  }): Promise<
    Result<
      readonly MediaId[],
      TransientDependencyFailure | PermanentUpstreamContentFailure
    >
  >;

  resolveMedia(input: {
    readonly mediaId: MediaId;
  }): Promise<
    Result<
      { readonly upstreamUrl: string },
      TransientDependencyFailure | PermanentUpstreamContentFailure
    >
  >;

  fetchImage(input: {
    readonly sourceUrl: string;
  }): Promise<
    Result<
      { readonly body: ByteStream; readonly size?: number },
      TransientDependencyFailure | PermanentOperationalFailure
    >
  >;
}

export type ArchiveRead =
  | {
      readonly kind: "found";
      readonly size: number;
      readonly body: ByteStream;
    }
  | { readonly kind: "missing" };

export interface ArchiveScanItem {
  readonly mediaId: MediaId | null;
  readonly key: string;
  readonly size: number;
}

export interface ArchiveObjects {
  readImage(programmeId: ProgrammeId): Promise<Result<ArchiveRead>>;
  readAudio(mediaId: MediaId): Promise<Result<ArchiveRead>>;
  readAudioRange(input: {
    readonly mediaId: MediaId;
    readonly start: number;
    readonly endInclusive: number;
  }): Promise<Result<ArchiveRead>>;
  putRevisionZeroImageIfAbsent(input: {
    readonly programmeId: ProgrammeId;
    readonly body: ByteStream;
    readonly size?: number;
  }): Promise<
    Result<
      | { readonly kind: "created" }
      | { readonly kind: "already-present" }
    >
  >;
  scanAudio(input: {
    readonly cursor?: Cursor;
    readonly limit: number;
  }): Promise<
    Result<{
      readonly items: readonly ArchiveScanItem[];
      readonly nextCursor?: Cursor;
    }>
  >;
}

export interface JobPublisher {
  /** Brand prevents publishing an outbox draft before commit. */
  publish(
    message: DurableOutboxMessage,
  ): Promise<Result<{ readonly kind: "accepted" }>>;
}

export interface Clock {
  now(): IsoInstant;
}

export interface CorePorts {
  readonly programmes: ProgrammeRepository;
  readonly episodes: EpisodeRepository;
  readonly media: MediaRepository;
  readonly manifests: ManifestRepository;
  readonly statistics: StatisticsRepository;
  readonly jobs: JobRepository;
  readonly unitOfWork: UnitOfWorkRepository;
  readonly radioCanada: RadioCanadaGateway;
  readonly archiveObjects: ArchiveObjects;
  readonly jobPublisher: JobPublisher;
  readonly clock: Clock;
}

export interface CoreConfiguration {
  readonly autoAddProgrammes: boolean;
  readonly refreshInterval: 0 | 3600;
  readonly maxEpisodes: number; // zero means unlimited
  readonly serveArchivedImages: boolean;
  readonly imageArchiveBaseUrl: string;
  readonly serveArchivedMedia: boolean;
  readonly audioArchiveBaseUrl: string;
  readonly limits: {
    readonly hourlySweepPage: number;
    readonly programmePageCommit: number;
    readonly episodeMediaChunk: number;
    readonly archiveScanPage: number;
    readonly outboxRelayPage: number;
    readonly continuationLimit: number;
    readonly leaseSeconds: number;
  };
}

export type BuildOhdieux = (
  configuration: CoreConfiguration,
  ports: CorePorts,
) => Result<Ohdieux, PermanentOperationalFailure>;
