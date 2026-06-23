// Lightweight error type for the sidecar. We deliberately do not pull in
// @oneplatform/core's full AppError hierarchy — the sidecar is intentionally
// minimal and self-contained (it only needs the Docker socket capability).

export class DockerBffError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DockerBffError";
  }
}

export class DockerUnavailableError extends DockerBffError {
  constructor(message = "Docker daemon is not reachable.") {
    super("DOCKER_UNAVAILABLE", message, 503);
  }
}

export class ContainerNotFoundError extends DockerBffError {
  constructor(id: string) {
    super("CONTAINER_NOT_FOUND", `Container "${id}" not found.`, 404);
  }
}

export class ContainerRunningError extends DockerBffError {
  constructor(id: string) {
    super(
      "CONTAINER_RUNNING",
      `Container "${id}" is running. Stop it before removing.`,
      422,
    );
  }
}

export class ImageNotFoundError extends DockerBffError {
  constructor(id: string) {
    super("IMAGE_NOT_FOUND", `Image "${id}" not found.`, 404);
  }
}

// Maps a thrown error to the OnePlatform error envelope + HTTP status.
export function toErrorResponse(err: unknown): {
  status: number;
  body: { error: { code: string; message: string } };
} {
  if (err instanceof DockerBffError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  // dockerode surfaces daemon HTTP errors with a numeric `statusCode`.
  if (isDockerodeError(err)) {
    if (err.statusCode === 404) {
      return {
        status: 404,
        body: { error: { code: "NOT_FOUND", message: err.message } },
      };
    }
    if (err.statusCode === 409) {
      return {
        status: 409,
        body: { error: { code: "CONFLICT", message: err.message } },
      };
    }
  }

  // Socket-level failures (daemon down, socket missing) surface as ENOENT /
  // ECONNREFUSED on the error's `code` field.
  if (isSocketError(err)) {
    return {
      status: 503,
      body: {
        error: {
          code: "DOCKER_UNAVAILABLE",
          message: "Docker daemon is not reachable.",
        },
      },
    };
  }

  const message = err instanceof Error ? err.message : "Internal error.";
  return {
    status: 500,
    body: { error: { code: "INTERNAL", message } },
  };
}

function isDockerodeError(err: unknown): err is { statusCode: number; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    typeof (err as { statusCode: unknown }).statusCode === "number"
  );
}

function isSocketError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return false;
  }
  const code = (err as { code: unknown }).code;
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "EACCES" ||
    code === "ETIMEDOUT"
  );
}
