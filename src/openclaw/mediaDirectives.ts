import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.js";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";
import { type ChatEvent } from "./protocol.js";

export type TranscriptArtifactKind = "image" | "video" | "audio" | "file";

export type TranscriptArtifact = {
  /** The artifact path as resolved inside OpenClaw state/workspace. */
  path: string;
  fileName: string;
  kind: TranscriptArtifactKind;
  contentType: string;
  sizeBytes: number;
};

export type TranscriptMediaFile = {
  path: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

type ArtifactRequestSource = "structured_artifact" | "media_directive";

type TranscriptArtifactRequest = {
  source: ArtifactRequestSource;
  path?: string;
  fileName?: string;
  kind?: TranscriptArtifactKind;
  contentType?: string;
  sizeBytes?: number;
};

export type TranscriptArtifactResolutionIssue = {
  source: ArtifactRequestSource;
  reason:
    | "invalid_path"
    | "missing_file"
    | "empty_file"
    | "too_large"
    | "missing_search_fields"
    | "no_recovery_match"
    | "ambiguous_file_name"
    | "ambiguous_size_type";
  path?: string;
  fileName?: string;
  kind?: TranscriptArtifactKind;
  contentType?: string;
  sizeBytes?: number;
  candidatePaths?: string[];
};

export type TranscriptArtifactCollectionReport = {
  artifacts: TranscriptArtifact[];
  unresolved: TranscriptArtifactResolutionIssue[];
  requestedCount: number;
  recoveredCount: number;
  usedStructuredArtifacts: boolean;
  usedLegacyMediaDirectives: boolean;
};

export type CollectTranscriptMediaOpts = {
  stateDir?: string; // defaults to $OPENCLAW_STATE_DIR or ~/.openclaw
  maxFiles?: number;
  maxBytes?: number;
  logContext?: {
    taskId?: string;
    runId?: string;
    sessionKey?: string;
  };
};

function resolveDefaultStateDir(): string {
  return resolveOpenclawStateDir(process.env);
}

function looksLikePlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (value as { constructor?: unknown }).constructor === Object;
}

export function extractMediaDirectivePaths(text: string): string[] {
  const out: string[] = [];
  const re = /(^|\n)\s*MEDIA:\s*([^\n\r]+)\s*(?=\r?\n|$)/g;
  for (;;) {
    const m = re.exec(text);
    if (!m) break;
    const raw = (m[2] ?? "").trim();
    if (raw) out.push(raw);
  }
  // Dedupe while preserving order.
  return Array.from(new Set(out));
}

function extractTextFromReplyMessage(message: unknown): string | null {
  if (typeof message === "string") {
    const normalized = message.trim();
    return normalized.length > 0 ? normalized : null;
  }
  if (!looksLikePlainObject(message)) return null;
  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return message.text.trim();
  }
  if (typeof message.content === "string" && message.content.trim().length > 0) {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) return null;
  const parts = message.content
    .map((part) => {
      if (typeof part === "string" && part.trim().length > 0) {
        return part.trim();
      }
      if (looksLikePlainObject(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
        return part.text.trim();
      }
      return null;
    })
    .filter((part): part is string => typeof part === "string");
  return parts.length > 0 ? parts.join("\n") : null;
}

function readReplyCandidates(input: { message?: unknown; openclawEvents?: ChatEvent[] }): unknown[] {
  const candidates: unknown[] = [];
  if (input.message !== undefined) {
    candidates.push(input.message);
  }
  if (Array.isArray(input.openclawEvents)) {
    for (let i = input.openclawEvents.length - 1; i >= 0; i -= 1) {
      candidates.push(input.openclawEvents[i]?.message);
    }
  }
  return candidates;
}

function readLatestMediaPathsFromCurrentReply(input: { message?: unknown; openclawEvents?: ChatEvent[] }): string[] {
  const candidates = readReplyCandidates(input);
  for (const candidate of candidates) {
    const text = extractTextFromReplyMessage(candidate);
    if (!text) continue;
    const paths = extractMediaDirectivePaths(text);
    if (paths.length > 0) return paths;
  }
  return [];
}

function normalizeArtifactKind(value: unknown): TranscriptArtifactKind | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "image" || normalized === "video" || normalized === "audio" || normalized === "file") {
    return normalized;
  }
  return undefined;
}

function readStructuredArtifactsFromCurrentReply(input: {
  message?: unknown;
  openclawEvents?: ChatEvent[];
}): TranscriptArtifactRequest[] {
  const candidates = readReplyCandidates(input);
  for (const candidate of candidates) {
    if (!looksLikePlainObject(candidate)) continue;
    const artifacts = Array.isArray(candidate.artifacts) ? candidate.artifacts : null;
    if (!artifacts || artifacts.length === 0) continue;
    const normalized: TranscriptArtifactRequest[] = artifacts
      .map((item) => {
        if (!looksLikePlainObject(item)) return null;
        const artifactPath = typeof item.path === "string" ? item.path.trim() : "";
        const fileName = typeof item.fileName === "string" ? item.fileName.trim() : "";
        const contentType = typeof item.contentType === "string" ? item.contentType.trim() : "";
        const sizeBytes =
          typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes)
            ? Math.trunc(item.sizeBytes)
            : undefined;
        return {
          source: "structured_artifact" as const,
          ...(artifactPath ? { path: artifactPath } : {}),
          ...(fileName ? { fileName } : {}),
          ...(normalizeArtifactKind(item.kind) ? { kind: normalizeArtifactKind(item.kind) } : {}),
          ...(contentType ? { contentType } : {}),
          ...(sizeBytes && sizeBytes > 0 ? { sizeBytes } : {}),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    if (normalized.length > 0) return normalized;
  }
  return [];
}

function sniffContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg") return "audio/ogg";
  return "application/octet-stream";
}

function inferArtifactKind(input: {
  contentType?: string;
  filePath?: string;
  kind?: TranscriptArtifactKind;
}): TranscriptArtifactKind {
  if (input.kind) return input.kind;
  const contentType = input.contentType?.trim().toLowerCase() ?? "";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  const byExt = sniffContentType(input.filePath ?? "");
  if (byExt.startsWith("image/")) return "image";
  if (byExt.startsWith("video/")) return "video";
  if (byExt.startsWith("audio/")) return "audio";
  return "file";
}

export async function resolveRelayMediaFile(params: {
  stateDir: string;
  workspaceRoot: string;
  mediaPath: string;
}): Promise<{ absPath: string; relPath: string }> {
  const raw = params.mediaPath.trim();
  if (!raw) {
    throw new Error("MEDIA path is empty");
  }
  const stateReal = await fs.realpath(params.stateDir).catch(() => params.stateDir);
  const workspaceReal = await fs.realpath(params.workspaceRoot).catch(() => params.workspaceRoot);
  const statePrefix = stateReal.endsWith(path.sep) ? stateReal : stateReal + path.sep;
  const workspacePrefix = workspaceReal.endsWith(path.sep) ? workspaceReal : workspaceReal + path.sep;

  // OpenClaw can emit:
  // - workspace-relative paths: MEDIA: avatars/foo.png
  // - state absolute paths: MEDIA:/root/.openclaw/media/browser/foo.png
  if (path.isAbsolute(raw)) {
    const absCandidate = path.resolve(raw);
    const absReal = await fs.realpath(absCandidate).catch(() => absCandidate);
    if (!(absReal === stateReal || absReal.startsWith(statePrefix))) {
      throw new Error("MEDIA absolute path is outside stateDir");
    }
    const relToState = path.relative(stateReal, absReal).replace(/\\/g, "/");
    return { absPath: absReal, relPath: relToState || path.basename(absReal) };
  }

  const normalized = raw.replace(/\\/g, "/");
  if (normalized.split("/").some((seg) => seg === "..")) {
    throw new Error("MEDIA path traversal is not allowed");
  }
  const workspaceCandidate = path.resolve(workspaceReal, normalized);
  const workspaceCandidateReal = await fs.realpath(workspaceCandidate).catch(() => workspaceCandidate);
  if (!(workspaceCandidateReal === workspaceReal || workspaceCandidateReal.startsWith(workspacePrefix))) {
    throw new Error("MEDIA path is outside workspace");
  }
  return { absPath: workspaceCandidateReal, relPath: normalized };
}

type WorkspaceArtifactCandidate = {
  absPath: string;
  relPath: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  kind: TranscriptArtifactKind;
};

async function listWorkspaceArtifactCandidates(input: {
  workspaceRoot: string;
  maxBytes: number;
}): Promise<WorkspaceArtifactCandidate[]> {
  const rootReal = await fs.realpath(input.workspaceRoot).catch(() => input.workspaceRoot);
  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  const out: WorkspaceArtifactCandidate[] = [];
  const stack = [rootReal];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const realPath = await fs.realpath(absPath).catch(() => absPath);
      if (!(realPath === rootReal || realPath.startsWith(rootPrefix))) continue;
      const stat = await fs.stat(realPath).catch(() => null);
      if (!stat || !stat.isFile() || stat.size <= 0 || stat.size > input.maxBytes) continue;
      const relPath = path.relative(rootReal, realPath).replace(/\\/g, "/");
      const contentType = sniffContentType(relPath);
      out.push({
        absPath: realPath,
        relPath,
        fileName: path.basename(relPath),
        contentType,
        sizeBytes: stat.size,
        kind: inferArtifactKind({ contentType, filePath: relPath }),
      });
    }
  }
  return out;
}

function makeIssue(input: {
  request: TranscriptArtifactRequest;
  reason: TranscriptArtifactResolutionIssue["reason"];
  candidatePaths?: string[];
}): TranscriptArtifactResolutionIssue {
  return {
    source: input.request.source,
    reason: input.reason,
    ...(input.request.path ? { path: input.request.path } : {}),
    ...(input.request.fileName ? { fileName: input.request.fileName } : {}),
    ...(input.request.kind ? { kind: input.request.kind } : {}),
    ...(input.request.contentType ? { contentType: input.request.contentType } : {}),
    ...(input.request.sizeBytes ? { sizeBytes: input.request.sizeBytes } : {}),
    ...(input.candidatePaths && input.candidatePaths.length > 0 ? { candidatePaths: input.candidatePaths } : {}),
  };
}

function logArtifactResolution(input: {
  level: "info" | "warn";
  message: string;
  opts: CollectTranscriptMediaOpts | undefined;
  request?: TranscriptArtifactRequest;
  reason?: string;
  resolvedPath?: string;
  candidatePaths?: string[];
}) {
  logger[input.level](
    {
      event: "artifact_delivery",
      stage: "artifact_resolution",
      taskId: input.opts?.logContext?.taskId ?? null,
      runId: input.opts?.logContext?.runId ?? null,
      sessionKey: input.opts?.logContext?.sessionKey ?? null,
      requestSource: input.request?.source ?? null,
      requestedPath: input.request?.path ?? null,
      requestedFileName: input.request?.fileName ?? null,
      requestedKind: input.request?.kind ?? null,
      requestedContentType: input.request?.contentType ?? null,
      requestedSizeBytes: input.request?.sizeBytes ?? null,
      reason: input.reason ?? null,
      resolvedPath: input.resolvedPath ?? null,
      candidatePaths: input.candidatePaths ?? [],
    },
    input.message
  );
}

async function resolveArtifactExactly(input: {
  request: TranscriptArtifactRequest;
  stateDir: string;
  workspaceRoot: string;
  maxBytes: number;
}): Promise<{ artifact?: TranscriptArtifact; issue?: TranscriptArtifactResolutionIssue }> {
  const { request } = input;
  if (!request.path) {
    return { issue: makeIssue({ request, reason: "missing_file" }) };
  }
  let resolved: { absPath: string; relPath: string };
  try {
    resolved = await resolveRelayMediaFile({
      stateDir: input.stateDir,
      workspaceRoot: input.workspaceRoot,
      mediaPath: request.path,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("path traversal") || message.includes("outside")) {
      return { issue: makeIssue({ request, reason: "invalid_path" }) };
    }
    return { issue: makeIssue({ request, reason: "missing_file" }) };
  }
  const stat = await fs.stat(resolved.absPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { issue: makeIssue({ request, reason: "missing_file" }) };
  }
  if (stat.size <= 0) {
    return { issue: makeIssue({ request, reason: "empty_file" }) };
  }
  if (stat.size > input.maxBytes) {
    return { issue: makeIssue({ request, reason: "too_large" }) };
  }
  const contentType = request.contentType?.trim() || sniffContentType(resolved.relPath);
  return {
    artifact: {
      path: resolved.relPath,
      fileName: request.fileName?.trim() || path.basename(resolved.relPath),
      kind: inferArtifactKind({ contentType, filePath: resolved.relPath, kind: request.kind }),
      contentType,
      sizeBytes: stat.size,
    },
  };
}

function recoverArtifactFromWorkspace(input: {
  request: TranscriptArtifactRequest;
  workspaceCandidates: WorkspaceArtifactCandidate[];
}): {
  artifact?: TranscriptArtifact;
  issue?: TranscriptArtifactResolutionIssue;
  recovered: boolean;
} {
  const { request } = input;
  const nameMatches = request.fileName
    ? input.workspaceCandidates.filter((candidate) => candidate.fileName === request.fileName)
    : [];
  if (nameMatches.length === 1) {
    const candidate = nameMatches[0];
    return {
      recovered: true,
      artifact: {
        path: candidate.relPath,
        fileName: candidate.fileName,
        kind: candidate.kind,
        contentType: candidate.contentType,
        sizeBytes: candidate.sizeBytes,
      },
    };
  }
  if (nameMatches.length > 1) {
    return {
      recovered: false,
      issue: makeIssue({
        request,
        reason: "ambiguous_file_name",
        candidatePaths: nameMatches.map((candidate) => candidate.relPath).sort(),
      }),
    };
  }
  if (request.sizeBytes && request.sizeBytes > 0 && request.contentType) {
    const sizeTypeMatches = input.workspaceCandidates.filter(
      (candidate) =>
        candidate.sizeBytes === request.sizeBytes && candidate.contentType === request.contentType
    );
    if (sizeTypeMatches.length === 1) {
      const candidate = sizeTypeMatches[0];
      return {
        recovered: true,
        artifact: {
          path: candidate.relPath,
          fileName: candidate.fileName,
          kind: candidate.kind,
          contentType: candidate.contentType,
          sizeBytes: candidate.sizeBytes,
        },
      };
    }
    if (sizeTypeMatches.length > 1) {
      return {
        recovered: false,
        issue: makeIssue({
          request,
          reason: "ambiguous_size_type",
          candidatePaths: sizeTypeMatches.map((candidate) => candidate.relPath).sort(),
        }),
      };
    }
  }
  if (!request.fileName && !(request.sizeBytes && request.contentType)) {
    return {
      recovered: false,
      issue: makeIssue({ request, reason: "missing_search_fields" }),
    };
  }
  return {
    recovered: false,
    issue: makeIssue({ request, reason: "no_recovery_match" }),
  };
}

export async function collectTranscriptArtifacts(params: {
  message?: unknown;
  openclawEvents?: ChatEvent[];
  opts?: CollectTranscriptMediaOpts;
}): Promise<TranscriptArtifactCollectionReport> {
  const stateDir = params.opts?.stateDir ?? resolveDefaultStateDir();
  const maxFiles = Math.max(0, Math.min(10, Math.trunc(params.opts?.maxFiles ?? 4)));
  const maxBytes = Math.max(1, Math.trunc(params.opts?.maxBytes ?? 5_000_000));
  if (maxFiles === 0) {
    return {
      artifacts: [],
      unresolved: [],
      requestedCount: 0,
      recoveredCount: 0,
      usedStructuredArtifacts: false,
      usedLegacyMediaDirectives: false,
    };
  }
  const workspaceRoot = path.join(stateDir, "workspace");
  const structuredArtifacts = readStructuredArtifactsFromCurrentReply({
    message: params.message,
    openclawEvents: params.openclawEvents,
  });
  const legacyMediaPaths =
    structuredArtifacts.length === 0
      ? readLatestMediaPathsFromCurrentReply({
          message: params.message,
          openclawEvents: params.openclawEvents,
        })
      : [];
  const requests: TranscriptArtifactRequest[] =
    structuredArtifacts.length > 0
      ? structuredArtifacts
      : legacyMediaPaths.map((mediaPath) => ({
          source: "media_directive" as const,
          path: mediaPath,
          fileName: path.basename(mediaPath.trim().replace(/\\/g, "/")),
          contentType: sniffContentType(mediaPath),
          kind: inferArtifactKind({ filePath: mediaPath, contentType: sniffContentType(mediaPath) }),
        }));
  if (requests.length === 0) {
    return {
      artifacts: [],
      unresolved: [],
      requestedCount: 0,
      recoveredCount: 0,
      usedStructuredArtifacts: false,
      usedLegacyMediaDirectives: false,
    };
  }

  const artifacts: TranscriptArtifact[] = [];
  const unresolved: TranscriptArtifactResolutionIssue[] = [];
  const workspaceCandidates = await listWorkspaceArtifactCandidates({ workspaceRoot, maxBytes });
  let recoveredCount = 0;
  for (const request of requests) {
    if (artifacts.length >= maxFiles) break;
    const exact = await resolveArtifactExactly({
      request,
      stateDir,
      workspaceRoot,
      maxBytes,
    });
    if (exact.artifact) {
      artifacts.push(exact.artifact);
      logArtifactResolution({
        level: "info",
        message: "Artifact resolved strictly",
        opts: params.opts,
        request,
        reason: "strict_path_match",
        resolvedPath: exact.artifact.path,
      });
      continue;
    }
    if (exact.issue?.reason === "invalid_path") {
      unresolved.push(exact.issue);
      logArtifactResolution({
        level: "warn",
        message: "Artifact resolution failed due to invalid path",
        opts: params.opts,
        request,
        reason: exact.issue.reason,
      });
      continue;
    }
    const recovered = recoverArtifactFromWorkspace({ request, workspaceCandidates });
    if (recovered.artifact) {
      artifacts.push(recovered.artifact);
      recoveredCount += 1;
      logArtifactResolution({
        level: "info",
        message: "Artifact recovered from workspace",
        opts: params.opts,
        request,
        reason: request.fileName === recovered.artifact.fileName ? "recovered_by_file_name" : "recovered_by_size_type",
        resolvedPath: recovered.artifact.path,
      });
      continue;
    }
    if (recovered.issue) {
      unresolved.push(recovered.issue);
      logArtifactResolution({
        level: "warn",
        message: "Artifact recovery did not produce a single match",
        opts: params.opts,
        request,
        reason: recovered.issue.reason,
        candidatePaths: recovered.issue.candidatePaths,
      });
      continue;
    }
  }
  return {
    artifacts,
    unresolved,
    requestedCount: requests.length,
    recoveredCount,
    usedStructuredArtifacts: structuredArtifacts.length > 0,
    usedLegacyMediaDirectives: structuredArtifacts.length === 0 && legacyMediaPaths.length > 0,
  };
}

export async function collectTranscriptMedia(params: {
  message?: unknown;
  openclawEvents?: ChatEvent[];
  opts?: CollectTranscriptMediaOpts;
}): Promise<TranscriptMediaFile[]> {
  const report = await collectTranscriptArtifacts(params);
  return report.artifacts.map((artifact) => ({
    path: artifact.path,
    fileName: artifact.fileName,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
  }));
}

